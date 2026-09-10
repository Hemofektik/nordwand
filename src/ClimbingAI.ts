// TODO: generalize anchor distance dependencies to support all sorts of anchor intervals
// TODO: unify movement of limbs to get more control over animation speed/pacing
// TODO: place rope anchor from time to time

import type { Rope } from "./Rope.ts";
import type { Skeleton } from "./Skeleton.ts";
import type { Wall } from "./Wall.ts";
import { EGameState } from "./Core.ts";
import { GetAngleBetweenVertices, GetDistance } from "./MathUtils.ts";

export const ECLimbingState = Object.freeze(
    {
        None: 0,
        Raise: 1, // flex arm and extend leg to get higher
        FindReachTargets: 2, // look for reachable anchors for free arm and leg to grab
        FindReachTargetsMax: 3, // look for maximum reachable anchors for free arm and leg to grab
        Reach: 4, // use free arm and leg to grab reachable anchors
        GrabRope: 5, // grab pelvis where the rope is attached
        PlaceRopeAnchor: 6, // take rope from pelvis and attach it to the wall
    } as const,
);

export type ECLimbingState = (typeof ECLimbingState)[keyof typeof ECLimbingState];

const RaiseSpeed = 10.0;
const ReachSpeed = 10.0;

function flexLimb(
    skeleton: Skeleton,
    primaryJointIndex: number,
    secondaryJointIndex: number,
    primaryTargetAngle: number,
    secondaryTargetAngle: number,
    deltaTime: number,
    speed: number,
): number {
    const maxSpeed = Math.min(1.0, speed * deltaTime);
    const primaryDelta = (primaryTargetAngle - skeleton.phys.angularConstraints[primaryJointIndex]!.targetAngle) * maxSpeed;
    const secondaryDelta = (secondaryTargetAngle - skeleton.phys.angularConstraints[secondaryJointIndex]!.targetAngle) * maxSpeed;
    skeleton.phys.angularConstraints[primaryJointIndex]!.targetAngle += primaryDelta;
    skeleton.phys.angularConstraints[secondaryJointIndex]!.targetAngle += secondaryDelta;

    return Math.abs(primaryDelta) + Math.abs(secondaryDelta);
}

class ReachAngleDefinition {
    public targetAnchorIndex = -1;
    public sourceParticleIndex = -1;
    public limbLength = 0;
    public firstJointAngularConstraintsIndices: number[] = [];
    public secondJointAngularConstraintIndices: number[] = [];
    public grabParticleIndices: number[] = [];
    public grabConstraintIndices: number[] = [];
    public invertAngles = false;
}

// rad = ReachAngleDefinition
function updateLimbAngles(deltaTime: number, skeleton: Skeleton, wall: Wall, rad: ReachAngleDefinition): void {
    if (rad.targetAnchorIndex >= 0) {
        const sourceParticleState = skeleton.phys.particleStates[rad.sourceParticleIndex]!;
        const targetAnchor = wall.wallAnchors[rad.targetAnchorIndex]!;

        // try to reach target
        // compute elbow angle first based on distance -> shoulder angle is dependent on that

        const distance = GetDistance(targetAnchor.posX, targetAnchor.posY, sourceParticleState.posX, sourceParticleState.posY);

        const speed = Math.min(1.0, ReachSpeed * deltaTime);
        void speed;
        if (distance <= rad.limbLength) {
            let firstJointTargetAngle = 0.0;
            let secondJointTargetAngle = 0.0;
            if (!rad.invertAngles) {
                const secondJointTargetAngleRelative = -Math.asin(distance / rad.limbLength) * 2.0;
                secondJointTargetAngle = secondJointTargetAngleRelative + Math.PI * 2.0;

                // we only use parts of ac here, which are equal for both sides
                const firstJointAC = skeleton.phys.angularConstraints[rad.firstJointAngularConstraintsIndices[0]!]!;
                const firstJointTargetAngleRelative = GetAngleBetweenVertices(
                    skeleton.phys.particleStates[firstJointAC.particleIndex0]!,
                    skeleton.phys.particleStates[firstJointAC.particleIndex1]!,
                    targetAnchor,
                );
                firstJointTargetAngle = firstJointTargetAngleRelative - ((Math.PI + secondJointTargetAngleRelative) * 0.5);
            } else {
                const secondJointTargetAngleRelative = Math.asin(distance / rad.limbLength) * 2.0;
                secondJointTargetAngle = secondJointTargetAngleRelative;

                // we only use parts of ac here, which are equal for both sides
                const firstJointAC = skeleton.phys.angularConstraints[rad.firstJointAngularConstraintsIndices[0]!]!;
                const firstJointTargetAngleRelative = GetAngleBetweenVertices(
                    skeleton.phys.particleStates[firstJointAC.particleIndex0]!,
                    skeleton.phys.particleStates[firstJointAC.particleIndex1]!,
                    targetAnchor,
                );
                firstJointTargetAngle = firstJointTargetAngleRelative - ((Math.PI + secondJointTargetAngleRelative) * 0.5) + Math.PI;
            }

            for (let n = 0; n < rad.grabConstraintIndices.length; n++) {
                if (!skeleton.phys.fixedConstraints[rad.grabConstraintIndices[n]!]!.isEnabled) {
                    flexLimb(
                        skeleton,
                        rad.firstJointAngularConstraintsIndices[n]!,
                        rad.secondJointAngularConstraintIndices[n]!,
                        firstJointTargetAngle,
                        secondJointTargetAngle,
                        deltaTime,
                        ReachSpeed,
                    );
                }
            }
        }

        // test whether we reached our target
        let allHaveReachedTarget = true;
        let maxAnchorIndex = -1;
        for (let n = 0; n < rad.grabConstraintIndices.length; n++) {
            const fc = skeleton.phys.fixedConstraints[rad.grabConstraintIndices[n]!]!;
            if (!fc.isEnabled) {
                const handParticle = skeleton.phys.particleStates[rad.grabParticleIndices[n]!]!;
                const deltaX = targetAnchor.posX - handParticle.posX;
                const deltaY = targetAnchor.posY - handParticle.posY;
                const distanceSqr = deltaX * deltaX + deltaY * deltaY;

                if (distanceSqr < 3.0) {
                    fc.isEnabled = true;
                    fc.wallAnchorIndex = targetAnchor.index;
                    fc.posX = targetAnchor.posX;
                    fc.posY = targetAnchor.posY;

                    maxAnchorIndex = fc.wallAnchorIndex;
                } else {
                    allHaveReachedTarget = false;
                }
            }
        }
        if (allHaveReachedTarget) {
            rad.targetAnchorIndex = -1;

            // let go anchors from other limb
            for (const grabConstraintIndex of rad.grabConstraintIndices) {
                const fc = skeleton.phys.fixedConstraints[grabConstraintIndex]!;

                if (fc.isEnabled && fc.wallAnchorIndex < maxAnchorIndex) {
                    fc.isEnabled = false;
                }
            }
        }
    }
}

export class ClimbingAI {
    public rope: Rope; ///< Rope the player is using to secure fall.
    public wall: Wall; ///< Wall the pawn is attached to.
    public skeleton: Skeleton; ///< Skeleton used to animate the player pawn.
    public gameState: number; ///< Current Game Type

    public currentStrength = 0.0;

    ///< Current climbing state
    public climbingState: number = ECLimbingState.Raise;
    public climbedDistance = 0;
    public climbingPosX = 0;
    public climbingPosY = 0;
    public ropeLengtheningRemainder = 0;

    public maximumArmReachDistanceSqr = 0.0;
    public maximumLegReachDistanceSqr = 0.0;

    public targetHandAnchorIndex = -1;
    public targetFootAnchorIndex = -1;

    public constructor(rope: Rope, wall: Wall, skeleton: Skeleton, gameState: number) {
        this.rope = rope;
        this.wall = wall;
        this.skeleton = skeleton;
        this.gameState = gameState;

        this.initialize();
    }

    public update(deltaTime: number): void {
        this.currentStrength = this.currentStrength * Math.pow(0.5, deltaTime);

        this.updateBodyFlexion(deltaTime);

        if (this.climbingState === ECLimbingState.Raise) {
            this.updateRaise(deltaTime);
        } else if (
            this.climbingState === ECLimbingState.FindReachTargets ||
            this.climbingState === ECLimbingState.FindReachTargetsMax ||
            this.climbingState === ECLimbingState.Reach
        ) {
            this.updateReach(deltaTime);
        }
    }

    public draw(_ctx: CanvasRenderingContext2D, _cam: import("./Camera.ts").Camera): void {
    }

    public applyStrength(strength: number): void {
        this.currentStrength += strength;
    }

    public updateRaise(deltaTime: number): void {
        let raised = false;
        let accumulatedDelta = 0.0;
        for (let n = 0; n < this.skeleton.handGrabConstraintIndex.length; n++) {
            if (this.skeleton.phys.fixedConstraints[this.skeleton.handGrabConstraintIndex[n]!]!.isEnabled) {
                // flex arm based on shape of the wall (to better reach next anchors)
                let targetAngleOffset = 0.0;
                const wallAnchorIndex = this.skeleton.phys.fixedConstraints[this.skeleton.handGrabConstraintIndex[n]!]!.wallAnchorIndex;
                if (wallAnchorIndex >= 0) {
                    const topAnchor = this.wall.wallAnchors[wallAnchorIndex + 2]!;
                    const middleAnchor = this.wall.wallAnchors[wallAnchorIndex]!;
                    const bottomAnchor = this.wall.wallAnchors[wallAnchorIndex - 2]!;

                    const wallAngle = GetAngleBetweenVertices(bottomAnchor, middleAnchor, topAnchor);
                    targetAngleOffset = (Math.PI - wallAngle) * 0.5;
                    if (targetAngleOffset > Math.PI * 0.25) targetAngleOffset = Math.PI * 0.25;
                }

                accumulatedDelta += flexLimb(this.skeleton, this.skeleton.shoulderACIndex[n]!, this.skeleton.elbowACIndex[n]!, Math.PI * 0.3 - targetAngleOffset, Math.PI * 1.7 + targetAngleOffset, deltaTime, RaiseSpeed);
                raised = true;
            }
        }
        for (let n = 0; n < this.skeleton.footGrabConstraintIndex.length; n++) {
            if (this.skeleton.phys.fixedConstraints[this.skeleton.footGrabConstraintIndex[n]!]!.isEnabled) {
                // flex leg based on shape of the wall (to better reach next anchors)
                let targetAngleOffset = 0.0;
                const wallAnchorIndex = this.skeleton.phys.fixedConstraints[this.skeleton.footGrabConstraintIndex[n]!]!.wallAnchorIndex;
                if (wallAnchorIndex >= 0) {
                    const topAnchor = this.wall.wallAnchors[wallAnchorIndex + 5]!;
                    const middleAnchor = this.wall.wallAnchors[wallAnchorIndex + 1]!;
                    const bottomAnchor = this.wall.wallAnchors[wallAnchorIndex - 2]!;

                    const wallAngle = GetAngleBetweenVertices(bottomAnchor, middleAnchor, topAnchor);
                    targetAngleOffset = Math.PI - wallAngle;
                    if (targetAngleOffset > 0.0) targetAngleOffset *= 0.5;
                    if (targetAngleOffset > Math.PI * 0.2) targetAngleOffset = Math.PI * 0.2;
                }

                accumulatedDelta += flexLimb(this.skeleton, this.skeleton.hipJointACIndex[n]!, this.skeleton.kneeJointACIndex[n]!, Math.PI * 1.3 - targetAngleOffset, Math.PI * 0.7 + targetAngleOffset, deltaTime, RaiseSpeed);
                raised = true;
            }
        }
        if (raised) {
            if (accumulatedDelta < 0.01) {
                this.climbingState = ECLimbingState.FindReachTargets;

                const newClimbingPosX = this.skeleton.phys.particleStates[this.skeleton.pelvisParticleIndex]!.posX;
                const newClimbingPosY = this.skeleton.phys.particleStates[this.skeleton.pelvisParticleIndex]!.posY;

                const distanceClimbed = GetDistance(newClimbingPosX, newClimbingPosY, this.climbingPosX, this.climbingPosY);
                this.climbedDistance += distanceClimbed;
                this.ropeLengtheningRemainder += distanceClimbed;

                this.climbingPosX = newClimbingPosX;
                this.climbingPosY = newClimbingPosY;

                while (this.ropeLengtheningRemainder >= this.rope.ropeSegmentLength) {
                    this.rope.lengthenEnd();
                    this.ropeLengtheningRemainder -= this.rope.ropeSegmentLength;
                }
            }
        } else {
            this.climbingState = ECLimbingState.None;
        }
    }

    public updateReach(deltaTime: number): void {
        let numSteps = (this.gameState & EGameState.Demo) ? 3 : 0;

        if (this.gameState & EGameState.Game && this.currentStrength > 0.0) {
            numSteps = Math.round(this.currentStrength + 0.5);
        }

        while (numSteps > 0) {
            if (this.updateReachTargets(deltaTime, numSteps)) {
                this.currentStrength = 0.0;
                break;
            }
            numSteps--;
        }

        this.updateReachLimbAngles(deltaTime);
    }

    public updateReachTargets(deltaTime: number, anchorIndexOffset: number): boolean {
        void deltaTime;
        // Constraints of this algorithm:
        // Limbs have to have a joint at the center of maximum length reachable (armlength & leglength)
        // otherwise we would have to add a minimum distance an anchor has to be away from source joint

        if (this.climbingState !== ECLimbingState.FindReachTargets && this.climbingState !== ECLimbingState.FindReachTargetsMax) {
            return true;
        }

        if (this.targetHandAnchorIndex === -1) {
            // look whether next arm anchor is in reach of neckParticleState

            let maxHandWallAnchorIndex = -1;
            for (const constraintIndex of this.skeleton.handGrabConstraintIndex) {
                if (this.skeleton.phys.fixedConstraints[constraintIndex]!.isEnabled) {
                    maxHandWallAnchorIndex = Math.max(maxHandWallAnchorIndex, this.skeleton.phys.fixedConstraints[constraintIndex]!.wallAnchorIndex);
                }
            }

            const neckParticleState = this.skeleton.phys.particleStates[this.skeleton.neckParticleIndex]!;

            const nextHandAnchor = this.wall.wallAnchors[maxHandWallAnchorIndex + anchorIndexOffset]!;

            const deltaX = nextHandAnchor.posX - neckParticleState.posX;
            const deltaY = nextHandAnchor.posY - neckParticleState.posY;
            const distanceSqr = deltaX * deltaX + deltaY * deltaY;

            if (distanceSqr <= this.maximumArmReachDistanceSqr) {
                this.targetHandAnchorIndex = nextHandAnchor.index;
            }
        }

        if (this.targetFootAnchorIndex === -1) {
            // look whether next foot anchors are in reach of buttocksParticleState
            let maxFootWallAnchorIndex = -1;
            for (const constraintIndex of this.skeleton.footGrabConstraintIndex) {
                if (this.skeleton.phys.fixedConstraints[constraintIndex]!.isEnabled) {
                    maxFootWallAnchorIndex = Math.max(maxFootWallAnchorIndex, this.skeleton.phys.fixedConstraints[constraintIndex]!.wallAnchorIndex);
                }
            }

            const buttocksParticleState = this.skeleton.phys.particleStates[this.skeleton.buttocksParticleIndex]!;

            const nextFootAnchor = this.wall.wallAnchors[maxFootWallAnchorIndex + anchorIndexOffset]!;

            const deltaX = nextFootAnchor.posX - buttocksParticleState.posX;
            const deltaY = nextFootAnchor.posY - buttocksParticleState.posY;
            const distanceSqr = deltaX * deltaX + deltaY * deltaY;

            if (distanceSqr <= this.maximumLegReachDistanceSqr) {
                this.targetFootAnchorIndex = nextFootAnchor.index;
            }
        }

        // we found only one target for all limbs with given distance, remove target
        if (this.targetHandAnchorIndex < 0 || this.targetFootAnchorIndex < 0) {
            this.targetHandAnchorIndex = -1;
            this.targetFootAnchorIndex = -1;
            return false;
        }

        // we found targets for all limbs, start moving
        if (this.targetHandAnchorIndex >= 0 && this.targetFootAnchorIndex >= 0) {
            this.climbingState = ECLimbingState.Reach;
            return true;
        }

        return false;
    }

    public updateReachLimbAngles(deltaTime: number): void {
        if (this.climbingState !== ECLimbingState.Reach) {
            return;
        }

        this.updateReachArmAngles(deltaTime);
        this.updateReachLegAngles(deltaTime);

        // we reached our targets, lets get higher
        if (this.targetHandAnchorIndex === -1 && this.targetFootAnchorIndex === -1) {
            this.climbingState = ECLimbingState.Raise;
        }
    }

    public updateReachArmAngles(deltaTime: number): void {
        const reachArmAngleDefinition = new ReachAngleDefinition();
        reachArmAngleDefinition.targetAnchorIndex = this.targetHandAnchorIndex;
        reachArmAngleDefinition.sourceParticleIndex = this.skeleton.neckParticleIndex;
        reachArmAngleDefinition.limbLength = this.skeleton.armlength;
        reachArmAngleDefinition.firstJointAngularConstraintsIndices = this.skeleton.shoulderACIndex;
        reachArmAngleDefinition.secondJointAngularConstraintIndices = this.skeleton.elbowACIndex;
        reachArmAngleDefinition.grabParticleIndices = this.skeleton.handParticleIndex;
        reachArmAngleDefinition.grabConstraintIndices = this.skeleton.handGrabConstraintIndex;
        reachArmAngleDefinition.invertAngles = false;

        updateLimbAngles(deltaTime, this.skeleton, this.wall, reachArmAngleDefinition);

        this.targetHandAnchorIndex = reachArmAngleDefinition.targetAnchorIndex;
    }

    public updateReachLegAngles(deltaTime: number): void {
        const reachLegAngleDefinition = new ReachAngleDefinition();
        reachLegAngleDefinition.targetAnchorIndex = this.targetFootAnchorIndex;
        reachLegAngleDefinition.sourceParticleIndex = this.skeleton.buttocksParticleIndex;
        reachLegAngleDefinition.limbLength = this.skeleton.leglength;
        reachLegAngleDefinition.firstJointAngularConstraintsIndices = this.skeleton.hipJointACIndex;
        reachLegAngleDefinition.secondJointAngularConstraintIndices = this.skeleton.kneeJointACIndex;
        reachLegAngleDefinition.grabParticleIndices = this.skeleton.footParticleIndex;
        reachLegAngleDefinition.grabConstraintIndices = this.skeleton.footGrabConstraintIndex;
        reachLegAngleDefinition.invertAngles = true;

        updateLimbAngles(deltaTime, this.skeleton, this.wall, reachLegAngleDefinition);

        this.targetFootAnchorIndex = reachLegAngleDefinition.targetAnchorIndex;
    }

    // bow body according to shape of the wall (looks more natural)
    public updateBodyFlexion(_deltaTime: number): void {
        if (this.targetHandAnchorIndex === -1 || this.targetFootAnchorIndex === -1) {
            return;
        }

        const handAnchor = this.wall.wallAnchors[this.targetHandAnchorIndex + 2]!;
        const footAnchor = this.wall.wallAnchors[this.targetFootAnchorIndex - 1]!;

        //var middleAnchorIndex = footAnchor.index + Math.floor((handAnchor.index - footAnchor.index) / 2);
        const middleAnchor = this.wall.wallAnchors[footAnchor.index + 1]!;

        const wallAngle = GetAngleBetweenVertices(footAnchor, middleAnchor, handAnchor);
        const angleAdaptionStrength = (wallAngle < Math.PI) ? 1.0 : 1.0;

        this.skeleton.phys.angularConstraints[this.skeleton.backACIndex[0]!]!.targetAngle = Math.PI - (Math.PI - wallAngle) * 0.4 * angleAdaptionStrength;
        this.skeleton.phys.angularConstraints[this.skeleton.backACIndex[1]!]!.targetAngle = Math.PI - (Math.PI - wallAngle) * 0.4 * angleAdaptionStrength;
        this.skeleton.phys.angularConstraints[this.skeleton.backACIndex[2]!]!.targetAngle = Math.PI - (Math.PI - wallAngle) * 0.2 * angleAdaptionStrength;
    }

    public initialize(): void {
        this.climbingPosX = this.skeleton.phys.particleStates[this.skeleton.pelvisParticleIndex]!.posX;
        this.climbingPosY = this.skeleton.phys.particleStates[this.skeleton.pelvisParticleIndex]!.posY;

        this.maximumArmReachDistanceSqr = Math.pow(this.skeleton.armlength * 0.95, 2); // reduced to be safe
        this.maximumLegReachDistanceSqr = Math.pow(this.skeleton.leglength * 0.95, 2); // reduced to be safe
    }
}
