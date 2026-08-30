import type { Camera } from "./Camera.ts";
import type { FixedConstraint, PhysicalParticleState, SpringPhysics } from "./Physics.ts";
import type { Wall, WallAnchor } from "./Wall.ts";
import { defined } from "./assert.ts";

function drawDebugLine(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
): void {
    const screenPosX0 = Math.round(cam.world_to_viewport_x_pixel(x0) / cam.pixelScale) * cam.pixelScale;
    const screenPosY0 = Math.round(cam.world_to_viewport_y_pixel(y0) / cam.pixelScale) * cam.pixelScale;
    const screenPosX1 = Math.round(cam.world_to_viewport_x_pixel(x1) / cam.pixelScale) * cam.pixelScale;
    const screenPosY1 = Math.round(cam.world_to_viewport_y_pixel(y1) / cam.pixelScale) * cam.pixelScale;

    ctx.strokeStyle = color;
    ctx.lineWidth = cam.pixelScale;
    ctx.beginPath();
    ctx.moveTo(screenPosX0, screenPosY0);
    ctx.lineTo(screenPosX1, screenPosY1);
    ctx.stroke();
}

function drawDistanceConstraints(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    phys: SpringPhysics,
    distanceConstraintIndices: readonly number[],
    color: string,
): void {
    for (const constraintIndex of distanceConstraintIndices) {
        if (constraintIndex >= phys.distanceConstraints.length) {
            continue;
        }

        const c = phys.distanceConstraints[constraintIndex];
        if (c === undefined) {
            continue;
        }

        const state0 = phys.particleStates[c.particleIndex0];
        const state1 = phys.particleStates[c.particleIndex1];
        if (state0 === undefined || state1 === undefined) {
            continue;
        }

        drawDebugLine(ctx, cam, state0.posX, state0.posY, state1.posX, state1.posY, color);
    }
}

function createBodyParticle(phys: SpringPhysics, posX: number, posY: number, mass: number): number {
    const particleIndex = phys.createParticle(posX, posY);
    const particle = defined(phys.particleStates[particleIndex], "Created particle is missing");
    particle.mass = mass;
    particle.inverseMass = 1.0 / mass;
    return particleIndex;
}

export class Skeleton {
    public phys: SpringPhysics;
    public wall: Wall;
    public time = 0;

    public bodylength = 24;
    public armlength = 20;
    public leglength = 24;

    public bodyConstraintIndices: number[] = [];
    public leftArmConstraintIndices: number[] = [];
    public leftLegConstraintIndices: number[] = [];
    public rightArmConstraintIndices: number[] = [];
    public rightLegConstraintIndices: number[] = [];

    public pelvisParticleIndex = -1;
    public buttocksParticleIndex = -1;
    public neckParticleIndex = -1;

    public handParticleIndex: number[] = [];
    public footParticleIndex: number[] = [];
    public shoulderACIndex: number[] = [];
    public elbowACIndex: number[] = [];
    public hipJointACIndex: number[] = [];
    public kneeJointACIndex: number[] = [];

    public handGrabConstraintIndex: number[] = [];
    public footGrabConstraintIndex: number[] = [];

    public constructor(phys: SpringPhysics, wall: Wall, posX: number, posY: number) {
        this.phys = phys;
        this.wall = wall;
        this.initialize(posX, posY);
    }

    public update(deltaTime: number): void {
        this.time += deltaTime;
    }

    public draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
        drawDistanceConstraints(ctx, cam, this.phys, this.bodyConstraintIndices, "#AA6000");
        drawDistanceConstraints(ctx, cam, this.phys, this.leftArmConstraintIndices, "#000080");
        drawDistanceConstraints(ctx, cam, this.phys, this.leftLegConstraintIndices, "#00AA00");
        drawDistanceConstraints(ctx, cam, this.phys, this.rightArmConstraintIndices, "#3080FF");
        drawDistanceConstraints(ctx, cam, this.phys, this.rightLegConstraintIndices, "#00FF00");
    }

    public addBowOffset(offset: number): void {
        const leftHip = defined(this.phys.angularConstraints[defined(this.hipJointACIndex[0], "Missing left hip")], "Missing left hip constraint");
        const rightHip = defined(this.phys.angularConstraints[defined(this.hipJointACIndex[1], "Missing right hip")], "Missing right hip constraint");
        const leftShoulder = defined(
            this.phys.angularConstraints[defined(this.shoulderACIndex[0], "Missing left shoulder")],
            "Missing left shoulder constraint",
        );
        const rightShoulder = defined(
            this.phys.angularConstraints[defined(this.shoulderACIndex[1], "Missing right shoulder")],
            "Missing right shoulder constraint",
        );

        leftHip.targetAngle -= offset;
        rightHip.targetAngle -= offset;
        leftShoulder.targetAngle += offset;
        rightShoulder.targetAngle += offset;
    }

    public letGo(): void {
        this.release("hand", 0);
        this.release("hand", 1);
        this.release("foot", 0);
        this.release("foot", 1);
    }

    public isGrabbing(kind: "hand" | "foot", sideIndex: number): boolean {
        return this.grabConstraint(kind, sideIndex).isEnabled;
    }

    public findFreeSide(kind: "hand" | "foot"): number {
        for (let side = 0; side < 2; side++) {
            if (!this.isGrabbing(kind, side)) {
                return side;
            }
        }
        return -1;
    }

    public grab(kind: "hand" | "foot", sideIndex: number, anchor: WallAnchor): void {
        const constraint = this.grabConstraint(kind, sideIndex);
        constraint.posX = anchor.posX;
        constraint.posY = anchor.posY;
        constraint.wallAnchorIndex = anchor.index;
        constraint.isEnabled = true;

        const particle = this.limbParticle(kind, sideIndex);
        particle.posX = anchor.posX;
        particle.posY = anchor.posY;
        particle.velX = 0;
        particle.velY = 0;
    }

    public release(kind: "hand" | "foot", sideIndex: number): void {
        this.grabConstraint(kind, sideIndex).isEnabled = false;
    }

    public grabConstraint(kind: "hand" | "foot", sideIndex: number): FixedConstraint {
        const indices = kind === "hand" ? this.handGrabConstraintIndex : this.footGrabConstraintIndex;
        const constraintIndex = defined(indices[sideIndex], `Missing ${kind} grab`);
        return defined(this.phys.fixedConstraints[constraintIndex], `Missing ${kind} grab constraint`);
    }

    public limbParticle(kind: "hand" | "foot", sideIndex: number): PhysicalParticleState {
        const indices = kind === "hand" ? this.handParticleIndex : this.footParticleIndex;
        const particleIndex = defined(indices[sideIndex], `Missing ${kind} particle`);
        return defined(this.phys.particleStates[particleIndex], `Missing ${kind} particle state`);
    }

    private initialize(posX: number, posY: number): void {
        const bodyParticleMass = 0.1;
        const anchors = this.wall.getNearbyAnchors(posX, posY, 300);
        const selectedAnchor = defined(anchors[Math.round(anchors.length / 2)], "No nearby wall anchors for skeleton");
        const armAnchorIndex = selectedAnchor.index;
        const legAnchorIndex = armAnchorIndex - 4;
        const armAnchor = defined(anchors[armAnchorIndex], "Missing arm anchor");

        posX = armAnchor.posX - this.armlength * 2.0;
        posY = armAnchor.posY + this.bodylength * 0.7;

        const buttocksPosY = posY + this.bodylength * 0.3;
        const neckPosY = posY - this.bodylength * 0.7;

        const pelvisIndex = createBodyParticle(this.phys, posX, posY, bodyParticleMass);
        const buttocksIndex = createBodyParticle(this.phys, posX, buttocksPosY, bodyParticleMass);
        const backIndex = createBodyParticle(this.phys, posX, posY - this.bodylength * 0.3, bodyParticleMass);
        const neckIndex = createBodyParticle(this.phys, posX, neckPosY, bodyParticleMass);
        const headIndex = createBodyParticle(this.phys, posX, posY - this.bodylength * 0.9, bodyParticleMass);

        this.pelvisParticleIndex = pelvisIndex;
        this.buttocksParticleIndex = buttocksIndex;
        this.neckParticleIndex = neckIndex;

        const leftelbowIndex = createBodyParticle(this.phys, posX + this.armlength * 0.5, neckPosY, bodyParticleMass * 0.5);
        const leftwristIndex = createBodyParticle(this.phys, posX + this.armlength * 1.0, neckPosY, bodyParticleMass * 0.5);
        this.handParticleIndex.push(leftwristIndex);

        const leftkneeIndex = createBodyParticle(this.phys, posX + this.leglength * 0.5, buttocksPosY, bodyParticleMass * 0.5);
        const leftankleIndex = createBodyParticle(
            this.phys,
            posX + this.leglength * 0.5,
            buttocksPosY + this.leglength * 0.5,
            bodyParticleMass * 0.5,
        );
        this.footParticleIndex.push(leftankleIndex);

        const rightelbowIndex = createBodyParticle(this.phys, posX + this.armlength * 0.5, neckPosY, bodyParticleMass * 0.5);
        const rightwristIndex = createBodyParticle(this.phys, posX + this.armlength * 1.0, neckPosY, bodyParticleMass * 0.5);
        this.handParticleIndex.push(rightwristIndex);

        const rightkneeIndex = createBodyParticle(this.phys, posX + this.leglength * 0.5, buttocksPosY, bodyParticleMass * 0.5);
        const rightankleIndex = createBodyParticle(
            this.phys,
            posX + this.leglength * 0.5,
            buttocksPosY + this.leglength * 0.5,
            bodyParticleMass * 0.5,
        );
        this.footParticleIndex.push(rightankleIndex);

        this.bodyConstraintIndices.push(this.phys.createDistanceConstraint(pelvisIndex, buttocksIndex));
        this.bodyConstraintIndices.push(this.phys.createDistanceConstraint(pelvisIndex, backIndex));
        this.bodyConstraintIndices.push(this.phys.createDistanceConstraint(backIndex, neckIndex));
        this.bodyConstraintIndices.push(this.phys.createDistanceConstraint(neckIndex, headIndex));

        this.leftArmConstraintIndices.push(this.phys.createDistanceConstraint(neckIndex, leftelbowIndex));
        this.leftArmConstraintIndices.push(this.phys.createDistanceConstraint(leftelbowIndex, leftwristIndex));

        this.leftLegConstraintIndices.push(this.phys.createDistanceConstraint(buttocksIndex, leftkneeIndex));
        this.leftLegConstraintIndices.push(this.phys.createDistanceConstraint(leftkneeIndex, leftankleIndex));

        this.rightArmConstraintIndices.push(this.phys.createDistanceConstraint(neckIndex, rightelbowIndex));
        this.rightArmConstraintIndices.push(this.phys.createDistanceConstraint(rightelbowIndex, rightwristIndex));

        this.rightLegConstraintIndices.push(this.phys.createDistanceConstraint(buttocksIndex, rightkneeIndex));
        this.rightLegConstraintIndices.push(this.phys.createDistanceConstraint(rightkneeIndex, rightankleIndex));

        const backAC0 = this.phys.createAngularConstraint(buttocksIndex, pelvisIndex, backIndex);
        const backAC1 = this.phys.createAngularConstraint(pelvisIndex, backIndex, neckIndex);
        const backAC2 = this.phys.createAngularConstraint(backIndex, neckIndex, headIndex);

        defined(this.phys.angularConstraints[backAC0], "Missing back angular constraint 0").tightnessFactor = 2.0;
        defined(this.phys.angularConstraints[backAC1], "Missing back angular constraint 1").tightnessFactor = 2.0;
        defined(this.phys.angularConstraints[backAC2], "Missing back angular constraint 2").tightnessFactor = 2.0;

        this.shoulderACIndex.push(this.phys.createAngularConstraint(backIndex, neckIndex, leftelbowIndex));
        this.elbowACIndex.push(this.phys.createAngularConstraint(neckIndex, leftelbowIndex, leftwristIndex));

        this.hipJointACIndex.push(this.phys.createAngularConstraint(pelvisIndex, buttocksIndex, leftkneeIndex));
        this.kneeJointACIndex.push(this.phys.createAngularConstraint(buttocksIndex, leftkneeIndex, leftankleIndex));

        this.shoulderACIndex.push(this.phys.createAngularConstraint(backIndex, neckIndex, rightelbowIndex));
        this.elbowACIndex.push(this.phys.createAngularConstraint(neckIndex, rightelbowIndex, rightwristIndex));

        this.hipJointACIndex.push(this.phys.createAngularConstraint(pelvisIndex, buttocksIndex, rightkneeIndex));
        this.kneeJointACIndex.push(this.phys.createAngularConstraint(buttocksIndex, rightkneeIndex, rightankleIndex));

        const leftHandConstraintAnchorIndex = this.phys.createFixedConstraint(leftwristIndex);
        const leftHandConstraint = defined(
            this.phys.fixedConstraints[leftHandConstraintAnchorIndex],
            "Missing left hand constraint",
        );
        const armWallAnchor = defined(this.wall.wallAnchors[armAnchorIndex + 0], "Missing arm wall anchor");
        leftHandConstraint.posX = armWallAnchor.posX;
        leftHandConstraint.posY = armWallAnchor.posY;

        const rightankleConstraintAnchorIndex = this.phys.createFixedConstraint(rightankleIndex);
        const rightAnkleConstraint = defined(
            this.phys.fixedConstraints[rightankleConstraintAnchorIndex],
            "Missing right ankle constraint",
        );
        const legWallAnchor = defined(this.wall.wallAnchors[legAnchorIndex], "Missing leg wall anchor");
        rightAnkleConstraint.posX = legWallAnchor.posX;
        rightAnkleConstraint.posY = legWallAnchor.posY;

        this.handGrabConstraintIndex.push(leftHandConstraintAnchorIndex);
        this.handGrabConstraintIndex.push(this.phys.createFixedConstraint(rightwristIndex));

        this.footGrabConstraintIndex.push(this.phys.createFixedConstraint(leftankleIndex));
        this.footGrabConstraintIndex.push(rightankleConstraintAnchorIndex);

        defined(this.phys.fixedConstraints[defined(this.handGrabConstraintIndex[0], "Missing left hand grab")], "Missing left hand grab constraint").isEnabled =
            true;
        defined(this.phys.fixedConstraints[defined(this.handGrabConstraintIndex[1], "Missing right hand grab")], "Missing right hand grab constraint").isEnabled =
            false;
        defined(this.phys.fixedConstraints[defined(this.footGrabConstraintIndex[0], "Missing left foot grab")], "Missing left foot grab constraint").isEnabled =
            false;
        defined(this.phys.fixedConstraints[defined(this.footGrabConstraintIndex[1], "Missing right foot grab")], "Missing right foot grab constraint").isEnabled =
            true;

        defined(this.phys.fixedConstraints[defined(this.handGrabConstraintIndex[0], "Missing left hand grab")], "Missing left hand grab constraint").wallAnchorIndex =
            armAnchorIndex;
        defined(this.phys.fixedConstraints[defined(this.footGrabConstraintIndex[1], "Missing right foot grab")], "Missing right foot grab constraint").wallAnchorIndex =
            legAnchorIndex;
    }
}
