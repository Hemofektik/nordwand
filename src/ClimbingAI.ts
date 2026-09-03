import type { Camera } from "./Camera.ts";
import type { Rope } from "./Rope.ts";
import type { Skeleton } from "./Skeleton.ts";
import type { Wall, WallAnchor } from "./Wall.ts";
import { defined } from "./assert.ts";

export const ClimbingState = {
    Idle: 0,
    Push: 1,
    HandReach: 2,
    HandSettle: 3,
    LegReach: 4,
    LegSettle: 5,
} as const;

export type ClimbingState = (typeof ClimbingState)[keyof typeof ClimbingState];

type LimbKind = "hand" | "foot";

// --- timing ---
const PUSH_TIME = 0.9;
const REACH_TIMEOUT = 2.5;
const SETTLE_TIME = 0.18;
const STUCK_LOG_INTERVAL = 2;
const DEBUG = true;

// --- grabbing ---
const GRAB_RADIUS = 8;
const GRAB_RADIUS_WIDE = 16;
const WIDE_GRAB_AFTER = 1.2;

// --- pose angles ---
const STRAIGHT_HIP_ANGLE = Math.PI;
const STRAIGHT_KNEE_ANGLE = Math.PI * 0.95;
const COIL_HIP_ANGLE = Math.PI * 1.12;
const COIL_KNEE_ANGLE = Math.PI * 0.5;
const OVERHEAD_SHOULDER_ANGLE = Math.PI * 0.92;
const STRAIGHT_ELBOW_ANGLE = Math.PI * 1.04;
const FLEX_SHOULDER_ANGLE = Math.PI * 0.55;
const FLEX_ELBOW_ANGLE = Math.PI * 1.5;
const ELBOW_MIN_ANGLE = Math.PI * 1.02;
const ELBOW_MAX_ANGLE = Math.PI * 1.85;
const KNEE_MIN_ANGLE = Math.PI * 0.35;
const KNEE_MAX_ANGLE = Math.PI * 0.95;
const STRAIGHT_SPINE_ANGLE = Math.PI;

// --- forces ---
const ANGLE_SPEED = 10;
const BODY_PULL = 10;
const WALL_HUG_DISTANCE = 6;
const WALL_HUG_STRENGTH = 14;
const LIMB_REACH_PULL = 90;
const LIMB_REACH_TRAVEL = 7;
const PLANTED_TIGHTNESS = 8;
const FREE_TIGHTNESS = 4;

// --- step selection ---
const MIN_STEP = 4;

const STATE_NAMES: Record<ClimbingState, string> = {
    [ClimbingState.Idle]: "Idle",
    [ClimbingState.Push]: "Push",
    [ClimbingState.HandReach]: "HandReach",
    [ClimbingState.HandSettle]: "HandSettle",
    [ClimbingState.LegReach]: "LegReach",
    [ClimbingState.LegSettle]: "LegSettle",
};

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

function lerpAngle(current: number, target: number, deltaTime: number, speed = ANGLE_SPEED): number {
    const delta = shortestAngleDelta(current, target);
    return wrapAngle(current + delta * Math.min(1, deltaTime * speed));
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

function distanceSqr(x0: number, y0: number, x1: number, y1: number): number {
    const dx = x1 - x0;
    const dy = y1 - y0;
    return dx * dx + dy * dy;
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
): number {
    let next = lerpAngle(current, target, deltaTime);
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
): void {
    const elbow = defined(
        skeleton.phys.angularConstraints[defined(skeleton.elbowACIndex[sideIndex], "Missing elbow index")],
        "Missing elbow constraint",
    );
    const shoulder = defined(
        skeleton.phys.angularConstraints[defined(skeleton.shoulderACIndex[sideIndex], "Missing shoulder index")],
        "Missing shoulder constraint",
    );
    elbow.targetAngle = moveJointAngle(elbow.targetAngle, elbowTarget, deltaTime, ELBOW_MIN_ANGLE, ELBOW_MAX_ANGLE);
    shoulder.targetAngle = moveJointAngle(shoulder.targetAngle, shoulderTarget, deltaTime);
}

function poseLeg(
    skeleton: Skeleton,
    sideIndex: number,
    hipTarget: number,
    kneeTarget: number,
    deltaTime: number,
): void {
    const hip = defined(
        skeleton.phys.angularConstraints[defined(skeleton.hipJointACIndex[sideIndex], "Missing hip index")],
        "Missing hip constraint",
    );
    const knee = defined(
        skeleton.phys.angularConstraints[defined(skeleton.kneeJointACIndex[sideIndex], "Missing knee index")],
        "Missing knee constraint",
    );
    hip.targetAngle = moveJointAngle(hip.targetAngle, hipTarget, deltaTime);
    knee.targetAngle = moveJointAngle(knee.targetAngle, kneeTarget, deltaTime, KNEE_MIN_ANGLE, KNEE_MAX_ANGLE);
}

function poseSpine(skeleton: Skeleton, deltaTime: number): void {
    for (let i = 0; i < skeleton.backACIndex.length; i++) {
        const constraint = defined(
            skeleton.phys.angularConstraints[defined(skeleton.backACIndex[i], "Missing back index")],
            "Missing back angular constraint",
        );
        constraint.targetAngle = moveJointAngle(constraint.targetAngle, STRAIGHT_SPINE_ANGLE, deltaTime);
    }
}

function setLimbTightness(skeleton: Skeleton, kind: LimbKind, plantedSide: number): void {
    const indices = kind === "hand"
        ? [skeleton.shoulderACIndex, skeleton.elbowACIndex]
        : [skeleton.hipJointACIndex, skeleton.kneeJointACIndex];
    for (let side = 0; side < 2; side++) {
        const tightness = side === plantedSide ? PLANTED_TIGHTNESS : FREE_TIGHTNESS;
        for (const indexList of indices) {
            const constraintIndex = defined(indexList[side], `Missing ${kind} joint index`);
            const constraint = defined(
                skeleton.phys.angularConstraints[constraintIndex],
                `Missing ${kind} joint constraint`,
            );
            constraint.tightnessFactor = tightness;
        }
    }
}

function originParticle(skeleton: Skeleton, kind: LimbKind) {
    const particleIndex = kind === "hand" ? skeleton.neckParticleIndex : skeleton.buttocksParticleIndex;
    const message = kind === "hand" ? "Missing neck particle" : "Missing buttocks particle";
    return defined(skeleton.phys.particleStates[particleIndex], message);
}

function captureLegAngles(skeleton: Skeleton, side: number): { hip: number; knee: number } {
    return {
        hip: currentConstraintAngle(skeleton, defined(skeleton.hipJointACIndex[side], "Missing hip index")),
        knee: currentConstraintAngle(skeleton, defined(skeleton.kneeJointACIndex[side], "Missing knee index")),
    };
}

function pullParticleTowardY(
    particle: { velY: number; posY: number },
    targetY: number,
    desiredDistance: number,
    deltaTime: number,
): void {
    const error = Math.abs(targetY - particle.posY) - desiredDistance;
    const direction = targetY < particle.posY ? -1 : 1;
    particle.velY += direction * error * BODY_PULL * deltaTime;
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

function pullBodyTowardFeet(skeleton: Skeleton, extensionBlend: number, deltaTime: number): void {
    hugWall(skeleton, deltaTime);
    const buttocks = defined(
        skeleton.phys.particleStates[skeleton.buttocksParticleIndex],
        "Missing buttocks particle",
    );
    const legDistance = skeleton.leglength * (0.92 + 0.08 * clampRange(extensionBlend, 0, 1));
    for (let side = 0; side < 2; side++) {
        if (!skeleton.isGrabbing("foot", side)) {
            continue;
        }
        const plantedFoot = skeleton.limbParticle("foot", side);
        pullParticleTowardY(buttocks, plantedFoot.posY, legDistance, deltaTime);
    }
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
): void {
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

    const preferredDistal = kind === "hand" ? STRAIGHT_ELBOW_ANGLE : COIL_KNEE_ANGLE;
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

    if (kind === "hand") {
        proximalConstraint.targetAngle = moveJointAngle(proximalConstraint.targetAngle, desiredProximal, deltaTime);
        distalConstraint.targetAngle = moveJointAngle(
            distalConstraint.targetAngle,
            desiredDistal,
            deltaTime,
            ELBOW_MIN_ANGLE,
            ELBOW_MAX_ANGLE,
        );
    } else {
        proximalConstraint.targetAngle = moveJointAngle(proximalConstraint.targetAngle, desiredProximal, deltaTime);
        distalConstraint.targetAngle = moveJointAngle(
            distalConstraint.targetAngle,
            desiredDistal,
            deltaTime,
            KNEE_MIN_ANGLE,
            KNEE_MAX_ANGLE,
        );
    }

    const limb = skeleton.limbParticle(kind, sideIndex);
    const dx = target.posX - limb.posX;
    const dy = target.posY - limb.posY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 0.001) {
        return;
    }
    const step = Math.min(1, deltaTime * LIMB_REACH_TRAVEL);
    limb.posX += dx * step;
    limb.posY += dy * step;
    limb.velX += (dx / distance) * LIMB_REACH_PULL * deltaTime;
    limb.velY += (dy / distance) * LIMB_REACH_PULL * deltaTime;
}

/**
 * Deterministic climbing cycle:
 *   1. Push      - the flexed (drive) leg extends and pushes the body up.
 *   2. HandReach - the free arm extends up, latches a new anchor, then the old
 *      support arm releases.
 *   3. LegReach  - the free leg flexes up, latches a new anchor, then the old
 *      drive leg releases.
 *   4. Back to Push with swapped limbs.
 */
export class ClimbingAI {
    public rope: Rope;
    public skeleton: Skeleton;
    public wall: Wall;
    public state: ClimbingState = ClimbingState.Idle;
    public driveLegSide = 1;
    public supportArmSide = 0;
    public handTargetIndex = -1;
    public legTargetIndex = -1;
    public phaseElapsed = 0;
    public grabCount = 0;
    public pushStartHip = COIL_HIP_ANGLE;
    public pushStartKnee = COIL_KNEE_ANGLE;
    public handReachTime = 0;
    public legReachTime = 0;
    public stuckLogTimer = 0;
    public recentlyReleased = new Map<number, number>();

    public constructor(rope: Rope, wall: Wall, skeleton: Skeleton) {
        this.rope = rope;
        this.wall = wall;
        this.skeleton = skeleton;
    }

    public update(deltaTime: number): void {
        if (!this.hasAnyGrab()) {
            if (this.state !== ClimbingState.Idle) {
                this.log("no grabs left -> Idle");
                this.state = ClimbingState.Idle;
                this.resetTargets();
            }
            return;
        }
        if (this.state === ClimbingState.Idle) {
            this.initializeFromGrabs();
        }

        this.phaseElapsed += deltaTime;
        setLimbTightness(this.skeleton, "hand", this.supportArmSide);
        setLimbTightness(this.skeleton, "foot", this.driveLegSide);
        poseSpine(this.skeleton, deltaTime);
        pullBodyTowardFeet(this.skeleton, this.state === ClimbingState.Push ? this.pushProgress() : 1, deltaTime);

        switch (this.state) {
            case ClimbingState.Push:
                this.updatePush(deltaTime);
                break;
            case ClimbingState.HandReach:
                this.updateHandReach(deltaTime);
                break;
            case ClimbingState.HandSettle:
                this.poseCycle(deltaTime);
                if (this.phaseElapsed >= SETTLE_TIME) {
                    this.beginPhase(ClimbingState.LegReach);
                }
                break;
            case ClimbingState.LegReach:
                this.updateLegReach(deltaTime);
                break;
            case ClimbingState.LegSettle:
                this.poseCycle(deltaTime);
                if (this.phaseElapsed >= SETTLE_TIME) {
                    this.beginPush();
                }
                break;
            default:
                break;
        }

        if (this.phaseElapsed > STUCK_LOG_INTERVAL) {
            this.stuckLogTimer += deltaTime;
            if (this.stuckLogTimer >= STUCK_LOG_INTERVAL) {
                this.stuckLogTimer = 0;
                this.logStuck();
            }
        } else {
            this.stuckLogTimer = 0;
        }
    }

    public stopClimbing(): void {
        this.state = ClimbingState.Idle;
        this.resetTargets();
        this.phaseElapsed = 0;
    }

    public draw(_ctx: CanvasRenderingContext2D, _cam: Camera): void { }

    // --- phase transitions ---

    private initializeFromGrabs(): void {
        const plantedFoot = this.findPlantedSide("foot");
        const plantedHand = this.findPlantedSide("hand");
        this.driveLegSide = plantedFoot >= 0 ? plantedFoot : 1;
        this.supportArmSide = plantedHand >= 0 ? plantedHand : 0;
        this.resetTargets();
        this.log(`init: driveLeg=${this.driveLegSide} supportArm=${this.supportArmSide}`);
        this.beginPush();
    }

    private beginPush(): void {
        this.beginPhase(ClimbingState.Push);
        const angles = captureLegAngles(this.skeleton, this.driveLegSide);
        this.pushStartHip = angles.hip;
        this.pushStartKnee = angles.knee;
    }

    private beginPhase(phase: ClimbingState): void {
        this.state = phase;
        this.phaseElapsed = 0;
        this.handReachTime = 0;
        this.legReachTime = 0;
        this.log(`phase -> ${STATE_NAMES[phase]}`);
    }

    private pushProgress(): number {
        return smoothstep(this.phaseElapsed / PUSH_TIME);
    }

    private resetTargets(): void {
        this.handTargetIndex = -1;
        this.legTargetIndex = -1;
    }

    // --- phases ---

    private updatePush(deltaTime: number): void {
        const progress = this.pushProgress();
        this.poseCycle(deltaTime);

        // Drive leg extends from its captured (flexed) angles to straight.
        const hip = defined(
            this.skeleton.phys.angularConstraints[
                defined(this.skeleton.hipJointACIndex[this.driveLegSide], "Missing hip index")
            ],
            "Missing hip constraint",
        );
        const knee = defined(
            this.skeleton.phys.angularConstraints[
                defined(this.skeleton.kneeJointACIndex[this.driveLegSide], "Missing knee index")
            ],
            "Missing knee constraint",
        );
        hip.targetAngle = blendAngle(this.pushStartHip, STRAIGHT_HIP_ANGLE, progress);
        knee.targetAngle = blendAngle(this.pushStartKnee, STRAIGHT_KNEE_ANGLE, progress);

        if (this.phaseElapsed >= PUSH_TIME) {
            this.beginPhase(ClimbingState.HandReach);
        }
    }

    private updateHandReach(deltaTime: number): void {
        this.poseCycle(deltaTime);
        this.handReachTime += deltaTime;

        const freeSide = 1 - this.supportArmSide;
        if (this.handTargetIndex < 0) {
            this.handTargetIndex = this.chooseTarget("hand", freeSide, this.handReachTime > REACH_TIMEOUT);
        }
        const target = this.wall.wallAnchors[this.handTargetIndex];
        if (target === undefined) {
            this.handTargetIndex = -1;
            return;
        }
        aimLimbToward(this.skeleton, "hand", freeSide, target, deltaTime);

        const radius = this.handReachTime > WIDE_GRAB_AFTER ? GRAB_RADIUS_WIDE : GRAB_RADIUS;
        if (this.tryGrab("hand", freeSide, target, radius)) {
            this.releasePlanted("hand", this.supportArmSide);
            this.supportArmSide = freeSide;
            this.handTargetIndex = -1;
            this.beginPhase(ClimbingState.HandSettle);
        } else if (this.handReachTime >= REACH_TIMEOUT) {
            this.handTargetIndex = -1;
            this.handReachTime = 0;
        }
    }

    private updateLegReach(deltaTime: number): void {
        this.poseCycle(deltaTime);
        this.legReachTime += deltaTime;

        const freeSide = 1 - this.driveLegSide;
        if (this.legTargetIndex < 0) {
            this.legTargetIndex = this.chooseTarget("foot", freeSide, this.legReachTime > REACH_TIMEOUT);
        }
        const target = this.wall.wallAnchors[this.legTargetIndex];
        if (target === undefined) {
            this.legTargetIndex = -1;
            return;
        }
        aimLimbToward(this.skeleton, "foot", freeSide, target, deltaTime);

        const radius = this.legReachTime > WIDE_GRAB_AFTER ? GRAB_RADIUS_WIDE : GRAB_RADIUS;
        if (this.tryGrab("foot", freeSide, target, radius)) {
            this.releasePlanted("foot", this.driveLegSide);
            this.driveLegSide = freeSide;
            this.legTargetIndex = -1;
            this.beginPhase(ClimbingState.LegSettle);
        } else if (this.legReachTime >= REACH_TIMEOUT) {
            this.legTargetIndex = -1;
            this.legReachTime = 0;
        }
    }

    /**
     * Poses everything that is not the currently moving limb:
     * - support arm straight (overhead) during Push, flexed otherwise
     * - drive leg straight during reach phases
     * - free limbs coil up ready for their turn
     */
    private poseCycle(deltaTime: number): void {
        const reachingHandSide = this.state === ClimbingState.HandReach ? 1 - this.supportArmSide : -1;
        const reachingFootSide = this.state === ClimbingState.LegReach ? 1 - this.driveLegSide : -1;

        for (let side = 0; side < 2; side++) {
            if (side === reachingHandSide) {
                continue;
            }
            if (this.skeleton.isGrabbing("hand", side)) {
                const flexed = this.state !== ClimbingState.Push;
                poseArm(
                    this.skeleton,
                    side,
                    flexed ? FLEX_ELBOW_ANGLE : STRAIGHT_ELBOW_ANGLE,
                    flexed ? FLEX_SHOULDER_ANGLE : OVERHEAD_SHOULDER_ANGLE,
                    deltaTime,
                );
            } else {
                poseArm(this.skeleton, side, FLEX_ELBOW_ANGLE, FLEX_SHOULDER_ANGLE, deltaTime);
            }

            if (side === reachingFootSide) {
                continue;
            }
            if (this.skeleton.isGrabbing("foot", side)) {
                const straight = this.state !== ClimbingState.Push && side === this.driveLegSide;
                poseLeg(
                    this.skeleton,
                    side,
                    straight ? STRAIGHT_HIP_ANGLE : COIL_HIP_ANGLE,
                    straight ? STRAIGHT_KNEE_ANGLE : COIL_KNEE_ANGLE,
                    deltaTime,
                );
            } else {
                poseLeg(this.skeleton, side, COIL_HIP_ANGLE, COIL_KNEE_ANGLE, deltaTime);
            }
        }
    }

    // --- target selection ---

    private findPlantedSide(kind: LimbKind): number {
        for (let side = 0; side < 2; side++) {
            if (this.skeleton.isGrabbing(kind, side)) {
                return side;
            }
        }
        return -1;
    }

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

    private isBlacklisted(index: number): boolean {
        return this.recentlyReleased.has(index);
    }

    /**
     * Picks the next anchor for a limb: the nearest hold above the limb that
     * is within reach. When relaxed (timeout) the reach window is widened and
     * the "above" requirement softened so progress never stalls.
     */
    private chooseTarget(kind: LimbKind, side: number, relaxed: boolean): number {
        if (side < 0) {
            return -1;
        }
        const limb = this.skeleton.limbParticle(kind, side);
        const { proximal, distal } = boneLengths(this.skeleton, kind, side);
        const reachFactor = relaxed ? 1.35 : 1.0;
        const reachSqr = Math.pow((proximal + distal) * reachFactor, 2);
        const occupied = this.occupiedIndices();

        let bestIndex = -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const anchor of this.wall.wallAnchors) {
            if (occupied.has(anchor.index) || this.isBlacklisted(anchor.index)) {
                continue;
            }
            const step = limb.posY - anchor.posY;
            if (!relaxed && step < MIN_STEP) {
                continue;
            }
            const distSqr = distanceSqr(limb.posX, limb.posY, anchor.posX, anchor.posY);
            if (distSqr > reachSqr) {
                continue;
            }
            const distance = Math.sqrt(distSqr);
            const upwardBonus = relaxed ? Math.min(20, Math.max(0, step)) : 0;
            const score = -distance + upwardBonus;
            if (score > bestScore) {
                bestScore = score;
                bestIndex = anchor.index;
            }
        }

        if (DEBUG) {
            const best = bestIndex >= 0 ? this.wall.wallAnchors[bestIndex] : undefined;
            this.log(
                `choose ${kind} side=${side}${relaxed ? " relaxed" : ""} -> ${bestIndex}` +
                `${best !== undefined ? ` (y=${best.posY.toFixed(0)})` : " (none)"}`,
            );
        }
        return bestIndex;
    }

    private tryGrab(kind: LimbKind, side: number, anchor: WallAnchor, radius: number): boolean {
        const limb = this.skeleton.limbParticle(kind, side);
        if (distanceSqr(limb.posX, limb.posY, anchor.posX, anchor.posY) > radius * radius) {
            return false;
        }
        this.skeleton.grab(kind, side, anchor);
        this.grabCount++;
        this.log(`grab ${kind} side=${side} anchor=${anchor.index} y=${anchor.posY.toFixed(0)}`);
        return true;
    }

    private releasePlanted(kind: LimbKind, side: number): void {
        const constraint = this.skeleton.grabConstraint(kind, side);
        const anchorIndex = constraint.wallAnchorIndex;
        const anchor = this.wall.wallAnchors[anchorIndex];
        this.skeleton.release(kind, side);
        this.recentlyReleased.set(anchorIndex, this.grabCount);
        if (this.recentlyReleased.size > 6) {
            const oldest = [...this.recentlyReleased.entries()].sort((a, b) => a[1] - b[1])[0];
            if (oldest !== undefined) {
                this.recentlyReleased.delete(oldest[0]);
            }
        }
        this.log(
            `release ${kind} side=${side} anchor=${anchorIndex}` +
            ` y=${anchor !== undefined ? anchor.posY.toFixed(0) : "?"}`,
        );
    }

    private hasAnyGrab(): boolean {
        return (
            this.skeleton.isGrabbing("hand", 0) ||
            this.skeleton.isGrabbing("hand", 1) ||
            this.skeleton.isGrabbing("foot", 0) ||
            this.skeleton.isGrabbing("foot", 1)
        );
    }

    private log(message: string): void {
        if (DEBUG) {
            console.log(`[climb] ${message} grabs=${this.grabCount}`);
        }
    }

    private logStuck(): void {
        const hand0 = this.skeleton.isGrabbing("hand", 0) ? 1 : 0;
        const hand1 = this.skeleton.isGrabbing("hand", 1) ? 1 : 0;
        const foot0 = this.skeleton.isGrabbing("foot", 0) ? 1 : 0;
        const foot1 = this.skeleton.isGrabbing("foot", 1) ? 1 : 0;
        const targetHand = this.handTargetIndex >= 0 ? this.wall.wallAnchors[this.handTargetIndex] : undefined;
        const targetFoot = this.legTargetIndex >= 0 ? this.wall.wallAnchors[this.legTargetIndex] : undefined;
        console.log(
            `[climb-stuck] phase=${STATE_NAMES[this.state]} H${hand0}${hand1}/F${foot0}${foot1}` +
            ` driveLeg=${this.driveLegSide} supportArm=${this.supportArmSide}` +
            ` targetH=${this.handTargetIndex}${targetHand !== undefined ? `(y=${targetHand.posY.toFixed(0)})` : ""}` +
            ` targetF=${this.legTargetIndex}${targetFoot !== undefined ? `(y=${targetFoot.posY.toFixed(0)})` : ""}` +
            ` elapsed=${this.phaseElapsed.toFixed(2)}`,
        );
    }
}
