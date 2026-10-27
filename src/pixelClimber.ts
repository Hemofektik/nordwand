import type { Camera } from "./Camera.ts";
import type { Skeleton } from "./Skeleton.ts";

/**
 * The climber is filled in logical pixels: a capsule per bone, a disc at
 * every joint, then a one-pixel outline. Nothing is rotated as a sprite,
 * so a sharp elbow cannot open a gap or drop a pixel.
 */

const OUTLINE = 1;

const PALETTE = [
    "",
    "#201f1a",
    "#aba17d",
    "#8a8264",
    "#665f46",
    "#414722",
    "#22260d",
    "#e7a96c",
    "#1b1a15",
    "#6b4a32",
    "#4a3022",
    "#ac6900",
    "#995d00",
    "#daffff",
    "#21548f",
    "#de7947",
];

const SHIRT = 2;
const SHIRT_SHADE = 3;
const PANTS = 4;
const PANTS_DARK = 5;
const PANTS_DEEP = 6;
const SKIN = 7;
const BOOT = 8;
const PACK = 9;
const PACK_DARK = 10;
const HELMET = 11;
const HELMET_DARK = 12;
const LAMP = 13;
const EYE = 14;
const ACCENT = 15;

const HEAD: readonly string[] = [
    "..hhhHH..",
    ".hHHHLHh.",
    ".hHssssh.",
    ".dhseash.",
    "..dssssd.",
    "..cccccc.",
];

const HEAD_INK: Record<string, number> = {
    h: HELMET_DARK,
    H: HELMET,
    L: LAMP,
    s: SKIN,
    e: EYE,
    a: ACCENT,
    c: SHIRT,
    d: HELMET_DARK,
};

export interface Point {
    x: number;
    y: number;
}

export interface ClimberPoints {
    neck: Point;
    back: Point;
    pelvis: Point;
    buttocks: Point;
    head: Point;
    elbows: readonly [Point, Point];
    hands: readonly [Point, Point];
    knees: readonly [Point, Point];
    feet: readonly [Point, Point];
}

export interface ClimberRaster {
    indices: Uint8Array;
    width: number;
    height: number;
    originX: number;
    originY: number;
}

export interface SilhouetteReport {
    components: number;
    holes: number;
    body: number;
}

function fillCapsule(
    buf: Uint8Array,
    width: number,
    height: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    radius: number,
    fill: number,
    shade: number,
): void {
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - radius - 1));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + radius + 1));
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - radius - 1));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by) + radius + 1));
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const r2 = radius * radius;
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5;
            const py = y + 0.5;
            let t = 0;
            if (len2 > 1e-8) {
                t = ((px - ax) * dx + (py - ay) * dy) / len2;
                if (t < 0) {
                    t = 0;
                } else if (t > 1) {
                    t = 1;
                }
            }
            const qx = ax + t * dx;
            const qy = ay + t * dy;
            const ex = px - qx;
            const ey = py - qy;
            if (ex * ex + ey * ey > r2) {
                continue;
            }
            const side = dx * ey - dy * ex;
            buf[y * width + x] = side < 0 ? shade : fill;
        }
    }
}

function fillDisc(buf: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number, fill: number): void {
    fillCapsule(buf, width, height, cx, cy, cx, cy, radius, fill, fill);
}

function stamp(
    buf: Uint8Array,
    width: number,
    height: number,
    rows: readonly string[],
    ink: Record<string, number>,
    atX: number,
    atY: number,
    originCol: number,
    originRow: number,
): void {
    const ox = Math.round(atX) - originCol;
    const oy = Math.round(atY) - originRow;
    for (let row = 0; row < rows.length; row++) {
        const line = rows[row]!;
        for (let col = 0; col < line.length; col++) {
            const color = ink[line[col]!];
            if (color === undefined) {
                continue;
            }
            const x = ox + col;
            const y = oy + row;
            if (x < 0 || y < 0 || x >= width || y >= height) {
                continue;
            }
            buf[y * width + x] = color;
        }
    }
}

function addOutline(buf: Uint8Array, width: number, height: number): void {
    const marks: number[] = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (buf[i] !== 0) {
                continue;
            }
            let touch = false;
            for (let oy = -1; oy <= 1 && !touch; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    if (ox === 0 && oy === 0) {
                        continue;
                    }
                    const nx = x + ox;
                    const ny = y + oy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
                        continue;
                    }
                    if (buf[ny * width + nx] !== 0) {
                        touch = true;
                        break;
                    }
                }
            }
            if (touch) {
                marks.push(i);
            }
        }
    }
    for (const i of marks) {
        buf[i] = OUTLINE;
    }
}

function closeHoles(buf: Uint8Array, width: number, height: number): void {
    const outside = new Uint8Array(buf.length);
    const queue: number[] = [];
    const push = (i: number): void => {
        if (i < 0 || i >= buf.length || buf[i] !== 0 || outside[i] === 1) {
            return;
        }
        outside[i] = 1;
        queue.push(i);
    };
    for (let x = 0; x < width; x++) {
        push(x);
        push((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
        push(y * width);
        push(y * width + width - 1);
    }
    while (queue.length > 0) {
        const at = queue.pop()!;
        const x = at % width;
        const y = (at - x) / width;
        if (x > 0) {
            push(at - 1);
        }
        if (x + 1 < width) {
            push(at + 1);
        }
        if (y > 0) {
            push(at - width);
        }
        if (y + 1 < height) {
            push(at + width);
        }
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (let i = 0; i < buf.length; i++) {
            if (buf[i] !== 0 || outside[i] === 1) {
                continue;
            }
            const x = i % width;
            const y = (i - x) / width;
            let color = 0;
            const next = [
                x > 0 ? i - 1 : -1,
                x + 1 < width ? i + 1 : -1,
                y > 0 ? i - width : -1,
                y + 1 < height ? i + width : -1,
            ];
            for (const n of next) {
                if (n < 0) {
                    continue;
                }
                const neighbor = buf[n] ?? 0;
                if (neighbor >= 2) {
                    color = neighbor;
                } else if (neighbor === OUTLINE && color === 0) {
                    color = OUTLINE;
                }
            }
            if (color !== 0) {
                buf[i] = color;
                changed = true;
            }
        }
    }
}

function paint(buf: Uint8Array, width: number, height: number, points: ClimberPoints, originX: number, originY: number): void {
    const p = (pt: Point): Point => ({ x: pt.x - originX, y: pt.y - originY });
    const neck = p(points.neck);
    const back = p(points.back);
    const pelvis = p(points.pelvis);
    const buttocks = p(points.buttocks);
    const head = p(points.head);
    const elbows = [p(points.elbows[0]), p(points.elbows[1])] as const;
    const hands = [p(points.hands[0]), p(points.hands[1])] as const;
    const knees = [p(points.knees[0]), p(points.knees[1])] as const;
    const feet = [p(points.feet[0]), p(points.feet[1])] as const;

    const dx = pelvis.x - neck.x;
    const dy = pelvis.y - neck.y;
    const len = Math.hypot(dx, dy) || 1;
    let ax = -dy / len;
    let ay = dx / len;
    if (ax > 0) {
        ax = -ax;
        ay = -ay;
    }
    const pack = { x: back.x + ax * 3.2, y: back.y + ay * 2.2 };
    fillCapsule(buf, width, height, pack.x, pack.y - 3, pack.x, pack.y + 3, 2.6, PACK, PACK_DARK);

    for (let side = 0; side < 2; side++) {
        const knee = knees[side]!;
        const foot = feet[side]!;
        const pants = side === 0 ? PANTS_DARK : PANTS;
        const deep = side === 0 ? PANTS_DEEP : PANTS_DARK;
        fillCapsule(buf, width, height, buttocks.x, buttocks.y, knee.x, knee.y, 2.7, pants, deep);
        fillCapsule(buf, width, height, knee.x, knee.y, foot.x, foot.y, 2.15, pants, deep);
        fillDisc(buf, width, height, knee.x, knee.y, 2.9, pants);
        const sx = foot.x - knee.x;
        const sy = foot.y - knee.y;
        const sl = Math.hypot(sx, sy) || 1;
        fillCapsule(buf, width, height, foot.x, foot.y, foot.x + (sx / sl) * 3.5, foot.y + (sy / sl) * 3.5, 2.3, BOOT, BOOT);
        fillDisc(buf, width, height, foot.x, foot.y, 2.4, BOOT);
    }

    fillCapsule(buf, width, height, buttocks.x, buttocks.y, pelvis.x, pelvis.y, 3.3, PANTS, PANTS_DARK);
    fillCapsule(buf, width, height, pelvis.x, pelvis.y, back.x, back.y, 3.8, SHIRT, SHIRT_SHADE);
    fillCapsule(buf, width, height, back.x, back.y, neck.x, neck.y, 3.5, SHIRT, SHIRT_SHADE);
    fillCapsule(buf, width, height, neck.x, neck.y, head.x, head.y, 3.2, SHIRT, SHIRT_SHADE);
    fillDisc(buf, width, height, neck.x, neck.y, 3.6, SHIRT);
    fillDisc(buf, width, height, pelvis.x, pelvis.y, 3.6, SHIRT);
    fillDisc(buf, width, height, back.x, back.y, 3.7, SHIRT);

    for (let side = 0; side < 2; side++) {
        const elbow = elbows[side]!;
        const hand = hands[side]!;
        fillCapsule(buf, width, height, neck.x, neck.y, elbow.x, elbow.y, 1.9, SHIRT, SHIRT_SHADE);
        fillCapsule(buf, width, height, elbow.x, elbow.y, hand.x, hand.y, 1.7, SHIRT, SHIRT_SHADE);
        fillDisc(buf, width, height, elbow.x, elbow.y, 2.15, SHIRT);
        fillDisc(buf, width, height, hand.x, hand.y, 2.05, SKIN);
        fillCapsule(buf, width, height, hand.x, hand.y, hand.x + 2.4, hand.y, 1.45, SKIN, SKIN);
    }

    const headAt = { x: (neck.x + head.x) * 0.5, y: (neck.y + head.y) * 0.5 };
    fillDisc(buf, width, height, headAt.x, headAt.y - 1, 4.4, HELMET);
    stamp(buf, width, height, HEAD, HEAD_INK, neck.x, neck.y, 4, 5);
    addOutline(buf, width, height);
    closeHoles(buf, width, height);
}

export function rasterClimber(points: ClimberPoints): ClimberRaster {
    const all = [
        points.neck,
        points.back,
        points.pelvis,
        points.buttocks,
        points.head,
        points.elbows[0],
        points.elbows[1],
        points.hands[0],
        points.hands[1],
        points.knees[0],
        points.knees[1],
        points.feet[0],
        points.feet[1],
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pt of all) {
        if (pt.x < minX) {
            minX = pt.x;
        }
        if (pt.y < minY) {
            minY = pt.y;
        }
        if (pt.x > maxX) {
            maxX = pt.x;
        }
        if (pt.y > maxY) {
            maxY = pt.y;
        }
    }
    const pad = 12;
    const originX = Math.floor(minX - pad);
    const originY = Math.floor(minY - pad);
    const width = Math.ceil(maxX + pad) - originX + 1;
    const height = Math.ceil(maxY + pad) - originY + 1;
    const indices = new Uint8Array(width * height);
    paint(indices, width, height, points, originX, originY);
    return { indices, width, height, originX, originY };
}

/** 4-connected body, and no empty pocket sealed inside the outline. */
export function climberSilhouetteReport(raster: ClimberRaster): SilhouetteReport {
    const { indices, width, height } = raster;
    const bodyAt = (i: number): boolean => (indices[i] ?? 0) >= 2;
    const solidAt = (i: number): boolean => (indices[i] ?? 0) !== 0;
    const seen = new Uint8Array(indices.length);
    let components = 0;
    let body = 0;
    for (let i = 0; i < indices.length; i++) {
        if (bodyAt(i)) {
            body++;
        }
    }
    const stack: number[] = [];
    for (let i = 0; i < indices.length; i++) {
        if (!bodyAt(i) || seen[i] === 1) {
            continue;
        }
        components++;
        stack.push(i);
        seen[i] = 1;
        while (stack.length > 0) {
            const at = stack.pop()!;
            const x = at % width;
            const y = (at - x) / width;
            const next = [
                x > 0 ? at - 1 : -1,
                x + 1 < width ? at + 1 : -1,
                y > 0 ? at - width : -1,
                y + 1 < height ? at + width : -1,
            ];
            for (const n of next) {
                if (n >= 0 && bodyAt(n) && seen[n] === 0) {
                    seen[n] = 1;
                    stack.push(n);
                }
            }
        }
    }

    const outside = new Uint8Array(indices.length);
    const queue: number[] = [];
    const pushEmpty = (i: number): void => {
        if (i < 0 || i >= indices.length || solidAt(i) || outside[i] === 1) {
            return;
        }
        outside[i] = 1;
        queue.push(i);
    };
    for (let x = 0; x < width; x++) {
        pushEmpty(x);
        pushEmpty((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
        pushEmpty(y * width);
        pushEmpty(y * width + width - 1);
    }
    while (queue.length > 0) {
        const at = queue.pop()!;
        const x = at % width;
        const y = (at - x) / width;
        if (x > 0) {
            pushEmpty(at - 1);
        }
        if (x + 1 < width) {
            pushEmpty(at + 1);
        }
        if (y > 0) {
            pushEmpty(at - width);
        }
        if (y + 1 < height) {
            pushEmpty(at + width);
        }
    }

    let holes = 0;
    const holeSeen = new Uint8Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
        if (solidAt(i) || outside[i] === 1 || holeSeen[i] === 1) {
            continue;
        }
        holes++;
        const hole: number[] = [i];
        holeSeen[i] = 1;
        while (hole.length > 0) {
            const at = hole.pop()!;
            const x = at % width;
            const y = (at - x) / width;
            const next = [
                x > 0 ? at - 1 : -1,
                x + 1 < width ? at + 1 : -1,
                y > 0 ? at - width : -1,
                y + 1 < height ? at + width : -1,
            ];
            for (const n of next) {
                if (n >= 0 && !solidAt(n) && outside[n] === 0 && holeSeen[n] === 0) {
                    holeSeen[n] = 1;
                    hole.push(n);
                }
            }
        }
    }
    return { components, holes, body };
}

export const STUDY_POSES: readonly ClimberPoints[] = [
    {
        head: { x: 36, y: 14 },
        neck: { x: 36, y: 22 },
        back: { x: 37, y: 34 },
        pelvis: { x: 38, y: 48 },
        buttocks: { x: 38, y: 56 },
        elbows: [
            { x: 48, y: 28 },
            { x: 50, y: 34 },
        ],
        hands: [
            { x: 60, y: 22 },
            { x: 62, y: 36 },
        ],
        knees: [
            { x: 32, y: 70 },
            { x: 46, y: 72 },
        ],
        feet: [
            { x: 30, y: 86 },
            { x: 52, y: 88 },
        ],
    },
    {
        head: { x: 40, y: 16 },
        neck: { x: 40, y: 24 },
        back: { x: 41, y: 36 },
        pelvis: { x: 42, y: 50 },
        buttocks: { x: 42, y: 58 },
        elbows: [
            { x: 34, y: 12 },
            { x: 54, y: 30 },
        ],
        hands: [
            { x: 30, y: 2 },
            { x: 66, y: 24 },
        ],
        knees: [
            { x: 28, y: 48 },
            { x: 52, y: 72 },
        ],
        feet: [
            { x: 18, y: 40 },
            { x: 58, y: 90 },
        ],
    },
    {
        head: { x: 16, y: 48 },
        neck: { x: 26, y: 48 },
        back: { x: 40, y: 50 },
        pelvis: { x: 56, y: 48 },
        buttocks: { x: 66, y: 48 },
        elbows: [
            { x: 28, y: 34 },
            { x: 32, y: 64 },
        ],
        hands: [
            { x: 16, y: 22 },
            { x: 22, y: 76 },
        ],
        knees: [
            { x: 74, y: 34 },
            { x: 76, y: 64 },
        ],
        feet: [
            { x: 90, y: 22 },
            { x: 92, y: 78 },
        ],
    },
    {
        head: { x: 34, y: 18 },
        neck: { x: 36, y: 26 },
        back: { x: 40, y: 36 },
        pelvis: { x: 42, y: 48 },
        buttocks: { x: 40, y: 56 },
        elbows: [
            { x: 22, y: 30 },
            { x: 24, y: 42 },
        ],
        hands: [
            { x: 30, y: 20 },
            { x: 34, y: 48 },
        ],
        knees: [
            { x: 52, y: 64 },
            { x: 30, y: 66 },
        ],
        feet: [
            { x: 40, y: 52 },
            { x: 36, y: 46 },
        ],
    },
];

function blitRaster(ctx: CanvasRenderingContext2D, raster: ClimberRaster, dx: number, dy: number, scale: number): void {
    const { indices, width, height } = raster;
    for (let y = 0; y < height; y++) {
        let x = 0;
        while (x < width) {
            const idx = indices[y * width + x] ?? 0;
            if (idx === 0) {
                x++;
                continue;
            }
            let run = 1;
            while (x + run < width && indices[y * width + x + run] === idx) {
                run++;
            }
            ctx.fillStyle = PALETTE[idx] ?? PALETTE[OUTLINE]!;
            ctx.fillRect(dx + x * scale, dy + y * scale, run * scale, scale);
            x += run;
        }
    }
}

export function drawClimberStudy(ctx: CanvasRenderingContext2D): void {
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#bad4ed";
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const scale = ctx.canvas.height >= 700 ? 2 : 1;
    let y = 6;
    for (const pose of STUDY_POSES) {
        const raster = rasterClimber(pose);
        const x = Math.max(2, Math.floor((ctx.canvas.width - raster.width * scale) / 2));
        blitRaster(ctx, raster, x, y, scale);
        y += raster.height * scale + 8;
    }
}

function logicalPoint(cam: Camera, x: number, y: number): Point {
    const s = Math.max(1, cam.pixelScale);
    return {
        x: cam.world_to_viewport_x_pixel(x) / s,
        y: cam.world_to_viewport_y_pixel(y) / s,
    };
}

function endParticle(skeleton: Skeleton, constraintIndex: number, which: 0 | 1): { x: number; y: number } {
    const constraint = skeleton.phys.distanceConstraints[constraintIndex]!;
    const index = which === 0 ? constraint.particleIndex0 : constraint.particleIndex1;
    const state = skeleton.phys.particleStates[index]!;
    return { x: state.posX, y: state.posY };
}

function at(skeleton: Skeleton, index: number): { x: number; y: number } {
    const state = skeleton.phys.particleStates[index]!;
    return { x: state.posX, y: state.posY };
}

export function drawPixelClimber(ctx: CanvasRenderingContext2D, cam: Camera, skeleton: Skeleton): void {
    const lp = (x: number, y: number): Point => logicalPoint(cam, x, y);
    const neck = at(skeleton, skeleton.neckParticleIndex);
    const back = at(skeleton, skeleton.backParticleIndex);
    const pelvis = at(skeleton, skeleton.pelvisParticleIndex);
    const buttocks = at(skeleton, skeleton.buttocksParticleIndex);
    const head = endParticle(skeleton, skeleton.bodyConstraintIndices[3]!, 1);
    const points: ClimberPoints = {
        neck: lp(neck.x, neck.y),
        back: lp(back.x, back.y),
        pelvis: lp(pelvis.x, pelvis.y),
        buttocks: lp(buttocks.x, buttocks.y),
        head: lp(head.x, head.y),
        elbows: [
            lp(endParticle(skeleton, skeleton.leftArmConstraintIndices[0]!, 1).x, endParticle(skeleton, skeleton.leftArmConstraintIndices[0]!, 1).y),
            lp(endParticle(skeleton, skeleton.rightArmConstraintIndices[0]!, 1).x, endParticle(skeleton, skeleton.rightArmConstraintIndices[0]!, 1).y),
        ],
        hands: [
            lp(at(skeleton, skeleton.handParticleIndex[0]!).x, at(skeleton, skeleton.handParticleIndex[0]!).y),
            lp(at(skeleton, skeleton.handParticleIndex[1]!).x, at(skeleton, skeleton.handParticleIndex[1]!).y),
        ],
        knees: [
            lp(endParticle(skeleton, skeleton.leftLegConstraintIndices[0]!, 1).x, endParticle(skeleton, skeleton.leftLegConstraintIndices[0]!, 1).y),
            lp(endParticle(skeleton, skeleton.rightLegConstraintIndices[0]!, 1).x, endParticle(skeleton, skeleton.rightLegConstraintIndices[0]!, 1).y),
        ],
        feet: [
            lp(at(skeleton, skeleton.footParticleIndex[0]!).x, at(skeleton, skeleton.footParticleIndex[0]!).y),
            lp(at(skeleton, skeleton.footParticleIndex[1]!).x, at(skeleton, skeleton.footParticleIndex[1]!).y),
        ],
    };
    const raster = rasterClimber(points);
    const s = Math.max(1, cam.pixelScale);
    ctx.imageSmoothingEnabled = false;
    blitRaster(ctx, raster, raster.originX * s, raster.originY * s, s);
}
