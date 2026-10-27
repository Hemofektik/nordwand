import type { Camera } from "./Camera.ts";
import { drawCloudField } from "./cloudSprites.ts";
import { drawRockFace } from "./rockTexture.ts";

/**
 * Sky, distant ridges, and birds. Clouds and the rock face live in their
 * own modules and are re-exported so the frame loop keeps one import.
 */

const SKY = "#bad4ed";
const BIRD = "#2c3338";

let mountains: HTMLImageElement | null = null;
let started = false;

function imageReady(image: HTMLImageElement | null): image is HTMLImageElement {
    return image !== null && image.complete && image.naturalWidth > 0;
}

export function loadPixelScene(): void {
    if (started) {
        return;
    }
    started = true;
    mountains = new Image();
    mountains.src = "/sprites/bg_mountains.png";
}

export function drawSky(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = SKY;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

export function drawMountains(ctx: CanvasRenderingContext2D, cam: Camera): void {
    if (!imageReady(mountains)) {
        return;
    }
    const parallax = Math.round(-cam.posY * 0.08);
    const y = Math.round(cam.canvas.height - mountains.naturalHeight + parallax);
    const tile = mountains.naturalWidth;
    const drift = Math.round(-cam.posX * 0.02);
    let x = ((drift % tile) + tile) % tile;
    if (x > 0) {
        x -= tile;
    }
    for (; x < cam.canvas.width; x += tile) {
        ctx.drawImage(mountains, x, y);
    }
}

export function drawClouds(ctx: CanvasRenderingContext2D, cam: Camera, timeSeconds: number, seed: number): void {
    drawCloudField(ctx, cam, timeSeconds, seed);
}

const BIRDS: ReadonlyArray<readonly [number, number, number]> = [
    [0.1, 0.16, 0.4],
    [0.28, 0.3, 1.6],
    [0.06, 0.48, 2.4],
    [0.22, 0.66, 3.5],
];

/** Tiny sky silhouettes. Screen-space, so a bird stays in the open air as the wall scrolls. */
export function drawBirds(ctx: CanvasRenderingContext2D, timeSeconds: number): void {
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    ctx.fillStyle = BIRD;
    for (const bird of BIRDS) {
        const drift = Math.sin(timeSeconds * 0.12 + bird[2]!) * 14;
        const x = Math.round(bird[0]! * width * 0.7 + drift);
        const y = Math.round(bird[1]! * height * 0.72 + Math.sin(timeSeconds * 0.4 + bird[2]!) * 1.5);
        const lift = Math.sin(timeSeconds * 3 + bird[2]!) > 0 ? 0 : 1;
        ctx.fillRect(x - 2, y + lift, 1, 1);
        ctx.fillRect(x + 2, y + lift, 1, 1);
        ctx.fillRect(x - 1, y + 1, 1, 1);
        ctx.fillRect(x + 1, y + 1, 1, 1);
        ctx.fillRect(x, y + 2, 1, 1);
    }
}

export { drawRockFace };
