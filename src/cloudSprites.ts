import type { Camera } from "./Camera.ts";
import { SAMPLED_CLOUDS, sampledCloudMask } from "./sampledClouds.ts";

/**
 * Pixel clouds in the mockup palette: white body, `#e5eaef` underside.
 * Small shapes are hand-authored. Large and medium shapes are masks cut
 * from `concept/nordwand_mockup_04_large.png` (see `sampledClouds.ts`).
 * A seeded layout picks the sprite, flip, whole-number scale, and drift.
 * Big clouds sit on a nearer parallax layer than the small ones.
 * Sprites are drawn 1:1 from pre-baked canvases, smoothing off.
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

const SMALL_PARALLAX = 0.1;
const MEDIUM_PARALLAX = 0.18;
const LARGE_PARALLAX = 0.28;
const BAND = 200;

export const CLOUDS_PER_BAND = 4;

const LARGE_SPRITES: number[] = [];
const MEDIUM_SPRITES: number[] = [];
for (let i = 0; i < SAMPLED_CLOUDS.length; i++) {
    const cloud = SAMPLED_CLOUDS[i];
    if (cloud === undefined) {
        continue;
    }
    const index = SPRITES.length + i;
    if (cloud.tier === "large") {
        LARGE_SPRITES.push(index);
    } else {
        MEDIUM_SPRITES.push(index);
    }
}

export type CloudTier = "small" | "medium" | "large";

export interface CloudSpriteInfo {
    width: number;
    height: number;
    tier: CloudTier;
    parallax: number;
}

export function cloudSpriteCount(): number {
    return SPRITES.length + SAMPLED_CLOUDS.length;
}

export function cloudSpriteInfo(index: number): CloudSpriteInfo {
    if (index < SPRITES.length) {
        const rows = SPRITES[index];
        if (rows === undefined) {
            throw new Error("Unknown cloud sprite");
        }
        const width = rows[0]?.length ?? 0;
        return { width, height: rows.length, tier: "small", parallax: SMALL_PARALLAX };
    }
    const sampled = SAMPLED_CLOUDS[index - SPRITES.length];
    if (sampled === undefined) {
        throw new Error("Unknown cloud sprite");
    }
    return {
        width: sampled.width,
        height: sampled.height,
        tier: sampled.tier,
        parallax: sampled.tier === "large" ? LARGE_PARALLAX : MEDIUM_PARALLAX,
    };
}

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
    const info = cloudSpriteInfo(sprite);
    const canvas = document.createElement("canvas");
    canvas.width = info.width * scale;
    canvas.height = info.height * scale;
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
        throw new Error("Cloud sprite context is not available");
    }
    ctx.imageSmoothingEnabled = false;
    const paint = (x: number, y: number, color: string): void => {
        ctx.fillStyle = color;
        ctx.fillRect(x * scale, y * scale, scale, scale);
    };
    if (sprite < SPRITES.length) {
        const rows = SPRITES[sprite]!;
        for (let y = 0; y < info.height; y++) {
            const row = rows[y]!;
            for (let x = 0; x < info.width; x++) {
                const ch = row[flip ? info.width - 1 - x : x];
                if (ch === "W") {
                    paint(x, y, WHITE);
                } else if (ch === "U") {
                    paint(x, y, UNDER);
                }
            }
        }
    } else {
        const mask = sampledCloudMask(sprite - SPRITES.length);
        for (let y = 0; y < info.height; y++) {
            for (let x = 0; x < info.width; x++) {
                const src = flip ? info.width - 1 - x : x;
                const value = mask[y * info.width + src];
                if (value === 1) {
                    paint(x, y, WHITE);
                } else if (value === 2) {
                    paint(x, y, UNDER);
                }
            }
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

function pick(pool: readonly number[], h: number): number {
    const sprite = pool[h % pool.length];
    if (sprite === undefined) {
        return 0;
    }
    return sprite;
}

/** One cloud in a vertical band. Deterministic from the wall seed. */
export function cloudInstance(seed: number, band: number, index: number): CloudInstance {
    const h = hash3(band, index, seed + 50);
    const h2 = hash3(index, seed, band + 9);
    let sprite: number;
    let scale: 1 | 2 = 1;
    if (index === 0) {
        sprite = pick(LARGE_SPRITES, h);
    } else if (index === 1) {
        sprite = pick(MEDIUM_SPRITES, h);
    } else {
        sprite = h % SPRITES.length;
        scale = h % 4 === 0 ? 2 : 1;
    }
    return {
        sprite,
        x: (h2 % 1000) / 1000,
        y: band * BAND + (h % 140),
        flip: (h2 & 1) === 1,
        scale,
        drift: 3 + (h2 % 9),
        phase: (h % 628) / 100,
    };
}

export function drawCloudField(ctx: CanvasRenderingContext2D, cam: Camera, timeSeconds: number, seed: number): void {
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    if (width <= 0 || height <= 0) {
        return;
    }
    ctx.imageSmoothingEnabled = false;
    const yLo = cam.posY * SMALL_PARALLAX - 80;
    const yHi = cam.posY * LARGE_PARALLAX + height + 80;
    const band0 = Math.floor(yLo / BAND) - 1;
    const band1 = Math.ceil(yHi / BAND) + 1;
    for (let band = band0; band <= band1; band++) {
        for (let i = CLOUDS_PER_BAND - 1; i >= 0; i--) {
            const cloud = cloudInstance(seed, band, i);
            const info = cloudSpriteInfo(cloud.sprite);
            const sprite = bake(cloud.sprite, cloud.flip, cloud.scale);
            const driftAmp = info.tier === "large" ? Math.max(2, Math.round(cloud.drift * 0.5)) : cloud.drift;
            const drift = Math.round(Math.sin(timeSeconds * 0.045 * (cloud.drift / 6) + cloud.phase) * driftAmp);
            const bob = info.tier === "large" ? 0 : Math.round(Math.sin(timeSeconds * 0.12 + cloud.phase));
            const viewY = cam.posY * info.parallax;
            const y = Math.round(cloud.y - viewY + bob);
            let x: number;
            if (info.tier === "small") {
                const sky = Math.max(sprite.width + 4, Math.round(width * 0.68));
                x = Math.round(cloud.x * Math.max(0, sky - sprite.width) + drift);
            } else {
                // Keep the body of a wide cloud in the open sky. The rock owns
                // the right side of the frame, so a full-width scatter hides
                // the big banks inside the wall.
                const skyLimit = Math.round(width * (info.tier === "large" ? 0.5 : 0.6));
                const minX = -Math.round(sprite.width * 0.32);
                const maxX = Math.max(minX + 8, skyLimit - Math.round(sprite.width * 0.62));
                x = Math.round(minX + cloud.x * (maxX - minX) + drift);
            }
            if (x > width || y > height || x + sprite.width < 0 || y + sprite.height < 0) {
                continue;
            }
            ctx.drawImage(sprite.canvas, x, y);
        }
    }
}
