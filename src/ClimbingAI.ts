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
const PUSH_TIME = 1.6;
const REACH_TIMEOUT = 2.5;
const STUCK_LOG_INTERVAL = 2;
const DEBUG = true; // [DEBUG-a4f2] temporary test diagnosis

// --- grabbing ---
const GRAB_RADIUS = 8;
const REACH_FACTOR = 0.85;
// Relaxed picks may use the limb's full bone sum (no flex margin), but never
// more: an anchor beyond the bone sum cannot be touched by any joint pose, so
// chasing it only deadlocks the reach. The IK folds the limb for anything
// inside the disc.
const REACH_FACTOR_RELAXED = 1.0;

// --- pose angles ---
const STRAIGHT_HIP_ANGLE = Math.PI;
const STRAIGHT_KNEE_ANGLE = Math.PI * 0.95;
const COIL_HIP_ANGLE = Math.PI * 1.12;
const COIL_KNEE_ANGLE = Math.PI * 0.5;
const FREE_LEG_HIP_ANGLE = Math.PI * 1.3;
const FREE_LEG_KNEE_ANGLE = Math.PI * 0.4;
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
// Movement is angular-only: every body and limb position is reached by
// driving joint target angles (hip/knee/shoulder/elbow/spine). No direct
// velocity impulses on particles - the angular constraint solver propagates
// all forces through the limb chains.
const ANGLE_SPEED = 10;
const REACH_ANGLE_SPEED = 14;
const PLANTED_TIGHTNESS = 10;
// Planted limbs aim their IK at a target this fraction of the way from the
// limb origin to the anchor, so the solution pose is flexed (bent) rather
// than taut - the bend continuously hauls the body toward the hold.
const PLANTED_IK_SCALE = 0.85;

// --- step selection ---
// Natural small steps: the free limb reaches only a few anchors past its
// latched partner limb (anchor spacing is ~5px). Leaping 5+ anchors looks
// unnatural and sends the limb beyond full extension, where it stalls.
const MAX_ANCHOR_STEPS = 3;
const MAX_ANCHOR_STEPS_RELAXED = 5;
// Anti-flicker blacklist expires after this much sim time. Grab-count-based
// expiry deadlocks: once nothing can be grabbed, grabCount freezes and the
// entries can never age out, walling off the whole neighborhood.
const BLACKLIST_SECONDS = 3;

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
    speed = ANGLE_SPEED,
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

function setLimbTightness(skeleton: Skeleton, kind: LimbKind): void {
    const indices = kind === "hand"
        ? [skeleton.shoulderACIndex, skeleton.elbowACIndex]
        : [skeleton.hipJointACIndex, skeleton.kneeJointACIndex];
    for (let side = 0; side < 2; side++) {
        // Reaching limbs need at least the planted tightness: with only 6 the
        // angular solver cannot swing the free limb against the body weight
        // and the foot stalls ~14px from its anchor at full extension.
        const tightness = PLANTED_TIGHTNESS;
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

    // For feet, keep the continuity-based bend side: forcing the knee
    // outward ratchets the climb downward (the fold must adapt to each hold).

    // For feet the knee must fold on the OUTWARD side (smaller x - away from
    // the -x-facing wall). Bend-side continuity otherwise locks the knee on
    // the wall side, pushing the foot past the anchor and stalling the reach
    // a few pixels short forever.
    if (preferOutwardKnee) {
        return jointA.x <= jointB.x ? jointA : jointB;
    }

    // Near full extension both solutions nearly coincide and the
    // preferred-angle comparison flips between frames, making the joint
    // wiggle. Prefer solution continuity: keep the bend side closest to where
    // the joint currently is (fallback: preferred angle).
    if (currentJointX !== undefined && currentJointY !== undefined) {
        const distA = distanceSqr(currentJointX, currentJointY, jointA.x, jointA.y);
        const distB = distanceSqr(currentJointX, currentJointY, jointB.x, jointB.y);
        if (Math.abs(distA - distB) > 1.0) {
            return distA < distB ? jointA : jointB;
        }
    }
    return errorA <= errorB ? jointA : jointB;
}

/**
 * Aims a limb at a virtual target scaled from the limb ORIGIN toward the
 * anchor. Used for planted limbs: the anchor itself can sit beyond max
 * extension when the body hangs taut, and its IK then only ever says
 * "straighten more". A shortened target is inside reach and its IK solution
 * bends the limb, pulling the body toward the anchor.
 */
function aimLimbTowardOriginScaled(
    skeleton: Skeleton,
    kind: LimbKind,
    sideIndex: number,
    anchor: WallAnchor,
    scale: number,
    deltaTime: number,
): void {
    const origin = originParticle(skeleton, kind);
    const virtualTarget: WallAnchor = {
        posX: origin.posX + (anchor.posX - origin.posX) * scale,
        posY: origin.posY + (anchor.posY - origin.posY) * scale,
        index: anchor.index,
    };
    aimLimbToward(skeleton, kind, sideIndex, virtualTarget, deltaTime);
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
    // Current mid-joint (elbow/knee) position, so the IK keeps the same bend
    // side frame-to-frame instead of flipping near full extension.
    const jointConstraintIndex = defined(
        kind === "hand" ? skeleton.elbowACIndex[sideIndex] : skeleton.kneeJointACIndex[sideIndex],
        `Missing ${kind} distal joint index`,
    );
    const jointConstraint = defined(
        skeleton.phys.angularConstraints[jointConstraintIndex],
        `Missing ${kind} distal angular constraint`,
    );
    const jointParticle = defined(
        skeleton.phys.particleStates[jointConstraint.particleIndex1],
        `Missing ${kind} joint particle`,
    );
    const joint = bentJointPosition(
        origin.posX,
        origin.posY,
        target.posX,
        target.posY,
        proximal,
        distal,
        preferredDistal,
        kind === "foot",
        jointParticle.posX,
        jointParticle.posY,
    );
    const desiredProximal = jointAngle(root.posX, root.posY, origin.posX, origin.posY, joint.x, joint.y);
    const desiredDistal = jointAngle(origin.posX, origin.posY, joint.x, joint.y, target.posX, target.posY);

    // The limb is driven entirely by the angular constraints: recompute the
    // ideal joint angles from scratch each frame and move the targets toward
    // them. Recomputing (instead of lerping from the previous target) avoids
    // lagging behind the moving body, and the angle speed caps how fast the
    // limb swings so the motion stays smooth.
    if (kind === "hand") {
        proximalConstraint.targetAngle = moveJointAngle(
            proximalConstraint.targetAngle,
            desiredProximal,
            deltaTime,
            undefined,
            undefined,
            REACH_ANGLE_SPEED,
        );
        distalConstraint.targetAngle = moveJointAngle(
            distalConstraint.targetAngle,
            desiredDistal,
            deltaTime,
            ELBOW_MIN_ANGLE,
            ELBOW_MAX_ANGLE,
            REACH_ANGLE_SPEED * 1.5,
        );
    } else {
        // Foot reach, flex-first: while the foot is far from the target the
        // knee folds up (COIL) so the foot lifts off its old hold; the full
        // geometric IK takes over once the foot is near the anchor. Driving
        // the pure IK solution from far away keeps the knee near-straight and
        // the foot never flexes onto the hold.
        const endParticle = defined(
            skeleton.phys.particleStates[distalConstraint.particleIndex2],
            "Missing foot end particle",
        );
        const footToTarget = Math.sqrt(
            distanceSqr(endParticle.posX, endParticle.posY, target.posX, target.posY),
        );
        if (footToTarget > GRAB_RADIUS * 2) {
            // Fold the knee toward the target: hip perpendicular to the
            // origin->target direction, on the side that lifts the foot UP
            // (hip 0 = knee straight above the buttocks, PI = straight down).
            const dirToTarget = Math.atan2(target.posY - origin.posY, target.posX - origin.posX);
            const flexedHip = wrapAngle(dirToTarget + Math.PI * 0.5);
            proximalConstraint.targetAngle = moveJointAngle(
                proximalConstraint.targetAngle,
                flexedHip,
                deltaTime,
                undefined,
                undefined,
                REACH_ANGLE_SPEED,
            );
            distalConstraint.targetAngle = moveJointAngle(
                distalConstraint.targetAngle,
                COIL_KNEE_ANGLE,
                deltaTime,
                KNEE_MIN_ANGLE,
                KNEE_MAX_ANGLE,
                REACH_ANGLE_SPEED * 1.5,
            );
        } else {
            // Pure geometric IK for the leg. Because targets are chosen within
            // 85% reach of the buttocks, the law-of-cosines solution is exactly
            // the flexed pose needed to place the foot on the hold: a close
            // anchor yields a strongly bent hip+knee, a far one a straighter leg.
            // (A fixed "step pose" deadlocks: the knee never extends, so the
            // foot never comes within grab radius.)
            proximalConstraint.targetAngle = moveJointAngle(
                proximalConstraint.targetAngle,
                desiredProximal,
                deltaTime,
                undefined,
                undefined,
                REACH_ANGLE_SPEED,
            );
            distalConstraint.targetAngle = moveJointAngle(
                distalConstraint.targetAngle,
                desiredDistal,
                deltaTime,
                KNEE_MIN_ANGLE,
                KNEE_MAX_ANGLE,
                REACH_ANGLE_SPEED * 1.5,
            );
        }
    }
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
    public footPreviewTargetIndex: [number, number] = [-1, -1];
    public handPreviewTargetIndex: [number, number] = [-1, -1];
    public phaseElapsed = 0;
    public grabCount = 0;
    public pushStartHip = COIL_HIP_ANGLE;
    public pushStartKnee = COIL_KNEE_ANGLE;
    public handReachTime = 0;
    public legReachTime = 0;
    public pushElapsed = 0;
    public stuckLogTimer = 0;
    public recentlyReleased = new Map<number, number>();
    public clock = 0;
    private lastLegRepick = -1;
    /** Last leg target the AI aimed at; survives the latch so observers
     *  never miss a reach that completes within a single update. */
    public lastLegTargetIndex = -1;
    public lastHandTargetIndex = -1;

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
        this.pushElapsed += deltaTime;
        this.clock += deltaTime;
        setLimbTightness(this.skeleton, "hand");
        setLimbTightness(this.skeleton, "foot");
        poseSpine(this.skeleton, deltaTime);

        // The drive leg keeps extending through the whole cycle so the body
        // rises continuously while hands and legs reach.
        this.applyDriveLegExtension(deltaTime);

        switch (this.state) {
            case ClimbingState.Push:
                this.updatePush(deltaTime);
                break;
            case ClimbingState.HandReach:
                this.updateHandReach(deltaTime);
                break;
            case ClimbingState.LegReach:
                this.updateLegReach(deltaTime);
                break;
            default:
                this.poseCycle(deltaTime);
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
        this.pushElapsed = 0;
        const angles = captureLegAngles(this.skeleton, this.driveLegSide);
        this.pushStartHip = angles.hip;
        this.pushStartKnee = angles.knee;
    }

    private beginPhase(phase: ClimbingState): void {
        this.state = phase;
        this.phaseElapsed = 0;
        this.handReachTime = 0;
        this.legReachTime = 0;
        // Preview targets are intentionally kept: the reach phase consumes the
        // target the free limb was already traveling toward, so the IK does
        // not retarget mid-swing. (They are per-side, so the released drive
        // leg previewing its own next step cannot clobber the reaching leg.)
        this.log(`phase -> ${STATE_NAMES[phase]}`);
    }

    private pushProgress(): number {
        return smoothstep(clampRange(this.pushElapsed / PUSH_TIME, 0, 1));
    }

    private resetTargets(): void {
        this.handTargetIndex = -1;
        this.legTargetIndex = -1;
        this.footPreviewTargetIndex = [-1, -1];
        this.handPreviewTargetIndex = [-1, -1];
    }

    // --- phases ---

    /** Blends the drive leg from its flexed start pose to straight. */
    private applyDriveLegExtension(deltaTime: number): void {
        const progress = this.pushProgress();
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
        void deltaTime;
    }

    private updatePush(deltaTime: number): void {
        this.poseCycle(deltaTime);

        if (this.pushElapsed >= PUSH_TIME) {
            this.beginPhase(ClimbingState.HandReach);
        }
    }

    private updateHandReach(deltaTime: number): void {
        this.poseCycle(deltaTime);
        this.handReachTime += deltaTime;

        const freeSide = 1 - this.supportArmSide;
        const handPreview = this.handPreviewTargetIndex[freeSide] ?? -1;
        if (this.handTargetIndex < 0 && handPreview >= 0) {
            this.handTargetIndex = handPreview;
            this.handPreviewTargetIndex[freeSide] = -1;
        }
        if (this.handTargetIndex < 0) {
            this.handTargetIndex = this.chooseTarget("hand", freeSide, this.handReachTime > REACH_TIMEOUT);
        }
        let target = this.wall.wallAnchors[this.handTargetIndex];
        // A target the body has drifted away from must be dropped and
        // re-picked, otherwise the hand chases an unreachable anchor forever
        // while valid holds sit right next to it.
        if (target !== undefined && this.isTargetOutOfRange("hand", freeSide, target)) {
            this.log(`hand target ${this.handTargetIndex} drifted out of reach -> re-pick`);
            this.handTargetIndex = -1;
            this.handTargetIndex = this.chooseTarget("hand", freeSide, this.handReachTime > REACH_TIMEOUT);
            target = this.wall.wallAnchors[this.handTargetIndex];
        }
        if (target === undefined) {
            this.handTargetIndex = -1;
            return;
        }
        this.lastHandTargetIndex = this.handTargetIndex;
        aimLimbToward(this.skeleton, "hand", freeSide, target, deltaTime);

        if (this.tryGrab("hand", freeSide, target, GRAB_RADIUS)) {
            this.releasePlanted("hand", this.supportArmSide);
            this.supportArmSide = freeSide;
            this.handTargetIndex = -1;
            this.beginPhase(ClimbingState.LegReach);
        }
        // Do not clear the target or reset the timer on timeout: relaxed
        // selection is `handReachTime > REACH_TIMEOUT`. Resetting made that
        // true for a single frame every 2.5s, so the arm never committed.
    }

    private updateLegReach(deltaTime: number): void {
        this.poseCycle(deltaTime);
        this.legReachTime += deltaTime;

        const freeSide = 1 - this.driveLegSide;
        // A previous cycle can leave the "free" foot still planted (grab
        // succeeded without releasing the old drive). It cannot IK to a new
        // hold while pinned, so free it before aiming.
        if (this.skeleton.isGrabbing("foot", freeSide)) {
            this.releasePlanted("foot", freeSide);
        }

        const footPreview = this.footPreviewTargetIndex[freeSide] ?? -1;
        if (this.legTargetIndex < 0 && footPreview >= 0) {
            this.legTargetIndex = footPreview;
            this.footPreviewTargetIndex[freeSide] = -1;
        }
        if (this.legTargetIndex < 0) {
            this.legTargetIndex = this.chooseTarget("foot", freeSide, this.legReachTime > REACH_TIMEOUT);
        }
        let target = this.wall.wallAnchors[this.legTargetIndex];
        // Same stale-target re-pick as the hand reach. Also re-pick when the
        // relaxed pick is not making contact: after REACH_TIMEOUT with no
        // grab the chosen anchor is either unreachable in practice or occupied
        // by the pendulum sway, and chasing it forever deadlocks the phase.
        if (target !== undefined && this.legReachTime > REACH_TIMEOUT) {
            if (this.legTargetIndex !== this.lastLegRepick || this.legReachTime > REACH_TIMEOUT * 2) {
                this.lastLegRepick = this.legTargetIndex;
                this.log(`foot target ${this.legTargetIndex} timed out -> re-pick relaxed`);
                this.legTargetIndex = this.chooseTarget("foot", freeSide, true);
                target = this.wall.wallAnchors[this.legTargetIndex];
            }
        }
        if (target === undefined) {
            this.legTargetIndex = -1;
            return;
        }
        this.lastLegTargetIndex = this.legTargetIndex;
        aimLimbToward(this.skeleton, "foot", freeSide, target, deltaTime);

        if (this.tryGrab("foot", freeSide, target, GRAB_RADIUS)) {
            // Old drive stays planted as support until this latch, then lets
            // go so the next cycle's free foot is actually free.
            if (this.skeleton.isGrabbing("foot", this.driveLegSide)) {
                this.releasePlanted("foot", this.driveLegSide);
            }
            this.driveLegSide = freeSide;
            this.legTargetIndex = -1;
            this.beginPush();
        }
        // Do not clear the target or reset the timer on timeout: relaxed
        // selection is `legReachTime > REACH_TIMEOUT`. Resetting discarded
        // the relaxed pick on the same frame it was chosen.
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
                // Angular body translation: aim the planted arm at a virtual
                // target 15% short of its anchor. When the body hangs taut,
                // the anchor itself is beyond max extension and the only IK
                // solution is "more straight" (pendulum). The shortened target
                // is inside reach, so its IK solution is a BENT elbow, and the
                // angular solver hauls the neck toward the wall until the
                // angles are satisfied.
                const anchorIndex = this.skeleton.grabConstraint("hand", side).wallAnchorIndex;
                const anchor = this.wall.wallAnchors[anchorIndex];
                if (anchor !== undefined) {
                    aimLimbTowardOriginScaled(this.skeleton, "hand", side, anchor, PLANTED_IK_SCALE, deltaTime);
                } else {
                    poseArm(this.skeleton, side, STRAIGHT_ELBOW_ANGLE, OVERHEAD_SHOULDER_ANGLE, deltaTime);
                }
            } else {
                // Free limb: continuously aim it at its next anchor with the
                // same IK used during reach, so it is always traveling toward
                // the hold it will grab - no static pose, no snapping.
                const previewIndex = this.pickPreviewTarget("hand", side);
                const previewTarget = this.wall.wallAnchors[previewIndex];
                if (previewTarget !== undefined) {
                    aimLimbToward(this.skeleton, "hand", side, previewTarget, deltaTime);
                } else {
                    poseArm(this.skeleton, side, FLEX_ELBOW_ANGLE, FLEX_SHOULDER_ANGLE, deltaTime);
                }
            }

            if (side === reachingFootSide) {
                continue;
            }
            if (this.skeleton.isGrabbing("foot", side)) {
                if (side === this.driveLegSide && this.state === ClimbingState.Push) {
                    // The drive leg's angles are blended by updatePush; do not
                    // overwrite them with coil pose targets here.
                    continue;
                }
                // Same shortened-target IK as the planted arm: a foot pinned
                // beyond leg reach yields only "straighten more"; a target
                // 15% short yields a flexed hip/knee whose solution pulls the
                // buttocks back toward the wall.
                const anchorIndex = this.skeleton.grabConstraint("foot", side).wallAnchorIndex;
                const anchor = this.wall.wallAnchors[anchorIndex];
                if (anchor !== undefined) {
                    aimLimbTowardOriginScaled(this.skeleton, "foot", side, anchor, PLANTED_IK_SCALE, deltaTime);
                } else {
                    poseLeg(this.skeleton, side, COIL_HIP_ANGLE, COIL_KNEE_ANGLE, deltaTime);
                }
            } else {
                const previewIndex = this.pickPreviewTarget("foot", side);
                const previewTarget = this.wall.wallAnchors[previewIndex];
                if (previewTarget !== undefined) {
                    aimLimbToward(this.skeleton, "foot", side, previewTarget, deltaTime);
                } else {
                    poseLeg(this.skeleton, side, FREE_LEG_HIP_ANGLE, FREE_LEG_KNEE_ANGLE, deltaTime);
                }
            }
        }
    }

    /**
     * Persistent per-side preview target for a free limb: chosen once and
     * kept until invalid, so the limb does not flicker between holds and one
     * limb's preview cannot clobber another's.
     */
    private pickPreviewTarget(kind: LimbKind, side: number): number {
        const previews = kind === "hand" ? this.handPreviewTargetIndex : this.footPreviewTargetIndex;
        const current = previews[side] ?? -1;
        const anchor = current >= 0 ? this.wall.wallAnchors[current] : undefined;
        const limb = this.skeleton.limbParticle(kind, side);
        const occupied = this.occupiedIndices();
        const stillValid =
            anchor !== undefined &&
            !occupied.has(anchor.index) &&
            !this.isBlacklisted(anchor.index) &&
            distanceSqr(limb.posX, limb.posY, anchor.posX, anchor.posY) < 1e9;
        if (stillValid) {
            return current;
        }
        const next = this.chooseTarget(kind, side, false);
        previews[side] = next;
        return next;
    }

    // --- target selection ---

    /**
     * Index of the anchor held by the partner limb of the same kind (the
     * other hand / the other foot): the free limb steps only a few anchors
     * past it. Falls back to the limb's own root height when nothing of that
     * kind is planted.
     */
    private partnerAnchorIndex(kind: LimbKind, side: number): number {
        const partner = 1 - side;
        if (this.skeleton.isGrabbing(kind, partner)) {
            return this.skeleton.grabConstraint(kind, partner).wallAnchorIndex;
        }
        // Partner not planted: derive from the other kind's highest hold so
        // the window still tracks the body.
        const otherKind: LimbKind = kind === "hand" ? "foot" : "hand";
        let best = -1;
        for (let s = 0; s < 2; s++) {
            if (this.skeleton.isGrabbing(otherKind, s)) {
                best = Math.max(best, this.skeleton.grabConstraint(otherKind, s).wallAnchorIndex);
            }
        }
        return best;
    }

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
        const releasedAt = this.recentlyReleased.get(index);
        if (releasedAt === undefined) {
            return false;
        }
        // Expire by sim time so expiry cannot be blocked by a frozen
        // grabCount.
        if (this.clock - releasedAt >= BLACKLIST_SECONDS) {
            this.recentlyReleased.delete(index);
            return false;
        }
        return true;
    }

    /**
     * Picks the next anchor for a limb: one of the few anchors just above the
     * latched partner limb (1-3 for a normal step, up to 5 when relaxed),
     * within the limb's reach. This keeps every step small and natural.
     */
    private chooseTarget(kind: LimbKind, side: number, relaxed: boolean): number {
        if (side < 0) {
            return -1;
        }
        const { proximal, distal } = boneLengths(this.skeleton, kind, side);
        // Only holds inside the limb's reach: the IK must be able to actually
        // bring the end particle to the anchor.
        const reachFactor = relaxed ? REACH_FACTOR_RELAXED : REACH_FACTOR;
        const reachSqr = Math.pow((proximal + distal) * reachFactor, 2);
        // Holds are measured from the limb's ROOT (neck / buttocks), not the
        // end particle: the IK folds the limb, so a hold must be inside the
        // root's reach.
        const reachOrigin = originParticle(this.skeleton, kind);
        const occupied = this.occupiedIndices();

        // Anchor-index window: a few past the latched partner limb so each
        // step gains only those anchors (index grows with wall height).
        const partnerIndex = this.partnerAnchorIndex(kind, side);
        const maxSteps = relaxed ? MAX_ANCHOR_STEPS_RELAXED : MAX_ANCHOR_STEPS;
        const minIndex = partnerIndex >= 0 ? partnerIndex + 1 : 0;
        const maxIndex = partnerIndex >= 0 ? partnerIndex + maxSteps : Number.MAX_SAFE_INTEGER;

        let bestIndex = -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const anchor of this.wall.wallAnchors) {
            if (occupied.has(anchor.index)) {
                continue;
            }
            // Relaxed (desperate) picks ignore the anti-flicker blacklist.
            // Otherwise a small neighborhood can end up fully blacklisted
            // while grabCount - frozen because nothing can be grabbed - never
            // advances far enough for the TTL to expire the entries.
            if (!relaxed && this.isBlacklisted(anchor.index)) {
                continue;
            }
            if (anchor.index < minIndex || anchor.index > maxIndex) {
                continue;
            }
            const step = reachOrigin.posY - anchor.posY;
            // The target must sit meaningfully above the limb's root, or the
            // limb would just re-grab at its own height.
            if (!relaxed && step < 2) {
                continue;
            }
            const distSqr = distanceSqr(reachOrigin.posX, reachOrigin.posY, anchor.posX, anchor.posY);
            if (distSqr > reachSqr) {
                continue;
            }
            const distance = Math.sqrt(distSqr);
            // Prefer the highest hold in the window: the limb should fold UP
            // to its next anchor.
            const upwardBonus = relaxed ? Math.min(20, Math.max(0, step)) : step;
            const score = upwardBonus * 3 - distance;
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
            // [DEBUG-a4f2] diagnose empty picks: dump the anchor neighborhood
            // around the limb's origin so unreachable picks can be compared
            // with what a flexed limb could actually touch.
            if (bestIndex === -1) {
                const nearby = this.wall.wallAnchors
                    .map(a => ({ i: a.index, x: a.posX, y: a.posY, d: Math.sqrt(distanceSqr(reachOrigin.posX, reachOrigin.posY, a.posX, a.posY)) }))
                    .filter(a => a.d < 60)
                    .sort((a, b) => a.d - b.d)
                    .slice(0, 8)
                    .map(a => `${a.i}@d${a.d.toFixed(0)}${occupied.has(a.i) ? "O" : ""}${this.isBlacklisted(a.i) ? "B" : ""}`)
                    .join(" ");
                this.log(
                    `choose-miss ${kind} origin=(${reachOrigin.posX.toFixed(0)},${reachOrigin.posY.toFixed(0)})` +
                    ` reach=${Math.sqrt(reachSqr).toFixed(0)}: ${nearby}`,
                );
            }
        }
        return bestIndex;
    }

    /**
     * True when the anchor can no longer be touched even with the limb fully
     * extended plus grab radius: the body has moved out of position and the
     * target must be re-picked rather than chased forever.
     */
    private isTargetOutOfRange(kind: LimbKind, side: number, target: WallAnchor): boolean {
        const { proximal, distal } = boneLengths(this.skeleton, kind, side);
        const origin = originParticle(this.skeleton, kind);
        const maxReach = (proximal + distal) * REACH_FACTOR_RELAXED + GRAB_RADIUS;
        return distanceSqr(origin.posX, origin.posY, target.posX, target.posY) > maxReach * maxReach;
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
        this.recentlyReleased.set(anchorIndex, this.clock);
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
