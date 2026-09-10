import type { Camera } from "./Camera.ts";
import type { SpringPhysics } from "./Physics.ts";
import type { Wall } from "./Wall.ts";

function updateDistanceConstraintBasedOnTargetAngle(
    phys: SpringPhysics,
    distanceConstraintIndex: number,
    angularConstraintIndex: number,
    dcLeftIndex: number,
    dcRightIndex: number,
): void {
    const dc = phys.distanceConstraints[distanceConstraintIndex]!;
    const ac = phys.angularConstraints[angularConstraintIndex]!;
    const dcLeft = phys.distanceConstraints[dcLeftIndex]!;
    const dcRight = phys.distanceConstraints[dcRightIndex]!;

    // see http://de.wikipedia.org/wiki/Formelsammlung_Trigonometrie#Kosinussatz for more details
    const gamma = ac.targetAngle;
    const a = dcLeft.distance;
    const b = dcRight.distance;
    const newDistance = Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(gamma));
    dc.distance = newDistance;
}

function drawDebugLine(ctx: CanvasRenderingContext2D, cam: Camera, x0: number, y0: number, x1: number, y1: number, color: string): void {
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
    distanceConstraintIndices: number[],
    color: string,
): void {
    for (const index of distanceConstraintIndices) {
        // TODO: this is not sufficient to guard broken constraints -> add callback instead to notify anyone about broken constraints
        if (index < phys.distanceConstraints.length) {
            const c = phys.distanceConstraints[index]!;

            const state0 = phys.particleStates[c.particleIndex0]!;
            const state1 = phys.particleStates[c.particleIndex1]!;

            drawDebugLine(ctx, cam, state0.posX, state0.posY, state1.posX, state1.posY, color);
        }
    }
}

function createBodyParticle(phys: SpringPhysics, posX: number, posY: number, mass: number): number {
    const particleIndex = phys.createParticle(posX, posY);

    phys.particleStates[particleIndex]!.mass = mass;
    phys.particleStates[particleIndex]!.inverseMass = 1.0 / mass;

    return particleIndex;
}

export class Skeleton {
    public phys: SpringPhysics = undefined as unknown as SpringPhysics;
    public wall: Wall = undefined as unknown as Wall;

    public time = 0;

    public bodylength = 24;
    public armlength = 20;
    public leglength = 24;

    public bodyConstraintIndices: number[] = [];
    public leftArmConstraintIndices: number[] = [];
    public leftLegConstraintIndices: number[] = [];
    public rightArmConstraintIndices: number[] = [];
    public rightLegConstraintIndices: number[] = [];

    public leftArmHelperConstraintIndices: number[] = [];
    public rightArmHelperConstraintIndices: number[] = [];
    public leftLegHelperConstraintIndices: number[] = [];
    public rightLegHelperConstraintIndices: number[] = [];

    public pelvisParticleIndex = -1; // rope is attached here
    public buttocksParticleIndex = -1; // feet are attached here
    public backParticleIndex = -1; // nothing attached to
    public neckParticleIndex = -1; // arms are attached here

    // each of the following arrays has two elements (0 = left; 1 = right)
    public handParticleIndex: number[] = [];
    public footParticleIndex: number[] = [];
    public shoulderACIndex: number[] = []; // AC == AngularConstraint
    public elbowACIndex: number[] = [];
    public hipJointACIndex: number[] = [];
    public kneeJointACIndex: number[] = [];

    public handGrabConstraintIndex: number[] = [];
    public footGrabConstraintIndex: number[] = [];

    public backACIndex: number[] = []; // three AC indices

    public constructor(phys: SpringPhysics, wall: Wall, posX: number, posY: number) {
        this.initialize(phys, wall, posX, posY);
    }

    public update(deltaTime: number): void {
        updateDistanceConstraintBasedOnTargetAngle(this.phys, this.leftArmHelperConstraintIndices[0]!, this.shoulderACIndex[0]!, this.bodyConstraintIndices[2]!, this.leftArmConstraintIndices[0]!);
        updateDistanceConstraintBasedOnTargetAngle(this.phys, this.leftArmHelperConstraintIndices[1]!, this.elbowACIndex[0]!, this.leftArmConstraintIndices[0]!, this.leftArmConstraintIndices[1]!);

        updateDistanceConstraintBasedOnTargetAngle(this.phys, this.rightArmHelperConstraintIndices[0]!, this.shoulderACIndex[1]!, this.bodyConstraintIndices[2]!, this.rightArmConstraintIndices[0]!);
        updateDistanceConstraintBasedOnTargetAngle(this.phys, this.rightArmHelperConstraintIndices[1]!, this.elbowACIndex[1]!, this.rightArmConstraintIndices[0]!, this.rightArmConstraintIndices[1]!);

        updateDistanceConstraintBasedOnTargetAngle(this.phys, this.leftLegHelperConstraintIndices[0]!, this.hipJointACIndex[0]!, this.bodyConstraintIndices[1]!, this.leftLegConstraintIndices[0]!);
        updateDistanceConstraintBasedOnTargetAngle(this.phys, this.leftLegHelperConstraintIndices[1]!, this.kneeJointACIndex[0]!, this.leftLegConstraintIndices[0]!, this.leftLegConstraintIndices[1]!);

        updateDistanceConstraintBasedOnTargetAngle(this.phys, this.rightLegHelperConstraintIndices[0]!, this.hipJointACIndex[1]!, this.bodyConstraintIndices[1]!, this.rightLegConstraintIndices[0]!);
        updateDistanceConstraintBasedOnTargetAngle(this.phys, this.rightLegHelperConstraintIndices[1]!, this.kneeJointACIndex[1]!, this.rightLegConstraintIndices[0]!, this.rightLegConstraintIndices[1]!);

        this.time += deltaTime;
    }

    public draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
        // Debug output to visualize the skeleton
        /*ctx.globalAlpha = 0.2;
        drawDistanceConstraints(ctx, cam, this.phys, this.leftArmHelperConstraintIndices, "#000000");
        drawDistanceConstraints(ctx, cam, this.phys, this.rightArmHelperConstraintIndices, "#000000");
        drawDistanceConstraints(ctx, cam, this.phys, this.leftLegHelperConstraintIndices, "#000000");
        drawDistanceConstraints(ctx, cam, this.phys, this.rightLegHelperConstraintIndices, "#000000");
        ctx.globalAlpha = 1.0;*/

        drawDistanceConstraints(ctx, cam, this.phys, this.bodyConstraintIndices, "#AA6000");
        drawDistanceConstraints(ctx, cam, this.phys, this.leftArmConstraintIndices, "#000080");
        drawDistanceConstraints(ctx, cam, this.phys, this.leftLegConstraintIndices, "#00AA00");
        drawDistanceConstraints(ctx, cam, this.phys, this.rightArmConstraintIndices, "#3080FF");
        drawDistanceConstraints(ctx, cam, this.phys, this.rightLegConstraintIndices, "#00FF00");
    }

    public addBowOffset(offset: number): void {
        this.phys.angularConstraints[this.hipJointACIndex[0]!]!.targetAngle -= offset;
        this.phys.angularConstraints[this.hipJointACIndex[1]!]!.targetAngle -= offset;

        this.phys.angularConstraints[this.shoulderACIndex[0]!]!.targetAngle += offset;
        this.phys.angularConstraints[this.shoulderACIndex[1]!]!.targetAngle += offset;
    }

    public letGo(): void {
        this.phys.fixedConstraints[this.handGrabConstraintIndex[0]!]!.isEnabled = false;
        this.phys.fixedConstraints[this.handGrabConstraintIndex[1]!]!.isEnabled = false;
        this.phys.fixedConstraints[this.footGrabConstraintIndex[0]!]!.isEnabled = false;
        this.phys.fixedConstraints[this.footGrabConstraintIndex[1]!]!.isEnabled = false;
    }

    public getPosition(): { posX: number; posY: number } {
        return {
            posX: this.phys.particleStates[this.pelvisParticleIndex]!.posX,
            posY: this.phys.particleStates[this.pelvisParticleIndex]!.posY,
        };
    }

    private initialize(phys: SpringPhysics, wall: Wall, posX: number, posY: number): void {
        this.phys = phys;
        this.wall = wall;

        const bodyParticleMass = 0.1;

        const anchors = wall.getNearbyAnchors(posX, posY, 200);

        posX += 50;

        // put skeleton at a position where the left wrist touches the selected anchor
        const armAnchorIndex = anchors[Math.round(anchors.length / 2)]!.index;
        const legAnchorIndex = armAnchorIndex - 8;
        posX = this.wall.wallAnchors[armAnchorIndex]!.posX - this.armlength * 2.0; // x2 to get enough extra distance
        posY = this.wall.wallAnchors[armAnchorIndex]!.posY + this.bodylength * 0.7;

        const buttocksPosY = posY + this.bodylength * 0.3;
        const neckPosY = posY - this.bodylength * 0.7;

        const pelvisIndex = createBodyParticle(phys, posX, posY, bodyParticleMass);
        const buttocksIndex = createBodyParticle(phys, posX, buttocksPosY, bodyParticleMass);
        const backIndex = createBodyParticle(phys, posX, posY - this.bodylength * 0.3, bodyParticleMass);
        const neckIndex = createBodyParticle(phys, posX, neckPosY, bodyParticleMass);
        const headIndex = createBodyParticle(phys, posX, posY - this.bodylength * 0.9, bodyParticleMass);

        this.pelvisParticleIndex = pelvisIndex;
        this.buttocksParticleIndex = buttocksIndex;
        this.backParticleIndex = backIndex;
        this.neckParticleIndex = neckIndex;

        const leftelbowIndex = createBodyParticle(phys, posX + this.armlength * 0.5, neckPosY, bodyParticleMass * 0.5);
        const leftwristIndex = createBodyParticle(phys, posX + this.armlength * 1.0, neckPosY, bodyParticleMass * 0.5);
        this.handParticleIndex.push(leftwristIndex);

        const leftkneeIndex = createBodyParticle(phys, posX + this.leglength * 0.5, buttocksPosY, bodyParticleMass * 0.5);
        const leftankleIndex = createBodyParticle(phys, posX + this.leglength * 0.5, buttocksPosY + this.leglength * 0.5, bodyParticleMass * 0.5);
        this.footParticleIndex.push(leftankleIndex);

        const rightelbowIndex = createBodyParticle(phys, posX + this.armlength * 0.5, neckPosY, bodyParticleMass * 0.5);
        const rightwristIndex = createBodyParticle(phys, posX + this.armlength * 1.0, neckPosY, bodyParticleMass * 0.5);
        this.handParticleIndex.push(rightwristIndex);

        const rightkneeIndex = createBodyParticle(phys, posX + this.leglength * 0.5, buttocksPosY, bodyParticleMass * 0.5);
        const rightankleIndex = createBodyParticle(phys, posX + this.leglength * 0.5, buttocksPosY + this.leglength * 0.5, bodyParticleMass * 0.5);
        this.footParticleIndex.push(rightankleIndex);

        this.bodyConstraintIndices.push(phys.createDistanceConstraint(pelvisIndex, buttocksIndex));
        this.bodyConstraintIndices.push(phys.createDistanceConstraint(pelvisIndex, backIndex));
        this.bodyConstraintIndices.push(phys.createDistanceConstraint(backIndex, neckIndex));
        this.bodyConstraintIndices.push(phys.createDistanceConstraint(neckIndex, headIndex));

        this.leftArmConstraintIndices.push(phys.createDistanceConstraint(neckIndex, leftelbowIndex));
        this.leftArmConstraintIndices.push(phys.createDistanceConstraint(leftelbowIndex, leftwristIndex));
        this.leftArmHelperConstraintIndices.push(phys.createDistanceConstraint(backIndex, leftelbowIndex));
        this.leftArmHelperConstraintIndices.push(phys.createDistanceConstraint(neckIndex, leftwristIndex));

        this.leftLegConstraintIndices.push(phys.createDistanceConstraint(buttocksIndex, leftkneeIndex));
        this.leftLegConstraintIndices.push(phys.createDistanceConstraint(leftkneeIndex, leftankleIndex));
        this.leftLegHelperConstraintIndices.push(phys.createDistanceConstraint(pelvisIndex, leftkneeIndex));
        this.leftLegHelperConstraintIndices.push(phys.createDistanceConstraint(buttocksIndex, leftankleIndex));

        this.rightArmConstraintIndices.push(phys.createDistanceConstraint(neckIndex, rightelbowIndex));
        this.rightArmConstraintIndices.push(phys.createDistanceConstraint(rightelbowIndex, rightwristIndex));
        this.rightArmHelperConstraintIndices.push(phys.createDistanceConstraint(backIndex, rightelbowIndex));
        this.rightArmHelperConstraintIndices.push(phys.createDistanceConstraint(neckIndex, rightwristIndex));

        this.rightLegConstraintIndices.push(phys.createDistanceConstraint(buttocksIndex, rightkneeIndex));
        this.rightLegConstraintIndices.push(phys.createDistanceConstraint(rightkneeIndex, rightankleIndex));
        this.rightLegHelperConstraintIndices.push(phys.createDistanceConstraint(pelvisIndex, rightkneeIndex));
        this.rightLegHelperConstraintIndices.push(phys.createDistanceConstraint(buttocksIndex, rightankleIndex));

        this.backACIndex.push(phys.createAngularConstraint(buttocksIndex, pelvisIndex, backIndex));
        this.backACIndex.push(phys.createAngularConstraint(pelvisIndex, backIndex, neckIndex));
        this.backACIndex.push(phys.createAngularConstraint(backIndex, neckIndex, headIndex));

        phys.angularConstraints[this.backACIndex[0]!]!.tightnessFactor = 2.0;
        phys.angularConstraints[this.backACIndex[1]!]!.tightnessFactor = 2.0;
        phys.angularConstraints[this.backACIndex[2]!]!.tightnessFactor = 2.0;

        this.shoulderACIndex.push(phys.createAngularConstraint(backIndex, neckIndex, leftelbowIndex));
        this.elbowACIndex.push(phys.createAngularConstraint(neckIndex, leftelbowIndex, leftwristIndex));

        this.hipJointACIndex.push(phys.createAngularConstraint(pelvisIndex, buttocksIndex, leftkneeIndex));
        this.kneeJointACIndex.push(phys.createAngularConstraint(buttocksIndex, leftkneeIndex, leftankleIndex));

        this.shoulderACIndex.push(phys.createAngularConstraint(backIndex, neckIndex, rightelbowIndex));
        this.elbowACIndex.push(phys.createAngularConstraint(neckIndex, rightelbowIndex, rightwristIndex));

        this.hipJointACIndex.push(phys.createAngularConstraint(pelvisIndex, buttocksIndex, rightkneeIndex));
        this.kneeJointACIndex.push(phys.createAngularConstraint(buttocksIndex, rightkneeIndex, rightankleIndex));

        const leftHandConstraintAnchorIndex = phys.createFixedConstraint(leftwristIndex);
        phys.fixedConstraints[leftHandConstraintAnchorIndex]!.posX = this.wall.wallAnchors[armAnchorIndex]!.posX;
        phys.fixedConstraints[leftHandConstraintAnchorIndex]!.posY = this.wall.wallAnchors[armAnchorIndex]!.posY;
        phys.particleStates[rightwristIndex]!.posX = this.wall.wallAnchors[armAnchorIndex]!.posX;
        phys.particleStates[rightwristIndex]!.posY = this.wall.wallAnchors[armAnchorIndex]!.posY;

        const rightankleConstraintAnchorIndex = phys.createFixedConstraint(rightankleIndex);
        phys.fixedConstraints[rightankleConstraintAnchorIndex]!.posX = this.wall.wallAnchors[legAnchorIndex]!.posX;
        phys.fixedConstraints[rightankleConstraintAnchorIndex]!.posY = this.wall.wallAnchors[legAnchorIndex]!.posY;
        phys.particleStates[leftankleIndex]!.posX = this.wall.wallAnchors[legAnchorIndex]!.posX;
        phys.particleStates[leftankleIndex]!.posY = this.wall.wallAnchors[legAnchorIndex]!.posY;

        this.handGrabConstraintIndex.push(leftHandConstraintAnchorIndex);
        this.handGrabConstraintIndex.push(phys.createFixedConstraint(rightwristIndex));

        this.footGrabConstraintIndex.push(phys.createFixedConstraint(leftankleIndex));
        this.footGrabConstraintIndex.push(rightankleConstraintAnchorIndex);

        phys.fixedConstraints[this.handGrabConstraintIndex[0]!]!.isEnabled = true;
        phys.fixedConstraints[this.handGrabConstraintIndex[1]!]!.isEnabled = false;
        phys.fixedConstraints[this.footGrabConstraintIndex[0]!]!.isEnabled = false;
        phys.fixedConstraints[this.footGrabConstraintIndex[1]!]!.isEnabled = true;

        phys.fixedConstraints[this.handGrabConstraintIndex[0]!]!.wallAnchorIndex = armAnchorIndex;
        phys.fixedConstraints[this.footGrabConstraintIndex[1]!]!.wallAnchorIndex = legAnchorIndex;
    }
}
