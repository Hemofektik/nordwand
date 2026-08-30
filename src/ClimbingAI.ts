import type { Camera } from "./Camera.ts";
import type { Rope } from "./Rope.ts";
import type { Skeleton } from "./Skeleton.ts";
import type { Wall } from "./Wall.ts";
import { defined } from "./assert.ts";

export const ClimbingState = {
    None: 0,
    Raise: 1,
    Reach: 2,
} as const;

export type ClimbingState = (typeof ClimbingState)[keyof typeof ClimbingState];

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
            let maxHandWallAnchorIndex = -1;
            for (const grabIndex of this.skeleton.handGrabConstraintIndex) {
                const constraint = defined(this.skeleton.phys.fixedConstraints[grabIndex], "Missing hand grab constraint");
                if (constraint.isEnabled) {
                    maxHandWallAnchorIndex = Math.max(maxHandWallAnchorIndex, constraint.wallAnchorIndex);
                }
            }

            const neckParticleState = defined(
                this.skeleton.phys.particleStates[this.skeleton.neckParticleIndex],
                "Missing neck particle",
            );
            const nextHandAnchor = this.wall.wallAnchors[maxHandWallAnchorIndex + 1];
            if (nextHandAnchor !== undefined) {
                const deltaX = nextHandAnchor.posX - neckParticleState.posX;
                const deltaY = nextHandAnchor.posY - neckParticleState.posY;
                const distanceSqr = deltaX * deltaX + deltaY * deltaY;
                if (distanceSqr <= this.skeleton.armlength * this.skeleton.armlength) {
                    this.targetHandAnchorIndex = nextHandAnchor.index;
                }
            }
        }

        if (this.targetFootAnchorIndex === -1) {
            let maxFootWallAnchorIndex = -1;
            for (const grabIndex of this.skeleton.footGrabConstraintIndex) {
                const constraint = defined(this.skeleton.phys.fixedConstraints[grabIndex], "Missing foot grab constraint");
                if (constraint.isEnabled) {
                    maxFootWallAnchorIndex = Math.max(maxFootWallAnchorIndex, constraint.wallAnchorIndex);
                }
            }

            const buttocksParticleState = defined(
                this.skeleton.phys.particleStates[this.skeleton.buttocksParticleIndex],
                "Missing buttocks particle",
            );
            const nextFootAnchor = this.wall.wallAnchors[maxFootWallAnchorIndex + 1];
            if (nextFootAnchor !== undefined) {
                const deltaX = nextFootAnchor.posX - buttocksParticleState.posX;
                const deltaY = nextFootAnchor.posY - buttocksParticleState.posY;
                const distanceSqr = deltaX * deltaX + deltaY * deltaY;
                if (distanceSqr <= this.skeleton.leglength * this.skeleton.leglength) {
                    this.targetFootAnchorIndex = nextFootAnchor.index;
                }
            }
        }
    }

    public updateReachLimbAngles(_deltaTime?: number): void {
        if (this.targetHandAnchorIndex >= 0) {
            defined(this.skeleton.phys.particleStates[this.skeleton.neckParticleIndex], "Missing neck particle");
            defined(this.wall.wallAnchors[this.targetHandAnchorIndex], "Missing target hand anchor");
        }

        if (this.targetFootAnchorIndex >= 0) {
            return;
        }
    }

    public updateReach(deltaTime: number): void {
        this.updateReachTargets(deltaTime);
        this.updateReachLimbAngles(deltaTime);
    }
}
