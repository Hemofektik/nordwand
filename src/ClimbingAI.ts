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

const GRAB_RADIUS = 8;
const REACH_ANGLE_SPEED = 6;

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

function flexArm(skeleton: Skeleton, sideIndex: number, deltaTime: number): number {
    const elbow = defined(
        skeleton.phys.angularConstraints[defined(skeleton.elbowACIndex[sideIndex], "Missing elbow index")],
        "Missing elbow constraint",
    );
    const shoulder = defined(
        skeleton.phys.angularConstraints[defined(skeleton.shoulderACIndex[sideIndex], "Missing shoulder index")],
        "Missing shoulder constraint",
    );

    const elbowDelta = (Math.PI * 1.8 - elbow.targetAngle) * deltaTime;
    const shoulderDelta = (Math.PI * 0.2 - shoulder.targetAngle) * deltaTime;
    elbow.targetAngle += elbowDelta;
    shoulder.targetAngle += shoulderDelta;
    return Math.abs(shoulderDelta) + Math.abs(elbowDelta);
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

    const hipJointDelta = (Math.PI * 1.2 - hip.targetAngle) * deltaTime;
    const kneeJointDelta = (Math.PI * 0.8 - knee.targetAngle) * deltaTime;
    hip.targetAngle += hipJointDelta;
    knee.targetAngle += kneeJointDelta;
    return Math.abs(hipJointDelta) + Math.abs(kneeJointDelta);
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

function aimLimbToward(
    skeleton: Skeleton,
    kind: LimbKind,
    sideIndex: number,
    target: WallAnchor,
    deltaTime: number,
): number {
    const origin = originParticle(skeleton, kind);
    const { proximal, distal } = boneLengths(skeleton, kind, sideIndex);
    const reachX = target.posX - origin.posX;
    const reachY = target.posY - origin.posY;
    const reachDistance = Math.sqrt(reachX * reachX + reachY * reachY);
    const maxReach = Math.max(0.5, proximal + distal - 0.5);
    const clampedDistance = Math.min(Math.max(reachDistance, 0.5), maxReach);
    const cosine =
        (proximal * proximal + distal * distal - clampedDistance * clampedDistance) / (2 * proximal * distal);
    const interior = Math.acos(Math.min(1, Math.max(-1, cosine)));
    const jointTarget = wrapAngle(Math.PI * 2 - interior);

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
    const desiredProximal = wrapAngle(
        Math.atan2(root.posY - origin.posY, root.posX - origin.posX) - Math.atan2(reachY, reachX),
    );

    const previousProximal = proximalConstraint.targetAngle;
    const previousDistal = distalConstraint.targetAngle;
    proximalConstraint.targetAngle = lerpAngle(previousProximal, desiredProximal, deltaTime);
    distalConstraint.targetAngle = lerpAngle(previousDistal, jointTarget, deltaTime);

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

        releaseLowerLimbIfBothPlanted(this.skeleton, "hand");
        releaseLowerLimbIfBothPlanted(this.skeleton, "foot");

        this.updateReachTargets(deltaTime);
        this.updateReachLimbAngles(deltaTime);

        const grabbed = this.tryGrabLimb("hand") || this.tryGrabLimb("foot");
        if (grabbed) {
            this.climbinState = ClimbingState.Raise;
        }
    }

    private findReachableAnchor(kind: LimbKind): number {
        const maxIndex = maxEnabledWallAnchorIndex(this.skeleton, kind);
        const origin = originParticle(this.skeleton, kind);
        const reach = limbLength(this.skeleton, kind);
        const reachSqr = reach * reach;
        const freeSide = this.skeleton.findFreeSide(kind);
        const limb = freeSide >= 0 ? this.skeleton.limbParticle(kind, freeSide) : undefined;

        for (let index = maxIndex + 1; index < this.wall.wallAnchors.length; index++) {
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

    private hasAnyGrab(): boolean {
        return (
            this.skeleton.isGrabbing("hand", 0) ||
            this.skeleton.isGrabbing("hand", 1) ||
            this.skeleton.isGrabbing("foot", 0) ||
            this.skeleton.isGrabbing("foot", 1)
        );
    }
}
