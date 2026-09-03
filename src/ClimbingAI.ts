import type { Camera } from "./Camera.ts";
import type { Rope } from "./Rope.ts";
import type { Skeleton } from "./Skeleton.ts";
import type { Wall, WallAnchor } from "./Wall.ts";
import { defined } from "./assert.ts";

export const ClimbingState = {
    None: 0,
    Coil: 1,
    Push: 2,
    Reach: 3,
} as const;

export type ClimbingState = (typeof ClimbingState)[keyof typeof ClimbingState];

type LimbKind = "hand" | "foot";

const GRAB_RADIUS = 8;
const REACH_ANGLE_SPEED = 10;
const COIL_ELBOW_ANGLE = Math.PI * 1.65;
const HUG_SHOULDER_ANGLE = Math.PI * 0.5;
const COIL_HIP_ANGLE = Math.PI * 1.12;
const COIL_KNEE_ANGLE = Math.PI * 0.5;
const REACH_ELBOW_ANGLE = Math.PI * 1.08;
const PUSH_HIP_ANGLE = Math.PI * 1.05;
const HIGH_KNEE_ANGLE = Math.PI * 0.45;
const ELBOW_MIN_ANGLE = Math.PI * 1.02;
const ELBOW_MAX_ANGLE = Math.PI * 1.85;
const HIP_MIN_ANGLE = Math.PI * 0.95;
const HIP_MAX_ANGLE = Math.PI * 1.25;
const REACH_HIP_ANGLE = Math.PI * 1.55;
const REACH_HIP_MIN_ANGLE = Math.PI * 1.05;
const REACH_HIP_MAX_ANGLE = Math.PI * 1.85;
const KNEE_MIN_ANGLE = Math.PI * 0.35;
const KNEE_MAX_ANGLE = Math.PI * 0.95;
const STRAIGHT_SPINE_ANGLE = Math.PI;
const BODY_PULL = 12;
const WALL_HUG_DISTANCE = 8;
const WALL_HUG_STRENGTH = 18;
const MIN_HAND_STEP = 4;
const MIN_FOOT_STEP = 4;
const MAX_HAND_STEP = 18;
const MAX_HAND_RECOVERY_STEP = 32;
const MAX_FOOT_STEP = 16;
const HAND_FOOT_SEPARATION = 10;
const MIN_HAND_FOOT_SEPARATION = 14;
const OPTIMAL_HAND_FOOT_SEPARATION = 20;
const MAX_HAND_FOOT_SEPARATION = 30;
const MIN_PUSH_LIFT = 3;
const PUSH_STRAIGHTEN_DURATION = 0.92;
const MAX_PUSH_TIME = 1.23;
const COIL_LEG_LENGTH_FACTOR = 0.92;
const PUSH_LEG_LENGTH_FACTOR = 0.98;
const MAX_COIL_TIME = 0.45;
const MAX_REACH_TIME = 2.2;
const PUSH_LEG_TIGHTNESS = 8;
const SUPPORT_LEG_TIGHTNESS = 6;
const FREE_LEG_TIGHTNESS = 8;
const PLANTED_ARM_TIGHTNESS = 3;
const FREE_ARM_TIGHTNESS = 8;
const LIMB_REACH_PULL = 90;
const LIMB_REACH_TRAVEL = 7;

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

function lerpAngle(
    current: number,
    target: number,
    deltaTime: number,
    speed = REACH_ANGLE_SPEED,
): number {
    const delta = shortestAngleDelta(current, target);
    return wrapAngle(current + delta * Math.min(1, deltaTime * speed));
}

function distanceSqr(x0: number, y0: number, x1: number, y1: number): number {
    const dx = x1 - x0;
    const dy = y1 - y0;
    return dx * dx + dy * dy;
}

function clampRange(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function smoothstep(value: number): number {
    const t = clampRange(value, 0, 1);
    return t * t * (3 - 2 * t);
}

function blendAngle(from: number, to: number, t: number): number {
    return wrapAngle(from + shortestAngleDelta(from, to) * clampRange(t, 0, 1));
}

function currentConstraintAngle(skeleton: Skeleton, constraintIndex: number): number {
    const constraint = defined(
        skeleton.phys.angularConstraints[constraintIndex],
        "Missing angular constraint",
    );
    const state0 = defined(
        skeleton.phys.particleStates[constraint.particleIndex0],
        "Missing angular particle 0",
    );
    const state1 = defined(
        skeleton.phys.particleStates[constraint.particleIndex1],
        "Missing angular particle 1",
    );
    const state2 = defined(
        skeleton.phys.particleStates[constraint.particleIndex2],
        "Missing angular particle 2",
    );
    return wrapAngle(
        Math.atan2(state0.posY - state1.posY, state0.posX - state1.posX) -
        Math.atan2(state2.posY - state1.posY, state2.posX - state1.posX),
    );
}

function moveJointAngle(
    current: number,
    target: number,
    deltaTime: number,
    minAngle?: number,
    maxAngle?: number,
    speed = REACH_ANGLE_SPEED,
): number {
    let next = lerpAngle(current, target, deltaTime, speed);
    if (minAngle !== undefined && maxAngle !== undefined) {
        next = clampRange(next, minAngle, maxAngle);
    }
    return next;
}

function poseArm(
    skeleton: Skeleton,
    sideIndex: number,
    elbowTarget: number,
    shoulderTarget: number,
    deltaTime: number,
): number {
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
    elbow.targetAngle = moveJointAngle(previousElbow, elbowTarget, deltaTime, ELBOW_MIN_ANGLE, ELBOW_MAX_ANGLE);
    shoulder.targetAngle = moveJointAngle(previousShoulder, shoulderTarget, deltaTime);
    return (
        Math.abs(shortestAngleDelta(previousElbow, elbow.targetAngle)) +
        Math.abs(shortestAngleDelta(previousShoulder, shoulder.targetAngle))
    );
}

function poseLeg(
    skeleton: Skeleton,
    sideIndex: number,
    hipTarget: number,
    kneeTarget: number,
    deltaTime: number,
    hipMin = HIP_MIN_ANGLE,
    hipMax = HIP_MAX_ANGLE,
    kneeSpeed = REACH_ANGLE_SPEED,
): number {
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
    hip.targetAngle = moveJointAngle(previousHip, hipTarget, deltaTime, hipMin, hipMax);
    knee.targetAngle = moveJointAngle(
        previousKnee,
        kneeTarget,
        deltaTime,
        KNEE_MIN_ANGLE,
        KNEE_MAX_ANGLE,
        kneeSpeed,
    );
    return (
        Math.abs(shortestAngleDelta(previousHip, hip.targetAngle)) +
        Math.abs(shortestAngleDelta(previousKnee, knee.targetAngle))
    );
}

function posePlantedPush(
    skeleton: Skeleton,
    progress: number,
    startHipAngle: readonly [number, number],
    startKneeAngle: readonly [number, number],
    deltaTime: number,
): number {
    let accumulatedDelta = 0;
    let posed = false;
    for (let side = 0; side < 2; side++) {
        if (skeleton.isGrabbing("hand", side)) {
            accumulatedDelta += poseArm(skeleton, side, COIL_ELBOW_ANGLE, HUG_SHOULDER_ANGLE, deltaTime);
            posed = true;
        }
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
        hip.targetAngle = clampRange(
            blendAngle(defined(startHipAngle[side], "Missing start hip angle"), PUSH_HIP_ANGLE, progress),
            HIP_MIN_ANGLE,
            HIP_MAX_ANGLE,
        );
        knee.targetAngle = clampRange(
            blendAngle(defined(startKneeAngle[side], "Missing start knee angle"), KNEE_MAX_ANGLE, progress),
            KNEE_MIN_ANGLE,
            KNEE_MAX_ANGLE,
        );
        accumulatedDelta +=
            Math.abs(shortestAngleDelta(previousHip, hip.targetAngle)) +
            Math.abs(shortestAngleDelta(previousKnee, knee.targetAngle));
        posed = true;
    }
    return posed ? accumulatedDelta : -1;
}

function posePlantedArms(skeleton: Skeleton, deltaTime: number): number {
    let accumulatedDelta = 0;
    for (let side = 0; side < 2; side++) {
        if (skeleton.isGrabbing("hand", side)) {
            accumulatedDelta += poseArm(skeleton, side, COIL_ELBOW_ANGLE, HUG_SHOULDER_ANGLE, deltaTime);
        }
    }
    return accumulatedDelta;
}

function poseFreeArms(skeleton: Skeleton, deltaTime: number): number {
    let accumulatedDelta = 0;
    for (let side = 0; side < 2; side++) {
        if (skeleton.isGrabbing("hand", side)) {
            continue;
        }
        accumulatedDelta += poseArm(skeleton, side, COIL_ELBOW_ANGLE, HUG_SHOULDER_ANGLE, deltaTime);
    }
    return accumulatedDelta;
}

function poseSupportLegs(skeleton: Skeleton, deltaTime: number): number {
    let accumulatedDelta = 0;
    for (let side = 0; side < 2; side++) {
        if (!skeleton.isGrabbing("foot", side)) {
            continue;
        }
        accumulatedDelta += poseLeg(skeleton, side, COIL_HIP_ANGLE, COIL_KNEE_ANGLE, deltaTime);
    }
    return accumulatedDelta;
}

function poseFreeLegs(skeleton: Skeleton, deltaTime: number): number {
    let accumulatedDelta = 0;
    for (let side = 0; side < 2; side++) {
        if (skeleton.isGrabbing("foot", side)) {
            continue;
        }
        accumulatedDelta += poseLeg(
            skeleton,
            side,
            REACH_HIP_ANGLE,
            HIGH_KNEE_ANGLE,
            deltaTime,
            REACH_HIP_MIN_ANGLE,
            REACH_HIP_MAX_ANGLE,
        );
    }
    return accumulatedDelta;
}

function poseSpine(skeleton: Skeleton, deltaTime: number): number {
    let accumulatedDelta = 0;
    for (const constraintIndex of skeleton.backACIndex) {
        const constraint = defined(
            skeleton.phys.angularConstraints[constraintIndex],
            "Missing back angular constraint",
        );
        const previous = constraint.targetAngle;
        constraint.targetAngle = moveJointAngle(previous, STRAIGHT_SPINE_ANGLE, deltaTime);
        constraint.tightnessFactor = 8;
        accumulatedDelta += Math.abs(shortestAngleDelta(previous, constraint.targetAngle));
    }
    return accumulatedDelta;
}

function setLegTightness(skeleton: Skeleton, plantedFactor: number, freeFactor = plantedFactor): void {
    for (let side = 0; side < 2; side++) {
        const hip = defined(
            skeleton.phys.angularConstraints[defined(skeleton.hipJointACIndex[side], "Missing hip index")],
            "Missing hip constraint",
        );
        const knee = defined(
            skeleton.phys.angularConstraints[defined(skeleton.kneeJointACIndex[side], "Missing knee index")],
            "Missing knee constraint",
        );
        const tightnessFactor = skeleton.isGrabbing("foot", side) ? plantedFactor : freeFactor;
        hip.tightnessFactor = tightnessFactor;
        knee.tightnessFactor = tightnessFactor;
    }
}

function setArmTightness(skeleton: Skeleton, plantedFactor: number, freeFactor = plantedFactor): void {
    for (let side = 0; side < 2; side++) {
        const shoulder = defined(
            skeleton.phys.angularConstraints[defined(skeleton.shoulderACIndex[side], "Missing shoulder index")],
            "Missing shoulder constraint",
        );
        const elbow = defined(
            skeleton.phys.angularConstraints[defined(skeleton.elbowACIndex[side], "Missing elbow index")],
            "Missing elbow constraint",
        );
        const tightnessFactor = skeleton.isGrabbing("hand", side) ? plantedFactor : freeFactor;
        shoulder.tightnessFactor = tightnessFactor;
        elbow.tightnessFactor = tightnessFactor;
    }
}

function buttocksY(skeleton: Skeleton): number {
    return defined(skeleton.phys.particleStates[skeleton.buttocksParticleIndex], "Missing buttocks particle").posY;
}

function capturePlantedLegAngles(skeleton: Skeleton): {
    hips: [number, number];
    knees: [number, number];
} {
    const hips: [number, number] = [COIL_HIP_ANGLE, COIL_HIP_ANGLE];
    const knees: [number, number] = [HIGH_KNEE_ANGLE, HIGH_KNEE_ANGLE];
    for (let side = 0; side < 2; side++) {
        hips[side] = currentConstraintAngle(
            skeleton,
            defined(skeleton.hipJointACIndex[side], "Missing hip index"),
        );
        knees[side] = currentConstraintAngle(
            skeleton,
            defined(skeleton.kneeJointACIndex[side], "Missing knee index"),
        );
    }
    return { hips, knees };
}

function pullParticleToward(
    particle: { velX: number; velY: number; posX: number; posY: number },
    targetX: number,
    targetY: number,
    desiredDistance: number,
    deltaTime: number,
): void {
    const dx = targetX - particle.posX;
    const dy = targetY - particle.posY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 0.001) {
        return;
    }
    const error = distance - desiredDistance;
    const strength = BODY_PULL * deltaTime;
    particle.velX += (dx / distance) * error * strength;
    particle.velY += (dy / distance) * error * strength;
}

function hugWall(skeleton: Skeleton, deltaTime: number): void {
    const particleIndices = [
        skeleton.buttocksParticleIndex,
        skeleton.pelvisParticleIndex,
        skeleton.neckParticleIndex,
    ];
    const strength = WALL_HUG_STRENGTH * deltaTime;
    for (const particleIndex of particleIndices) {
        const particle = defined(skeleton.phys.particleStates[particleIndex], "Missing body particle");
        const wallX = skeleton.wall.wallXAtY(particle.posY);
        if (wallX === undefined) {
            continue;
        }
        particle.velX += (wallX - WALL_HUG_DISTANCE - particle.posX) * strength;
    }
}

function pullBodyTowardHolds(skeleton: Skeleton, extensionBlend: number, deltaTime: number): void {
    hugWall(skeleton, deltaTime);

    const buttocks = defined(
        skeleton.phys.particleStates[skeleton.buttocksParticleIndex],
        "Missing buttocks particle",
    );
    const legDistance =
        skeleton.leglength *
        (COIL_LEG_LENGTH_FACTOR +
            (PUSH_LEG_LENGTH_FACTOR - COIL_LEG_LENGTH_FACTOR) * clampRange(extensionBlend, 0, 1));

    for (let side = 0; side < 2; side++) {
        if (!skeleton.isGrabbing("foot", side)) {
            continue;
        }
        const foot = skeleton.limbParticle("foot", side);
        pullParticleToward(buttocks, foot.posX, foot.posY, legDistance, deltaTime);
    }
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

function grabHoldYs(skeleton: Skeleton, wall: Wall, kind: LimbKind): number[] {
    const holdYs: number[] = [];
    for (let side = 0; side < 2; side++) {
        const constraint = skeleton.grabConstraint(kind, side);
        if (!constraint.isEnabled) {
            continue;
        }
        const planted = wall.wallAnchors[constraint.wallAnchorIndex];
        if (planted === undefined) {
            continue;
        }
        holdYs.push(planted.posY);
    }
    return holdYs;
}

function closestHandFootGap(kind: LimbKind, anchorY: number, oppositeYs: readonly number[]): number | undefined {
    if (oppositeYs.length === 0) {
        return undefined;
    }

    let closestGap = Number.POSITIVE_INFINITY;
    for (const oppositeY of oppositeYs) {
        const gap = kind === "foot" ? anchorY - oppositeY : oppositeY - anchorY;
        if (gap < closestGap) {
            closestGap = gap;
        }
    }
    return closestGap;
}

function isHandFootSeparationOk(kind: LimbKind, anchorY: number, oppositeYs: readonly number[]): boolean {
    const gap = closestHandFootGap(kind, anchorY, oppositeYs);
    if (gap === undefined) {
        return true;
    }
    if (kind === "hand") {
        return gap >= MIN_HAND_FOOT_SEPARATION;
    }
    return gap >= MIN_HAND_FOOT_SEPARATION && gap <= MAX_HAND_FOOT_SEPARATION;
}

function minHoldGap(handYs: readonly number[], footYs: readonly number[]): number | undefined {
    if (handYs.length === 0 || footYs.length === 0) {
        return undefined;
    }
    let minGap = Number.POSITIVE_INFINITY;
    for (const handY of handYs) {
        for (const footY of footYs) {
            const gap = Math.abs(footY - handY);
            if (gap < minGap) {
                minGap = gap;
            }
        }
    }
    return minGap;
}

function travelParticleToward(
    particle: { velX: number; velY: number; posX: number; posY: number },
    targetX: number,
    targetY: number,
    deltaTime: number,
): void {
    const dx = targetX - particle.posX;
    const dy = targetY - particle.posY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 0.001) {
        return;
    }
    const step = Math.min(1, deltaTime * LIMB_REACH_TRAVEL);
    particle.posX += dx * step;
    particle.posY += dy * step;
    particle.velX += (dx / distance) * LIMB_REACH_PULL * deltaTime;
    particle.velY += (dy / distance) * LIMB_REACH_PULL * deltaTime;
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

    const preferredDistal = kind === "hand" ? REACH_ELBOW_ANGLE : HIGH_KNEE_ANGLE;
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
    if (kind === "hand") {
        proximalConstraint.targetAngle = moveJointAngle(previousProximal, desiredProximal, deltaTime);
        distalConstraint.targetAngle = moveJointAngle(
            previousDistal,
            desiredDistal,
            deltaTime,
            ELBOW_MIN_ANGLE,
            ELBOW_MAX_ANGLE,
        );
        proximalConstraint.tightnessFactor = FREE_ARM_TIGHTNESS;
        distalConstraint.tightnessFactor = FREE_ARM_TIGHTNESS;
    } else {
        proximalConstraint.targetAngle = moveJointAngle(
            previousProximal,
            desiredProximal,
            deltaTime,
            REACH_HIP_MIN_ANGLE,
            REACH_HIP_MAX_ANGLE,
        );
        distalConstraint.targetAngle = moveJointAngle(
            previousDistal,
            desiredDistal,
            deltaTime,
            KNEE_MIN_ANGLE,
            KNEE_MAX_ANGLE,
        );
        proximalConstraint.tightnessFactor = FREE_LEG_TIGHTNESS;
        distalConstraint.tightnessFactor = FREE_LEG_TIGHTNESS;
    }

    const limb = skeleton.limbParticle(kind, sideIndex);
    travelParticleToward(limb, target.posX, target.posY, deltaTime);

    return (
        Math.abs(shortestAngleDelta(previousProximal, proximalConstraint.targetAngle)) +
        Math.abs(shortestAngleDelta(previousDistal, distalConstraint.targetAngle))
    );
}

export class ClimbingAI {
    public rope: Rope;
    public skeleton: Skeleton;
    public wall: Wall;
    public climbinState: ClimbingState = ClimbingState.Coil;
    public targetHandAnchorIndex = -1;
    public pushStartHipAngle: [number, number] = [COIL_HIP_ANGLE, COIL_HIP_ANGLE];
    public pushStartKneeAngle: [number, number] = [HIGH_KNEE_ANGLE, HIGH_KNEE_ANGLE];
    public targetFootAnchorIndex = -1;
    public pushElapsed = 0;
    public pushStartButtocksY = 0;
    public coilElapsed = 0;
    public reachElapsed = 0;

    public constructor(rope: Rope, wall: Wall, skeleton: Skeleton) {
        this.rope = rope;
        this.wall = wall;
        this.skeleton = skeleton;
    }

    public update(deltaTime: number): void {
        if (this.climbinState === ClimbingState.Coil) {
            this.updateCoil(deltaTime);
            return;
        }
        if (this.climbinState === ClimbingState.Push) {
            this.updatePush(deltaTime);
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
        this.pushElapsed = 0;
        this.coilElapsed = 0;
        this.reachElapsed = 0;
    }

    public draw(_ctx: CanvasRenderingContext2D, _cam: Camera): void { }

    public updateCoil(deltaTime: number): void {
        if (!this.hasAnyGrab()) {
            this.climbinState = ClimbingState.None;
            return;
        }

        if (!this.needsHandSeparationRecovery()) {
            releaseLowerLimbIfBothPlanted(this.skeleton, "foot");
        }

        this.coilElapsed += deltaTime;
        setArmTightness(this.skeleton, PLANTED_ARM_TIGHTNESS, FREE_ARM_TIGHTNESS);
        setLegTightness(this.skeleton, SUPPORT_LEG_TIGHTNESS, FREE_LEG_TIGHTNESS);
        pullBodyTowardHolds(this.skeleton, 0, deltaTime);
        this.updateReachTargets(deltaTime);
        const plantedDelta =
            poseSpine(this.skeleton, deltaTime) +
            posePlantedArms(this.skeleton, deltaTime) +
            poseSupportLegs(this.skeleton, deltaTime);
        this.updateReachLimbAngles(deltaTime);
        if (this.targetHandAnchorIndex < 0) {
            poseFreeArms(this.skeleton, deltaTime);
        }
        if (this.targetFootAnchorIndex < 0 && !this.needsHandSeparationRecovery()) {
            poseFreeLegs(this.skeleton, deltaTime);
        }
        if (this.needsHandSeparationRecovery()) {
            this.reachElapsed = 0;
            this.climbinState = ClimbingState.Reach;
            return;
        }
        if ((plantedDelta < 0.01 && this.coilElapsed > 0.12) || this.coilElapsed >= MAX_COIL_TIME) {
            this.reachElapsed = 0;
            this.climbinState = ClimbingState.Reach;
        }
    }

    public updatePush(deltaTime: number): void {
        if (this.pushElapsed === 0) {
            this.pushStartButtocksY = buttocksY(this.skeleton);
            const startAngles = capturePlantedLegAngles(this.skeleton);
            this.pushStartHipAngle = startAngles.hips;
            this.pushStartKneeAngle = startAngles.knees;
        }
        this.pushElapsed += deltaTime;
        const straightenProgress = smoothstep(this.pushElapsed / PUSH_STRAIGHTEN_DURATION);

        releaseLowerLimbIfBothPlanted(this.skeleton, "hand");
        if (!this.needsHandSeparationRecovery()) {
            releaseLowerLimbIfBothPlanted(this.skeleton, "foot");
        }
        setArmTightness(this.skeleton, PLANTED_ARM_TIGHTNESS, FREE_ARM_TIGHTNESS);
        setLegTightness(this.skeleton, PUSH_LEG_TIGHTNESS, FREE_LEG_TIGHTNESS);
        pullBodyTowardHolds(this.skeleton, straightenProgress, deltaTime);

        const plantedDelta = posePlantedPush(
            this.skeleton,
            straightenProgress,
            this.pushStartHipAngle,
            this.pushStartKneeAngle,
            deltaTime,
        );
        if (plantedDelta < 0) {
            this.pushElapsed = 0;
            this.climbinState = ClimbingState.None;
            return;
        }

        poseSpine(this.skeleton, deltaTime);
        poseFreeArms(this.skeleton, deltaTime);
        if (!this.needsHandSeparationRecovery()) {
            poseFreeLegs(this.skeleton, deltaTime);
        }

        if (this.needsHandSeparationRecovery()) {
            this.targetHandAnchorIndex = -1;
            this.targetFootAnchorIndex = -1;
            this.pushElapsed = 0;
            this.coilElapsed = 0;
            this.reachElapsed = 0;
            this.climbinState = ClimbingState.Reach;
            return;
        }

        const hipsRose = this.pushStartButtocksY - buttocksY(this.skeleton) >= MIN_PUSH_LIFT;
        if ((straightenProgress >= 1 && hipsRose) || this.pushElapsed >= MAX_PUSH_TIME) {
            this.targetHandAnchorIndex = -1;
            this.targetFootAnchorIndex = -1;
            this.pushElapsed = 0;
            this.coilElapsed = 0;
            this.climbinState = ClimbingState.Coil;
        }
    }

    public updateReachTargets(_deltaTime?: number): void {
        this.restoreHandFootSeparation();

        if (!this.isCurrentTargetValid("hand")) {
            this.targetHandAnchorIndex = -1;
        }
        if (this.targetHandAnchorIndex === -1) {
            this.targetHandAnchorIndex = this.findReachableAnchor("hand");
        }

        if (this.needsHandSeparationRecovery()) {
            this.targetFootAnchorIndex = -1;
        } else if (!this.isCurrentTargetValid("foot")) {
            this.targetFootAnchorIndex = -1;
            this.targetFootAnchorIndex = this.findReachableAnchor("foot");
        } else if (this.targetFootAnchorIndex === -1) {
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

        if (this.targetFootAnchorIndex >= 0 && !this.needsHandSeparationRecovery()) {
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

        this.reachElapsed += deltaTime;
        this.updateReachTargets(deltaTime);
        pullBodyTowardHolds(this.skeleton, 0, deltaTime);
        this.updateReachLimbAngles(deltaTime);
        setArmTightness(this.skeleton, PLANTED_ARM_TIGHTNESS, FREE_ARM_TIGHTNESS);
        setLegTightness(this.skeleton, SUPPORT_LEG_TIGHTNESS, FREE_LEG_TIGHTNESS);
        poseSpine(this.skeleton, deltaTime);
        posePlantedArms(this.skeleton, deltaTime);
        poseSupportLegs(this.skeleton, deltaTime);
        if (this.targetHandAnchorIndex < 0) {
            poseFreeArms(this.skeleton, deltaTime);
        }
        if (this.targetFootAnchorIndex < 0 && !this.needsHandSeparationRecovery()) {
            poseFreeLegs(this.skeleton, deltaTime);
        }

        const grabbedHand = this.tryGrabLimb("hand");
        const grabbedFoot = this.needsHandSeparationRecovery() ? false : this.tryGrabLimb("foot");
        if (!this.needsHandSeparationRecovery()) {
            releaseLowerLimbIfBothPlanted(this.skeleton, "foot");
        }
        if (this.needsHandSeparationRecovery()) {
            this.reachElapsed = Math.min(this.reachElapsed, MAX_REACH_TIME * 0.5);
            return;
        }
        if (this.reachCycleComplete(grabbedHand || grabbedFoot) || this.reachElapsed >= MAX_REACH_TIME) {
            this.targetHandAnchorIndex = -1;
            this.targetFootAnchorIndex = -1;
            this.pushElapsed = 0;
            this.reachElapsed = 0;
            this.climbinState = ClimbingState.Push;
        }
    }

    private findReachableAnchor(kind: LimbKind): number {
        if (this.skeleton.findFreeSide(kind) < 0) {
            return -1;
        }
        return this.pickReachableAnchor(kind);
    }

    private plantedHoldYs(kind: LimbKind): number[] {
        return grabHoldYs(this.skeleton, this.wall, kind);
    }

    private currentHoldYs(kind: LimbKind): number[] {
        const holdYs = this.plantedHoldYs(kind);
        const targetIndex = kind === "hand" ? this.targetHandAnchorIndex : this.targetFootAnchorIndex;
        if (targetIndex >= 0) {
            const target = this.wall.wallAnchors[targetIndex];
            if (target !== undefined) {
                holdYs.push(target.posY);
            }
        }
        return holdYs;
    }

    private plantedHandFootGap(): number | undefined {
        return minHoldGap(this.plantedHoldYs("hand"), this.plantedHoldYs("foot"));
    }

    private needsHandSeparationRecovery(): boolean {
        const gap = this.plantedHandFootGap();
        return gap !== undefined && gap < MIN_HAND_FOOT_SEPARATION;
    }

    private crowdedHandSide(): number {
        const footYs = this.currentHoldYs("foot");
        if (footYs.length === 0) {
            return -1;
        }

        let crowdedSide = -1;
        let crowdedGap = Number.POSITIVE_INFINITY;
        for (let side = 0; side < 2; side++) {
            const constraint = this.skeleton.grabConstraint("hand", side);
            if (!constraint.isEnabled) {
                continue;
            }
            const planted = this.wall.wallAnchors[constraint.wallAnchorIndex];
            if (planted === undefined) {
                continue;
            }
            const gap = closestHandFootGap("hand", planted.posY, footYs);
            if (gap !== undefined && gap < crowdedGap) {
                crowdedGap = gap;
                crowdedSide = side;
            }
        }
        return crowdedGap < MIN_HAND_FOOT_SEPARATION ? crowdedSide : -1;
    }

    private restoreHandFootSeparation(): void {
        if (!this.needsHandSeparationRecovery()) {
            return;
        }

        this.targetFootAnchorIndex = -1;
        const crowdedSide = this.crowdedHandSide();
        if (crowdedSide >= 0 && this.skeleton.findFreeSide("hand") < 0) {
            this.skeleton.release("hand", crowdedSide);
        }
        if (this.skeleton.findFreeSide("hand") < 0) {
            return;
        }
        if (this.targetHandAnchorIndex >= 0) {
            const target = this.wall.wallAnchors[this.targetHandAnchorIndex];
            if (target !== undefined && isHandFootSeparationOk("hand", target.posY, this.currentHoldYs("foot"))) {
                return;
            }
            this.targetHandAnchorIndex = -1;
        }
    }

    private oppositeHoldYs(kind: LimbKind): number[] {
        const opposite: LimbKind = kind === "hand" ? "foot" : "hand";
        const holdYs = grabHoldYs(this.skeleton, this.wall, opposite);
        const targetIndex = opposite === "hand" ? this.targetHandAnchorIndex : this.targetFootAnchorIndex;
        if (targetIndex >= 0) {
            const target = this.wall.wallAnchors[targetIndex];
            if (target !== undefined) {
                holdYs.push(target.posY);
            }
        }
        return holdYs;
    }

    private pickReachableAnchor(kind: LimbKind): number {
        const freeSide = this.skeleton.findFreeSide(kind);
        const limb = freeSide >= 0 ? this.skeleton.limbParticle(kind, freeSide) : undefined;
        const minIndex = maxEnabledWallAnchorIndex(this.skeleton, kind) + 1;
        const plantedY = this.highestPlantedY(kind);
        const oppositeYs = this.oppositeHoldYs(kind);
        const recoveringHands = kind === "hand" && this.needsHandSeparationRecovery();
        const minStep = kind === "hand" ? MIN_HAND_STEP : MIN_FOOT_STEP;
        const maxStep = recoveringHands
            ? MAX_HAND_RECOVERY_STEP
            : kind === "hand"
                ? MAX_HAND_STEP
                : MAX_FOOT_STEP;
        const minY = plantedY - minStep;
        const maxY = plantedY - maxStep;

        let bestIndex = -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        let fallbackIndex = -1;
        let fallbackScore = Number.NEGATIVE_INFINITY;

        for (let index = minIndex; index < this.wall.wallAnchors.length; index++) {
            const anchor = this.wall.wallAnchors[index];
            if (anchor === undefined) {
                continue;
            }
            if (anchor.posY >= minY) {
                continue;
            }
            if (anchor.posY < maxY) {
                break;
            }

            const limbDistanceSqr =
                limb === undefined
                    ? 0
                    : distanceSqr(limb.posX, limb.posY, anchor.posX, anchor.posY);
            const step = plantedY - anchor.posY;
            const gap = closestHandFootGap(kind, anchor.posY, oppositeYs);
            const gapPenalty = gap === undefined
                ? 0
                : recoveringHands
                    ? Math.max(0, MIN_HAND_FOOT_SEPARATION - gap) * 20
                    : Math.abs(gap - OPTIMAL_HAND_FOOT_SEPARATION) * 6;
            const score = -step * 8 - limbDistanceSqr * 0.05 - gapPenalty;
            if (score > fallbackScore) {
                fallbackScore = score;
                fallbackIndex = anchor.index;
            }
            if (!isHandFootSeparationOk(kind, anchor.posY, oppositeYs)) {
                continue;
            }
            if (score > bestScore) {
                bestScore = score;
                bestIndex = anchor.index;
            }
        }

        if (bestIndex >= 0) {
            return bestIndex;
        }
        if (kind === "foot") {
            return -1;
        }
        if (fallbackIndex < 0) {
            return -1;
        }
        const fallback = this.wall.wallAnchors[fallbackIndex];
        if (fallback !== undefined && !isHandFootSeparationOk(kind, fallback.posY, oppositeYs)) {
            return -1;
        }
        return fallbackIndex;
    }

    private isCurrentTargetValid(kind: LimbKind): boolean {
        const targetIndex = kind === "hand" ? this.targetHandAnchorIndex : this.targetFootAnchorIndex;
        if (targetIndex < 0) {
            return false;
        }
        const anchor = this.wall.wallAnchors[targetIndex];
        if (anchor === undefined) {
            return false;
        }
        const plantedY = this.highestPlantedY(kind);
        const step = plantedY - anchor.posY;
        const minStep = kind === "hand" ? MIN_HAND_STEP : MIN_FOOT_STEP;
        const maxStep = kind === "hand" && this.needsHandSeparationRecovery()
            ? MAX_HAND_RECOVERY_STEP
            : kind === "hand"
                ? MAX_HAND_STEP
                : MAX_FOOT_STEP;
        if (step < minStep || step > maxStep) {
            return false;
        }
        return isHandFootSeparationOk(kind, anchor.posY, this.oppositeHoldYs(kind));
    }

    private highestPlantedY(kind: LimbKind): number {
        let found = false;
        let highestY = 0;
        for (let side = 0; side < 2; side++) {
            const constraint = this.skeleton.grabConstraint(kind, side);
            if (!constraint.isEnabled) {
                continue;
            }
            const planted = this.wall.wallAnchors[constraint.wallAnchorIndex];
            if (planted === undefined) {
                continue;
            }
            highestY = found ? Math.min(highestY, planted.posY) : planted.posY;
            found = true;
        }
        if (found) {
            return highestY;
        }

        if (kind === "foot") {
            return originParticle(this.skeleton, "foot").posY + HAND_FOOT_SEPARATION;
        }
        return originParticle(this.skeleton, "hand").posY;
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
        if (distanceSqr(limb.posX, limb.posY, anchor.posX, anchor.posY) > GRAB_RADIUS * GRAB_RADIUS) {
            return false;
        }
        if (!isHandFootSeparationOk(kind, anchor.posY, this.oppositeHoldYs(kind))) {
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
