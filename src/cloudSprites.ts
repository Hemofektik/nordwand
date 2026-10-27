import type { Camera } from "./Camera.ts";

/**
 * Fixed pixel clouds in the mockup palette: white body, one-pixel underside.
 * Shapes follow the stepped banks in `sprite_wolken_01` and mockup 04.
 * A seeded layout picks a sprite, flip, whole-number scale, and drift.
 * They are drawn 1:1 from pre-baked canvases, smoothing off.
 */

const WHITE = "#ffffff";
const UNDER = "#e5eaef";

const SPRITES: ReadonlyArray<readonly string[]> = [
    [
        "......WWWWWW..........",
        "....WWWWWWWWWWW.......",
        "..WWWWWWWWWWWWWWW.....",
        ".WWWWWWWWWWWWWWWWWW...",
        "WWWWWWWWWWWWWWWWWWWW..",
        "WWWWWWWWWWWWWWWWWWWWW.",
        "WWWWWWWWWWWWWWWWWWWW..",
        ".UUUUUUUUUUUUUUUUUUU..",
    ],
    [
        "...WWW..",
        ".WWWWWW.",
        "WWWWWWWW",
        "WWWWWWWW",
        ".UUUUUU.",
    ],
    [
        "....WWWW....WWWWW.......",
        ".WWWWWWWWWWWWWWWWWWW....",
        "WWWWWWWWWWWWWWWWWWWWWW..",
        "WWWWWWWWWWWWWWWWWWWWWWW.",
        ".UUUUUUUUUUUUUUUUUUUUU..",
    ],
    [
        "....WWW.....",
        "..WWWWWWW...",
        ".WWWWWWWWW..",
        "..WWWWWWWWWW",
        ".WWWWWWWWWWW",
        "WWWWWWWWWWWW",
        "WWWWWWWWWWWW",
        ".UUUUUUUUUUU",
    ],
    [
        "..WWWW.",
        ".WWWWWW",
        "WWWWWWWW",
        ".UUUUUU.",
    ],
    [
        ".WWWW....WWW..",
        "WWWWWW.WWWWWW.",
        "WWWWWWWWWWWWWW",
        ".UUUUUUUUUUUU.",
    ],
];

interface BakedCloud {
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
}

const baked = new Map<string, BakedCloud>();

function bake(sprite: number, flip: boolean, scale: 1 | 2): BakedCloud {
    const key = `${sprite}:${flip ? 1 : 0}:${scale}`;
    const hit = baked.get(key);
    if (hit !== undefined) {
        return hit;
    }
    const rows = SPRITES[sprite]!;
    const sw = rows[0]!.length;
    const sh = rows.length;
    const canvas = document.createElement("canvas");
    canvas.width = sw * scale;
    canvas.height = sh * scale;
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
        throw new Error("Cloud sprite context is not available");
    }
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < sh; y++) {
        const row = rows[y]!;
        for (let x = 0; x < sw; x++) {
            const ch = row[flip ? sw - 1 - x : x];
            if (ch === "W") {
                ctx.fillStyle = WHITE;
            } else if (ch === "U") {
                ctx.fillStyle = UNDER;
            } else {
                continue;
            }
            ctx.fillRect(x * scale, y * scale, scale, scale);
        }
    }
    const cloud = { canvas, width: canvas.width, height: canvas.height };
    baked.set(key, cloud);
    return cloud;
}

export interface CloudInstance {
    sprite: number;
    x: number;
    y: number;
    flip: boolean;
    scale: 1 | 2;
    drift: number;
    phase: number;
}

function hash3(x: number, y: number, s: number): number {
    let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1440672389);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (n ^ (n >>> 16)) >>> 0;
}

/** One cloud in a vertical band. Deterministic from the wall seed. */
export function cloudInstance(seed: number, band: number, index: number): CloudInstance {
    const h = hash3(band, index, seed + 50);
    const h2 = hash3(index, seed, band + 9);
    const scale: 1 | 2 = h % 4 === 0 ? 2 : 1;
    return {
        sprite: h % SPRITES.length,
        x: (h2 % 1000) / 1000,
        y: band * 150 + (h % 130),
        flip: (h2 & 1) === 1,
        scale,
        drift: 3 + (h2 % 9),
        phase: (h % 628) / 100,
    };
}

const PARALLAX = 0.2;

export function drawCloudField(ctx: CanvasRenderingContext2D, cam: Camera, timeSeconds: number, seed: number): void {
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    if (width <= 0 || height <= 0) {
        return;
    }
    ctx.imageSmoothingEnabled = false;
    const viewY = cam.posY * PARALLAX;
    const band0 = Math.floor(viewY / 150) - 1;
    const band1 = band0 + Math.ceil(height / 90) + 2;
    for (let band = band0; band <= band1; band++) {
        const count = 3 + (hash3(band, seed, 3) % 2);
        for (let i = 0; i < count; i++) {
            const cloud = cloudInstance(seed, band, i);
            const sprite = bake(cloud.sprite, cloud.flip, cloud.scale);
            const drift = Math.round(Math.sin(timeSeconds * 0.045 * (cloud.drift / 6) + cloud.phase) * cloud.drift);
            const bob = Math.round(Math.sin(timeSeconds * 0.12 + cloud.phase) * 1);
            const sky = Math.max(sprite.width + 4, Math.round(width * 0.8));
            const x = Math.round(cloud.x * (sky - sprite.width) + drift);
            const y = Math.round(cloud.y - viewY + bob);
            if (x > width || y > height || x + sprite.width < 0 || y + sprite.height < 0) {
                continue;
            }
            ctx.drawImage(sprite.canvas, x, y);
        }
    }
}
