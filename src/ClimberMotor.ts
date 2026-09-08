/**
 * ClimberMotor - the execution layer (concept/climbing-plan.md §6).
 *
 * Owns ALL joint angles, IK, angle speeds and per-move timing. Callers
 * (the Climber today, player input later) only name limbs and anchors and
 * receive a MotorStatus. All motion is angular-only (ADR-0001): this file
 * writes zero velocities; every body position is reached by driving joint
 * target angles through the angular constraint solver.
 */
import type { SpringPhysics } from "./Physics.ts";
import type { Wall, WallAnchor } from "./Wall.ts";
import type { Skeleton } from "./Skeleton.ts";
import { defined } from "./assert.ts";

export type MotorStatus =
    | "in-progress"
    | "latched"
    | "unreachable"
    | "timeout";

export type LimbKind = "hand" | "foot";

// --- constants (concept/climbing-plan.md §7.1) ---
export const REACH_FRACTION = 0.9;
export const REACH_FRACTION_RELAXED = 1.0;
/** Shared reach-envelope margin: BOTH the target pick (Climber) and the
 *  motor's envelope gate add this to boneSum*fraction. They MUST agree -
 *  the gate was boneSum*fraction + LATCH_RADIUS, so shrinking the latch
 *  snap (8 -> 5) silently tightened the gate below the pick's envelope
 *  and the climber looped forever: pick chooses a target at d=25.5, gate
 *  rejects it at 25.0, PullUp, re-pick, same target (measured on seed
 *  101). The snap distance is a separate concern (LATCH_RADIUS). */
export const REACH_MARGIN = 6;
/** Latch distance: the IK converges well, so the snap can be tight -
 *  latching at 8px visibly teleported the limb onto the hold well before
 *  it arrived (user-observed). 5px is the tightest value the soft-body
 *  jitter reliably enters (3px starves latches: seed 101 dropped to 3
 *  latches/12s and 36px/40s). ONLY used for the latch check since the
 *  envelope gate decoupling above. */
export const LATCH_RADIUS = 5;
export const FOOT_TO_LOWEST_HAND_GAP = 15;
export const HAND_MIN_ABOVE_NECK = 5;
export const COM_MAX_WALL_DISTANCE = 35;
export const MOVE_TIMEOUT = 3.0;

// --- pose angles (validated in the previous implementation) ---
const STRAIGHT_HIP_ANGLE = Math.PI;
const STRAIGHT_KNEE_ANGLE = Math.PI * 0.95;
const COIL_KNEE_ANGLE = Math.PI * 0.5;
const OVERHEAD_SHOULDER_ANGLE = Math.PI * 0.92;
// Elbow hinge: the angle is measured neck->elbow vs elbow->hand, so 180deg
// (straight) is the center. The skeleton's natural bend side is angle > 180
// (initial pose ~190deg), but reaching across the body (e.g. up-LEFT when the
// elbow hangs on the right) needs the elbow on the other side of the
// neck->target line (~144deg) - the old one-sided clamp [1.02pi, 1.85pi]
// forbade that and pinned the elbow at the clamp floor while the hand drifted
// AWAY from the target (verified on seed 404, anchor a165). The window is
// asymmetric around straight: generous on the natural side, and wide enough
// on the other side to cover cross-body reaches, but NOT so wide that the
// elbow can fold up over the shoulder (angles near 0 = elbow pointing back
// over the neck, verified to break the hang on seed 202).
const STRAIGHT_ELBOW_ANGLE = Math.PI;
/** Elbow window: SYMMETRIC around straight (180deg), covering BOTH bend
 *  sides in one arc. Measured requirement on seed 101 a50: d(neck->anchor)
 *  9.2px with 10px bones needs an interior elbow angle of 54.8deg =
 *  125deg fold-from-straight; the old F=117 window pinned the elbow and
 *  the wrist hovered 5.3px short forever. F=140 (human elbows flex to
 *  ~40deg interior = 140 fold) admits it with margin.
 *  Why symmetric matters: the window is applied as a LINEAR clamp on a
 *  wrapping angle. An asymmetric window like [63,333] forbids the arc
 *  (333..63) through 0, which contains legitimate OTHER-side folds - the
 *  elbow then gets stuck on the wrong bend side (measured: desired 45,
 *  current 333, shortestAngleDelta points forward through 360 but the
 *  clamp pins 333). */
const ELBOW_MIN_ANGLE = Math.PI * (40 / 180);
const ELBOW_MAX_ANGLE = Math.PI * (320 / 180);
/** Knee fold floor: the measured failure mode is the IK CLAMPED at this
 *  value while the target needs a tighter fold - the move then times out
 *  with the foot frozen short (verified on seed 101, move to a126: anchor
 *  15.8px from the buttocks needs an interior knee angle of 56deg, but
 *  KNEE_MIN=63deg forbids it; the foot sat 18.5px short for the whole
 *  3s timeout). A deep human squat reaches ~40-45deg, so the floor is
 *  40deg. It remains a fold guard (the singularity at 0deg is still
 *  excluded); the physics solver's hard knee floor stays at 0.05pi for
 *  load compression. */
export const KNEE_MIN_ANGLE = Math.PI * (40 / 180);
const KNEE_MAX_ANGLE = Math.PI * 0.95;
/** Push goal: knee fully straight (pushWithLeg latches at 0.12 of this). */
export const FULLY_STRAIGHT_KNEE_ANGLE = Math.PI;
/** Minimum origin-to-foot distance the knee fold allows: with equal bones b
 *  and knee angle >= KNEE_MIN (angle between knee->origin and knee->end
 *  directions), the origin-end distance is 2b*sin(KNEE_MIN/2). Anchors closer
 *  than this to the limb origin can never be latched. */
export const LEG_MIN_FOLD_DISTANCE =
    2 * 12 * Math.sin(KNEE_MIN_ANGLE / 2);
const STRAIGHT_SPINE_ANGLE = Math.PI;

// --- anatomical joint limits (enforced by the physics solver, not just the
//  IK targets - soft target tracking alone lets load shove joints past
//  straight into inversion, measured on seed 101: knees reached -169deg
//  signed bend = ~91deg backwards, hips rotated the full circle) ---
/** Hip angle window. Convention (measured): hip angle = pi with the thigh
 *  hanging straight down, < pi = forward swing (toward the wall), > pi =
 *  backward swing, 0 = thigh pointing straight up-forward (impossible).
 *  Only the MIN limit is anatomical here: hip flexion past ~45deg from
 *  vertical up-forward is the shoulder-like rotation the user sees. The
 *  MAX side stays open (2pi = never violated): thigh-up-behind is a
 *  legitimate high-step pose, and a ceiling near 2pi makes the positional
 *  projection fire constantly on legal poses - with the foot pinned it
 *  then rotates the pelvis and destabilizes the body (measured: seed 101
 *  dropped from 276px to 55px neck rise). */
const HIP_MIN_ANGLE = Math.PI * 0.25;
const HIP_MAX_ANGLE = Math.PI * 2;

// --- angular solver coupling (validated) ---
const PLANTED_TIGHTNESS = 10;
const PLANTED_IK_SCALE = 0.85;
/** Pull-up haul: the planted-arm IK target is pulled in by this many px
 *  (subtractive, unlike the multiplicative PLANTED_IK_SCALE). */
const PULL_AMOUNT = 5;
/** A hand reach in flight longer than this gets the planted-arm haul assist. */
const REACH_ASSIST_AFTER = 1.5;
const ANGLE_SPEED = 10;
const REACH_ANGLE_SPEED = 14;

interface ReachMove {
    kind: LimbKind;
    side: number;
    anchor: WallAnchor;
    elapsed: number;
}

/**
 * Geometric helpers - ported unchanged from the validated previous
 * implementation (they were TDD'd there and behave identically).
 */
function wrapAngle(angle: number): number {
    while (angle > Math.PI * 2) {
        angle -= Math.PI * 2;
    }
    while (angle < 0) {
        angle += Math.PI * 2;
    }
    return angle;
}

export function shortestAngleDelta(from: number, to: number): number {
    let delta = to - from;
    while (delta > Math.PI) {
        delta -= Math.PI * 2;
    }
    while (delta < -Math.PI) {
        delta += Math.PI * 2;
    }
    return delta;
}

function clampRange(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function moveJointAngle(
    current: number,
    target: number,
    deltaTime: number,
    minAngle?: number,
    maxAngle?: number,
    speed = ANGLE_SPEED,
): number {
    let delta = shortestAngleDelta(current, target);
    if (minAngle !== undefined && maxAngle !== undefined) {
        // Window-aware routing (measured on seed 101 a50): the window is an
        // ARC [min,max] through 180; the forbidden arc (max..min) through 0
        // separates the two bend sides. When the SHORT path from current to
        // target passes through the forbidden arc, the linear clamp would
        // pin the joint at the window edge forever (elbow stuck at 320
        // while the target folded to 67 on the other side). In that case
        // route the LONG way through 180.
        //
        // Precise crossing test: current normalized to [0,2pi); the short
        // path crosses the forbidden arc iff it passes through the 0/2pi
        // boundary (the forbidden arc lives around 0).
        const cur = wrapAngle(current);
        const unwrappedEnd = cur + delta;
        const crossesForbidden =
            (delta > 0 && unwrappedEnd >= Math.PI * 2) ||
            (delta < 0 && unwrappedEnd <= 0);
        if (crossesForbidden) {
            delta = delta > 0 ? delta - Math.PI * 2 : delta + Math.PI * 2;
        }
        let next = current + delta * Math.min(1, deltaTime * speed);
        next = wrapAngle(next);
        // Clamp INSIDE the window: after rerouting, the motion approaches
        // the target through 180 and never leaves the window, so the clamp
        // only acts as a final safety.
        next = clampRange(next, minAngle, maxAngle);
        return next;
    }
    let next = current + delta * Math.min(1, deltaTime * speed);
    next = wrapAngle(next);
    return next;
}

function distanceSqr(x0: number, y0: number, x1: number, y1: number): number {
    const dx = x1 - x0;
    const dy = y1 - y0;
    return dx * dx + dy * dy;
}

function jointAngle(originX: number, originY: number, jointX: number, jointY: number, endX: number, endY: number): number {
    return wrapAngle(Math.atan2(originY - jointY, originX - jointX) - Math.atan2(endY - jointY, endX - jointX));
}

export function currentConstraintAngle(skeleton: Skeleton, constraintIndex: number): number {
    const constraint = defined(skeleton.phys.angularConstraints[constraintIndex], "Missing angular constraint");
    const s0 = defined(skeleton.phys.particleStates[constraint.particleIndex0], "Missing particle 0");
    const s1 = defined(skeleton.phys.particleStates[constraint.particleIndex1], "Missing particle 1");
    const s2 = defined(skeleton.phys.particleStates[constraint.particleIndex2], "Missing particle 2");
    return wrapAngle(
        Math.atan2(s0.posY - s1.posY, s0.posX - s1.posX) -
        Math.atan2(s2.posY - s1.posY, s2.posX - s1.posX),
    );
}

/**
 * Two-bone IK: the law-of-cosines joint position. Bend-side selection uses
 * continuity (keep the joint nearest its current position) with a
 * preferred-angle fallback, and an outward-knee override for feet (validated
 * rules from the previous implementation).
 */
function bentJointPosition(
    originX: number,
    originY: number,
    targetX: number,
    targetY: number,
    proximal: number,
    distal: number,
    preferredJointAngle: number,
    preferOutwardKnee: boolean,
    currentJointX?: number,
    currentJointY?: number,
): { x: number; y: number } {
    let reachX = targetX - originX;
    let reachY = targetY - originY;
    let reachDistance = Math.sqrt(reachX * reachX + reachY * reachY);
    if (reachDistance < 0.0001) {
        reachX = 1;
        reachY = 0;
        reachDistance = 1;
    }

    const maxReach = Math.max(0.5, proximal + distal - 0.5);
    const minReach = Math.abs(proximal - distal) + 0.5;
    const clampedDistance = Math.min(maxReach, Math.max(minReach, reachDistance));
    const dirX = reachX / reachDistance;
    const dirY = reachY / reachDistance;
    const cosine = clampRange(
        (proximal * proximal + clampedDistance * clampedDistance - distal * distal) / (2 * proximal * clampedDistance),
        -1,
        1,
    );
    const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
    const alongX = dirX * cosine;
    const alongY = dirY * cosine;
    const perpX = -dirY * sine;
    const perpY = dirX * sine;

    const jointA = { x: originX + proximal * (alongX + perpX), y: originY + proximal * (alongY + perpY) };
    const jointB = { x: originX + proximal * (alongX - perpX), y: originY + proximal * (alongY - perpY) };

    if (preferOutwardKnee) {
        return jointA.x <= jointB.x ? jointA : jointB;
    }
    if (currentJointX !== undefined && currentJointY !== undefined) {
        const distA = distanceSqr(currentJointX, currentJointY, jointA.x, jointA.y);
        const distB = distanceSqr(currentJointX, currentJointY, jointB.x, jointB.y);
        if (Math.abs(distA - distB) > 1.0) {
            return distA < distB ? jointA : jointB;
        }
    }
    const angleA = jointAngle(originX, originY, jointA.x, jointA.y, targetX, targetY);
    const angleB = jointAngle(originX, originY, jointB.x, jointB.y, targetX, targetY);
    const errorA = Math.abs(shortestAngleDelta(angleA, preferredJointAngle));
    const errorB = Math.abs(shortestAngleDelta(angleB, preferredJointAngle));
    return errorA <= errorB ? jointA : jointB;
}

export class ClimberMotor {
    public readonly phys: SpringPhysics;
    public readonly wall: Wall;
    public readonly skeleton: Skeleton;

    /** The one move currently being animated, if any. */
    private currentMove: ReachMove | undefined;
    /** Anti-flicker: anchor -> sim time of release. */
    private recentlyReleased = new Map<number, number>();
    /** Sim time accumulated by update(). */
    public clock = 0;

    public constructor(phys: SpringPhysics, wall: Wall, skeleton: Skeleton) {
        this.phys = phys;
        this.wall = wall;
        this.skeleton = skeleton;
        this.setLimbTightness("hand");
        this.setLimbTightness("foot");
        this.applyJointLimits();
    }

    /** Install hard anatomical limits on hips and knees in the physics
     *  solver. Knees: [KNEE_MIN, pi] - bend side below straight, never
     *  hyperextended. Hips: [HIP_MIN, HIP_MAX] - the thigh swings forward
     *  but never rotates around like a shoulder. */
    private applyJointLimits(): void {
        for (let side = 0; side < 2; side++) {
            const hip = defined(
                this.phys.angularConstraints[defined(this.skeleton.hipJointACIndex[side], "Missing hip index")],
                "Missing hip constraint",
            );
            const knee = defined(
                this.phys.angularConstraints[defined(this.skeleton.kneeJointACIndex[side], "Missing knee index")],
                "Missing knee constraint",
            );
            hip.minAngle = HIP_MIN_ANGLE;
            hip.maxAngle = HIP_MAX_ANGLE;
            // The knee's anatomical constraint is one-directional bend: the
            // angle (in [0,2pi)) must stay in (0, pi]. ANY angle past pi is
            // a visible backwards bend - the earlier 1.17pi tolerance still
            // read as knees bending both ways (user-verified in browser).
            // Angles below the IK's KNEE_MIN are deep-but-natural folds (a
            // loaded knee legitimately compresses past 63deg - a hard floor
            // there fights the squat and stalls the climb, measured on seed
            // 303), so the floor only guards the fold singularity at 0.
            knee.minAngle = Math.PI * 0.05;
            knee.maxAngle = Math.PI;
        }
    }

    // ------------------------------------------------------------------
    // Move API (§6.1)
    // ------------------------------------------------------------------

    public reachFoot(side: number, anchor: WallAnchor): MotorStatus {
        return this.beginOrContinueReach("foot", side, anchor, false);
    }

    public reachHand(side: number, anchor: WallAnchor): MotorStatus {
        // NOTE: the motor does NOT re-check the hand height floor here. The
        // floor is a DECISION-layer rule (Climber.pickHandTarget): the
        // own-anchor/partner-anchor floor there is posture-dependent and the
        // motor's static neck floor disagreed with it - the pick accepted a
        // target the motor then rejected as unreachable, and the phase
        // timed out in a loop (verified on seed 505). The decision layer
        // owns all filtering; the motor only checks geometric reachability.
        return this.beginOrContinueReach("hand", side, anchor, false);
    }

    public pullHand(side: number, anchor: WallAnchor): MotorStatus {
        // Planted arm flexes to haul: the IK target is the anchor pulled IN
        // by PULL_AMOUNT pixels along the origin->anchor direction. This
        // deliberately BYPASSES the mantle posture override inside
        // aimPlantedLimb, and the shortening is SUBTRACTIVE rather than the
        // multiplicative PLANTED_IK_SCALE: when the arm hangs near-straight
        // (dist ~= bone sum), scaling by 0.85 still clamps to ~full
        // extension and the haul is a no-op (verified on seed 505).
        if (!this.skeleton.isGrabbing("hand", side)) {
            return "unreachable";
        }
        const origin = this.origin("hand");
        const { proximal, distal } = this.boneLengths("hand", side);
        const dx = anchor.posX - origin.posX;
        const dy = anchor.posY - origin.posY;
        const dist = Math.hypot(dx, dy) || 1;
        const maxReach = Math.max(0.5, proximal + distal - 0.5);
        const minReach = Math.abs(proximal - distal) + 0.5;
        const pullDist = Math.min(maxReach, Math.max(minReach, dist - PULL_AMOUNT));
        const virtualTarget: WallAnchor = {
            posX: origin.posX + (dx / dist) * pullDist,
            posY: origin.posY + (dy / dist) * pullDist,
            index: anchor.index,
        };
        this.aimArmToward(side, virtualTarget, dtOrDefault());
        return "in-progress";
    }

    public pushWithLeg(side: number): MotorStatus {
        if (!this.skeleton.isGrabbing("foot", side)) {
            return "unreachable";
        }
        this.pushingLegSide = side;
        const hip = defined(
            this.phys.angularConstraints[defined(this.skeleton.hipJointACIndex[side], "Missing hip index")],
            "Missing hip constraint",
        );
        const knee = defined(
            this.phys.angularConstraints[defined(this.skeleton.kneeJointACIndex[side], "Missing knee index")],
            "Missing knee constraint",
        );
        hip.targetAngle = moveJointAngle(hip.targetAngle, STRAIGHT_HIP_ANGLE, dtOrDefault(), HIP_MIN_ANGLE, HIP_MAX_ANGLE, REACH_ANGLE_SPEED);
        knee.targetAngle = moveJointAngle(knee.targetAngle, STRAIGHT_KNEE_ANGLE, dtOrDefault(), KNEE_MIN_ANGLE, Math.PI, REACH_ANGLE_SPEED);
        // Planted-arm adaptation (§6.4): every latched arm re-solves toward a
        // shortened virtual target so the elbow goes extension -> flex as the
        // body rises. The skeleton adapts to the push, never fights it.
        for (let armSide = 0; armSide < 2; armSide++) {
            if (!this.skeleton.isGrabbing("hand", armSide)) {
                continue;
            }
            const anchorIndex = this.skeleton.grabConstraint("hand", armSide).wallAnchorIndex;
            const anchor = this.wall.wallAnchors[anchorIndex];
            if (anchor !== undefined) {
                this.aimPlantedLimb("hand", armSide, anchor, PLANTED_IK_SCALE, dtOrDefault());
            }
        }
        // Extension goal met when the knee is within tolerance of straight.
        const kneeAngle = currentConstraintAngle(this.skeleton, defined(this.skeleton.kneeJointACIndex[side], "Missing knee index"));
        return Math.abs(shortestAngleDelta(kneeAngle, STRAIGHT_KNEE_ANGLE)) < 0.12 ? "latched" : "in-progress";
    }

    public releaseFoot(side: number): void {
        if (!this.skeleton.isGrabbing("foot", side)) {
            return;
        }
        const index = this.skeleton.grabConstraint("foot", side).wallAnchorIndex;
        this.skeleton.release("foot", side);
        this.recentlyReleased.set(index, this.clock);
        if (this.currentMove?.kind === "foot" && this.currentMove.side === side) {
            this.currentMove = undefined;
        }
    }

    public releaseHand(side: number): void {
        if (!this.skeleton.isGrabbing("hand", side)) {
            return;
        }
        const index = this.skeleton.grabConstraint("hand", side).wallAnchorIndex;
        this.skeleton.release("hand", side);
        this.recentlyReleased.set(index, this.clock);
        if (this.currentMove?.kind === "hand" && this.currentMove.side === side) {
            this.currentMove = undefined;
        }
    }

    /**
     * Blacklists an anchor for 3s (same window as release anti-flicker).
     * Used by the decision layer when a reach TIMES OUT: without this the
     * pick re-chooses the same unreachable target every cycle and the phase
     * loops forever (verified on seed 404, anchor a80).
     */
    public blacklistAnchor(anchorIndex: number): void {
        this.recentlyReleased.set(anchorIndex, this.clock);
    }

    // ------------------------------------------------------------------
    // Per-substep update
    // ------------------------------------------------------------------

    public update(deltaTime: number): void {
        this.clock += deltaTime;
        this.poseSpine(deltaTime);
        this.setLimbTightness("hand");
        this.setLimbTightness("foot");

        const move = this.currentMove;
        if (move === undefined) {
            // Idle pose: planted limbs hold shortened-target IK; free limbs coil.
            this.poseNonMovingLimbs(deltaTime);
            return;
        }
        move.elapsed += deltaTime;
        this.aimReachingLimb(move, deltaTime);
        this.poseNonMovingLimbs(deltaTime, move);
        // Planted-arm flex during a hand reach (user request): while the
        // free arm reaches, the LATCHED arm should be flexed - upper arm
        // close to the body, elbow at a small angle - so the body hangs
        // close to the wall and the reach has more range. The passive
        // poseNonMovingLimbs path (scale 0.85) barely bends the arm on far
        // anchors (0.85 * d(24) = 20.4 ~ the 19.5 full-extension limit,
        // measured: planted elbow >160deg in 95% of reach frames), so the
        // body hangs at arm's length and 1-in-5 reaches fail. pullHand
        // actively pulls the anchor IN along the origin direction (the
        // same haul the reach-assist uses), folding the arm properly.
        // This replaces the passive pose for the planted arm during the
        // whole reach, not just after REACH_ASSIST_AFTER.
        if (move.kind === "hand") {
            const planted = 1 - move.side;
            if (this.skeleton.isGrabbing("hand", planted)) {
                const anchor = this.wall.wallAnchors[this.skeleton.grabConstraint("hand", planted).wallAnchorIndex];
                if (anchor !== undefined) {
                    this.pullHand(planted, anchor);
                }
            }
        }
    }

    /** The move the motor is currently animating (read-only view). */
    public get activeMove(): Readonly<ReachMove> | undefined {
        return this.currentMove;
    }

    /** True while a reach move is in flight (a caller-issued command). */
    public hasMove(): boolean {
        return this.currentMove !== undefined;
    }

    /** The leg currently driven by pushWithLeg (excluded from idle posing). */
    private pushingLegSide = -1;

    public cancelMove(): void {
        this.currentMove = undefined;
    }

    public isBlacklisted(anchorIndex: number): boolean {
        const releasedAt = this.recentlyReleased.get(anchorIndex);
        if (releasedAt === undefined) {
            return false;
        }
        // 1.5s window: long enough to break a pick loop, short enough that
        // an anchor blacklisted because of a transient body sag becomes
        // available again once the posture recovers. The old 3s window
        // outlived the sag and starved the pick of every candidate
        // (verified on seed 303: a65/a66 blacklisted left NO candidates).
        if (this.clock - releasedAt >= 1.5) {
            this.recentlyReleased.delete(anchorIndex);
            return false;
        }
        return true;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private beginOrContinueReach(kind: LimbKind, side: number, anchor: WallAnchor, relaxed: boolean): MotorStatus {
        void relaxed;
        const origin = this.origin(kind);
        const { proximal, distal } = this.boneLengths(kind, side);
        // NOTE: rest lengths, no stretch factor. The IK (bentJointPosition)
        // clamps the target distance to proximal+distal-0.5 - it commands
        // REST lengths; the load-stretched constraint length is not
        // achievable by command. A stretched envelope accepted targets the
        // arm could never reach (verified on seed 101: a76 at 27.7 vs true
        // IK reach 25.5 - the hand froze 8px short for the whole timeout).
        const reach = (proximal + distal) * REACH_FRACTION_RELAXED + REACH_MARGIN;
        // MIN reach: the knee fold floor keeps the end particle at least
        // MIN_FOLD px from the origin (2*minBone*sin(KNEE_MIN/2)). An anchor
        // CLOSER than that is unreachable by pure geometry - no pose of the
        // leg can bring the ankle to it (measured on seed 101, a45: anchor
        // 9.1px from the butt vs 8.2px fold floor; the IK converged to its
        // commanded pose exactly and the ankle still parked 9.3px away -
        // the gate only ever checked MAX reach, so the move timed out).
        // NOTE: measured from the limb's CURRENT end particle, not the
        // origin: the butt moves after the pick, so the honest test is
        // "can the end particle get closer to the anchor than half the
        // fold floor" - a loose static bound just restores the old bug.
        const minBone = Math.min(proximal, distal);
        const minFold = 2 * minBone * Math.sin(KNEE_MIN_ANGLE / 2);
        // Envelope gate: only for STARTING a move. Once a move to this anchor
        // is in flight, the reaching limb itself displaces the body (the
        // swing carries the origin out past the envelope transiently), and
        // re-checking every call killed healthy moves mid-flight (verified
        // on seed 101: pick at d=24.8, killed at d=29.1 while still swinging
        // toward the anchor). The continuous check below (with its grace
        // period) handles genuinely stale targets.
        const moveInFlightToThisAnchor =
            this.currentMove !== undefined &&
            this.currentMove.kind === kind &&
            this.currentMove.side === side &&
            this.currentMove.anchor.index === anchor.index;
        if (
            !moveInFlightToThisAnchor &&
            (distanceSqr(origin.posX, origin.posY, anchor.posX, anchor.posY) > reach * reach ||
                distanceSqr(origin.posX, origin.posY, anchor.posX, anchor.posY) < minFold * minFold * 0.25)
        ) {
            if (import.meta.env?.DEV) {
                console.log(`[motor] ${kind}${side} initial unreachable: a${anchor.index} d=${Math.hypot(origin.posX - anchor.posX, origin.posY - anchor.posY).toFixed(1)} reach=${reach.toFixed(1)} minFold=${minFold.toFixed(1)}`);
            }
            return "unreachable";
        }
        if (this.currentMove === undefined) {
            if (this.skeleton.isGrabbing(kind, side)) {
                this.release(kind, side);
            }
            this.currentMove = { kind, side, anchor, elapsed: 0 };
        } else if (
            this.currentMove.kind !== kind ||
            this.currentMove.side !== side ||
            this.currentMove.anchor.index !== anchor.index
        ) {
            // Retargeting: replace the move.
            this.currentMove = { kind, side, anchor, elapsed: this.currentMove.elapsed };
        }
        const move = this.currentMove;
        // Latch check.
        const limb = this.limb(kind, side);
        if (distanceSqr(limb.posX, limb.posY, anchor.posX, anchor.posY) <= LATCH_RADIUS * LATCH_RADIUS) {
            this.skeleton.grab(kind, side, anchor);
            this.currentMove = undefined;
            return "latched";
        }
        // Continuous FOLD-CIRCLE check (for legs): if the body sags so the
        // anchor ends up inside the knee fold circle, no pose can ever
        // reach it - this is NOT the transient swing overshoot that killed
        // the old continuous max-reach check (the swing moves the origin
        // OUTWARD; sag moves it INWARD past the fold floor, which is a
        // permanent geometric impossibility, measured on seed 101 a45:
        // butt drifted from d=9.1 to d=1.2 after the foot release). The
        // honest bound: the ankle can never get closer to the anchor than
        // (minFold - d(origin->anchor)), so the anchor is truly lost when
        // that lower bound exceeds the latch radius (measured on seed 101
        // a44: bound 3.2 < LATCH 5 at the fold boundary - a pose at
        // hip=358/knee=40 can still latch there, so the bound - not the
        // raw fold circle - is the correct test).
        if (kind === "foot" && !this.skeleton.isGrabbing("foot", side)) {
            const dOriginAnchor = Math.sqrt(distanceSqr(origin.posX, origin.posY, anchor.posX, anchor.posY));
            if (minFold - dOriginAnchor > LATCH_RADIUS) {
                this.currentMove = undefined;
                return "unreachable";
            }
        }
        // NOTE: no continuous max-reach check here. An earlier version
        // killed moves whose origin->anchor distance left the envelope
        // mid-flight, but the reaching limb itself displaces the body (the
        // swing transiently carries the origin out of the envelope), so
        // healthy moves were killed at the grace boundary (verified on seed
        // 101: pick at d=24.8, killed at d=29.1 while the hand was mid-swing
        // toward the anchor). Stale targets are handled by the move timeout
        // plus the decision layer's blacklist-on-timeout.
        if (move.elapsed > MOVE_TIMEOUT) {
            this.currentMove = undefined;
            return "timeout";
        }
        return "in-progress";
    }

    private aimReachingLimb(move: ReachMove, deltaTime: number): void {
        if (move.kind === "hand") {
            this.aimArmToward(move.side, move.anchor, deltaTime);
        } else {
            this.aimLegToward(move.side, move.anchor, deltaTime);
        }
    }

    private aimArmToward(side: number, target: WallAnchor, deltaTime: number): void {
        const origin = this.origin("hand");
        const { proximal, distal } = this.boneLengths("hand", side);
        const shoulder = defined(
            this.phys.angularConstraints[defined(this.skeleton.shoulderACIndex[side], "Missing shoulder index")],
            "Missing shoulder constraint",
        );
        const elbow = defined(
            this.phys.angularConstraints[defined(this.skeleton.elbowACIndex[side], "Missing elbow index")],
            "Missing elbow constraint",
        );
        const root = defined(this.phys.particleStates[shoulder.particleIndex0], "Missing arm root");
        const elbowParticle = defined(this.phys.particleStates[elbow.particleIndex1], "Missing elbow particle");
        const joint = bentJointPosition(
            origin.posX, origin.posY, target.posX, target.posY,
            proximal, distal,
            STRAIGHT_ELBOW_ANGLE, false,
            elbowParticle.posX, elbowParticle.posY,
        );
        // Shoulder constraint = back -> neck -> elbow, so its angle is the
        // back-to-neck direction minus the neck-to-elbow direction.
        const desiredShoulder =
            wrapAngle(
                Math.atan2(root.posY - origin.posY, root.posX - origin.posX) -
                Math.atan2(joint.y - origin.posY, joint.x - origin.posX),
            );
        const desiredElbow = jointAngle(origin.posX, origin.posY, joint.x, joint.y, target.posX, target.posY);
        shoulder.targetAngle = moveJointAngle(shoulder.targetAngle, desiredShoulder, deltaTime, undefined, undefined, REACH_ANGLE_SPEED);
        elbow.targetAngle = moveJointAngle(elbow.targetAngle, desiredElbow, deltaTime, ELBOW_MIN_ANGLE, ELBOW_MAX_ANGLE, REACH_ANGLE_SPEED * 1.5);
    }

    private aimLegToward(side: number, target: WallAnchor, deltaTime: number): void {
        const origin = this.origin("foot");
        const { proximal, distal } = this.boneLengths("foot", side);
        const hip = defined(
            this.phys.angularConstraints[defined(this.skeleton.hipJointACIndex[side], "Missing hip index")],
            "Missing hip constraint",
        );
        const knee = defined(
            this.phys.angularConstraints[defined(this.skeleton.kneeJointACIndex[side], "Missing knee index")],
            "Missing knee constraint",
        );
        const kneeParticle = defined(this.phys.particleStates[knee.particleIndex1], "Missing knee particle");

        // Pure geometric IK with bend-side continuity. Do NOT force the
        // outward knee here: for lateral targets the outward solution needs a
        // knee bend outside [KNEE_MIN, KNEE_MAX] and the clamp then stalls the
        // reach forever. (The outward-knee rule stays on the PLANTED leg,
        // where it prevents the downward ratchet.)
        //
        // Additionally, a bend-side solution whose resulting knee angle falls
        // outside [KNEE_MIN, KNEE_MAX] is inadmissible: the clamp would freeze
        // the joint short of the target forever. Compute both solutions,
        // filter to admissible ones, then apply continuity.
        const root = defined(this.phys.particleStates[hip.particleIndex0], "Missing leg root");
        const joint = this.admissibleLegJoint(
            origin.posX, origin.posY, target.posX, target.posY,
            proximal, distal,
            kneeParticle.posX, kneeParticle.posY,
        );
        const desiredHip = jointAngle(root.posX, root.posY, origin.posX, origin.posY, joint.x, joint.y);
        const desiredKnee = jointAngle(origin.posX, origin.posY, joint.x, joint.y, target.posX, target.posY);
        hip.targetAngle = moveJointAngle(hip.targetAngle, desiredHip, deltaTime, HIP_MIN_ANGLE, HIP_MAX_ANGLE, REACH_ANGLE_SPEED);
        knee.targetAngle = moveJointAngle(knee.targetAngle, desiredKnee, deltaTime, KNEE_MIN_ANGLE, KNEE_MAX_ANGLE, REACH_ANGLE_SPEED * 1.5);
    }

    /**
     * Two-bone leg IK with admissibility filtering: of the two bend-side
     * solutions, only those whose knee angle lands inside
     * [KNEE_MIN, KNEE_MAX] are candidates; continuity (nearest to the
     * current knee) picks among them.
     */
    private admissibleLegJoint(
        originX: number,
        originY: number,
        targetX: number,
        targetY: number,
        proximal: number,
        distal: number,
        currentKneeX: number,
        currentKneeY: number,
    ): { x: number; y: number } {
        let reachX = targetX - originX;
        let reachY = targetY - originY;
        let reachDistance = Math.sqrt(reachX * reachX + reachY * reachY);
        if (reachDistance < 0.0001) {
            reachX = 1;
            reachY = 0;
            reachDistance = 1;
        }
        const maxReach = Math.max(0.5, proximal + distal - 0.5);
        const minReach = Math.abs(proximal - distal) + 0.5;
        // Fold-circle handling: when the target is CLOSER to the origin than
        // the knee fold allows (d < 2*minBone*sin(KNEE_MIN/2)), the standard
        // clamped-distance solve produces candidate knees whose angles are
        // BOTH outside [KNEE_MIN, KNEE_MAX] (near-collinear, angle ~0/360 -
        // measured on seed 101 a44: candidates at 336/24deg), so the pool
        // falls back to both and continuity commands a hip toward a pose
        // that CANNOT reach the target. The poses that CAN reach an
        // inside-fold target put the knee ON the fold circle with the shin
        // pointing at the target: knee = origin + thighDir*femur where the
        // ankle lands at minFold from the origin. Solve those directly:
        // knee = origin + femur*unit(t) rotated by +/-KNEE_MIN/2-ish geometry:
        // place the knee so that |knee-origin|=proximal, |knee-target|=distal
        // (the ankle then sits at the target exactly) - this is the standard
        // two-bone solve with dc=|target-origin| NOT clamped to minReach but
        // to minFold, giving a valid triangle with knee angle = KNEE_MIN.
        const minFold = 2 * Math.min(proximal, distal) * Math.sin(KNEE_MIN_ANGLE / 2);
        const clampedDistance = reachDistance < minFold
            ? minFold
            : Math.min(maxReach, Math.max(minReach, reachDistance));
        const dirX = reachX / reachDistance;
        const dirY = reachY / reachDistance;
        const cosine = clampRange(
            (proximal * proximal + clampedDistance * clampedDistance - distal * distal) / (2 * proximal * clampedDistance),
            -1,
            1,
        );
        const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
        const alongX = dirX * cosine;
        const alongY = dirY * cosine;
        const perpX = -dirY * sine;
        const perpY = dirX * sine;

        const candidates = [
            { x: originX + proximal * (alongX + perpX), y: originY + proximal * (alongY + perpY) },
            { x: originX + proximal * (alongX - perpX), y: originY + proximal * (alongY - perpY) },
        ];
        const admissible = candidates.filter(j => {
            const kneeAngle = jointAngle(originX, originY, j.x, j.y, targetX, targetY);
            return kneeAngle >= KNEE_MIN_ANGLE - 0.05 && kneeAngle <= KNEE_MAX_ANGLE + 0.05;
        });
        // NOTE: deliberately knee-only filtering. Adding a hip-admissibility
        // filter here starves foot reaches whose only solutions swing the
        // thigh past the hip window (measured on seed 202: 55px vs 227px) -
        // the hip is guarded by the target clamp in moveJointAngle plus the
        // solver's hard limit instead.
        const pool = admissible.length > 0 ? admissible : candidates;
        let best = pool[0]!;
        let bestDist = distanceSqr(currentKneeX, currentKneeY, best.x, best.y);
        for (let i = 1; i < pool.length; i++) {
            const j = pool[i]!;
            const d = distanceSqr(currentKneeX, currentKneeY, j.x, j.y);
            if (d < bestDist) {
                bestDist = d;
                best = j;
            }
        }
        return best;
    }

    /**
     * Planted limb: aim the IK at a virtual target scaled from the limb
     * origin toward the anchor (§6.2). A shortened target bends the limb,
     * and the bend hauls the body toward the wall.
     */
    private aimPlantedLimb(kind: LimbKind, side: number, anchor: WallAnchor, scale: number, deltaTime: number): void {
        const origin = this.origin(kind);
        // Mantle posture: when a planted HAND holds an anchor BELOW the neck
        // (the body has pushed up past its hands), folding the arm via a
        // shortened target lets the body lean away from the wall. An EXTENDED
        // arm holds the body close - use the full anchor as the IK target so
        // the arm stays taut and hauls the neck in.
        const effectiveScale = kind === "hand" && anchor.posY > origin.posY ? 1.0 : scale;
        const virtualTarget: WallAnchor = {
            posX: origin.posX + (anchor.posX - origin.posX) * effectiveScale,
            posY: origin.posY + (anchor.posY - origin.posY) * effectiveScale,
            index: anchor.index,
        };
        if (kind === "hand") {
            this.aimArmToward(side, virtualTarget, deltaTime);
        } else {
            this.aimLegTowardPlanted(side, virtualTarget, deltaTime);
        }
    }

    /** Planted leg IK: pure geometric solution (no flex-first - the foot is already on its hold). */
    private aimLegTowardPlanted(side: number, target: WallAnchor, deltaTime: number): void {
        const origin = this.origin("foot");
        const { proximal, distal } = this.boneLengths("foot", side);
        const hip = defined(
            this.phys.angularConstraints[defined(this.skeleton.hipJointACIndex[side], "Missing hip index")],
            "Missing hip constraint",
        );
        const knee = defined(
            this.phys.angularConstraints[defined(this.skeleton.kneeJointACIndex[side], "Missing knee index")],
            "Missing knee constraint",
        );
        const kneeParticle = defined(this.phys.particleStates[knee.particleIndex1], "Missing knee particle");
        const root = defined(this.phys.particleStates[hip.particleIndex0], "Missing leg root");
        // Admissibility-filtered IK (same as the reaching leg): the world-x
        // "outward knee" rule could pick a bend side whose knee angle lands
        // outside [KNEE_MIN, pi] - the hard solver limits then fight the IK
        // and the planted leg stalls. Continuity among admissible solutions
        // keeps the knee on its natural side.
        const joint = this.admissibleLegJoint(
            origin.posX, origin.posY, target.posX, target.posY,
            proximal, distal,
            kneeParticle.posX, kneeParticle.posY,
        );
        const desiredHip = jointAngle(root.posX, root.posY, origin.posX, origin.posY, joint.x, joint.y);
        const desiredKnee = jointAngle(origin.posX, origin.posY, joint.x, joint.y, target.posX, target.posY);
        hip.targetAngle = moveJointAngle(hip.targetAngle, desiredHip, deltaTime, HIP_MIN_ANGLE, HIP_MAX_ANGLE, ANGLE_SPEED);
        knee.targetAngle = moveJointAngle(knee.targetAngle, desiredKnee, deltaTime, KNEE_MIN_ANGLE, KNEE_MAX_ANGLE, ANGLE_SPEED * 1.5);
    }

    private poseNonMovingLimbs(deltaTime: number, exclude?: ReachMove): void {
        for (let side = 0; side < 2; side++) {
            // Arms.
            if (!exclude || exclude.kind !== "hand" || exclude.side !== side) {
                if (this.skeleton.isGrabbing("hand", side)) {
                    const anchor = this.wall.wallAnchors[this.skeleton.grabConstraint("hand", side).wallAnchorIndex];
                    if (anchor !== undefined) {
                        this.aimPlantedLimb("hand", side, anchor, PLANTED_IK_SCALE, deltaTime);
                    } else {
                        this.poseArmStatic(side, deltaTime);
                    }
                } else {
                    this.poseArmStatic(side, deltaTime);
                }
            }
            // Legs.
            if ((!exclude || exclude.kind !== "foot" || exclude.side !== side) && side !== this.pushingLegSide) {
                if (this.skeleton.isGrabbing("foot", side)) {
                    const anchor = this.wall.wallAnchors[this.skeleton.grabConstraint("foot", side).wallAnchorIndex];
                    if (anchor !== undefined) {
                        this.aimLegTowardPlanted(side, anchor, deltaTime);
                    }
                } else {
                    // Free non-reaching leg: hold a soft coil so it is ready.
                    const hip = defined(
                        this.phys.angularConstraints[defined(this.skeleton.hipJointACIndex[side], "Missing hip index")],
                        "Missing hip constraint",
                    );
                    const knee = defined(
                        this.phys.angularConstraints[defined(this.skeleton.kneeJointACIndex[side], "Missing knee index")],
                        "Missing knee constraint",
                    );
                    hip.targetAngle = moveJointAngle(hip.targetAngle, Math.PI * 1.12, deltaTime, HIP_MIN_ANGLE, HIP_MAX_ANGLE);
                    knee.targetAngle = moveJointAngle(knee.targetAngle, COIL_KNEE_ANGLE, deltaTime, KNEE_MIN_ANGLE, KNEE_MAX_ANGLE);
                }
            }
        }
    }

    private poseArmStatic(side: number, deltaTime: number): void {
        const shoulder = defined(
            this.phys.angularConstraints[defined(this.skeleton.shoulderACIndex[side], "Missing shoulder index")],
            "Missing shoulder constraint",
        );
        const elbow = defined(
            this.phys.angularConstraints[defined(this.skeleton.elbowACIndex[side], "Missing elbow index")],
            "Missing elbow constraint",
        );
        shoulder.targetAngle = moveJointAngle(shoulder.targetAngle, OVERHEAD_SHOULDER_ANGLE, deltaTime);
        elbow.targetAngle = moveJointAngle(elbow.targetAngle, STRAIGHT_ELBOW_ANGLE, deltaTime, ELBOW_MIN_ANGLE, ELBOW_MAX_ANGLE);
    }

    private poseSpine(deltaTime: number): void {
        for (let i = 0; i < this.skeleton.backACIndex.length; i++) {
            const constraint = defined(
                this.phys.angularConstraints[defined(this.skeleton.backACIndex[i]!, "Missing back index")],
                "Missing back angular constraint",
            );
            constraint.targetAngle = moveJointAngle(constraint.targetAngle, STRAIGHT_SPINE_ANGLE, deltaTime);
        }
    }

    private setLimbTightness(kind: LimbKind): void {
        const indices = kind === "hand"
            ? [this.skeleton.shoulderACIndex, this.skeleton.elbowACIndex]
            : [this.skeleton.hipJointACIndex, this.skeleton.kneeJointACIndex];
        for (let side = 0; side < 2; side++) {
            for (const indexList of indices) {
                const constraint = defined(
                    this.phys.angularConstraints[defined(indexList[side]!, `Missing ${kind} joint index`)],
                    `Missing ${kind} joint constraint`,
                );
                constraint.tightnessFactor = PLANTED_TIGHTNESS;
            }
        }
    }

    private origin(kind: LimbKind) {
        const index = kind === "hand" ? this.skeleton.neckParticleIndex : this.skeleton.buttocksParticleIndex;
        return defined(this.phys.particleStates[index], `Missing ${kind} origin particle`);
    }

    private limb(kind: LimbKind, side: number) {
        return this.skeleton.limbParticle(kind, side);
    }

    private boneLengths(kind: LimbKind, side: number): { proximal: number; distal: number } {
        const constraintIndices = kind === "hand"
            ? side === 0 ? this.skeleton.leftArmConstraintIndices : this.skeleton.rightArmConstraintIndices
            : side === 0 ? this.skeleton.leftLegConstraintIndices : this.skeleton.rightLegConstraintIndices;
        const proximal = defined(
            this.phys.distanceConstraints[defined(constraintIndices[0]!, "Missing proximal constraint")],
            "Missing proximal distance",
        ).distance;
        const distal = defined(
            this.phys.distanceConstraints[defined(constraintIndices[1]!, "Missing distal constraint")],
            "Missing distal distance",
        ).distance;
        return { proximal, distal };
    }

    private release(kind: LimbKind, side: number): void {
        if (kind === "hand") {
            this.releaseHand(side);
        } else {
            this.releaseFoot(side);
        }
    }
}

/** Fallback dt for direct command calls outside update() (tests, one-shots). */
function dtOrDefault(): number {
    return 1 / 120;
}
