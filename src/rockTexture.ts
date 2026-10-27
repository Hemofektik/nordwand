import type { Camera } from "./Camera.ts";
import type { Wall } from "./Wall.ts";

/**
 * World-locked rock, baked once per chunk.
 *
 * Several materials (stratified slab, lumpy boulder, speckled granite,
 * fissures, moss) are chosen by a domain-warped cell mask. Cell borders are
 * hard Bayer dither, not blended antialiasing. Chunks are cached canvases
 * keyed by the wall seed, so scrolling only copies pixels and shades the lip.
 * The silhouette is a visual offset from `wallXAtY`. Collision is unchanged.
 * Nothing here calls the wall RNG.
 */

const CHUNK = 64;
const CELL = 34;

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

const SHADOW: readonly [number, number, number] = [28, 27, 22];
const RIM: readonly [number, number, number] = [130, 124, 104];
const MOSS = 12;
const MOSS_HI = 13;

const BAYER: ReadonlyArray<ReadonlyArray<number>> = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
];

interface RockChunk {
    canvas: HTMLCanvasElement;
    indices: Uint8Array;
    rgba: Uint8ClampedArray;
}

const chunks = new Map<string, RockChunk>();

function hash3(x: number, y: number, s: number): number {
    let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1440672389);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (n ^ (n >>> 16)) >>> 0;
}

function clampIndex(idx: number, max = 11): number {
    if (idx < 0) {
        return 0;
    }
    if (idx > max) {
        return max;
    }
    return idx;
}

function slab(x: number, y: number, seed: number): number {
    const col = Math.floor(x / 3);
    const ridge = (hash3(col, seed, 17) % 5) - 2;
    const band = Math.floor((y + Math.floor(x / 17)) / 5);
    const stratum = (hash3(band, seed, 29) % 5) - 2;
    let idx = 7 + ridge + stratum;
    const speck = hash3(x, y, seed) % 13;
    if (speck === 0) {
        idx -= 3;
    } else if (speck === 1) {
        idx += 2;
    } else if (speck < 4) {
        idx -= 1;
    }
    if (hash3(col, 3, seed) % 8 === 0) {
        idx -= 2;
    }
    return clampIndex(idx);
}

function boulder(x: number, y: number, seed: number): number {
    const cell = 10;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    let best = 1e9;
    let second = 1e9;
    for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
            const h = hash3(cx + ox, cy + oy, seed + 4);
            const fx = (cx + ox) * cell + (h % cell);
            const fy = (cy + oy) * cell + ((h >>> 8) % cell);
            const dx = x - fx;
            const dy = y - fy;
            const d = dx * dx + dy * dy;
            if (d < best) {
                second = best;
                best = d;
            } else if (d < second) {
                second = d;
            }
        }
    }
    const crevice = Math.sqrt(second) - Math.sqrt(best);
    if (crevice < 1.35) {
        return 2;
    }
    const lump = Math.sqrt(best);
    if (lump < 2.1) {
        return 10;
    }
    if (lump < 3.6) {
        return 8;
    }
    return 6;
}

function granite(x: number, y: number, seed: number): number {
    const n = hash3(x, y, seed + 9);
    let idx = 5 + (n % 4);
    if (n % 17 === 0) {
        idx = 11;
    } else if (n % 19 === 0) {
        idx = 2;
    }
    if (hash3(Math.floor(x / 2), seed, 2) % 7 === 0) {
        idx -= 1;
    }
    return clampIndex(idx);
}

function cracks(x: number, y: number, seed: number): number {
    const base = slab(x, y, seed);
    const col = Math.floor(x / 15);
    const h = hash3(col, seed, 77);
    if (h % 3 !== 0) {
        return base;
    }
    const jag = (hash3(y, seed + col, 6) % 5) - 2;
    const crackX = col * 15 + 7 + jag;
    const dist = Math.abs(x - crackX);
    if (dist === 0) {
        return 1;
    }
    if (dist === 1 && (y & 1) === 0) {
        return 3;
    }
    if (y % 20 === h % 5 && dist < 7) {
        return 2;
    }
    return base;
}

function mossy(x: number, y: number, seed: number): number {
    const base = slab(x, y, seed + 2);
    const n = hash3(Math.floor(x / 2), Math.floor(y / 2), seed + 15);
    if (n % 5 === 0) {
        return MOSS_HI;
    }
    if (n % 5 === 1 || n % 5 === 2) {
        return MOSS;
    }
    return base;
}

const MATERIALS = [slab, boulder, granite, cracks, mossy];

function materialId(cx: number, cy: number, seed: number): number {
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
    if (h < 9) {
        return 3;
    }
    return 4;
}

/** Palette index at a world pixel. Pure: same seed and coordinate, same rock. */
export function rockIndexAt(x: number, y: number, seed: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const nx = Math.floor(ix / 8);
    const ny = Math.floor(iy / 8);
    const ox = (hash3(nx, ny, seed) % 13) - 6;
    const oy = (hash3(nx + 3, ny + 1, seed) % 13) - 6;
    const wx = ix + ox;
    const wy = iy + oy;
    const cx = Math.floor(wx / CELL);
    const cy = Math.floor(wy / CELL);
    const fx = wx - cx * CELL;
    const fy = wy - cy * CELL;
    const border = Math.min(fx, CELL - fx, fy, CELL - fy);
    const here = materialId(cx, cy, seed);
    let id = here;
    if (border < 5) {
        let nbx = cx;
        let nby = cy;
        if (fx <= border) {
            nbx = cx - 1;
        } else if (CELL - fx <= border) {
            nbx = cx + 1;
        } else if (fy <= border) {
            nby = cy - 1;
        } else {
            nby = cy + 1;
        }
        const other = materialId(nbx, nby, seed);
        if (other !== here) {
            const t = (5 - border) / 5;
            const bayer = BAYER[iy & 3]![ix & 3]!;
            if (bayer < t * 16) {
                id = other;
            }
        }
    }
    return MATERIALS[id]!(ix, iy, seed);
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
            const rgb = PALETTE[idx]!;
            const i = (y * CHUNK + x) * 4;
            rgba[i] = rgb[0]!;
            rgba[i + 1] = rgb[1]!;
            rgba[i + 2] = rgb[2]!;
            rgba[i + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    return { canvas, indices, rgba };
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

/** How far the drawn face juts into the sky, in world units. Seeded, not the wall RNG. */
export function rockSilhouetteOffset(worldY: number, seed: number): number {
    const y = Math.floor(worldY);
    const big = Math.floor(y / 48);
    const bigT = (y - big * 48) / 48;
    const bigAmp = 4 + (hash3(big, seed, 3) % 12);
    const overhang = bigAmp * (1 - bigT) * (1 - bigT);
    const mid = hash3(Math.floor(y / 9), seed, 8) % 5;
    const fine = hash3(y, seed, 1) % 3;
    return overhang + mid * 0.55 + fine * 0.4;
}

function mix(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    t: number,
): readonly [number, number, number] {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
    ];
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

/** Copy cached chunks into the frame and shade the lip to match the silhouette. */
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

    for (let y = 0; y < height; y++) {
        const worldY = cam.viewport_to_world_y_pixel(y + 0.5);
        const wallX = wall.wallXAtY(worldY);
        if (wallX === undefined) {
            continue;
        }
        const offset = rockSilhouetteOffset(worldY, seed);
        const edgeWorld = wallX - offset;
        const edgePx = Math.round(cam.world_to_viewport_x_pixel(edgeWorld));
        const yFloor = Math.floor(worldY);
        const offsetDown = rockSilhouetteOffset(yFloor + 1, seed);
        const offsetUp = rockSilhouetteOffset(yFloor - 1, seed);
        const shelf = offset + 1.3 < offsetDown;
        const cap = offset > offsetUp + 1.3 && offset > 6;
        const underLip = offset > rockSilhouetteOffset(yFloor + 4, seed) + 3.5;

        if (shelf || cap) {
            const blades = 1 + (hash3(Math.floor(edgeWorld), yFloor, seed) % 3);
            const moss = hash3(yFloor, seed, 6) % 2 === 0 ? PALETTE[MOSS_HI]! : PALETTE[MOSS]!;
            for (let b = 1; b <= blades; b++) {
                write(pixels, width, height, edgePx - b, y, moss);
            }
            if (shelf && hash3(yFloor, seed, 11) % 2 === 0) {
                write(pixels, width, height, edgePx - 1, y - 1, PALETTE[MOSS_HI]!);
            }
        }

        const x0 = edgePx < 0 ? 0 : edgePx;
        const wy = Math.floor(worldY);
        const cy = Math.floor(wy / CHUNK);
        let activeCx = Number.NaN;
        let active: RockChunk | undefined;
        for (let x = x0; x < width; x++) {
            const worldX = cam.viewport_to_world_x_pixel(x + 0.5);
            const depth = worldX - edgeWorld;
            if (depth < 0) {
                continue;
            }
            const wx = Math.floor(worldX);
            const cx = Math.floor(wx / CHUNK);
            if (cx !== activeCx) {
                active = getChunk(seed, cx, cy);
                activeCx = cx;
            }
            const chunk = active!;
            const lx = wx - cx * CHUNK;
            const ly = wy - cy * CHUNK;
            const idx = chunk.indices[ly * CHUNK + lx]!;
            const src = PALETTE[idx]!;
            let rgb: readonly [number, number, number] = src;
            if ((shelf && depth < 5) || (cap && depth < 3)) {
                rgb = hash3(wx, wy, seed) % 3 === 0 ? PALETTE[MOSS_HI]! : PALETTE[MOSS]!;
            } else if (underLip && depth < 8) {
                rgb = mix(src, SHADOW, depth < 2 ? 0.55 : 0.32);
            } else if (depth < 1) {
                rgb = mix(src, RIM, 0.4);
            } else if (depth < 3) {
                rgb = mix(src, SHADOW, 0.24);
            }
            write(pixels, width, height, x, y, rgb);
        }
    }

    overlay.putImageData(frame, 0, 0);
    ctx.drawImage(rockLayer!, 0, 0);
}
