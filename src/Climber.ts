/**
 * Climber - the decision layer (concept/climbing-plan.md §5).
 *
 * A fixed three-phase rotation (LegReach -> Push -> HandReach) with:
 * - hard filter-chain target selection (§7),
 * - substitution when a filter yields nothing (§5.2),
 * - a stall ladder on timeouts (§8) that never forces, never releases a
 *   planted limb, and never writes velocities.
 *
 * The Climber names limbs and anchors only; all joint angles, IK and timing
 * live in ClimberMotor.
 */
import type { SpringPhysics } from "./Physics.ts";
import type { Wall, WallAnchor } from "./Wall.ts";
import type { Skeleton } from "./Skeleton.ts";
import {
    ClimberMotor,
    FOOT_TO_LOWEST_HAND_GAP,
    HAND_MIN_ABOVE_NECK,
    KNEE_MIN_ANGLE,
    REACH_FRACTION,
    REACH_FRACTION_RELAXED,
    type LimbKind,
    type MotorStatus,
} from "./ClimberMotor.ts";

export type ClimberPhase = "LegReach" | "Push" | "HandReach" | "Idle";

const PHASE_TIMEOUT = 3.0;
/** Minimum Push duration so the body gains height before HandReach. */
const MIN_PUSH = 0.5;

export class Climber {
    public readonly phys: SpringPhysics;
    public readonly wall: Wall;
    public readonly skeleton: Skeleton;
    public readonly motor: ClimberMotor;

    public phase: ClimberPhase = "Idle";
    public driveLegSide = -1;
    public supportArmSide = -1;
    /** Anchor chosen for the current LegReach/HandReach. */
    private target: WallAnchor | undefined;
    private phaseElapsed = 0;
    /** Ladder step reached in the current phase (0 = none). */
    private ladderStep = 0;
    /** Set once per update when the ladder needs the other move type. */
    private pendingSubstitution: "hand" | "leg" | undefined;
    /** Anchors released by this move's own limb; excluded from its next
     *  target pick (§7.2 rule 4 - a limb must not "reach" its old hold). */
    private releasedThisCycle = new Set<number>();
    /** Minimum remaining time for a substitution push (§5.2). */
    private pushHoldUntil = 0;
    /** y of the hand anchor released this cycle (for Q14 relaxation). */
    private lastReleasedHandY: number | undefined;
    /** Consecutive substitutions without a successful latch (§8.4). */
    private substitutionCount = 0;
    /** Side the HandReach move reaches with (captured once per move). */
    private handReachSide = -1;
    public clock = 0;

    /** Counts completed latches (observable; used by tests as cycle proxy). */
    public grabCount = 0;

    public constructor(phys: SpringPhysics, wall: Wall, skeleton: Skeleton) {
        this.phys = phys;
        this.wall = wall;
        this.skeleton = skeleton;
        this.motor = new ClimberMotor(phys, wall, skeleton);
    }

    public update(deltaTime: number): void {
        this.clock += deltaTime;
        this.phaseElapsed += deltaTime;
        this.motor.update(deltaTime);

        if (this.phase === "Idle") {
            this.beginInitialPhase();
        }

        switch (this.phase) {
            case "LegReach":
                this.updateLegReach(deltaTime);
                break;
            case "Push":
                this.updatePush();
                break;
            case "HandReach":
                this.updateHandReach(deltaTime);
                break;
            default:
                break;
        }

        if (this.phaseElapsed > PHASE_TIMEOUT) {
            if (this.ladderStep === 0) {
                this.ladderStep = 2;
                this.log(`phase ${this.phase} timed out -> ladder step 2 (relaxed reach)`);
            } else {
                this.ladderStep++;
                this.log(`phase ${this.phase} timed out again -> ladder step ${this.ladderStep}`);
            }
        }

        // Repeated substitutions advance the ladder too: each failed pick is
        // a stall signal, and after enough of them the wall genuinely offers
        // nothing (§8.4 Idle).
        if (this.substitutionCount >= 3) {
            this.log(`stall: ${this.substitutionCount} consecutive substitutions -> Idle`);
            this.enterIdle();
            return;
        }

        // Ladder cap (§8.4): a phase that keeps timing out has hit a wall the
        // filter chain cannot pass - give up to Idle rather than spin forever.
        if (this.ladderStep > 4) {
            this.log(`stall: ladder step ${this.ladderStep} exceeded -> Idle`);
            this.enterIdle();
            return;
        }
    }

    /** Enters Idle (§8.4): cancel any move, re-latch any free limb. */
    private enterIdle(): void {
        this.motor.cancelMove();
        for (let side = 0; side < 2; side++) {
            this.regrabFreeFoot(side);
            this.regrabFreeHand(side);
        }
        this.phase = "Idle";
        this.phaseElapsed = 0;
        this.ladderStep = 0;
        this.substitutionCount = 0;
        this.pendingSubstitution = undefined;
        this.target = undefined;
    }

    // ------------------------------------------------------------------
    // Phase logic
    // ------------------------------------------------------------------

    private beginInitialPhase(): void {
        // Find the planted configuration (all four limbs latched at start).
        this.driveLegSide = this.findPlantedSide("foot");
        this.supportArmSide = this.findPlantedSide("hand");
        this.log(`init: driveLeg=${this.driveLegSide} supportArm=${this.supportArmSide}`);
        this.beginPhase("LegReach");
    }

    private beginPhase(phase: ClimberPhase): void {
        this.phase = phase;
        this.phaseElapsed = 0;
        this.target = undefined;
        this.handReachSide = -1;
        // NOTE: ladderStep persists across substitution phases so the ladder
        // can reach step 2 (relaxed reach) even after a substitution; it is
        // reset on a successful latch.
        this.log(`phase -> ${phase}${this.ladderStep > 0 ? ` (ladder ${this.ladderStep})` : ""}`);
    }

    /** Anchors each foot side was last latched to (for re-latch on stall). */
    private footReleasedAnchor: [number, number] = [-1, -1];
    /** Anchors each hand side was last latched to (for re-latch on stall). */
    private handReleasedAnchor: [number, number] = [-1, -1];

    /** Re-latches a free limb to the anchor it was last latched to, if any. */
    private regrabFreeFoot(side: number): void {
        this.regrabFreeLimb("foot", side, this.footReleasedAnchor, 30);
    }

    private regrabFreeHand(side: number): void {
        this.regrabFreeLimb("hand", side, this.handReleasedAnchor, 30);
    }

    private regrabFreeLimb(
        kind: LimbKind,
        side: number,
        released: [number, number],
        maxDistance: number,
    ): void {
        if (this.skeleton.isGrabbing(kind, side)) return;
        const index = released[side];
        if (index === undefined || index < 0) return;
        const anchor = this.wall.wallAnchors[index];
        if (anchor === undefined) return;
        const limb = this.skeleton.limbParticle(kind, side);
        // The limb swings quickly once released; allow a generous recovery
        // radius. skeleton.grab snaps the particle back onto the anchor.
        if (Math.hypot(limb.posX - anchor.posX, limb.posY - anchor.posY) > maxDistance) return;
        this.motor.cancelMove();
        this.skeleton.grab(kind, side, anchor);
        released[side] = -1;
        this.log(`re-latch ${kind} ${side} to a${index} (stall recovery)`);
    }

    private updateLegReach(deltaTime: number): void {
        void deltaTime;
        let freeSide = 1 - this.driveLegSide;

        // Pick the target BEFORE releasing the foot: while the foot is still
        // planted, its own anchor is occupied and cannot be picked (no zero-
        // progress "reach"). If no candidate exists we substitute to HandReach
        // with BOTH feet still planted - the ≤1-free invariant (§9.2) holds.
        if (this.target === undefined) {
            const relaxed = this.ladderStep >= 2;
            this.target = this.pickFootTarget(freeSide, relaxed);
            if (this.target === undefined) {
                // The foot may already be free from an earlier attempt whose
                // target went stale: re-latch it to its old hold first so the
                // substitution starts with everything planted.
                this.regrabFreeFoot(freeSide);
                this.enterSubstitution("leg");
                return;
            }
        }

        // The reaching foot must be free. Normally the old drive leg was
        // already released at the start of the previous Push; at the very
        // first cycle (all four planted) release it here.
        if (this.skeleton.isGrabbing("foot", freeSide)) {
            const anchorIndex = this.skeleton.grabConstraint("foot", freeSide).wallAnchorIndex;
            this.footReleasedAnchor[freeSide] = anchorIndex;
            this.releasedThisCycle.add(anchorIndex);
            this.motor.releaseFoot(freeSide);
        }

        if (this.target !== undefined && !this.motor.hasMove()) {
            this.motor.reachFoot(freeSide, this.target);
        }
        if (this.target === undefined) {
            return;
        }
        // Stale target: the body drifted out of the limb's relaxed reach
        // envelope - chasing it forever deadlocks the phase. Cancel the move
        // and re-latch the foot to its old hold within the same substep, so
        // the free-limb window never exceeds one (the ≤1-free invariant).
        if (this.motor.hasMove() && this.isTargetOutOfRange("foot", this.target)) {
            this.motor.cancelMove();
            this.regrabFreeFoot(freeSide);
            this.target = undefined;
            return;
        }

        const status = this.motor.reachFoot(freeSide, this.target);
        if (status === "latched") {
            this.grabCount++;
            this.releasedThisCycle.clear();
            this.pendingSubstitution = undefined;
            this.ladderStep = 0;
            this.substitutionCount = 0;
            // NOTE: the old drive leg does NOT release here - it releases at
            // the start of Push (see updatePush), so that during HandReach
            // only the reaching hand is ever free (≤1-free invariant, §9.2).
            this.driveLegSide = freeSide;
            this.log(`LegReach: foot latched anchor ${this.target.index}`);
            this.beginPhase("Push");
        } else if (status === "timeout") {
            this.target = undefined;
        }
    }

    private updatePush(): void {
        // NOTE: the old drive leg stays planted through Push and HandReach.
        // It releases at the start of the NEXT LegReach (updateLegReach),
        // where it becomes the reaching leg. This ordering keeps at most one
        // limb free in every phase (§9.2 invariant).
        //
        // Push ends when the knee is near-straight AND the body has had at
        // least MIN_PUSH seconds to actually gain height (an already-extended
        // knee would otherwise end the phase instantly, and a substitution
        // push must move the body before HandReach re-picks).
        this.motor.pushWithLeg(this.driveLegSide);
        const minTime = this.pushHoldUntil > 0 ? this.pushHoldUntil : MIN_PUSH;
        if (this.phaseElapsed >= minTime) {
            if (this.pushHoldUntil > 0) {
                this.log(`Push: held substitution push`);
            } else {
                this.log(`Push: drive leg extended`);
            }
            this.pushHoldUntil = 0;
            this.beginPhase("HandReach");
        }
    }

    private updateHandReach(deltaTime: number): void {
        void deltaTime;
        // A free foot here (left by a stale-cancel in the previous LegReach)
        // is re-latched BEFORE releasing any hand: the ≤1-free invariant
        // (§9.2) outranks the hand move.
        for (let side = 0; side < 2; side++) {
            if (!this.skeleton.isGrabbing("foot", side) && !this.motor.hasMove()) {
                this.regrabFreeFoot(side);
            }
        }
        if ([0, 1].some(s => !this.skeleton.isGrabbing("foot", s))) {
            // A foot could not be re-latched (too far from its old hold):
            // keep the free foot as THE free limb this substep and defer the
            // hand move.
            return;
        }
        // The LOWEST hand itself releases and reaches (§5.1 phase 3). The
        // reach side is CAPTURED once per move: recomputing it from the
        // grabbing set each substep would retarget the reach after the
        // release changes the set.
        if (this.handReachSide < 0) {
            this.handReachSide = this.lowestHandSide();
        }
        const lowestSide = this.handReachSide;
        const reachSide = lowestSide;

        if (this.target === undefined) {
            const relaxed = this.ladderStep >= 2;
            // Q14 relaxation: when the strict "above the neck" rule yields
            // nothing (ladder step 2), relax to "above the hand's own current
            // anchor". Safety rules never relax.
            const releasedHandY = this.lastReleasedHandY;
            const minAboveY = relaxed && releasedHandY !== undefined
                ? releasedHandY
                : this.neck().posY - HAND_MIN_ABOVE_NECK;
            this.target = this.pickHandTarget(reachSide, minAboveY, relaxed);
            if (this.target === undefined) {
                this.enterSubstitution("hand");
                return;
            }
            // Release the lowest hand only after a target exists.
            if (this.skeleton.isGrabbing("hand", lowestSide)) {
                const anchorIndex = this.skeleton.grabConstraint("hand", lowestSide).wallAnchorIndex;
                this.handReleasedAnchor[lowestSide] = anchorIndex;
                this.releasedThisCycle.add(anchorIndex);
                this.lastReleasedHandY = this.wall.wallAnchors[anchorIndex]?.posY;
                this.motor.releaseHand(lowestSide);
            }
            this.motor.reachHand(reachSide, this.target);
        } else if (this.isTargetOutOfRange("hand", this.target)) {
            this.target = undefined;
            return;
        }

        const status = this.motor.reachHand(reachSide, this.target);
        if (status === "latched") {
            this.grabCount++;
            this.releasedThisCycle.clear();
            this.pendingSubstitution = undefined;
            this.ladderStep = 0;
            this.substitutionCount = 0;
            this.supportArmSide = reachSide;
            this.log(`HandReach: hand latched anchor ${this.target.index}`);
            this.beginPhase("LegReach");
        } else if (status === "timeout") {
            this.target = undefined;
        }
    }

    // ------------------------------------------------------------------
    // Substitution (§5.2)
    // ------------------------------------------------------------------

    private enterSubstitution(failedMove: "leg" | "hand"): void {
        // A limb freed for a move that now substitutes must be re-latched
        // first: the ≤1-free invariant (§9.2) outranks the substitution.
        if (failedMove === "hand") {
            for (let side = 0; side < 2; side++) {
                this.regrabFreeHand(side);
            }
        }
        if (this.pendingSubstitution === failedMove && this.ladderStep >= 3) {
            // Substitution already tried (even relaxed) and found nothing:
            // Idle (§8.4).
            this.log(`stall: no candidates for ${failedMove} or substitution -> Idle`);
            this.pendingSubstitution = undefined;
            this.enterIdle();
            return;
        }
        this.pendingSubstitution = failedMove;
        this.substitutionCount++;
        this.log(`substitution: ${failedMove} move has no candidates -> ${failedMove === "leg" ? "HandReach" : "leg push"} (ladder ${this.ladderStep}, streak ${this.substitutionCount})`);
        if (failedMove === "leg") {
            this.beginPhase("HandReach");
        } else {
            // A leg push to bring the shoulders closer to new anchors: treat
            // as a Push on the current drive leg. Hold the push for a minimum
            // duration so the body actually rises before HandReach re-picks.
            this.pushHoldUntil = this.phaseElapsed + 0.8;
            this.beginPhase("Push");
        }
    }

    // ------------------------------------------------------------------
    // Filter chain (§7)
    // ------------------------------------------------------------------

    private occupiedIndices(): Set<number> {
        const occupied = new Set<number>();
        for (const kind of ["hand", "foot"] as const) {
            for (let side = 0; side < 2; side++) {
                if (this.skeleton.isGrabbing(kind, side)) {
                    occupied.add(this.skeleton.grabConstraint(kind, side).wallAnchorIndex);
                }
            }
        }
        return occupied;
    }

    /** Lowest hand anchor y = LARGEST y (lowest position on the wall). */
    private lowestHandAnchorY(): number {
        let lowest = Number.NEGATIVE_INFINITY;
        for (let side = 0; side < 2; side++) {
            if (!this.skeleton.isGrabbing("hand", side)) continue;
            const index = this.skeleton.grabConstraint("hand", side).wallAnchorIndex;
            const anchor = this.wall.wallAnchors[index];
            if (anchor !== undefined) {
                lowest = Math.max(lowest, anchor.posY);
            }
        }
        return lowest;
    }

    private lowestHandSide(): number {
        let best = 0;
        let bestY = Number.NEGATIVE_INFINITY;
        for (let side = 0; side < 2; side++) {
            if (!this.skeleton.isGrabbing("hand", side)) continue;
            const index = this.skeleton.grabConstraint("hand", side).wallAnchorIndex;
            const anchor = this.wall.wallAnchors[index];
            if (anchor !== undefined && anchor.posY > bestY) {
                bestY = anchor.posY;
                best = side;
            }
        }
        return best;
    }

    private pickFootTarget(_side: number, relaxed: boolean): WallAnchor | undefined {
        const occupied = this.occupiedIndices();
        const lowestHandY = this.lowestHandAnchorY();
        const origin = this.origin("foot");
        // Reach envelope matches the motor's: the end particle can latch
        // within LATCH_RADIUS of the anchor, so the origin-reach band is
        // boneSum*fraction + LATCH_RADIUS.
        const reach = this.boneSum("foot") * (relaxed ? REACH_FRACTION_RELAXED : REACH_FRACTION) + 6;
        const gap = FOOT_TO_LOWEST_HAND_GAP;
        // The knee fold limit: anchors closer to the origin than this can
        // never be latched (the knee cannot fold tighter than KNEE_MIN).
        const bone = this.boneSum("foot") / 2;
        const minFold = 2 * bone * Math.sin(KNEE_MIN_ANGLE / 2);
        let best: WallAnchor | undefined;
        let bestY = Number.NEGATIVE_INFINITY;
        for (const anchor of this.wall.wallAnchors) {
            if (occupied.has(anchor.index) || this.motor.isBlacklisted(anchor.index)) continue;
            if (this.releasedThisCycle.has(anchor.index)) continue;
            // Rule 2 (gap): foot targets stay >= gap BELOW the lowest hand
            // (below = larger y). Feet never overtake hands.
            if (lowestHandY !== Number.POSITIVE_INFINITY && anchor.posY < lowestHandY + gap) continue;
            // Rule 1 (reachability) - a BAND: the IK cannot fold tighter than
            // minFold nor extend beyond reach.
            const dx = anchor.posX - origin.posX;
            const dy = anchor.posY - origin.posY;
            const distSqr = dx * dx + dy * dy;
            if (distSqr > reach * reach) continue;
            if (distSqr < minFold * minFold) continue;
            // Rule 3 (CoM) is checked by the invariant contract after the move;
            // here we prefer the highest candidate that passes 1+2.
            if (anchor.posY > bestY) {
                best = anchor;
                bestY = anchor.posY;
            }
        }
        if (best !== undefined) {
            this.log(`foot target: ${best.index} (y=${best.posY.toFixed(0)}, relaxed=${relaxed})`);
        }
        return best;
    }

    private pickHandTarget(_side: number, minAboveY: number, relaxed: boolean): WallAnchor | undefined {
        const occupied = this.occupiedIndices();
        const origin = this.origin("hand");
        const reach = this.boneSum("hand") * (relaxed ? REACH_FRACTION_RELAXED : REACH_FRACTION) + 6;
        let best: WallAnchor | undefined;
        let bestY = Number.POSITIVE_INFINITY;
        for (const anchor of this.wall.wallAnchors) {
            if (occupied.has(anchor.index) || this.motor.isBlacklisted(anchor.index)) continue;
            if (this.releasedThisCycle.has(anchor.index)) continue;
            // Hand rule: at least minAboveY (a height floor). Above = smaller y.
            if (anchor.posY > minAboveY) continue;
            const dx = anchor.posX - origin.posX;
            const dy = anchor.posY - origin.posY;
            if (dx * dx + dy * dy > reach * reach) continue;
            if (anchor.posY < bestY) {
                best = anchor;
                bestY = anchor.posY;
            }
        }
        if (best !== undefined) {
            this.log(`hand target: ${best.index} (y=${best.posY.toFixed(0)}, relaxed=${relaxed})`);
        }
        return best;
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /**
     * True when the anchor can no longer be touched even with the limb fully
     * extended plus latch radius: the body has drifted and the target must
     * be re-picked rather than chased forever (verified deadlock-maker).
     */
    private isTargetOutOfRange(kind: LimbKind, target: WallAnchor): boolean {
        const origin = this.origin(kind);
        const maxReach = this.boneSum(kind) * REACH_FRACTION_RELAXED + 6;
        const dx = target.posX - origin.posX;
        const dy = target.posY - origin.posY;
        return dx * dx + dy * dy > maxReach * maxReach;
    }

    private findPlantedSide(kind: LimbKind): number {
        for (let side = 0; side < 2; side++) {
            if (this.skeleton.isGrabbing(kind, side)) {
                return side;
            }
        }
        return -1;
    }

    private origin(kind: LimbKind) {
        const index = kind === "hand" ? this.skeleton.neckParticleIndex : this.skeleton.buttocksParticleIndex;
        const p = this.phys.particleStates[index];
        if (p === undefined) {
            throw new Error(`Missing ${kind} origin particle`);
        }
        return p;
    }

    private neck() {
        const p = this.phys.particleStates[this.skeleton.neckParticleIndex];
        if (p === undefined) {
            throw new Error("Missing neck particle");
        }
        return p;
    }

    private boneSum(kind: LimbKind): number {
        return kind === "hand"
            ? this.skeleton.armlength
            : this.skeleton.leglength;
    }

    /** Player let-go: stop deciding (the skeleton releases all grabs). */
    public stopClimbing(): void {
        this.phase = "Idle";
        this.target = undefined;
        this.phaseElapsed = 0;
        this.ladderStep = 0;
        this.substitutionCount = 0;
        this.pendingSubstitution = undefined;
        this.motor.cancelMove();
    }

    /** Debug draw hook (behind the D key). Currently a no-op; the motor's
     *  targets and the CoM proxy can be visualized here later (§10). */
    public draw(_ctx: CanvasRenderingContext2D, _cam: import("./Camera.ts").Camera): void { }

    private log(message: string): void {
        console.log(`[climber] ${message}`);
    }
}

export type { MotorStatus };
