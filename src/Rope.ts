import type { Camera } from "./Camera.ts";
import type { SpringPhysics } from "./Physics.ts";
import type { Skeleton } from "./Skeleton.ts";
import type { Wall, WallAnchor } from "./Wall.ts";
import { defined } from "./assert.ts";

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

    let currentX = x0;
    let currentY = y0;
    for (let n = 0; n < dist; n++) {
        const screenPosX = Math.round(cam.world_to_viewport_x_pixel(currentX) * invPixelScale) * cam.pixelScale;
        const screenPosY = Math.round(cam.world_to_viewport_y_pixel(currentY) * invPixelScale) * cam.pixelScale;
        ctx.rect(screenPosX, screenPosY, cam.pixelScale, cam.pixelScale);

        const e2 = 2 * err;
        if (e2 > dy) {
            err += dy;
            currentX += sx;
        }
        if (e2 < dx) {
            err += dx;
            currentY += sy;
        }
    }
}

function endDrawPixelLine(ctx: CanvasRenderingContext2D): void {
    ctx.fill();
}

function findNearbyWallAnchor(wall: Wall, posY: number): WallAnchor {
    let nearestAnchor: WallAnchor | undefined;
    let nearestAnchorDistanceSqr = 10000000000.0;
    for (const wa of wall.wallAnchors) {
        const deltaY = wa.posY - posY;
        const distanceSqr = deltaY * deltaY;
        if (nearestAnchorDistanceSqr > distanceSqr) {
            nearestAnchorDistanceSqr = distanceSqr;
            nearestAnchor = wa;
        }
    }

    return defined(nearestAnchor, "No nearby wall anchor found for rope");
}

export class Rope {
    public phys: SpringPhysics;
    public wall: Wall;
    public skeleton: Skeleton;
    public distanceConstraintIndices: number[] = [];

    public constructor(phys: SpringPhysics, wall: Wall, skeleton: Skeleton, posX: number, posY: number) {
        this.phys = phys;
        this.wall = wall;
        this.skeleton = skeleton;
        this.initialize(posX, posY);
    }

    public update(_deltaTime: number): void { }

    public draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
        const invPixelScale = 1.0 / cam.pixelScale;
        beginDrawPixelLine(ctx, "#2A0D03");
        for (const constraintIndex of this.distanceConstraintIndices) {
            const c = this.phys.distanceConstraints[constraintIndex];
            if (c === undefined) {
                continue;
            }

            const state0 = this.phys.particleStates[c.particleIndex0];
            const state1 = this.phys.particleStates[c.particleIndex1];
            if (state0 === undefined || state1 === undefined) {
                continue;
            }

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

    private initialize(_posX: number, _posY: number): void {
        const ropeSegmentLength = 2;
        let particleStartIndex = 0;
        let numParticlesForRope = 0;
        let lastParticleIndex = 0;

        const firstAnchor = defined(this.wall.wallAnchors[0], "Missing first wall anchor for rope");
        const secondAnchor = defined(this.wall.wallAnchors[1], "Missing second wall anchor for rope");
        const anchorSpacing = Math.hypot(
            secondAnchor.posX - firstAnchor.posX,
            secondAnchor.posY - firstAnchor.posY,
        );
        const anchorStartIndex = Math.round(200 / anchorSpacing);
        const wa0 = defined(this.wall.wallAnchors[anchorStartIndex], "Missing rope start wall anchor");
        const pelvis = defined(
            this.phys.particleStates[this.skeleton.pelvisParticleIndex],
            "Missing pelvis particle for rope",
        );
        const wa1 = findNearbyWallAnchor(this.wall, (wa0.posY + pelvis.posY) * 0.5);

        {
            const deltaX = wa1.posX - wa0.posX;
            const deltaY = wa1.posY - wa0.posY;
            const dirLength = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
            const dirX = deltaX / dirLength;
            const dirY = deltaY / dirLength;
            const numParticlesForFirstPart = Math.ceil(dirLength / ropeSegmentLength);
            numParticlesForRope += numParticlesForFirstPart;
            particleStartIndex = this.phys.particleStates.length;

            for (let n = 0; n < numParticlesForFirstPart; n++) {
                let particlePosX = wa0.posX + dirX * n * ropeSegmentLength;
                const particlePosY = wa0.posY + dirY * n * ropeSegmentLength;

                if (n > 0 && n < numParticlesForFirstPart - 1) {
                    const wa = findNearbyWallAnchor(this.wall, particlePosY);
                    particlePosX = wa.posX - 10;
                }

                lastParticleIndex = this.phys.createParticle(particlePosX, particlePosY);
            }

            this.phys.createFixedConstraint(particleStartIndex);
            this.phys.createFixedConstraint(particleStartIndex + numParticlesForFirstPart - 1);
        }

        {
            const targetParticleState = defined(
                this.phys.particleStates[this.skeleton.pelvisParticleIndex],
                "Missing pelvis particle for rope",
            );
            const deltaX = targetParticleState.posX - wa1.posX;
            const deltaY = targetParticleState.posY - wa1.posY;
            const dirLength = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
            const dirX = deltaX / dirLength;
            const dirY = deltaY / dirLength;
            const numParticlesForSecondPart = Math.ceil(dirLength / ropeSegmentLength);
            numParticlesForRope += numParticlesForSecondPart;

            for (let n = 0; n < numParticlesForSecondPart; n++) {
                const particlePosX = wa1.posX + dirX * n * ropeSegmentLength;
                const particlePosY = wa1.posY + dirY * n * ropeSegmentLength;
                lastParticleIndex = this.phys.createParticle(particlePosX, particlePosY);
            }
        }

        for (let n = 0; n < numParticlesForRope - 1; n++) {
            const dcIndex = this.phys.createDistanceConstraint(particleStartIndex + n, particleStartIndex + n + 1);
            this.distanceConstraintIndices.push(dcIndex);
        }

        this.distanceConstraintIndices.push(this.phys.createDistanceConstraint(lastParticleIndex, this.skeleton.pelvisParticleIndex));
    }
}
