import type { Camera } from "./Camera.ts";
import type { SpringPhysics } from "./Physics.ts";
import type { Skeleton } from "./Skeleton.ts";
import type { Wall, WallAnchor } from "./Wall.ts";

function beginDrawPixelLine(ctx: CanvasRenderingContext2D, color: string): void {
    ctx.beginPath();
    ctx.fillStyle = color;
}

function drawPixelLine(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    invPixelScale: number,
): void {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const dist = Math.max(dx, -dy);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let e2: number; /* error value e_xy */

    let currentX = x0;
    let currentY = y0;
    for (let n = 0; n < dist; n++) {
        const screenPosX = Math.round(cam.world_to_viewport_x_pixel(currentX) * invPixelScale) * cam.pixelScale;
        const screenPosY = Math.round(cam.world_to_viewport_y_pixel(currentY) * invPixelScale) * cam.pixelScale;

        ctx.rect(screenPosX, screenPosY, cam.pixelScale, cam.pixelScale);

        e2 = 2 * err;
        if (e2 > dy) {
            err += dy;
            currentX += sx;
        } /* e_xy+e_x > 0 */
        if (e2 < dx) {
            err += dx;
            currentY += sy;
        } /* e_xy+e_y < 0 */
    }
}

function endDrawPixelLine(ctx: CanvasRenderingContext2D): void {
    ctx.fill();
}

function findNearbyWallAnchor(wall: Wall, posY: number): WallAnchor {
    let nearestAnchor: WallAnchor | undefined;
    let nearestAnchorDistanceSqr = 10000000000.0;
    for (const wa of wall.wallAnchors) {
        // TODO: optimize this by height anticipation
        const deltaY = wa.posY - posY;
        const distanceSqr = deltaY * deltaY;
        if (nearestAnchorDistanceSqr > distanceSqr) {
            nearestAnchorDistanceSqr = distanceSqr;
            nearestAnchor = wa;
        }
    }

    return nearestAnchor!;
}

export class Rope {
    public phys: SpringPhysics = undefined as unknown as SpringPhysics;
    public wall: Wall = undefined as unknown as Wall;
    public skeleton: Skeleton = undefined as unknown as Skeleton;

    public distanceConstraintIndices: number[] = [];
    public fixedConstraintIndices: number[] = [];
    public ropeSegmentLength = 5;
    public fixedSkeletonConstraintIndex = -1;

    public constructor(phys: SpringPhysics, wall: Wall, skeleton: Skeleton, posX: number, posY: number) {
        this.initialize(phys, wall, skeleton, posX, posY);
    }

    public update(deltaTime: number): void {
        const fc = this.phys.fixedConstraints[this.fixedSkeletonConstraintIndex]!;
        const pelvisParticle = this.phys.particleStates[this.skeleton.pelvisParticleIndex]!;
        fc.posX = pelvisParticle.posX;
        fc.posY = pelvisParticle.posY;

        let index = this.distanceConstraintIndices.length - 1;
        while (this.phys.distanceConstraints[this.distanceConstraintIndices[index]!]!.distance < this.ropeSegmentLength) {
            const dc = this.phys.distanceConstraints[this.distanceConstraintIndices[index]!]!;

            dc.distance += this.ropeSegmentLength * deltaTime * 0.5;

            if (dc.distance > this.ropeSegmentLength) {
                dc.distance = this.ropeSegmentLength;
            }

            index--;
        }
    }

    public draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
        const invPixelScale = 1.0 / cam.pixelScale;

        beginDrawPixelLine(ctx, "#2A0D03");
        for (const constraintIndex of this.distanceConstraintIndices) {
            const c = this.phys.distanceConstraints[constraintIndex]!;

            const state0 = this.phys.particleStates[c.particleIndex0]!;
            const state1 = this.phys.particleStates[c.particleIndex1]!;

            drawPixelLine(
                ctx,
                cam,
                Math.round(state0.posX),
                Math.round(state0.posY),
                Math.round(state1.posX),
                Math.round(state1.posY),
                invPixelScale,
            );
        }
        endDrawPixelLine(ctx);
    }

    public lengthenEnd(): void {
        const pelvisParticle = this.phys.particleStates[this.skeleton.pelvisParticleIndex]!;

        const lastConstraintIndex = this.distanceConstraintIndices[this.distanceConstraintIndices.length - 1]!;
        const lastRopeParticle = this.phys.particleStates[this.phys.distanceConstraints[lastConstraintIndex]!.particleIndex0]!;

        const newPosX = lastRopeParticle.posX + (pelvisParticle.posX - lastRopeParticle.posX) * 0.5;
        const newPosY = lastRopeParticle.posY + (pelvisParticle.posY - lastRopeParticle.posY) * 0.5;

        const newRopeParticleIndex = this.phys.createParticle(newPosX, newPosY);
        this.phys.distanceConstraints[lastConstraintIndex]!.particleIndex1 = newRopeParticleIndex;

        this.distanceConstraintIndices.push(this.phys.createDistanceConstraint(newRopeParticleIndex, this.skeleton.pelvisParticleIndex));
    }

    public bindEndToSkeleton(): void {
        const lastConstraintIndex = this.distanceConstraintIndices[this.distanceConstraintIndices.length - 1]!;
        const fc = this.phys.fixedConstraints[this.fixedSkeletonConstraintIndex]!;
        fc.isEnabled = false;
        this.distanceConstraintIndices.push(
            this.phys.createDistanceConstraint(
                this.phys.distanceConstraints[lastConstraintIndex]!.particleIndex1,
                this.skeleton.pelvisParticleIndex,
            ),
        );
    }

    private initialize(phys: SpringPhysics, wall: Wall, skeleton: Skeleton, _posX: number, _posY: number): void {
        this.phys = phys;
        this.wall = wall;
        this.skeleton = skeleton;

        let particleStartIndex = 0;
        let numParticlesForRope = 0;

        // legacy var scope: wa1 is used by both rope parts below
        let wa1: WallAnchor;

        // create first anchored rope part
        {
            const anchorStartIndex = 16;
            const wa0 = this.wall.wallAnchors[anchorStartIndex + 0]!;
            wa1 = this.wall.wallAnchors[anchorStartIndex + 10]!;

            const deltaX = wa1.posX - wa0.posX;
            const deltaY = wa1.posY - wa0.posY;

            const dirLength = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

            const dirX = deltaX / dirLength;
            const dirY = deltaY / dirLength;

            const numParticlesForFirstPart = Math.ceil(dirLength / this.ropeSegmentLength);
            numParticlesForRope += numParticlesForFirstPart;
            particleStartIndex = this.phys.particleStates.length;
            for (let n = 0; n < numParticlesForFirstPart; n++) {
                let particlePosX = wa0.posX + dirX * n * this.ropeSegmentLength;
                const particlePosY = wa0.posY + dirY * n * this.ropeSegmentLength;

                if (n > 0 && n < numParticlesForFirstPart - 1) {
                    const wa = findNearbyWallAnchor(this.wall, particlePosY);
                    particlePosX = wa.posX - 10;
                }

                this.phys.createParticle(particlePosX, particlePosY);
            }

            this.fixedConstraintIndices.push(this.phys.createFixedConstraint(particleStartIndex));
            this.fixedConstraintIndices.push(this.phys.createFixedConstraint(particleStartIndex + numParticlesForFirstPart - 1));
        }

        // create second rope part which is bound to the player character
        {
            const targetParticleState = this.phys.particleStates[skeleton.pelvisParticleIndex]!;
            const deltaX = targetParticleState.posX - wa1.posX;
            const deltaY = targetParticleState.posY - wa1.posY;

            const dirLength = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

            const dirX = deltaX / dirLength;
            const dirY = deltaY / dirLength;

            const numParticlesForSecondPart = Math.ceil(dirLength / this.ropeSegmentLength);
            numParticlesForRope += numParticlesForSecondPart;
            for (let n = 0; n < numParticlesForSecondPart; n++) {
                const particlePosX = wa1.posX + dirX * n * this.ropeSegmentLength;
                const particlePosY = wa1.posY + dirY * n * this.ropeSegmentLength;

                /*if (n > 0 && n < numParticlesForSecondPart - 1) {
                    const wa = findNearbyWallAnchor(this.wall, particlePosY);
                    particlePosX = wa.posX - 10;
                }*/

                this.phys.createParticle(particlePosX, particlePosY);
            }
        }

        for (let n = 0; n < numParticlesForRope - 1; n++) {
            const dcIndex = this.phys.createDistanceConstraint(particleStartIndex + n, particleStartIndex + n + 1);
            this.distanceConstraintIndices.push(dcIndex);
        }

        // fake connect rope with skeleton
        const dc = this.phys.distanceConstraints[this.distanceConstraintIndices[this.distanceConstraintIndices.length - 1]!]!;
        this.fixedSkeletonConstraintIndex = this.phys.createFixedConstraint(dc.particleIndex1);
    }
}
