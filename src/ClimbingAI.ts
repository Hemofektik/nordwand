import type { Camera } from "./Camera.ts";
import type { Rope } from "./Rope.ts";
import type { Skeleton } from "./Skeleton.ts";
import type { Wall, WallAnchor } from "./Wall.ts";
import { defined } from "./assert.ts";

export const ClimbingState = {
    None: 0,
    Raise: 1,
    Reach: 2,
} as const;

export type ClimbingState = (typeof ClimbingState)[keyof typeof ClimbingState];

type LimbKind = "hand" | "foot";

const GRAB_RADIUS = 12;
const REACH_ANGLE_SPEED = 8;
const RAISE_ELBOW_ANGLE = Math.PI * 1.65;
const RAISE_SHOULDER_ANGLE = Math.PI * 0.35;
const RAISE_HIP_ANGLE = Math.PI * 1.25;
const REST_HIP_ANGLE = Math.PI * 1.5;
const KNEE_REST_ANGLE = Math.PI * 0.5;
const KNEE_FLEX_ANGLE = Math.PI * 0.32;
const ELBOW_MIN_ANGLE = Math.PI * 1.02;
const ELBOW_MAX_ANGLE = Math.PI * 1.85;
const KNEE_MIN_ANGLE = Math.PI * 0.22;
const KNEE_MAX_ANGLE = Math.PI * 0.62;
const ELBOW_PREFERRED_ANGLE = (ELBOW_MIN_ANGLE + ELBOW_MAX_ANGLE) * 0.5;

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

function lerpAngle(current: number, target: number, deltaTime: number): number {
    const delta = shortestAngleDelta(current, target);
    return wrapAngle(current + delta * Math.min(1, deltaTime * REACH_ANGLE_SPEED));
}

function distanceSqr(x0: number, y0: number, x1: number, y1: number): number {
    const dx = x1 - x0;
    const dy = y1 - y0;
    return dx * dx + dy * dy;
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
): number {
    let next = lerpAngle(current, target, deltaTime);
    if (minAngle !== undefined && maxAngle !== undefined) {
        next = clampRange(next, minAngle, maxAngle);
    }
    return next;
}

function flexArm(skeleton: Skeleton, sideIndex: number, deltaTime: number): number {
    const elbow = defined(
        skeleton.phys.angularConstraints[defined(skeleton.elbowACIndex[sideIndex], "Missing elbow index")],
        "Missing elbow constraint",
    );
    const shoulder = defined(
        skeleton.phys.angularConstraints[defined(skeleton.shoulderACIndex[sideIndex], "Missing shoulder index")],
        "Missing shoulder constraint",
    );

    const previousElbow = elbow.targetAngle;
    const previousShoulder = shoulder.targetAngle;
    elbow.targetAngle = moveJointAngle(previousElbow, RAISE_ELBOW_ANGLE, deltaTime, ELBOW_MIN_ANGLE, ELBOW_MAX_ANGLE);
    shoulder.targetAngle = moveJointAngle(previousShoulder, RAISE_SHOULDER_ANGLE, deltaTime);
    return (
        Math.abs(shortestAngleDelta(previousElbow, elbow.targetAngle)) +
        Math.abs(shortestAngleDelta(previousShoulder, shoulder.targetAngle))
    );
}

function restPlantedLegs(skeleton: Skeleton, deltaTime: number): number {
    let accumulatedDelta = 0;
    for (let side = 0; side < 2; side++) {
        if (!skeleton.isGrabbing("foot", side)) {
            continue;
        }
        const hip = defined(
            skeleton.phys.angularConstraints[defined(skeleton.hipJointACIndex[side], "Missing hip index")],
            "Missing hip constraint",
        );
        const knee = defined(
            skeleton.phys.angularConstraints[defined(skeleton.kneeJointACIndex[side], "Missing knee index")],
            "Missing knee constraint",
        );
        const previousHip = hip.targetAngle;
        const previousKnee = knee.targetAngle;
        hip.targetAngle = moveJointAngle(previousHip, REST_HIP_ANGLE, deltaTime);
        knee.targetAngle = moveJointAngle(previousKnee, KNEE_REST_ANGLE, deltaTime, KNEE_MIN_ANGLE, KNEE_MAX_ANGLE);
        accumulatedDelta +=
            Math.abs(shortestAngleDelta(previousHip, hip.targetAngle)) +
            Math.abs(shortestAngleDelta(previousKnee, knee.targetAngle));
    }
    return accumulatedDelta;
}

function extendLeg(skeleton: Skeleton, sideIndex: number, deltaTime: number): number {
    const hip = defined(
        skeleton.phys.angularConstraints[defined(skeleton.hipJointACIndex[sideIndex], "Missing hip index")],
        "Missing hip constraint",
    );
    const knee = defined(
        skeleton.phys.angularConstraints[defined(skeleton.kneeJointACIndex[sideIndex], "Missing knee index")],
        "Missing knee constraint",
    );

    const previousHip = hip.targetAngle;
    const previousKnee = knee.targetAngle;
    hip.targetAngle = moveJointAngle(previousHip, RAISE_HIP_ANGLE, deltaTime);
    knee.targetAngle = moveJointAngle(previousKnee, KNEE_FLEX_ANGLE, deltaTime, KNEE_MIN_ANGLE, KNEE_MAX_ANGLE);
    return (
        Math.abs(shortestAngleDelta(previousHip, hip.targetAngle)) +
        Math.abs(shortestAngleDelta(previousKnee, knee.targetAngle))
    );
}

function maxEnabledWallAnchorIndex(skeleton: Skeleton, kind: LimbKind): number {
    let maxIndex = -1;
    for (let side = 0; side < 2; side++) {
        const constraint = skeleton.grabConstraint(kind, side);
        if (constraint.isEnabled) {
            maxIndex = Math.max(maxIndex, constraint.wallAnchorIndex);
        }
    }
    return maxIndex;
}

function releaseLowerLimbIfBothPlanted(skeleton: Skeleton, kind: LimbKind): void {
    if (!skeleton.isGrabbing(kind, 0) || !skeleton.isGrabbing(kind, 1)) {
        return;
    }

    const left = skeleton.grabConstraint(kind, 0);
    const right = skeleton.grabConstraint(kind, 1);
    const lowerSide = left.wallAnchorIndex <= right.wallAnchorIndex ? 0 : 1;
    skeleton.release(kind, lowerSide);
}

function limbLength(skeleton: Skeleton, kind: LimbKind): number {
    return kind === "hand" ? skeleton.armlength : skeleton.leglength;
}

function originParticle(skeleton: Skeleton, kind: LimbKind) {
    const particleIndex = kind === "hand" ? skeleton.neckParticleIndex : skeleton.buttocksParticleIndex;
    const message = kind === "hand" ? "Missing neck particle" : "Missing buttocks particle";
    return defined(skeleton.phys.particleStates[particleIndex], message);
}

function boneLengths(skeleton: Skeleton, kind: LimbKind, sideIndex: number): { proximal: number; distal: number } {
    const constraintIndices =
        kind === "hand"
            ? sideIndex === 0
                ? skeleton.leftArmConstraintIndices
                : skeleton.rightArmConstraintIndices
            : sideIndex === 0
                ? skeleton.leftLegConstraintIndices
                : skeleton.rightLegConstraintIndices;

    const proximal = defined(
        skeleton.phys.distanceConstraints[defined(constraintIndices[0], `Missing ${kind} proximal constraint`)],
        `Missing ${kind} proximal distance`,
    ).distance;
    const distal = defined(
        skeleton.phys.distanceConstraints[defined(constraintIndices[1], `Missing ${kind} distal constraint`)],
        `Missing ${kind} distal distance`,
    ).distance;
    return { proximal, distal };
}

function jointAngle(originX: number, originY: number, jointX: number, jointY: number, endX: number, endY: number): number {
    return wrapAngle(Math.atan2(originY - jointY, originX - jointX) - Math.atan2(endY - jointY, endX - jointX));
}

function bentJointPosition(
    originX: number,
    originY: number,
    targetX: number,
    targetY: number,
    proximal: number,
    distal: number,
    preferredJointAngle: number,
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

    const jointA = {
        x: originX + proximal * (alongX + perpX),
        y: originY + proximal * (alongY + perpY),
    };
    const jointB = {
        x: originX + proximal * (alongX - perpX),
        y: originY + proximal * (alongY - perpY),
    };
    const angleA = jointAngle(originX, originY, jointA.x, jointA.y, targetX, targetY);
    const angleB = jointAngle(originX, originY, jointB.x, jointB.y, targetX, targetY);
    const errorA = Math.abs(shortestAngleDelta(angleA, preferredJointAngle));
    const errorB = Math.abs(shortestAngleDelta(angleB, preferredJointAngle));
    return errorA <= errorB ? jointA : jointB;
}

function aimLimbToward(
    skeleton: Skeleton,
    kind: LimbKind,
    sideIndex: number,
    target: WallAnchor,
    deltaTime: number,
): number {
    const origin = originParticle(skeleton, kind);
    const { proximal, distal } = boneLengths(skeleton, kind, sideIndex);
    const proximalConstraint = defined(
        skeleton.phys.angularConstraints[
        defined(
            kind === "hand" ? skeleton.shoulderACIndex[sideIndex] : skeleton.hipJointACIndex[sideIndex],
            `Missing ${kind} proximal joint`,
        )
        ],
        `Missing ${kind} proximal angular constraint`,
    );
    const distalConstraint = defined(
        skeleton.phys.angularConstraints[
        defined(
            kind === "hand" ? skeleton.elbowACIndex[sideIndex] : skeleton.kneeJointACIndex[sideIndex],
            `Missing ${kind} distal joint`,
        )
        ],
        `Missing ${kind} distal angular constraint`,
    );
    const root = defined(
        skeleton.phys.particleStates[proximalConstraint.particleIndex0],
        `Missing ${kind} root particle`,
    );

    const preferredDistal = kind === "hand" ? ELBOW_PREFERRED_ANGLE : KNEE_REST_ANGLE;
    const joint = bentJointPosition(
        origin.posX,
        origin.posY,
        target.posX,
        target.posY,
        proximal,
        distal,
        preferredDistal,
    );
    const desiredProximal = jointAngle(root.posX, root.posY, origin.posX, origin.posY, joint.x, joint.y);
    const desiredDistal = jointAngle(origin.posX, origin.posY, joint.x, joint.y, target.posX, target.posY);

    const previousProximal = proximalConstraint.targetAngle;
    const previousDistal = distalConstraint.targetAngle;
    proximalConstraint.targetAngle = moveJointAngle(previousProximal, desiredProximal, deltaTime);
    if (kind === "hand") {
        distalConstraint.targetAngle = moveJointAngle(
            previousDistal,
            desiredDistal,
            deltaTime,
            ELBOW_MIN_ANGLE,
            ELBOW_MAX_ANGLE,
        );
    } else {
        distalConstraint.targetAngle = moveJointAngle(
            previousDistal,
            desiredDistal,
            deltaTime,
            KNEE_MIN_ANGLE,
            KNEE_MAX_ANGLE,
        );
    }

    return (
        Math.abs(shortestAngleDelta(previousProximal, proximalConstraint.targetAngle)) +
        Math.abs(shortestAngleDelta(previousDistal, distalConstraint.targetAngle))
    );
}

export class ClimbingAI {
    public rope: Rope;
    public skeleton: Skeleton;
    public wall: Wall;
    public climbinState: ClimbingState = ClimbingState.Raise;
    public targetHandAnchorIndex = -1;
    public targetFootAnchorIndex = -1;

    public constructor(rope: Rope, wall: Wall, skeleton: Skeleton) {
        this.rope = rope;
        this.wall = wall;
        this.skeleton = skeleton;
    }

    public update(deltaTime: number): void {
        if (this.climbinState === ClimbingState.Raise) {
            this.updateRaise(deltaTime);
            return;
        }
        if (this.climbinState === ClimbingState.Reach) {
            this.updateReach(deltaTime);
        }
    }

    public stopClimbing(): void {
        this.climbinState = ClimbingState.None;
        this.targetHandAnchorIndex = -1;
        this.targetFootAnchorIndex = -1;
    }

    public draw(_ctx: CanvasRenderingContext2D, _cam: Camera): void { }

    public updateRaise(deltaTime: number): void {
        let raised = false;
        let accumulatedDelta = 0.0;

        for (let n = 0; n < this.skeleton.handGrabConstraintIndex.length; n++) {
            const constraint = defined(
                this.skeleton.phys.fixedConstraints[defined(this.skeleton.handGrabConstraintIndex[n], "Missing hand grab")],
                "Missing hand grab constraint",
            );
            if (constraint.isEnabled) {
                accumulatedDelta += flexArm(this.skeleton, n, deltaTime);
                raised = true;
            }
        }

        for (let n = 0; n < this.skeleton.footGrabConstraintIndex.length; n++) {
            const constraint = defined(
                this.skeleton.phys.fixedConstraints[defined(this.skeleton.footGrabConstraintIndex[n], "Missing foot grab")],
                "Missing foot grab constraint",
            );
            if (constraint.isEnabled) {
                accumulatedDelta += extendLeg(this.skeleton, n, deltaTime);
                raised = true;
            }
        }

        if (raised) {
            if (accumulatedDelta < 0.01) {
                releaseLowerLimbIfBothPlanted(this.skeleton, "hand");
                releaseLowerLimbIfBothPlanted(this.skeleton, "foot");
                this.targetHandAnchorIndex = -1;
                this.targetFootAnchorIndex = -1;
                this.climbinState = ClimbingState.Reach;
            }
            return;
        }

        this.climbinState = ClimbingState.None;
    }

    public updateReachTargets(_deltaTime?: number): void {
        if (this.targetHandAnchorIndex >= 0 && this.targetFootAnchorIndex >= 0) {
            return;
        }

        if (this.targetHandAnchorIndex === -1) {
            this.targetHandAnchorIndex = this.findReachableAnchor("hand");
        }

        if (this.targetFootAnchorIndex === -1) {
            this.targetFootAnchorIndex = this.findReachableAnchor("foot");
        }
    }

    public updateReachLimbAngles(deltaTime = 0): number {
        let accumulatedDelta = 0;

        if (this.targetHandAnchorIndex >= 0) {
            const freeHand = this.skeleton.findFreeSide("hand");
            const target = this.wall.wallAnchors[this.targetHandAnchorIndex];
            if (freeHand >= 0 && target !== undefined) {
                accumulatedDelta += aimLimbToward(this.skeleton, "hand", freeHand, target, deltaTime);
            }
        }

        if (this.targetFootAnchorIndex >= 0) {
            const freeFoot = this.skeleton.findFreeSide("foot");
            const target = this.wall.wallAnchors[this.targetFootAnchorIndex];
            if (freeFoot >= 0 && target !== undefined) {
                accumulatedDelta += aimLimbToward(this.skeleton, "foot", freeFoot, target, deltaTime);
            }
        }

        return accumulatedDelta;
    }

    public updateReach(deltaTime: number): void {
        if (!this.hasAnyGrab()) {
            this.stopClimbing();
            return;
        }

        this.updateReachTargets(deltaTime);
        this.updateReachLimbAngles(deltaTime);
        restPlantedLegs(this.skeleton, deltaTime);

        const grabbedHand = this.tryGrabLimb("hand");
        const grabbedFoot = this.tryGrabLimb("foot");
        if (this.reachCycleComplete(grabbedHand || grabbedFoot)) {
            this.climbinState = ClimbingState.Raise;
        }
    }

    private findReachableAnchor(kind: LimbKind): number {
        if (this.skeleton.findFreeSide(kind) < 0) {
            return -1;
        }

        const origin = originParticle(this.skeleton, kind);
        const reach = limbLength(this.skeleton, kind);
        const reachSqr = reach * reach;
        const freeSide = this.skeleton.findFreeSide(kind);
        const limb = freeSide >= 0 ? this.skeleton.limbParticle(kind, freeSide) : undefined;
        const minIndex = maxEnabledWallAnchorIndex(this.skeleton, kind) + 1;

        for (let index = minIndex; index < this.wall.wallAnchors.length; index++) {
            const anchor = this.wall.wallAnchors[index];
            if (anchor === undefined) {
                continue;
            }

            const originReachable = distanceSqr(origin.posX, origin.posY, anchor.posX, anchor.posY) <= reachSqr;
            const limbReachable =
                limb !== undefined &&
                distanceSqr(limb.posX, limb.posY, anchor.posX, anchor.posY) <= GRAB_RADIUS * GRAB_RADIUS;
            if (originReachable || limbReachable) {
                return anchor.index;
            }

            if (anchor.posY < origin.posY - reach) {
                break;
            }
        }

        return -1;
    }

    private tryGrabLimb(kind: LimbKind): boolean {
        const targetIndex = kind === "hand" ? this.targetHandAnchorIndex : this.targetFootAnchorIndex;
        if (targetIndex < 0) {
            return false;
        }

        const freeSide = this.skeleton.findFreeSide(kind);
        if (freeSide < 0) {
            return false;
        }

        const anchor = this.wall.wallAnchors[targetIndex];
        if (anchor === undefined) {
            return false;
        }

        const limb = this.skeleton.limbParticle(kind, freeSide);
        const origin = originParticle(this.skeleton, kind);
        const reach = limbLength(this.skeleton, kind);
        const closeToHold = distanceSqr(limb.posX, limb.posY, anchor.posX, anchor.posY) <= GRAB_RADIUS * GRAB_RADIUS;
        const originInReach = distanceSqr(origin.posX, origin.posY, anchor.posX, anchor.posY) <= reach * reach;
        if (!closeToHold && !originInReach) {
            return false;
        }

        this.skeleton.grab(kind, freeSide, anchor);
        if (kind === "hand") {
            this.targetHandAnchorIndex = -1;
        } else {
            this.targetFootAnchorIndex = -1;
        }
        return true;
    }

    private reachCycleComplete(grabbedThisFrame: boolean): boolean {
        if (!grabbedThisFrame) {
            return false;
        }

        const waitingOnHand = this.skeleton.findFreeSide("hand") >= 0 && this.targetHandAnchorIndex >= 0;
        const waitingOnFoot = this.skeleton.findFreeSide("foot") >= 0 && this.targetFootAnchorIndex >= 0;
        return !waitingOnHand && !waitingOnFoot;
    }

    private hasAnyGrab(): boolean {
        return (
            this.skeleton.isGrabbing("hand", 0) ||
            this.skeleton.isGrabbing("hand", 1) ||
            this.skeleton.isGrabbing("foot", 0) ||
            this.skeleton.isGrabbing("foot", 1)
        );
    }
}
