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

export type ClimberPhase = "LegReach" | "Push" | "HandReach" | "PullUp" | "Idle";

const PHASE_TIMEOUT = 3.0;
/** Minimum Push duration so the body gains height before HandReach. */
const MIN_PUSH = 0.5;
/** Preferred maximum foot leap: the foot rises at most this many px above
 *  its origin (about 2-3 anchors at the wall's anchor spacing). Among valid
 *  candidates the pick then prefers the highest anchor BELOW this cap; only
 *  when nothing fits under the cap does it fall back to the highest overall
 *  (still within reach and the gap rule). A full-band leap looks strangled
 *  and makes the push phase far harder than it needs to be. */
const FOOT_LEAP_MAX_RISE = 15;

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
    /** Minimum remaining time for a substitution pull-up (planted-arm haul). */
    private pullHoldUntil = 0;
    /** y of the hand anchor released this cycle (for Q14 relaxation). */
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

        // After a let-go (or a fall) nothing is latched: hold Idle until the
        // climber has both a planted foot and a planted hand to work from.
        // (Querying grab constraints for out-of-range sides would throw.)
        if (this.plantedCount("foot") === 0 || this.plantedCount("hand") === 0) {
            this.phase = "Idle";
            return;
        }

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
            case "PullUp":
                this.updatePullUp();
                break;
            case "HandReach":
                this.updateHandReach(deltaTime);
                break;
            default:
                break;
        }

        if (this.phaseElapsed > PHASE_TIMEOUT) {
            // A phase that timed out while a move was in flight means the
            // move's target was never reached: blacklist it so the next pick
            // chooses a DIFFERENT anchor. Without this the pick re-chooses
            // the same unreachable target every cycle (the phase timeout
            // preempts the move timeout, so the normal timeout branch never
            // sees it) and the climb loops on one anchor until Idle
            // (verified on seed 404, anchor a80).
            const move = this.motor.activeMove;
            if (move !== undefined) {
                this.log(`phase ${this.phase} timed out with move a${move.anchor.index} in flight -> blacklist`);
                this.motor.blacklistAnchor(move.anchor.index);
                this.motor.cancelMove();
            }
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

    private plantedCount(kind: LimbKind): number {
        let count = 0;
        for (let side = 0; side < 2; side++) {
            if (this.skeleton.isGrabbing(kind, side)) count++;
        }
        return count;
    }

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
        // Generous radius: a freed limb can swing far in a few substeps, and
        // re-latching it hauls the body back toward the wall (the leg chain
        // constrains the origin to within a limb's length of the anchor).
        // Without this, a swung-away foot stalls the phase until Idle.
        this.regrabFreeLimb("foot", side, this.footReleasedAnchor, 100);
    }

    private regrabFreeHand(side: number): void {
        this.regrabFreeLimb("hand", side, this.handReleasedAnchor, 100);
    }

    /** y of the anchor a free hand was last latched to (for the height floor). */
    private handReleasedAnchorY(side: number): number | undefined {
        const index = this.handReleasedAnchor[side];
        if (index === undefined || index < 0) return undefined;
        return this.wall.wallAnchors[index]?.posY;
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
            // Latch-time gap validation: the hands may have moved since the
            // target was picked (a hand re-latching lower shrinks the gap
            // band). If the latched anchor now violates feet-below-hands,
            // undo the latch and re-pick - the invariant (§9.2) outranks the
            // move.
            const latched = this.wall.wallAnchors[this.target.index];
            const lowestHandY = this.lowestHandAnchorY();
            if (latched !== undefined && lowestHandY !== Number.POSITIVE_INFINITY && latched.posY < lowestHandY + FOOT_TO_LOWEST_HAND_GAP) {
                this.log(`foot latch a${this.target.index} violates the gap rule (lowest hand y=${lowestHandY.toFixed(0)}) -> undo, re-pick`);
                this.footReleasedAnchor[freeSide] = this.target.index;
                this.releasedThisCycle.add(this.target.index);
                this.motor.releaseFoot(freeSide);
                this.target = undefined;
                return;
            }
            this.grabCount++;
            this.releasedThisCycle.clear();
            this.pendingSubstitution = undefined;
            this.ladderStep = 0;
            this.substitutionCount = 0;
            // The foot is holding a fresh anchor: clear the stale released
            // reference so a later regrab/floor uses the CURRENT hold.
            this.footReleasedAnchor[freeSide] = -1;
            // NOTE: the old drive leg does NOT release here - it releases at
            // the start of Push (see updatePush), so that during HandReach
            // only the reaching hand is ever free (≤1-free invariant, §9.2).
            this.driveLegSide = freeSide;
            this.log(`LegReach: foot latched anchor ${this.target.index}`);
            this.beginPhase("Push");
        } else if (status === "timeout" || status === "unreachable") {
            // The target was unreachable from the current body pose (the
            // body sags when the foot releases). Blacklist it so the next
            // pick chooses a DIFFERENT anchor instead of looping on the
            // same one until the stall ladder Idles.
            this.log(`LegReach: foot target a${this.target.index} ${status} -> blacklist`);
            this.motor.blacklistAnchor(this.target.index);
            // The foot may be free (the move released it): re-latch to the
            // old hold so the ≤1-free invariant holds while re-picking.
            this.regrabFreeFoot(freeSide);
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

    /**
     * Substitution for a failed hand pick when the legs are crumpled: both
     * planted arms flex (motor pullHand) to haul the body up toward the
     * hands. This shortens neck-to-anchor distances so the re-pick after the
     * hold finds candidates a leg push could never reach.
     */
    private updatePullUp(): void {
        for (let side = 0; side < 2; side++) {
            if (this.skeleton.isGrabbing("hand", side)) {
                const anchor = this.wall.wallAnchors[this.skeleton.grabConstraint("hand", side).wallAnchorIndex];
                if (anchor !== undefined) {
                    this.motor.pullHand(side, anchor);
                }
            }
        }
        if (this.phaseElapsed >= this.pullHoldUntil) {
            this.log("PullUp: hauled toward the hands");
            this.pullHoldUntil = 0;
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
            // Height floor for the hand target: above the neck (§7.1) AND
            // above the hand's own current anchor when it is planted - the
            // hand must make upward progress, never re-latch below itself
            // (the neck hangs below the folded arms, so "above the neck"
            // alone can pull a hand DOWN to its own level).
            // Own-anchor floor: the hand must not re-latch below itself. When
            // the reaching hand is free, its last-held anchor (tracked at
            // release) is the reference - otherwise a freed hand can latch
            // LOWER than its old hold and break the feet-below-hands gap.
            const ownAnchorY = this.skeleton.isGrabbing("hand", reachSide)
                ? this.wall.wallAnchors[this.skeleton.grabConstraint("hand", reachSide).wallAnchorIndex]?.posY
                : this.handReleasedAnchorY(reachSide);
            // The own-anchor floor is the upward-progress rule. The neck
            // floor is NOT an additional constraint: after pushes the neck
            // can rise ABOVE the hands (extended arms hang the body), and a
            // neck floor would then filter out every in-reach anchor - the
            // hands could never move and the phase deadlocked (verified on
            // seed 101). Upward progress is guaranteed by the own-anchor
            // floor; when the hand is free (first reach of a cycle), the
            // partner hand's anchor y-5 is the progress reference.
            const partnerSide = 1 - reachSide;
            const partnerY = this.skeleton.isGrabbing("hand", partnerSide)
                ? this.wall.wallAnchors[this.skeleton.grabConstraint("hand", partnerSide).wallAnchorIndex]?.posY
                : undefined;
            const floorY = ownAnchorY ?? (partnerY !== undefined ? partnerY : undefined);
            const minAboveY = floorY !== undefined ? floorY - 5 : this.neck().posY - HAND_MIN_ABOVE_NECK;
            this.target = this.pickHandTarget(reachSide, minAboveY, relaxed);
            if (this.target === undefined && !relaxed) {
                // Ladder step 2 (§8): a failed pick at normal reach relaxes
                // the reach BEFORE substituting - the body may just be
                // compressed and the next hold is a stretch away, which a
                // substitution push cannot fix (it has nothing to reach for).
                this.ladderStep = 2;
                this.log("hand pick: no candidates -> ladder step 2 (relaxed reach)");
                this.target = this.pickHandTarget(reachSide, minAboveY, true);
            }
            if (this.target === undefined) {
                this.enterSubstitution("hand");
                return;
            }
            // Release the lowest hand only after a target exists.
            if (this.skeleton.isGrabbing("hand", lowestSide)) {
                const anchorIndex = this.skeleton.grabConstraint("hand", lowestSide).wallAnchorIndex;
                this.handReleasedAnchor[lowestSide] = anchorIndex;
                this.releasedThisCycle.add(anchorIndex);
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
            // The hand is holding a fresh anchor: clear the stale released
            // reference so a later regrab/floor uses the CURRENT hold.
            this.handReleasedAnchor[reachSide] = -1;
            this.supportArmSide = reachSide;
            this.log(`HandReach: hand latched anchor ${this.target.index}`);
            this.beginPhase("LegReach");
        } else if (status === "unreachable") {
            // The anchor is valid (the pick just chose it) but the body
            // swung/sagged out of envelope. Blacklisting here causes a
            // boundary-flapping loop (the neck oscillates around the reach
            // edge); instead HAUL the body closer and keep the target.
            this.log(`HandReach: hand target a${this.target.index} unreachable -> PullUp, keep target`);
            this.regrabFreeHand(reachSide);
            this.pullHoldUntil = this.phaseElapsed + 1.0;
            this.beginPhase("PullUp");
        } else if (status === "timeout") {
            this.log(`HandReach: hand target a${this.target.index} timed out -> blacklist`);
            this.motor.blacklistAnchor(this.target.index);
            this.regrabFreeHand(reachSide);
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
        if (failedMove === "hand") {
            // The body hangs from the planted arms; a leg push cannot raise
            // it further when the arms are near-straight (the arms tether the
            // body - verified on seed 505 where a push held the body frozen
            // for 5s). A PULL on the planted arms hauls the body up toward
            // the hands, closing the gap to the next hold cluster; the drive
            // leg assists by extending at the same time. The hold scales with
            // the substitution streak: a single 1.5s haul often leaves the
            // target a fraction of a px out of reach, and the pick re-runs
            // before the body is high enough - repeated failures must haul
            // longer (verified on seed 101, a80 at 28px vs reach 27.6).
            this.pullHoldUntil = this.phaseElapsed + 1.5 + 0.75 * (this.substitutionCount - 1);
            this.beginPhase("PullUp");
        } else {
            // For a failed foot pick, the arm reach matters, not the haul:
            // a leg push raises the body toward new foot anchors.
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
        // Lowest on the wall = LARGEST y: seed with the smallest possible y
        // so any real anchor y beats it (a POSITIVE_INFINITY seed here would
        // make the comparison never true and always return side 0).
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
        // The leap band is measured from the BUTTOCKS (the pick's IK origin):
        // the foot can physically reach anything within the butt's reach
        // envelope, so a band around the butt admits every anchor the leg
        // could actually take. A band around the foot's own anchor is too
        // narrow when the body is extended - it excluded anchors 30-40px
        // above the foot that the leg reaches easily, forcing downward
        // repositioning steps (verified on seed 101: feet stuck at y=360
        // while a53/a54 rose 5-10px away). Preference is the CLOSEST
        // candidate in the band - a small step, not a max-reach fling.
        const leapRefY = origin.posY;
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
        let bestDist = Number.POSITIVE_INFINITY;
        // Closest candidate that rises at most FOOT_LEAP_MAX_RISE above the
        // reaching foot's own anchor (2-3 anchor step).
        let cappedBest: WallAnchor | undefined;
        let cappedBestDist = Number.POSITIVE_INFINITY;
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
            // Rule 3 (CoM) is checked by the invariant contract after the move.
            // Preference with a leap cap measured from the foot's own anchor:
            // among valid candidates prefer the CLOSEST anchor that still
            // rises (smaller y = higher) - a small step up, not a max-reach
            // fling. The old "highest within the cap" preference maxed out
            // the cap on every step, which read as a huge leap even though
            // the cap held. If nothing rises within the cap, take the
            // SHORTEST leap in-band (not the highest anchor): the old
            // fallback flung the foot to the highest in-reach anchor - a
            // 47px leap with 11 closer alternatives available (verified on
            // seed 101, a61 -> a73).
            if (cappedBest === undefined) {
                const dist = Math.sqrt(distSqr);
                if (best === undefined || dist < bestDist) {
                    best = anchor;
                    bestDist = dist;
                }
            }
            if (anchor.posY >= leapRefY - FOOT_LEAP_MAX_RISE && anchor.posY <= leapRefY + FOOT_LEAP_MAX_RISE) {
                const dist = Math.sqrt(distSqr);
                if (cappedBest === undefined || dist < cappedBestDist) {
                    cappedBest = anchor;
                    cappedBestDist = dist;
                }
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
        // NOTE: no stretch factor here. The IK (bentJointPosition) clamps the
        // target distance to proximal+distal-0.5 - it commands REST lengths,
        // not the load-stretched ones. A stretched envelope made the pick
        // accept targets the arm could never reach (verified on seed 101:
        // a76 at 27.7 vs true IK reach 25.5 - the hand froze 8px short).
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
        // Generous stale threshold: a long reach is exactly the move that
        // swings the body away from the wall, and the swing makes the target
        // measure out-of-range even though the reaching limb can still travel
        // to it (the extended limb hauls the body back). Only declare stale
        // when the target is beyond the relaxed reach PLUS the limb's own
        // length - i.e. genuinely untouchable.
        const maxReach = this.boneSum(kind) * REACH_FRACTION_RELAXED + 6 + this.boneSum(kind);
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
