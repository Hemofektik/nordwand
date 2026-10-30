import type { Camera } from "./Camera.ts";
import type { Wall } from "./Wall.ts";
import { ROCK_PATCHES, rockPatchPixels } from "./rockPatches.ts";

/**
 * World-locked rock, baked once per chunk.
 *
 * The face is a seeded collage of stencils cut from the mockup
 * (`public/sprites/rock`, mirrored by `rockPatches.ts`) plus a lumpy
 * patch remapped from `tex_fels_01`. Cells are smaller than a stencil,
 * so a window never wraps a non-seamless crop. Borders cross-fade with
 * an ordered dither, and each cell is flipped and shifted from the seed.
 * Chunks cache that collage. The silhouette is chosen once per integer
 * world row from `wallXAtY`, and the lip shade, shelf moss, and pitons are
 * baked into the same chunks. Nothing in that bake reads the camera.
 * Collision stays on `wallXAtY`. Nothing here calls the wall RNG.
 */

const CHUNK = 64;
const CELL = 32;
const BLEND = 8;
const SHADE_REACH = 9;

const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
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
    [90, 117, 46],
    [122, 162, 58],
];

const MOSS = 12;
const MOSS_HI = 13;

/** 8×8 ordered dither, values 0..63. */
const BAYER: ReadonlyArray<ReadonlyArray<number>> = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
];

interface RockChunk {
    pixels: Uint8ClampedArray;
    complete: boolean;
    segments: number;
}

const chunks = new Map<string, RockChunk>();
const edgeColumns = new Map<string, number>();
const pitonColumns = new Map<number, ReadonlyArray<{ x: number; y: number }>>();

const PITON_DARK: readonly [number, number, number] = [0x4e, 0x54, 0x5c];
const PITON_BODY: readonly [number, number, number] = [0xb7, 0xbc, 0xc4];
const PITON_HI: readonly [number, number, number] = [0xe7, 0xeb, 0xf0];

function hash3(x: number, y: number, s: number): number {
    let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1440672389);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (n ^ (n >>> 16)) >>> 0;
}

interface Stamp {
    patch: number;
    flipX: boolean;
    flipY: boolean;
    ox: number;
    oy: number;
}

function patchChoice(cx: number, cy: number, seed: number): number {
    const h = hash3(cx, cy, seed + 100) % 10;
    if (h < 3) {
        return 0;
    }
    if (h < 5) {
        return 1;
    }
    if (h < 7) {
        return 2;
    }
    if (h < 8) {
        return 3;
    }
    if (h < 9) {
        return 4;
    }
    return 5;
}

function stampAt(cx: number, cy: number, seed: number): Stamp {
    const patch = patchChoice(cx, cy, seed);
    const spec = ROCK_PATCHES[patch];
    const width = spec?.width ?? CELL;
    const height = spec?.height ?? CELL;
    const h = hash3(cx + 3, cy + 1, seed + 17);
    const h2 = hash3(cx + 9, cy + 5, seed + 29);
    const slackX = width - CELL;
    const slackY = height - CELL;
    return {
        patch,
        flipX: (h & 1) === 1,
        flipY: (h2 & 1) === 1,
        ox: slackX > 0 ? h % (slackX + 1) : 0,
        oy: slackY > 0 ? h2 % (slackY + 1) : 0,
    };
}

function sampleStamp(stamp: Stamp, localX: number, localY: number): number {
    const patch = ROCK_PATCHES[stamp.patch];
    if (patch === undefined) {
        return 8;
    }
    const pixels = rockPatchPixels(stamp.patch);
    let x = stamp.ox + localX;
    let y = stamp.oy + localY;
    if (stamp.flipX) {
        x = stamp.ox + (CELL - 1) - localX;
    }
    if (stamp.flipY) {
        y = stamp.oy + (CELL - 1) - localY;
    }
    if (x < 0) {
        x = 0;
    } else if (x >= patch.width) {
        x = patch.width - 1;
    }
    if (y < 0) {
        y = 0;
    } else if (y >= patch.height) {
        y = patch.height - 1;
    }
    return pixels[y * patch.width + x] ?? 8;
}

/**
 * Palette index at a world pixel. Pure: same seed and coordinate, same rock.
 * Stencil windows stay inside each patch. The blend band is an ordered dither
 * between this cell and the nearest neighbour, so a crop does not have to tile.
 */
export function rockIndexAt(x: number, y: number, seed: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const cx = Math.floor(ix / CELL);
    const cy = Math.floor(iy / CELL);
    const fx = ix - cx * CELL;
    const fy = iy - cy * CELL;
    const here = stampAt(cx, cy, seed);
    let index = sampleStamp(here, fx, fy);
    const border = Math.min(fx, fy, CELL - 1 - fx, CELL - 1 - fy);
    if (border < BLEND) {
        let nbx = cx;
        let nby = cy;
        if (fx <= border) {
            nbx = cx - 1;
        } else if (CELL - 1 - fx <= border) {
            nbx = cx + 1;
        } else if (fy <= border) {
            nby = cy - 1;
        } else {
            nby = cy + 1;
        }
        const other = stampAt(nbx, nby, seed);
        const otherIndex = sampleStamp(other, ix - nbx * CELL, iy - nby * CELL);
        if (otherIndex !== index) {
            const t = (BLEND - border) / BLEND;
            const bayer = BAYER[iy & 7]![ix & 7]!;
            if (bayer < t * 64) {
                index = otherIndex;
            }
        }
    }
    return index;
}

function rememberChunk(key: string, baked: RockChunk): RockChunk {
    chunks.set(key, baked);
    if (chunks.size > 96) {
        const oldest = chunks.keys().next().value;
        if (oldest !== undefined) {
            chunks.delete(oldest);
        }
    }
    return baked;
}

/**
 * Snap a collision sample to a world column.
 *
 * `worldX` is `wallXAtY` and `worldY` is the integer world row. The result is
 * `floor(worldX)` or `ceil(worldX)`, so the drawn edge stays within one pixel
 * of the collision line. The Bayer cell is `(worldX, worldY)`, never a screen
 * coordinate, so the choice does not move with the camera.
 */
export function quantizeEdgeColumn(worldX: number, worldY: number): number {
    if (!Number.isFinite(worldX)) {
        return 0;
    }
    const base = Math.floor(worldX);
    const frac = worldX - base;
    if (frac === 0) {
        return base;
    }
    const rowKey = worldY < 0 ? -worldY : worldY;
    const colKey = base < 0 ? -base : base;
    const threshold = (BAYER[rowKey & 7]![colKey & 7]! + 0.5) / 64;
    return frac >= threshold ? base + 1 : base;
}

/** True when this world row is above the generated wall and may appear later. */
function edgeStillGrowing(wall: Wall, worldY: number): boolean {
    const top = wall.wallSegments[wall.wallSegments.length - 1];
    return top !== undefined && worldY < top.posY;
}

/**
 * World x of the silhouette on one integer world row. Sampled once from
 * `wallXAtY` at the row center and then cached. Camera position is not an input.
 */
export function worldEdgeColumn(wall: Wall, worldY: number): number | undefined {
    const wy = Math.floor(worldY);
    const key = `${wall.seed}:${wy}`;
    const cached = edgeColumns.get(key);
    if (cached !== undefined) {
        return cached;
    }
    const wallX = wall.wallXAtY(wy + 0.5);
    if (wallX === undefined) {
        return undefined;
    }
    const column = quantizeEdgeColumn(wallX, wy);
    edgeColumns.set(key, column);
    return column;
}

function worldSlope(wall: Wall, worldY: number): { slope: number; pending: boolean } {
    const belowY = worldY + 2;
    const aboveY = worldY - 2;
    const below = worldEdgeColumn(wall, belowY);
    const above = worldEdgeColumn(wall, aboveY);
    const pending =
        (below === undefined && edgeStillGrowing(wall, belowY)) ||
        (above === undefined && edgeStillGrowing(wall, aboveY));
    if (below === undefined || above === undefined) {
        return { slope: 0, pending };
    }
    return { slope: (below - above) / 4, pending };
}

/** Metal pins on the bolted span, in world pixels. Stable for a wall seed. */
export function worldPitons(wall: Wall): ReadonlyArray<{ x: number; y: number }> {
    const cached = pitonColumns.get(wall.seed);
    if (cached !== undefined) {
        return cached;
    }
    const stamps: { x: number; y: number }[] = [];
    const last = Math.min(wall.wallAnchors.length - 1, 26);
    const seen = new Set<number>();
    for (let i = 16; i <= last; i += 3) {
        const anchor = wall.wallAnchors[i];
        if (anchor === undefined) {
            continue;
        }
        const y = Math.floor(anchor.posY);
        const edge = worldEdgeColumn(wall, y);
        if (edge === undefined || seen.has(y)) {
            continue;
        }
        seen.add(y);
        stamps.push({ x: edge, y });
    }
    const end = wall.wallAnchors[last];
    if (end !== undefined) {
        const y = Math.floor(end.posY);
        const edge = worldEdgeColumn(wall, y);
        if (edge !== undefined && !seen.has(y)) {
            stamps.push({ x: edge, y });
        }
    }
    pitonColumns.set(wall.seed, stamps);
    return stamps;
}

function paint(pixels: Uint8ClampedArray, lx: number, ly: number, rgb: readonly [number, number, number]): void {
    if (lx < 0 || ly < 0 || lx >= CHUNK || ly >= CHUNK) {
        return;
    }
    const i = (ly * CHUNK + lx) * 4;
    pixels[i] = rgb[0];
    pixels[i + 1] = rgb[1];
    pixels[i + 2] = rgb[2];
    pixels[i + 3] = 255;
}

function bakeChunk(wall: Wall, cx: number, cy: number): RockChunk {
    const pixels = new Uint8ClampedArray(CHUNK * CHUNK * 4);
    const seed = wall.seed;
    let complete = true;
    for (let ly = 0; ly < CHUNK; ly++) {
        const wy = cy * CHUNK + ly;
        const edge = worldEdgeColumn(wall, wy);
        if (edge === undefined) {
            if (edgeStillGrowing(wall, wy + 0.5)) {
                complete = false;
            }
            continue;
        }
        const slope = worldSlope(wall, wy);
        if (slope.pending) {
            complete = false;
        }
        const shelf = slope.slope < -0.35;
        const blades = shelf ? 1 + (hash3(edge, wy, seed) % 2) : 0;
        const moss = hash3(wy, seed, 6) % 2 === 0 ? MOSS_HI : MOSS;
        for (let lx = 0; lx < CHUNK; lx++) {
            const wx = cx * CHUNK + lx;
            const depth = wx - edge;
            let idx: number | undefined;
            if (depth < 0) {
                if (shelf && depth >= -blades) {
                    idx = moss;
                }
            } else {
                idx = rockIndexAt(wx, wy, seed);
                if (shelf && depth < 2) {
                    idx = hash3(wx, wy, seed) % 2 === 0 ? MOSS_HI : MOSS;
                }
                if (depth < SHADE_REACH) {
                    idx = applyRockShade(idx, rockEdgeShade(depth, slope.slope, wx, wy));
                }
            }
            const rgb = idx === undefined ? undefined : PALETTE[idx];
            if (rgb !== undefined) {
                paint(pixels, lx, ly, rgb);
            }
        }
    }
    for (const piton of worldPitons(wall)) {
        const originX = piton.x - cx * CHUNK;
        const originY = piton.y - cy * CHUNK;
        for (let dy = -2; dy <= 1; dy++) {
            for (let dx = -1; dx <= 2; dx++) {
                paint(pixels, originX + dx, originY + dy, PITON_DARK);
            }
        }
        for (let dy = -1; dy <= 0; dy++) {
            for (let dx = 0; dx <= 2; dx++) {
                paint(pixels, originX + dx, originY + dy, PITON_BODY);
            }
        }
        paint(pixels, originX + 1, originY - 1, PITON_HI);
    }
    return { pixels, complete, segments: wall.wallSegments.length };
}

function chunkAt(wall: Wall, cx: number, cy: number): RockChunk {
    const key = `${wall.seed}:${cx}:${cy}`;
    const hit = chunks.get(key);
    if (hit !== undefined && (hit.complete || hit.segments === wall.wallSegments.length)) {
        return hit;
    }
    return rememberChunk(key, bakeChunk(wall, cx, cy));
}

/** Baked colour of one world pixel, or null where the sky shows through. */
export function rockWorldPixel(wall: Wall, worldX: number, worldY: number): readonly [number, number, number, number] | null {
    const wx = Math.floor(worldX);
    const wy = Math.floor(worldY);
    const cx = Math.floor(wx / CHUNK);
    const cy = Math.floor(wy / CHUNK);
    const chunk = chunkAt(wall, cx, cy);
    const lx = wx - cx * CHUNK;
    const ly = wy - cy * CHUNK;
    const i = (ly * CHUNK + lx) * 4;
    const alpha = chunk.pixels[i + 3] ?? 0;
    if (alpha === 0) {
        return null;
    }
    return [chunk.pixels[i] ?? 0, chunk.pixels[i + 1] ?? 0, chunk.pixels[i + 2] ?? 0, alpha];
}

/** Screen pixel to the world pixel it shows, using a whole-pixel camera. */
export function screenToWorld(screen: number, cameraPos: number, viewSize: number): number {
    return Math.floor(screen + 0.5 + Math.round(cameraPos) - viewSize / 2);
}

/** Screen pixel that shows this world pixel under a whole-pixel camera. */
export function worldToScreen(world: number, cameraPos: number, viewSize: number): number {
    const wx = Math.floor(world);
    const guess = Math.floor(wx - Math.round(cameraPos) + viewSize / 2);
    for (let screen = guess - 1; screen <= guess + 1; screen++) {
        if (screenToWorld(screen, cameraPos, viewSize) === wx) {
            return screen;
        }
    }
    return guess;
}

/** Same baked pixel the screen shows at this camera, including fractional cameras. */
export function rockPixelForCamera(
    wall: Wall,
    cameraX: number,
    cameraY: number,
    viewWidth: number,
    viewHeight: number,
    screenX: number,
    screenY: number,
): readonly [number, number, number, number] | null {
    return rockWorldPixel(wall, screenToWorld(screenX, cameraX, viewWidth), screenToWorld(screenY, cameraY, viewHeight));
}

/**
 * How many palette steps to darken a rock pixel.
 *
 * `slope` is d(edgeX)/d(y) of the drawn silhouette (world +y is down, rock is
 * +x of the edge). The outward normal is (-1, slope). Light comes from the
 * upper left. A downward-facing normal (overhang underside, shaded side of a
 * lump) darkens more; an upward-facing normal stays closer to the stencil.
 * The amount falls off over `SHADE_REACH` pixels and the fractional step is
 * ordered-dithered so the ramp stays on the palette.
 */
export function rockEdgeShade(depth: number, slope: number, x: number, y: number): number {
    if (!(depth >= 0) || depth >= SHADE_REACH) {
        return 0;
    }
    const ny = slope < -1.6 ? -1.6 : slope > 1.6 ? 1.6 : slope;
    const len = Math.hypot(-1, ny);
    const down = Math.max(0, ny / len);
    const up = Math.max(0, -ny / len);
    const t = 1 - depth / SHADE_REACH;
    const fall = t * t * (3 - 2 * t);
    const darkness = fall * (0.3 + 0.95 * down - 0.22 * up);
    const steps = darkness * 4;
    const bayer = BAYER[y & 7]![x & 7]! / 64;
    let quant = Math.floor(steps + bayer);
    if (quant < 0) {
        quant = 0;
    } else if (quant > 4) {
        quant = 4;
    }
    return quant;
}

/** Step a palette index toward black. Moss drops to the darker moss, then to stone. */
export function applyRockShade(index: number, steps: number): number {
    if (steps <= 0) {
        return index;
    }
    if (index >= MOSS) {
        if (index === MOSS_HI && steps >= 1) {
            return steps >= 3 ? 8 : MOSS;
        }
        if (steps >= 4) {
            return 6;
        }
        return index;
    }
    const next = index - steps;
    return next < 0 ? 0 : next;
}

let rockLayer: HTMLCanvasElement | null = null;
let frame: ImageData | null = null;

function layer(width: number, height: number): CanvasRenderingContext2D {
    if (rockLayer === null) {
        rockLayer = document.createElement("canvas");
    }
    if (rockLayer.width !== width || rockLayer.height !== height) {
        rockLayer.width = width;
        rockLayer.height = height;
        frame = null;
    }
    const ctx = rockLayer.getContext("2d", { willReadFrequently: true });
    if (ctx === null) {
        throw new Error("Rock layer context is not available");
    }
    ctx.imageSmoothingEnabled = false;
    return ctx;
}

function write(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number, rgb: readonly [number, number, number]): void {
    if (x < 0 || y < 0 || x >= width || y >= height) {
        return;
    }
    const i = (y * width + x) * 4;
    pixels[i] = rgb[0]!;
    pixels[i + 1] = rgb[1]!;
    pixels[i + 2] = rgb[2]!;
    pixels[i + 3] = 255;
}

/** Blit the baked world chunks. The camera only chooses which world pixels are on screen. */
export function drawRockFace(ctx: CanvasRenderingContext2D, cam: Camera, wall: Wall): void {
    const width = cam.canvas.width;
    const height = cam.canvas.height;
    if (width <= 0 || height <= 0) {
        return;
    }
    const overlay = layer(width, height);
    if (frame === null || frame.width !== width || frame.height !== height) {
        frame = overlay.createImageData(width, height);
    } else {
        frame.data.fill(0);
    }
    const pixels = frame.data;
    let activeKey = "";
    let active: RockChunk | undefined;
    for (let sy = 0; sy < height; sy++) {
        const wy = screenToWorld(sy, cam.posY, height);
        const cy = Math.floor(wy / CHUNK);
        const ly = wy - cy * CHUNK;
        for (let sx = 0; sx < width; sx++) {
            const wx = screenToWorld(sx, cam.posX, width);
            const cx = Math.floor(wx / CHUNK);
            const key = `${cx}:${cy}`;
            if (key !== activeKey) {
                active = chunkAt(wall, cx, cy);
                activeKey = key;
            }
            const chunk = active;
            if (chunk === undefined) {
                continue;
            }
            const lx = wx - cx * CHUNK;
            const i = (ly * CHUNK + lx) * 4;
            const alpha = chunk.pixels[i + 3] ?? 0;
            if (alpha === 0) {
                continue;
            }
            write(pixels, width, height, sx, sy, [chunk.pixels[i] ?? 0, chunk.pixels[i + 1] ?? 0, chunk.pixels[i + 2] ?? 0]);
        }
    }

    overlay.putImageData(frame, 0, 0);
    ctx.drawImage(rockLayer!, 0, 0);
}
