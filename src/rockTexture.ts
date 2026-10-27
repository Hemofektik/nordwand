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
 * Chunks cache that collage. The silhouette is `wallXAtY` sampled once per
 * logical row and snapped to that pixel. Lip shading, ledge moss, and the
 * depth into the rock are measured from those integer columns. Collision
 * stays on `wallXAtY`. Nothing here calls the wall RNG.
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
    canvas: HTMLCanvasElement;
    indices: Uint8Array;
}

const chunks = new Map<string, RockChunk>();

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

function bakeChunk(seed: number, cx: number, cy: number): RockChunk {
    const canvas = document.createElement("canvas");
    canvas.width = CHUNK;
    canvas.height = CHUNK;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) {
        throw new Error("Rock chunk context is not available");
    }
    ctx.imageSmoothingEnabled = false;
    const image = ctx.createImageData(CHUNK, CHUNK);
    const indices = new Uint8Array(CHUNK * CHUNK);
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    const rgba = image.data;
    for (let y = 0; y < CHUNK; y++) {
        for (let x = 0; x < CHUNK; x++) {
            const idx = rockIndexAt(x0 + x, y0 + y, seed);
            indices[y * CHUNK + x] = idx;
            const rgb = PALETTE[idx] ?? PALETTE[8]!;
            const i = (y * CHUNK + x) * 4;
            rgba[i] = rgb[0]!;
            rgba[i + 1] = rgb[1]!;
            rgba[i + 2] = rgb[2]!;
            rgba[i + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    return { canvas, indices };
}

function getChunk(seed: number, cx: number, cy: number): RockChunk {
    const key = `${seed}:${cx}:${cy}`;
    const hit = chunks.get(key);
    if (hit !== undefined) {
        return hit;
    }
    const baked = bakeChunk(seed, cx, cy);
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
 * Snap a collision sample to a logical column.
 *
 * `screenX` is `wallXAtY` in the same pixel space as the logical frame.
 * The result is `floor(screenX)` or `ceil(screenX)`, so the drawn edge stays
 * within one logical pixel of the collision line. The Bayer threshold only
 * chooses which of those two columns a fractional sample lands on.
 */
export function quantizeEdgeColumn(screenX: number, row: number): number {
    if (!Number.isFinite(screenX)) {
        return 0;
    }
    const base = Math.floor(screenX);
    const frac = screenX - base;
    if (frac === 0) {
        return base;
    }
    const rowKey = row < 0 ? -row : row;
    const threshold = (BAYER[rowKey & 7]![0]! + 0.5) / 64;
    return frac >= threshold ? base + 1 : base;
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

function columnSlope(columns: ReadonlyArray<number | undefined>, y: number): number {
    const below = columns[y + 2];
    const above = columns[y - 2];
    if (below === undefined || above === undefined) {
        return 0;
    }
    return (below - above) / 4;
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

/** Copy cached chunks into the frame and darken the lip from the silhouette normal. */
export function drawRockFace(ctx: CanvasRenderingContext2D, cam: Camera, wall: Wall): void {
    const width = cam.canvas.width;
    const height = cam.canvas.height;
    if (width <= 0 || height <= 0) {
        return;
    }
    const seed = wall.seed;
    const overlay = layer(width, height);
    if (frame === null || frame.width !== width || frame.height !== height) {
        frame = overlay.createImageData(width, height);
    } else {
        frame.data.fill(0);
    }
    const pixels = frame.data;
    const columns: Array<number | undefined> = new Array(height);
    const worldRows = new Float64Array(height);

    for (let y = 0; y < height; y++) {
        const worldY = cam.viewport_to_world_y_pixel(y + 0.5);
        worldRows[y] = worldY;
        const wallX = wall.wallXAtY(worldY);
        if (wallX === undefined) {
            continue;
        }
        columns[y] = quantizeEdgeColumn(cam.world_to_viewport_x_pixel(wallX), y);
    }

    for (let y = 0; y < height; y++) {
        const column = columns[y];
        const worldY = worldRows[y] ?? 0;
        if (column === undefined) {
            continue;
        }
        const slope = columnSlope(columns, y);
        const shelf = slope < -0.35;
        if (shelf) {
            const blades = 1 + (hash3(column, y, seed) % 2);
            const moss = hash3(y, seed, 6) % 2 === 0 ? PALETTE[MOSS_HI]! : PALETTE[MOSS]!;
            for (let b = 1; b <= blades; b++) {
                write(pixels, width, height, column - b, y, moss);
            }
        }

        const x0 = column < 0 ? 0 : column;
        const wy = Math.floor(worldY);
        const cy = Math.floor(wy / CHUNK);
        let activeCx = Number.NaN;
        let active: RockChunk | undefined;
        for (let x = x0; x < width; x++) {
            const depth = x - column;
            const worldX = cam.viewport_to_world_x_pixel(x + 0.5);
            const wx = Math.floor(worldX);
            const cx = Math.floor(wx / CHUNK);
            if (cx !== activeCx) {
                active = getChunk(seed, cx, cy);
                activeCx = cx;
            }
            const chunk = active;
            if (chunk === undefined) {
                continue;
            }
            const lx = wx - cx * CHUNK;
            const ly = wy - cy * CHUNK;
            let idx = chunk.indices[ly * CHUNK + lx] ?? 8;
            if (shelf && depth < 2) {
                idx = hash3(wx, wy, seed) % 2 === 0 ? MOSS_HI : MOSS;
            }
            if (depth < SHADE_REACH) {
                idx = applyRockShade(idx, rockEdgeShade(depth, slope, x, y));
            }
            write(pixels, width, height, x, y, PALETTE[idx] ?? PALETTE[8]!);
        }
    }

    overlay.putImageData(frame, 0, 0);
    ctx.drawImage(rockLayer!, 0, 0);
}
