import type { Camera } from "./Camera.ts";
import type { PhysicalParticleState } from "./Physics.ts";

let noiseIndex = 0;

export function rand(): number {
    let x = noiseIndex;
    noiseIndex++;

    x = ((x << 13) ^ x) & 0xffffffff;
    return x * ((x * x * 15731 + 789221) & 0xffffffff) + 1376312589;
}

export function randF(): number {
    const r = rand();
    return (0x7fffffff & r) / 0x7fffffff;
}

export class WallSegment {
    public posX = 0;
    public posY = 0;
}

export class WallAnchor {
    public posX = 0;
    public posY = 0;
    public index = 0;
}

function drawDebugLineWall(
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

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(screenPosX0, screenPosY0);
    ctx.lineTo(screenPosX0 + 500, screenPosY0);
    ctx.lineTo(screenPosX1 + 500, screenPosY1);
    ctx.lineTo(screenPosX1, screenPosY1);
    ctx.closePath();
    ctx.fill();
}

function drawDebugWallAnchor(ctx: CanvasRenderingContext2D, cam: Camera, wa: WallAnchor, color: string): void {
    const screenPosX = Math.round(cam.world_to_viewport_x_pixel(wa.posX) / cam.pixelScale) * cam.pixelScale;
    const screenPosY = Math.round(cam.world_to_viewport_y_pixel(wa.posY) / cam.pixelScale) * cam.pixelScale;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.rect(screenPosX - cam.pixelScale, screenPosY - cam.pixelScale, cam.pixelScale * 2, cam.pixelScale * 2);
    ctx.closePath();
    ctx.fill();
}

export class Wall {
    public wallSegments: WallSegment[] = [];
    public wallAnchors: WallAnchor[] = [];

    public constructor(posX: number, posY: number) {
        this.initialize(posX, posY);
    }

    public update(_deltaTime: number): void { }

    public draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
        for (let n = 0; n < this.wallSegments.length - 1; n++) {
            const ws0 = this.wallSegments[n + 0];
            const ws1 = this.wallSegments[n + 1];
            if (ws0 === undefined || ws1 === undefined) {
                continue;
            }
            drawDebugLineWall(ctx, cam, ws0.posX, ws0.posY, ws1.posX, ws1.posY, "#303335");
        }

        for (const wa of this.wallAnchors) {
            drawDebugWallAnchor(ctx, cam, wa, "#FF0000");
        }
    }

    public addAnchor(segmentIndex: number): void {
        const anchorDistance = 10.0;
        const ws0 = this.wallSegments[segmentIndex + 0];
        const ws1 = this.wallSegments[segmentIndex + 1];
        if (ws0 === undefined || ws1 === undefined) {
            return;
        }

        const deltaX = ws1.posX - ws0.posX;
        const deltaY = ws1.posY - ws0.posY;
        const dirLength = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        if (dirLength === 0) {
            return;
        }

        const dirX = deltaX / dirLength;
        const dirY = deltaY / dirLength;
        const numAnchors = dirLength / anchorDistance;
        for (let n = 0; n < numAnchors; n++) {
            const wa = new WallAnchor();
            wa.posX = ws0.posX + dirX * n * anchorDistance;
            wa.posY = ws0.posY + dirY * n * anchorDistance;
            wa.index = this.wallAnchors.length;
            this.wallAnchors.push(wa);
        }
    }

    public getNearbyAnchors(posX: number, posY: number, maxDistance: number): WallAnchor[] {
        const result: WallAnchor[] = [];
        for (const wa of this.wallAnchors) {
            const deltaX = posX - wa.posX;
            const deltaY = posY - wa.posY;
            const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
            if (distance <= maxDistance) {
                result.push(wa);
            }
        }
        return result;
    }

    public wallXAtY(posY: number): number | undefined {
        let wallX: number | undefined;
        for (let n = 0; n < this.wallSegments.length - 1; n++) {
            const ws0 = this.wallSegments[n];
            const ws1 = this.wallSegments[n + 1];
            if (ws0 === undefined || ws1 === undefined) {
                continue;
            }

            const minY = Math.min(ws0.posY, ws1.posY);
            const maxY = Math.max(ws0.posY, ws1.posY);
            if (posY < minY || posY > maxY) {
                continue;
            }

            const deltaY = ws1.posY - ws0.posY;
            const t = Math.abs(deltaY) < 0.0001 ? 0 : (posY - ws0.posY) / deltaY;
            const x = ws0.posX + t * (ws1.posX - ws0.posX);
            wallX = wallX === undefined ? x : Math.min(wallX, x);
        }
        return wallX;
    }

    public collideParticle(state: PhysicalParticleState, skin = 1): boolean {
        const wallX = this.wallXAtY(state.posY);
        if (wallX === undefined) {
            return false;
        }

        const surfaceX = wallX - skin;
        if (state.posX <= surfaceX) {
            return false;
        }

        state.posX = surfaceX;
        if (state.velX > 0) {
            state.velX = 0;
        }
        state.velY *= 0.85;
        return true;
    }

    private initialize(initialPosX: number, initialPosY: number): void {
        const numParticles = 32;
        let posX = initialPosX + 45;
        let posY = initialPosY + 300;

        const wallVariationBandWidth = 100;
        const halfWallVariationBandWidth = wallVariationBandWidth * 0.5;
        const segmentLength = 40.0;
        let segmentDirRad = -Math.PI * 0.5;

        for (let x = 0; x < numParticles - 1; x++) {
            const ws = new WallSegment();
            const variationDir = (initialPosX - posX) / halfWallVariationBandWidth;
            const variationStrength = Math.max(0.0, 1.0 - Math.abs(variationDir));

            let dirRadOffset = 0.0;
            dirRadOffset += (randF() - 0.5) * variationStrength * Math.PI * 1.0;
            dirRadOffset += variationDir * Math.PI * 0.2;

            if (segmentDirRad + dirRadOffset > -Math.PI * 0.1) {
                dirRadOffset = -Math.abs(dirRadOffset);
            } else if (segmentDirRad + dirRadOffset < -Math.PI * 0.9) {
                dirRadOffset = Math.abs(dirRadOffset);
            }

            segmentDirRad += dirRadOffset;
            const segmentDirX = Math.cos(segmentDirRad);
            const segmentDirY = Math.sin(segmentDirRad);

            posX += segmentDirX * segmentLength;
            posY += segmentDirY * segmentLength;
            ws.posX = posX;
            ws.posY = posY;
            this.wallSegments.push(ws);
        }

        for (let n = 0; n < this.wallSegments.length - 1; n++) {
            this.addAnchor(n);
        }
    }
}
