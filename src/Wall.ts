import type { Camera } from "./Camera.ts";
import { RandF, SetNoiseIndex } from "./MathUtils.ts";

export class WallSegment {
    public posX = 0;
    public posY = 0;
}

export class WallAnchor {
    public posX = 0;
    public posY = 0;
    public index = 0; // index into wallAnchors array
    public segmentIndex = 0; // index into wallSegments array
}

function drawDebugLineWall(ctx: CanvasRenderingContext2D, cam: Camera, x0: number, y0: number, x1: number, y1: number, color: string): void {
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
    ctx.lineTo(screenPosX0 + 500 * cam.pixelScale, screenPosY0);
    ctx.lineTo(screenPosX1 + 500 * cam.pixelScale, screenPosY1);
    ctx.lineTo(screenPosX1, screenPosY1);
    ctx.closePath();
    ctx.fill();
}

function drawDebugWallAnchors(ctx: CanvasRenderingContext2D, cam: Camera, wallAnchors: WallAnchor[], color: string): void {
    ctx.fillStyle = color;
    ctx.beginPath();

    for (const wa of wallAnchors) {
        const screenPosX = Math.round(cam.world_to_viewport_x_pixel(wa.posX) / cam.pixelScale) * cam.pixelScale;
        const screenPosY = Math.round(cam.world_to_viewport_y_pixel(wa.posY) / cam.pixelScale) * cam.pixelScale;

        ctx.rect(screenPosX - cam.pixelScale, screenPosY - cam.pixelScale, cam.pixelScale * 2, cam.pixelScale * 2);
    }

    ctx.closePath();
    ctx.fill();
}

export class Wall {
    public wallSegments: WallSegment[] = [];
    public wallAnchors: WallAnchor[] = []; // points which the player can grab

    public medianX = 0;
    public minPosYVisible = 10000000;
    public maxPosYVisible = -10000000;
    public minWallSegmentIndexVisible = 0;
    public maxWallSegmentIndexVisible = 0;

    public segmentDirRad = -Math.PI * 0.5;

    public update(_deltaTime: number): void {
        const lastVisibleWallSegment = this.wallSegments[this.wallSegments.length - 2]!;
        while (lastVisibleWallSegment.posY > this.minPosYVisible) {
            const lastWS = this.wallSegments[this.wallSegments.length - 1]!;
            this.addSegment(lastWS.posX, lastWS.posY);
            this.addAnchors(this.wallSegments.length - 2);

            // TODO: start generation of wall segment image

            // re-read (the array grew)
            const current = this.wallSegments[this.wallSegments.length - 2]!;
            if (current.posY <= this.minPosYVisible) {
                break;
            }
        }
    }

    public draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
        this.minPosYVisible = cam.viewport_to_world_y_pixel(0);
        this.maxPosYVisible = cam.viewport_to_world_y_pixel(cam.canvas.height);

        // compute which segments are visible
        while (
            this.minWallSegmentIndexVisible > 0 &&
            this.wallSegments[this.minWallSegmentIndexVisible]!.posY < this.maxPosYVisible
        ) {
            this.minWallSegmentIndexVisible--;
        }
        while (
            this.maxWallSegmentIndexVisible + 2 < this.wallSegments.length &&
            this.wallSegments[this.maxWallSegmentIndexVisible + 1]!.posY > this.minPosYVisible
        ) {
            this.maxWallSegmentIndexVisible++;
        }

        // render only visible elements
        for (let n = this.minWallSegmentIndexVisible; n <= this.maxWallSegmentIndexVisible; n++) {
            const ws0 = this.wallSegments[n + 0];
            const ws1 = this.wallSegments[n + 1];
            if (ws0 === undefined || ws1 === undefined) {
                continue;
            }

            // hide elements if they are not visible
            if (ws1.posY > this.maxPosYVisible) {
                this.minWallSegmentIndexVisible++;
                continue;
            }
            if (ws0.posY < this.minPosYVisible) {
                this.maxWallSegmentIndexVisible--;
                continue;
            }

            drawDebugLineWall(ctx, cam, ws0.posX, ws0.posY, ws1.posX, ws1.posY, "#303335");
        }

        drawDebugWallAnchors(ctx, cam, this.wallAnchors, "#FF0000");
    }

    public addSegment(posX: number, posY: number): void {
        const wallVariationBandWidth = 100;
        const halfWallVariationBandWidth = wallVariationBandWidth * 0.5;
        const segmentLength = 40.0;

        const ws = new WallSegment();

        const variationDir = (this.medianX - posX) / halfWallVariationBandWidth;
        const variationStrength = Math.max(0.0, 1.0 - Math.abs(variationDir));

        let dirRadOffset = 0.0;
        // add variable slope change as long as not at screen border
        dirRadOffset += (RandF() - 0.5) * variationStrength * Math.PI * 1.0;
        // try to stay away from screen border
        dirRadOffset += variationDir * Math.PI * 0.2;

        // do not allow to get negative slope (downwards)
        if (this.segmentDirRad + dirRadOffset > -Math.PI * 0.1) {
            dirRadOffset = -Math.abs(dirRadOffset);
        } else if (this.segmentDirRad + dirRadOffset < -Math.PI * 0.9) {
            dirRadOffset = Math.abs(dirRadOffset);
        }

        this.segmentDirRad += dirRadOffset;

        const segmentDirX = Math.cos(this.segmentDirRad);
        const segmentDirY = Math.sin(this.segmentDirRad);

        posX += segmentDirX * segmentLength;
        posY += segmentDirY * segmentLength;

        ws.posX = posX;
        ws.posY = posY;

        this.wallSegments.push(ws);
    }

    public addAnchors(segmentIndex: number): void {
        const anchorDistance = 5.0;

        const ws0 = this.wallSegments[segmentIndex + 0];
        const ws1 = this.wallSegments[segmentIndex + 1];
        if (ws0 === undefined || ws1 === undefined) {
            return;
        }

        const deltaX = ws1.posX - ws0.posX;
        const deltaY = ws1.posY - ws0.posY;

        const dirLength = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

        const dirX = deltaX / dirLength;
        const dirY = deltaY / dirLength;

        const numAnchors = dirLength / anchorDistance;
        for (let n = 0; n < numAnchors; n++) {
            const wa = new WallAnchor();
            wa.posX = ws0.posX + dirX * n * anchorDistance;
            wa.posY = ws0.posY + dirY * n * anchorDistance;
            wa.index = this.wallAnchors.length;
            wa.segmentIndex = segmentIndex;
            this.wallAnchors.push(wa);
        }
    }

    public getNearbyAnchors(posX: number, posY: number, maxDistance: number): WallAnchor[] {
        const result: WallAnchor[] = [];

        // TODO: optimize by anticipation of height using posY
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

    public constructor(posX: number, posY: number, wallSeed: number) {
        this.initialize(posX, posY, wallSeed);
    }

    private initialize(initialPosX: number, initialPosY: number, wallSeed: number): void {
        const numSegments = 12;

        SetNoiseIndex(wallSeed);

        this.medianX = initialPosX;

        let posX = initialPosX + 45;
        let posY = initialPosY + 300;

        for (let n = 0; n < numSegments; n++) {
            this.addSegment(posX, posY);

            posX = this.wallSegments[n]!.posX;
            posY = this.wallSegments[n]!.posY;
        }

        for (let n = 0; n < this.wallSegments.length - 1; n++) {
            this.addAnchors(n);
        }
    }
}
