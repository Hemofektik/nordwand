import type { Camera } from "./Camera.ts";
import type { Wall } from "./Wall.ts";
import { wrapTextureCoord } from "./pixelDraw.ts";

/**
 * Sky, distant ridges, and the rock texture. The images are the concept
 * PSDs (`bg_mountains`, `sprite_wolken_01`, `tex_fels_01`) exported with
 * their alpha intact. They are drawn 1:1 in logical pixels — the presenter
 * scales the whole frame by an integer afterwards.
 */

const SKY_BANDS = ["#c9e2f4", "#bad4ed", "#a9cbe6", "#98bddc"];
const ROCK_FALLBACK = [71, 69, 62];
const ROCK_EDGE = [28, 26, 24];

let mountains: HTMLImageElement | null = null;
let clouds: HTMLImageElement | null = null;
let rockPixels: Uint8ClampedArray | null = null;
let rockWidth = 0;
let rockHeight = 0;
let rockLayer: HTMLCanvasElement | null = null;
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

    clouds = new Image();
    clouds.src = "/sprites/sprite_wolken_01.png";

    const rock = new Image();
    rock.src = "/sprites/tex_fels_01.png";
    rock.onload = (): void => {
        const scratch = document.createElement("canvas");
        scratch.width = rock.naturalWidth;
        scratch.height = rock.naturalHeight;
        const ctx = scratch.getContext("2d", { willReadFrequently: true });
        if (ctx === null) {
            return;
        }
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(rock, 0, 0);
        const data = ctx.getImageData(0, 0, scratch.width, scratch.height);
        rockPixels = data.data;
        rockWidth = scratch.width;
        rockHeight = scratch.height;
    };
}

export function drawSky(ctx: CanvasRenderingContext2D): void {
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    const bandCount = SKY_BANDS.length;
    const bandHeight = Math.max(1, Math.floor(height / bandCount));
    for (let i = 0; i < bandCount; i++) {
        const y = i * bandHeight;
        const h = i === bandCount - 1 ? height - y : bandHeight;
        ctx.fillStyle = SKY_BANDS[i]!;
        ctx.fillRect(0, y, width, h);
    }
}

export function drawMountains(ctx: CanvasRenderingContext2D, cam: Camera): void {
    if (!imageReady(mountains)) {
        return;
    }
    // The plate's ridges are the bottom 123 rows. Pin that edge to the
    // bottom of the frame, then let it drift down as the climber rises.
    const parallax = Math.round(-cam.posY * 0.08);
    const y = Math.round(cam.canvas.height - mountains.naturalHeight + parallax);
    ctx.drawImage(mountains, 0, y);
}

export function drawClouds(ctx: CanvasRenderingContext2D, cam: Camera, timeSeconds: number): void {
    if (!imageReady(clouds)) {
        return;
    }
    const drift = Math.round(Math.sin(timeSeconds * 0.2) * 6);
    const parallax = Math.round(-cam.posY * 0.04);
    const x = -8 + drift;
    const y = -36 + parallax;
    ctx.drawImage(clouds, x, y);
}

function overlayContext(width: number, height: number): CanvasRenderingContext2D {
    if (rockLayer === null) {
        rockLayer = document.createElement("canvas");
    }
    if (rockLayer.width !== width || rockLayer.height !== height) {
        rockLayer.width = width;
        rockLayer.height = height;
    }
    const ctx = rockLayer.getContext("2d", { willReadFrequently: true });
    if (ctx === null) {
        throw new Error("Rock layer context is not available");
    }
    return ctx;
}

/** Pixel rock on the +x side of the face. The edge is a single dark column, not a smoothed polygon. */
export function drawRockFace(ctx: CanvasRenderingContext2D, cam: Camera, wall: Wall): void {
    const width = cam.canvas.width;
    const height = cam.canvas.height;
    if (width <= 0 || height <= 0) {
        return;
    }

    const overlay = overlayContext(width, height);
    const image = overlay.createImageData(width, height);
    const pixels = image.data;
    const step = cam.pixelScale;
    const tex = rockPixels;
    const texW = rockWidth;
    const texH = rockHeight;

    for (let y = 0; y < height; y++) {
        const worldY = cam.viewport_to_world_y_pixel(y + 0.5);
        const wallX = wall.wallXAtY(worldY);
        if (wallX === undefined) {
            continue;
        }
        const start = Math.round(cam.world_to_viewport_x_pixel(wallX) / step) * step;
        const x0 = Math.max(0, start);
        const ty = tex !== null ? wrapTextureCoord(worldY, texH) : 0;
        for (let x = x0; x < width; x++) {
            const di = (y * width + x) * 4;
            if (x < start + step) {
                pixels[di] = ROCK_EDGE[0]!;
                pixels[di + 1] = ROCK_EDGE[1]!;
                pixels[di + 2] = ROCK_EDGE[2]!;
                pixels[di + 3] = 255;
                continue;
            }
            if (tex !== null) {
                const worldX = cam.viewport_to_world_x_pixel(x + 0.5);
                const tx = wrapTextureCoord(worldX, texW);
                const ti = (ty * texW + tx) * 4;
                pixels[di] = tex[ti]!;
                pixels[di + 1] = tex[ti + 1]!;
                pixels[di + 2] = tex[ti + 2]!;
                pixels[di + 3] = 255;
            } else {
                pixels[di] = ROCK_FALLBACK[0]!;
                pixels[di + 1] = ROCK_FALLBACK[1]!;
                pixels[di + 2] = ROCK_FALLBACK[2]!;
                pixels[di + 3] = 255;
            }
        }
    }

    overlay.putImageData(image, 0, 0);
    ctx.drawImage(rockLayer!, 0, 0);
}
