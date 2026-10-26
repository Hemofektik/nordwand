import type { Camera } from "./Camera.ts";
import type { Wall } from "./Wall.ts";

/**
 * Sky, clouds, distant ridges, and the rock face.
 *
 * The rock is a world-locked pixel texture in the mockup 04 olive-grey
 * palette: vertical ridges, horizontal strata, and fine speckle. Ledges and
 * the overhang are a visual offset from `wallXAtY` — collision does not move.
 * Mountains are the concept plate. Clouds are solid white pixels with a
 * one-pixel underside, not the shaded cloud PSD.
 */

const SKY = "#bad4ed";
const CLOUD = [255, 255, 255];
const CLOUD_UNDER = [229, 234, 239];
const BIRD = "#2c3338";

/** Dark olive / brown-grey, darkest first. Sampled from mockup 04. */
const ROCK: ReadonlyArray<readonly [number, number, number]> = [
    [32, 31, 26],
    [38, 37, 30],
    [46, 44, 37],
    [48, 46, 38],
    [58, 55, 46],
    [60, 58, 48],
    [63, 61, 50],
    [69, 66, 54],
    [72, 69, 57],
    [79, 76, 62],
    [86, 82, 68],
    [99, 95, 78],
];

const MOSS: readonly [number, number, number] = [90, 117, 46];
const MOSS_HI: readonly [number, number, number] = [122, 162, 58];

let mountains: HTMLImageElement | null = null;
let rockLayer: HTMLCanvasElement | null = null;
let cloudLayer: HTMLCanvasElement | null = null;
let cloudKey = "";
let started = false;

function imageReady(image: HTMLImageElement | null): image is HTMLImageElement {
    return image !== null && image.complete && image.naturalWidth > 0;
}

/** Deterministic 32-bit mix. Rendering must not touch the wall RNG. */
function hash(x: number, y: number): number {
    let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (n ^ (n >>> 16)) >>> 0;
}

/**
 * How many world units the drawn face juts into the sky past the collision
 * line. Larger at the top of each bulge, so the lip reads as an overhang.
 */
export function rockSilhouetteOffset(worldY: number): number {
    const y = Math.floor(worldY);
    const big = Math.floor(y / 52);
    const bigT = (y - big * 52) / 52;
    const bigAmp = 5 + (hash(big, 3) % 11);
    const overhang = bigAmp * (1 - bigT) * (1 - bigT);
    const mid = hash(Math.floor(y / 11), 8) % 4;
    const fine = hash(y, 1) % 3;
    return overhang + mid * 0.45 + fine * 0.35;
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

function ensureClouds(width: number, height: number): HTMLCanvasElement {
    const key = `${width}x${height}`;
    if (cloudLayer !== null && cloudKey === key) {
        return cloudLayer;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) {
        throw new Error("Cloud layer context is not available");
    }
    const image = ctx.createImageData(width, height);
    const pixels = image.data;
    const blobs = [
        [0.16, 0.1, 0.2, 0.045],
        [0.34, 0.13, 0.12, 0.032],
        [0.58, 0.2, 0.16, 0.038],
        [0.08, 0.34, 0.11, 0.028],
        [0.42, 0.42, 0.14, 0.03],
        [0.22, 0.56, 0.1, 0.024],
    ];
    for (const blob of blobs) {
        const cx = Math.round(blob[0]! * width);
        const cy = Math.round(blob[1]! * height);
        const rx = Math.max(8, Math.round(blob[2]! * width));
        const ry = Math.max(4, Math.round(blob[3]! * height));
        for (let dy = -ry; dy <= ry; dy++) {
            for (let dx = -rx; dx <= rx; dx++) {
                const nx = dx / rx;
                const ny = dy / ry;
                const d = nx * nx + ny * ny;
                if (d > 1) {
                    continue;
                }
                const px = cx + dx;
                const py = cy + dy;
                if (px < 0 || py < 0 || px >= width || py >= height) {
                    continue;
                }
                if (d > 0.78 && hash(px, py) % 3 === 0) {
                    continue;
                }
                const i = (py * width + px) * 4;
                pixels[i] = CLOUD[0]!;
                pixels[i + 1] = CLOUD[1]!;
                pixels[i + 2] = CLOUD[2]!;
                pixels[i + 3] = 255;
            }
        }
    }
    for (let x = 0; x < width; x++) {
        let bottom = -1;
        for (let y = height - 1; y >= 0; y--) {
            if (pixels[(y * width + x) * 4 + 3]! !== 0) {
                bottom = y;
                break;
            }
        }
        if (bottom < 0) {
            continue;
        }
        const i = (bottom * width + x) * 4;
        pixels[i] = CLOUD_UNDER[0]!;
        pixels[i + 1] = CLOUD_UNDER[1]!;
        pixels[i + 2] = CLOUD_UNDER[2]!;
    }
    ctx.putImageData(image, 0, 0);
    cloudLayer = canvas;
    cloudKey = key;
    return canvas;
}

export function drawClouds(ctx: CanvasRenderingContext2D, _cam: Camera, timeSeconds: number): void {
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    if (width <= 0 || height <= 0) {
        return;
    }
    const tile = ensureClouds(width, height);
    const drift = Math.round(Math.sin(timeSeconds * 0.05) * 10);
    const bob = Math.round(Math.sin(timeSeconds * 0.08) * 2);
    const x = ((drift % width) + width) % width;
    ctx.drawImage(tile, x, bob);
    ctx.drawImage(tile, x - width, bob);
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
    ctx.imageSmoothingEnabled = false;
    return ctx;
}

function rockRgb(worldX: number, worldY: number, depth: number, underLip: boolean): readonly [number, number, number] {
    const x = Math.floor(worldX);
    const y = Math.floor(worldY);
    const ridge = (hash(Math.floor(x / 3), 17) % 5) - 2;
    const stratum = (hash(Math.floor((y + Math.floor(x / 17)) / 6), 29) % 5) - 2;
    let idx = 7 + ridge + stratum;
    const speck = hash(x, y) % 11;
    if (speck === 0) {
        idx -= 3;
    } else if (speck === 1) {
        idx += 2;
    } else if (speck < 4) {
        idx -= 1;
    }
    if (depth < 1.2) {
        idx -= 1;
    }
    if (underLip && depth < 5) {
        idx -= 2;
    }
    if (idx < 0) {
        idx = 0;
    } else if (idx >= ROCK.length) {
        idx = ROCK.length - 1;
    }
    // The lip stays olive-grey. Near-black is for speckles and the underside of an overhang.
    if (!underLip && depth < 2 && idx < 4) {
        idx = 4;
    }
    return ROCK[idx]!;
}

function writePx(pixels: Uint8ClampedArray, width: number, x: number, y: number, rgb: readonly [number, number, number]): void {
    if (x < 0 || y < 0 || x >= width || y >= pixels.length / (width * 4)) {
        return;
    }
    const i = (y * width + x) * 4;
    pixels[i] = rgb[0]!;
    pixels[i + 1] = rgb[1]!;
    pixels[i + 2] = rgb[2]!;
    pixels[i + 3] = 255;
}

/** Pixel rock on the +x side of the face, with a soft lip instead of a black outline. */
export function drawRockFace(ctx: CanvasRenderingContext2D, cam: Camera, wall: Wall): void {
    const width = cam.canvas.width;
    const height = cam.canvas.height;
    if (width <= 0 || height <= 0) {
        return;
    }

    const overlay = overlayContext(width, height);
    const image = overlay.createImageData(width, height);
    const pixels = image.data;

    for (let y = 0; y < height; y++) {
        const worldY = cam.viewport_to_world_y_pixel(y + 0.5);
        const wallX = wall.wallXAtY(worldY);
        if (wallX === undefined) {
            continue;
        }
        const offset = rockSilhouetteOffset(worldY);
        const edgeWorld = wallX - offset;
        const edgePx = Math.round(cam.world_to_viewport_x_pixel(edgeWorld));
        const yDown = Math.floor(worldY);
        const offsetDown = rockSilhouetteOffset(yDown + 1);
        const offsetUp = rockSilhouetteOffset(yDown - 1);
        const shelf = offset + 1.2 < offsetDown;
        const cap = offset > offsetUp + 1.2 && offset > 6;
        const underLip = offset > rockSilhouetteOffset(yDown + 3) + 3;
        const tuft = hash(Math.floor(edgeWorld), yDown) % 11 === 0;

        if (shelf || cap || tuft) {
            const blades = 1 + (hash(Math.floor(edgeWorld), yDown) % 3);
            const moss = hash(Math.floor(edgeWorld) + yDown, 2) % 2 === 0 ? MOSS_HI : MOSS;
            for (let b = 1; b <= blades; b++) {
                writePx(pixels, width, edgePx - b, y, moss);
            }
            if (shelf && hash(yDown, 6) % 2 === 0) {
                writePx(pixels, width, edgePx - 1, y - 1, MOSS_HI);
            }
        }

        const x0 = edgePx < 0 ? 0 : edgePx;
        for (let x = x0; x < width; x++) {
            const worldX = cam.viewport_to_world_x_pixel(x + 0.5);
            const depth = worldX - edgeWorld;
            if (depth < 0) {
                continue;
            }
            let rgb = rockRgb(worldX, worldY, depth, underLip);
            if ((shelf && depth < 5) || (cap && depth < 3) || (tuft && depth < 2)) {
                rgb = hash(Math.floor(worldX), yDown) % 3 === 0 ? MOSS_HI : MOSS;
            }
            writePx(pixels, width, x, y, rgb);
        }
    }

    overlay.putImageData(image, 0, 0);
    ctx.drawImage(rockLayer!, 0, 0);
}
