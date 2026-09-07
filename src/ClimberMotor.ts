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
export const LATCH_RADIUS = 6;
export const FOOT_TO_LOWEST_HAND_GAP = 15;
export const HAND_MIN_ABOVE_NECK = 5;
export const COM_MAX_WALL_DISTANCE = 35;
export const MOVE_TIMEOUT = 3.0;

// --- pose angles (validated in the previous implementation) ---
const STRAIGHT_HIP_ANGLE = Math.PI;
const STRAIGHT_KNEE_ANGLE = Math.PI * 0.95;
const COIL_KNEE_ANGLE = Math.PI * 0.5;
const OVERHEAD_SHOULDER_ANGLE = Math.PI * 0.92;
const STRAIGHT_ELBOW_ANGLE = Math.PI * 1.04;
const ELBOW_MIN_ANGLE = Math.PI * 1.02;
const ELBOW_MAX_ANGLE = Math.PI * 1.85;
export const KNEE_MIN_ANGLE = Math.PI * 0.35;
const KNEE_MAX_ANGLE = Math.PI * 0.95;
/** Minimum origin-to-foot distance the knee fold allows: with equal bones b
 *  and knee angle >= KNEE_MIN (angle between knee->origin and knee->end
 *  directions), the origin-end distance is 2b*sin(KNEE_MIN/2). Anchors closer
 *  than this to the limb origin can never be latched. */
export const LEG_MIN_FOLD_DISTANCE =
    2 * 12 * Math.sin(KNEE_MIN_ANGLE / 2);
const STRAIGHT_SPINE_ANGLE = Math.PI;

// --- angular solver coupling (validated) ---
const PLANTED_TIGHTNESS = 10;
const PLANTED_IK_SCALE = 0.85;
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

function shortestAngleDelta(from: number, to: number): number {
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
    let next = current + shortestAngleDelta(current, target) * Math.min(1, deltaTime * speed);
    next = wrapAngle(next);
    if (minAngle !== undefined && maxAngle !== undefined) {
        next = clampRange(next, minAngle, maxAngle);
    }
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

function currentConstraintAngle(skeleton: Skeleton, constraintIndex: number): number {
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
    }

    // ------------------------------------------------------------------
    // Move API (§6.1)
    // ------------------------------------------------------------------

    public reachFoot(side: number, anchor: WallAnchor): MotorStatus {
        return this.beginOrContinueReach("foot", side, anchor, false);
    }

    public reachHand(side: number, anchor: WallAnchor): MotorStatus {
        // Hand rule (§7.1): the target must sit above the neck.
        const neck = this.neck();
        if (anchor.posY > neck.posY - HAND_MIN_ABOVE_NECK) {
            return "unreachable";
        }
        return this.beginOrContinueReach("hand", side, anchor, false);
    }

    public pullHand(side: number, anchor: WallAnchor): MotorStatus {
        // Planted arm flexes to haul: same IK, target shortened from origin.
        if (!this.skeleton.isGrabbing("hand", side)) {
            return "unreachable";
        }
        this.aimPlantedLimb("hand", side, anchor, PLANTED_IK_SCALE, dtOrDefault());
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
        hip.targetAngle = moveJointAngle(hip.targetAngle, STRAIGHT_HIP_ANGLE, dtOrDefault(), undefined, undefined, REACH_ANGLE_SPEED);
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
        if (this.clock - releasedAt >= 3) {
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
        const reach = (proximal + distal) * REACH_FRACTION_RELAXED + LATCH_RADIUS;
        if (distanceSqr(origin.posX, origin.posY, anchor.posX, anchor.posY) > reach * reach) {
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
        hip.targetAngle = moveJointAngle(hip.targetAngle, desiredHip, deltaTime, undefined, undefined, REACH_ANGLE_SPEED);
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

        const candidates = [
            { x: originX + proximal * (alongX + perpX), y: originY + proximal * (alongY + perpY) },
            { x: originX + proximal * (alongX - perpX), y: originY + proximal * (alongY - perpY) },
        ];
        const admissible = candidates.filter(j => {
            const kneeAngle = jointAngle(originX, originY, j.x, j.y, targetX, targetY);
            return kneeAngle >= KNEE_MIN_ANGLE - 0.05 && kneeAngle <= KNEE_MAX_ANGLE + 0.05;
        });
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
        const virtualTarget: WallAnchor = {
            posX: origin.posX + (anchor.posX - origin.posX) * scale,
            posY: origin.posY + (anchor.posY - origin.posY) * scale,
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
        const joint = bentJointPosition(
            origin.posX, origin.posY, target.posX, target.posY,
            proximal, distal,
            COIL_KNEE_ANGLE, true,
            kneeParticle.posX, kneeParticle.posY,
        );
        const desiredHip = jointAngle(root.posX, root.posY, origin.posX, origin.posY, joint.x, joint.y);
        const desiredKnee = jointAngle(origin.posX, origin.posY, joint.x, joint.y, target.posX, target.posY);
        hip.targetAngle = moveJointAngle(hip.targetAngle, desiredHip, deltaTime, undefined, undefined, ANGLE_SPEED);
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
                    hip.targetAngle = moveJointAngle(hip.targetAngle, Math.PI * 1.12, deltaTime);
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

    private neck() {
        return defined(this.phys.particleStates[this.skeleton.neckParticleIndex], "Missing neck particle");
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
