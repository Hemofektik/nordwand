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

const SEGMENT_LENGTH = 40.0;
const WALL_VARIATION_BAND_WIDTH = 100;
const INITIAL_SEGMENT_COUNT = 32;
const MAX_SEGMENTS_PER_EXTEND = 64;

export class Wall {
    public wallSegments: WallSegment[] = [];
    public wallAnchors: WallAnchor[] = [];
    private originX = 0;
    private cursorX = 0;
    private cursorY = 0;
    private segmentDirRad = -Math.PI * 0.5;

    public constructor(posX: number, posY: number) {
        this.initialize(posX, posY);
    }

    public update(_deltaTime: number): void { }

    public ensureGeneratedTo(minY: number): void {
        for (let n = 0; n < MAX_SEGMENTS_PER_EXTEND; n++) {
            const last = this.wallSegments[this.wallSegments.length - 1];
            if (last === undefined || last.posY <= minY) {
                return;
            }
            this.appendSegment();
        }
    }

    public draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
        const viewTop = cam.viewport_to_world_y(0) - SEGMENT_LENGTH;
        const viewBottom = cam.viewport_to_world_y(cam.canvas.height) + SEGMENT_LENGTH;

        for (let n = 0; n < this.wallSegments.length - 1; n++) {
            const ws0 = this.wallSegments[n + 0];
            const ws1 = this.wallSegments[n + 1];
            if (ws0 === undefined || ws1 === undefined) {
                continue;
            }
            if (Math.max(ws0.posY, ws1.posY) < viewTop || Math.min(ws0.posY, ws1.posY) > viewBottom) {
                continue;
            }
            drawDebugLineWall(ctx, cam, ws0.posX, ws0.posY, ws1.posX, ws1.posY, "#303335");
        }

        for (const wa of this.wallAnchors) {
            if (wa.posY < viewTop || wa.posY > viewBottom) {
                continue;
            }
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
        const first = this.wallSegments[0];
        const last = this.wallSegments[this.wallSegments.length - 1];
        if (first === undefined || last === undefined || this.wallSegments.length < 2) {
            return undefined;
        }
        if (posY > first.posY || posY < last.posY) {
            return undefined;
        }

        let lo = 0;
        let hi = this.wallSegments.length - 2;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const ws0 = this.wallSegments[mid];
            const ws1 = this.wallSegments[mid + 1];
            if (ws0 === undefined || ws1 === undefined) {
                return undefined;
            }

            if (posY > ws0.posY) {
                hi = mid - 1;
                continue;
            }
            if (posY < ws1.posY) {
                lo = mid + 1;
                continue;
            }

            const deltaY = ws1.posY - ws0.posY;
            const t = Math.abs(deltaY) < 0.0001 ? 0 : (posY - ws0.posY) / deltaY;
            return ws0.posX + t * (ws1.posX - ws0.posX);
        }

        return undefined;
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
        this.originX = initialPosX;
        this.cursorX = initialPosX + 45;
        this.cursorY = initialPosY + 300;
        this.segmentDirRad = -Math.PI * 0.5;

        for (let n = 0; n < INITIAL_SEGMENT_COUNT - 1; n++) {
            this.appendSegment();
        }
    }

    private appendSegment(): void {
        const halfWallVariationBandWidth = WALL_VARIATION_BAND_WIDTH * 0.5;
        const variationDir = (this.originX - this.cursorX) / halfWallVariationBandWidth;
        const variationStrength = Math.max(0.0, 1.0 - Math.abs(variationDir));

        let dirRadOffset = 0.0;
        dirRadOffset += (randF() - 0.5) * variationStrength * Math.PI * 1.0;
        dirRadOffset += variationDir * Math.PI * 0.2;

        if (this.segmentDirRad + dirRadOffset > -Math.PI * 0.1) {
            dirRadOffset = -Math.abs(dirRadOffset);
        } else if (this.segmentDirRad + dirRadOffset < -Math.PI * 0.9) {
            dirRadOffset = Math.abs(dirRadOffset);
        }

        this.segmentDirRad += dirRadOffset;
        this.cursorX += Math.cos(this.segmentDirRad) * SEGMENT_LENGTH;
        this.cursorY += Math.sin(this.segmentDirRad) * SEGMENT_LENGTH;

        const ws = new WallSegment();
        ws.posX = this.cursorX;
        ws.posY = this.cursorY;
        this.wallSegments.push(ws);

        if (this.wallSegments.length >= 2) {
            this.addAnchor(this.wallSegments.length - 2);
        }
    }
}
