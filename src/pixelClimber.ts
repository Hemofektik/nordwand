import type { Camera } from "./Camera.ts";
import {
    ARM_REACH,
    LEG_REACH,
    PAINTED_LEG_REACH,
    PAINTED_BACK,
    PAINTED_HEAD,
    PAINTED_HIP,
    PAINTED_NECK,
    type Skeleton,
} from "./Skeleton.ts";

/**
 * The climber is filled in logical pixels. The torso and head stay at the
 * mockup's lengths. Arms and legs keep a thigh and shin (or upper arm and
 * forearm) of about 8 and 8, or 7 and 6, and may stretch by at most 15%.
 * Elbows stay at least 25° from straight. Knees stay at least 80° from
 * straight in a reach, and bend further when the foot is already near the
 * hip. The physics skeleton is the same size, so the hand and the foot land
 * on the grip. No separate outline.
 */

const PALETTE = [
    "",
    "",
    "#aba17d",
    "#665f46",
    "#665f46",
    "#414722",
    "#22260d",
    "#e7a96c",
    "#c48a52",
    "#2a0d03",
    "#1b1b16",
    "#2a0d03",
    "#1b1b16",
    "#ac6900",
    "#995d00",
    "#daffff",
    "#21548f",
    "#de7947",
    "#2a0d03",
    "#1b1b16",
    "#22260d",
    "#665f46",
];

const SHIRT = 2;
const SHIRT_SHADE = 3;
const SHIRT_DEEP = 4;
const PANTS = 5;
const PANTS_DARK = 6;
const SKIN = 7;
const BOOT = 9;
const BOOT_SOLE = 10;
const PACK = 11;
const PACK_DARK = 12;
const HELMET = 13;
const HELMET_DARK = 14;
const LAMP = 15;
const EYE = 16;
const CHEEK = 17;
const GLOVE = 18;
const KNEE = 20;
const STRAP = 21;

/**
 * Torso and legs stay at the painted lengths. The arm is scaled so a 25°
 * bend and at most 15% stretch still reach the physics hand.
 */
const NECK_LEN = PAINTED_NECK;
const BACK_LEN = PAINTED_BACK;
const HIP_LEN = PAINTED_HIP;
const HEAD_LEN = PAINTED_HEAD;
const LEG_DRAW_SCALE = LEG_REACH / PAINTED_LEG_REACH;
const THIGH_LEN = 8 * LEG_DRAW_SCALE;
const SHIN_LEN = 8 * LEG_DRAW_SCALE;
const PAINTED_UPPER = 7;
const PAINTED_FORE = 6;
const PAINTED_ARM_FLEXED = Math.sqrt(
    PAINTED_UPPER * PAINTED_UPPER +
        PAINTED_FORE * PAINTED_FORE +
        2 * PAINTED_UPPER * PAINTED_FORE * Math.cos((25 * Math.PI) / 180),
);
const ARM_DRAW_SCALE = ARM_REACH / (PAINTED_ARM_FLEXED * 1.15);
const UPPER_ARM = PAINTED_UPPER * ARM_DRAW_SCALE;
const FOREARM = PAINTED_FORE * ARM_DRAW_SCALE;

/** Half-widths. The painted torso is about five pixels; the limbs two or three. */
const ARM = 1.05;
const THIGH = 1.55;
const SHIN = 1.35;
const TORSO = 2.35;
const NECK_R = 1.35;
const HEAD_R = 2.3;

/** Traced from climber_ref.png, rope pixels that crossed the face removed. */
const HEAD: readonly string[] = [
    ".HHHH..",
    ".HHHLH.",
    "HHkkkkk",
    "Hkkkkkk",
    ".kkkekh",
    ".kakkka",
    ".kkkhhh",
];

const PACK_SPRITE: readonly string[] = [
    "..RRRRR.",
    ".RRRRRRR",
    "RRRRRRRR",
    "RRRRRRRR",
    "RRRRRRR.",
    "RRRRRR..",
    "RRRRR...",
    ".RRRR...",
];

const GLOVE_SPRITE: readonly string[] = [
    ".GG",
    "GGG",
    "GGG",
    ".GG",
];

const BOOT_SPRITE: readonly string[] = [
    ".DD.DD",
    "DDDDDD",
    "DDDDDB",
    "DDD....",
];

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
                if (neighbor !== 0) {
                    color = neighbor;
                }
            }
            if (color !== 0) {
                buf[i] = color;
                changed = true;
            }
        }
    }
}

const PART_INK: Record<string, number> = {
    H: HELMET,
    h: HELMET_DARK,
    L: LAMP,
    k: SKIN,
    e: EYE,
    a: CHEEK,
    R: PACK,
    B: BOOT_SOLE,
    S: STRAP,
    G: GLOVE,
    D: BOOT,
};

/** Nearest-neighbour placement. Angle 0 points sprite +x along world +x. */
function placeSprite(
    buf: Uint8Array,
    width: number,
    height: number,
    rows: readonly string[],
    cx: number,
    cy: number,
    angle: number,
    anchorCol: number,
    anchorRow: number,
): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let row = 0; row < rows.length; row++) {
        const line = rows[row]!;
        for (let col = 0; col < line.length; col++) {
            const color = PART_INK[line[col]!];
            if (color === undefined) {
                continue;
            }
            const lx = col - anchorCol;
            const ly = row - anchorRow;
            const x = Math.round(cx + cos * lx - sin * ly);
            const y = Math.round(cy + sin * lx + cos * ly);
            if (x < 0 || y < 0 || x >= width || y >= height) {
                continue;
            }
            buf[y * width + x] = color;
        }
    }
}

function along(from: Point, to: Point, origin: Point, length: number): Point {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy) || 1;
    return { x: origin.x + (dx / dist) * length, y: origin.y + (dy / dist) * length };
}

function clampUnit(value: number): number {
    if (value < -1) {
        return -1;
    }
    if (value > 1) {
        return 1;
    }
    return value;
}

const MAX_STRETCH = 1.15;
/** Degrees away from a straight limb. Arms stay mostly extended; knees crouch. */
const ARM_MIN_FLEXION_DEG = 25;
const LEG_MIN_FLEXION_DEG = 80;
/**
 * How far the drawn grip is pulled toward the chest or the hips before the
 * bend. The physics reach is already inside the flexed limb, so this stays
 * at 0 and the hand and foot sit on the grip. The angle floors still bend
 * the elbow and the knee.
 */
const ARM_TUCK = 0;
const LEG_TUCK = 0;

function maxReachForFlex(upper: number, lower: number, flexionDeg: number): number {
    const cos = Math.cos((flexionDeg * Math.PI) / 180);
    return Math.sqrt(upper * upper + lower * lower + 2 * upper * lower * cos);
}

function pullToward(target: Point, body: Point, amount: number): Point {
    const dx = body.x - target.x;
    const dy = body.y - target.y;
    const dist = Math.hypot(dx, dy) || 1;
    const step = Math.min(amount, dist);
    return { x: target.x + (dx / dist) * step, y: target.y + (dy / dist) * step };
}

/**
 * Two-bone chain from `root` toward `target`. Lengths stay within 15% of the
 * mockup. The joint bends to `side` and stays at least `flexionDeg` from
 * straight. If the grip is still farther, the end stops short.
 */
function bendSide(root: Point, joint: Point, end: Point, body: Point): number {
    const dx = end.x - root.x;
    const dy = end.y - root.y;
    const cross = dx * (joint.y - root.y) - dy * (joint.x - root.x);
    if (Math.abs(cross) >= 1) {
        return cross >= 0 ? 1 : -1;
    }
    const bodyCross = dx * (body.y - root.y) - dy * (body.x - root.x);
    return bodyCross >= 0 ? 1 : -1;
}

function solveTwoBone(root: Point, target: Point, side: number, lenA: number, lenB: number, flexionDeg: number): { joint: Point; end: Point } {
    const dx = target.x - root.x;
    const dy = target.y - root.y;
    const dist = Math.hypot(dx, dy);
    let upper = lenA;
    let lower = lenB;
    if (!(dist > 1e-4)) {
        return {
            joint: { x: root.x + side * upper * 0.6, y: root.y },
            end: { x: root.x, y: root.y },
        };
    }
    // Stretch both bones together, up to 15%, when the grip is past the
    // flexed reach. The joint stays at least flexionDeg from straight.
    const naturalFlexed = maxReachForFlex(lenA, lenB, flexionDeg);
    if (dist > naturalFlexed) {
        const scale = Math.min(MAX_STRETCH, dist / naturalFlexed);
        upper *= scale;
        lower *= scale;
    }
    const flexed = maxReachForFlex(upper, lower, flexionDeg);
    const use = Math.min(dist, flexed);
    const ux = dx / dist;
    const uy = dy / dist;
    const end = { x: root.x + ux * use, y: root.y + uy * use };
    const cos = clampUnit((upper * upper + use * use - lower * lower) / (2 * upper * use));
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    let px = -uy;
    let py = ux;
    if (side < 0) {
        px = -px;
        py = -py;
    }
    return {
        joint: {
            x: root.x + ux * upper * cos + px * upper * sin,
            y: root.y + uy * upper * cos + py * upper * sin,
        },
        end,
    };
}

/**
 * Torso, head, and hips keep the mockup lengths. Hands and feet are the
 * physics grips. The pelvis stays on the physics pelvis, which is where the
 * rope harness attaches.
 */
/** The drawn pelvis stays on the physics pelvis, where the rope attaches. */
const MAX_BODY_SHIFT = 0;

export function drawnClimberPoints(points: ClimberPoints): ClimberPoints {
    const fx = (points.hands[0].x + points.hands[1].x) / 2 - points.pelvis.x;
    const fy = (points.hands[0].y + points.hands[1].y) / 2 - points.pelvis.y;
    const fl = Math.hypot(fx, fy) || 1;
    const shift = Math.min(MAX_BODY_SHIFT, fl);
    const pelvis = { x: points.pelvis.x + (fx / fl) * shift, y: points.pelvis.y + (fy / fl) * shift };
    const neck = along(points.pelvis, points.neck, pelvis, NECK_LEN);
    const back = along(points.pelvis, points.back, pelvis, BACK_LEN);
    const head = along(points.neck, points.head, neck, HEAD_LEN);
    const buttocks = along(points.pelvis, points.buttocks, pelvis, HIP_LEN);
    const leg0 = solveTwoBone(
        buttocks,
        pullToward(points.feet[0], pelvis, LEG_TUCK),
        bendSide(points.buttocks, points.knees[0], points.feet[0], pelvis),
        THIGH_LEN,
        SHIN_LEN,
        LEG_MIN_FLEXION_DEG,
    );
    const leg1 = solveTwoBone(
        buttocks,
        pullToward(points.feet[1], pelvis, LEG_TUCK),
        bendSide(points.buttocks, points.knees[1], points.feet[1], pelvis),
        THIGH_LEN,
        SHIN_LEN,
        LEG_MIN_FLEXION_DEG,
    );
    const arm0 = solveTwoBone(
        neck,
        pullToward(points.hands[0], back, ARM_TUCK),
        bendSide(points.neck, points.elbows[0], points.hands[0], back),
        UPPER_ARM,
        FOREARM,
        ARM_MIN_FLEXION_DEG,
    );
    const arm1 = solveTwoBone(
        neck,
        pullToward(points.hands[1], back, ARM_TUCK),
        bendSide(points.neck, points.elbows[1], points.hands[1], back),
        UPPER_ARM,
        FOREARM,
        ARM_MIN_FLEXION_DEG,
    );
    return {
        neck,
        back,
        pelvis,
        buttocks,
        head,
        elbows: [arm0.joint, arm1.joint],
        hands: [arm0.end, arm1.end],
        knees: [leg0.joint, leg1.joint],
        feet: [leg0.end, leg1.end],
    };
}

function paint(buf: Uint8Array, width: number, height: number, points: ClimberPoints, originX: number, originY: number): void {
    const posed = drawnClimberPoints(points);
    const p = (pt: Point): Point => ({ x: pt.x - originX, y: pt.y - originY });
    const neck = p(posed.neck);
    const back = p(posed.back);
    const pelvis = p(posed.pelvis);
    const buttocks = p(posed.buttocks);
    const head = p(posed.head);
    const elbows = [p(posed.elbows[0]), p(posed.elbows[1])] as const;
    const hands = [p(posed.hands[0]), p(posed.hands[1])] as const;
    const knees = [p(posed.knees[0]), p(posed.knees[1])] as const;
    const feet = [p(posed.feet[0]), p(posed.feet[1])] as const;

    const tdx = neck.x - pelvis.x;
    const tdy = neck.y - pelvis.y;
    const tlen = Math.hypot(tdx, tdy) || 1;
    const ux = tdx / tlen;
    const uy = tdy / tlen;
    let px = -uy;
    let py = ux;
    const hx = (hands[0].x + hands[1].x) / 2 - back.x;
    const hy = (hands[0].y + hands[1].y) / 2 - back.y;
    if (px * hx + py * hy > 0) {
        px = -px;
        py = -py;
    }
    const pack = { x: back.x + px * 4.5, y: back.y + py * 4.5 };
    fillCapsule(buf, width, height, pack.x - ux * 3, pack.y - uy * 3, pack.x + ux * 2.4, pack.y + uy * 2.4, 2.1, PACK, PACK_DARK);
    fillCapsule(buf, width, height, pack.x + ux * 2.2, pack.y + uy * 2.2, neck.x + px * 1.4, neck.y + py * 1.4, 0.75, PACK, PACK);
    const packUp = Math.atan2(-ux, uy);
    placeSprite(buf, width, height, PACK_SPRITE, pack.x, pack.y, packUp, 4, 3);

    for (let side = 0; side < 2; side++) {
        const knee = knees[side]!;
        const foot = feet[side]!;
        const pants = side === 0 ? PANTS_DARK : PANTS;
        const deep = side === 0 ? PANTS_DARK : PANTS;
        fillCapsule(buf, width, height, buttocks.x, buttocks.y, knee.x, knee.y, THIGH, pants, deep);
        fillCapsule(buf, width, height, knee.x, knee.y, foot.x, foot.y, SHIN, pants, deep);
        fillDisc(buf, width, height, knee.x, knee.y, THIGH + 0.35, KNEE);
        const sx = foot.x - knee.x;
        const sy = foot.y - knee.y;
        const sl = Math.hypot(sx, sy) || 1;
        const ux = sx / sl;
        const uy = sy / sl;
        fillDisc(buf, width, height, foot.x, foot.y, 1.3, BOOT);
        placeSprite(buf, width, height, BOOT_SPRITE, foot.x, foot.y, Math.atan2(uy, ux), 1, 1);
    }

    fillCapsule(buf, width, height, buttocks.x, buttocks.y, pelvis.x, pelvis.y, TORSO, PANTS, PANTS_DARK);
    fillCapsule(buf, width, height, pelvis.x, pelvis.y, back.x, back.y, TORSO, SHIRT, SHIRT_DEEP);
    fillCapsule(buf, width, height, back.x, back.y, neck.x, neck.y, TORSO, SHIRT, SHIRT_SHADE);
    fillCapsule(buf, width, height, neck.x, neck.y, head.x, head.y, NECK_R, SHIRT, SHIRT_SHADE);
    fillDisc(buf, width, height, neck.x, neck.y, TORSO, SHIRT);
    fillDisc(buf, width, height, pelvis.x, pelvis.y, TORSO, SHIRT);
    fillDisc(buf, width, height, back.x, back.y, TORSO, SHIRT);
    fillDisc(buf, width, height, buttocks.x, buttocks.y, TORSO, PANTS);

    for (let side = 0; side < 2; side++) {
        const elbow = elbows[side]!;
        const hand = hands[side]!;
        fillCapsule(buf, width, height, neck.x, neck.y, elbow.x, elbow.y, ARM, SHIRT, SHIRT_SHADE);
        fillCapsule(buf, width, height, elbow.x, elbow.y, hand.x, hand.y, ARM, SHIRT, SHIRT_SHADE);
        fillDisc(buf, width, height, elbow.x, elbow.y, ARM + 0.45, SHIRT_DEEP);
        const hx = hand.x - elbow.x;
        const hy = hand.y - elbow.y;
        fillDisc(buf, width, height, hand.x, hand.y, 1.2, GLOVE);
        placeSprite(buf, width, height, GLOVE_SPRITE, hand.x, hand.y, Math.atan2(hy, hx), 2, 1);
    }

    fillDisc(buf, width, height, head.x, head.y, HEAD_R, HELMET);
    const headDx = head.x - neck.x;
    const headDy = head.y - neck.y;
    placeSprite(buf, width, height, HEAD, head.x, head.y, Math.atan2(headDx, -headDy), 3, 2);
    closeHoles(buf, width, height);
}

export function rasterClimber(points: ClimberPoints): ClimberRaster {
    const drawn = drawnClimberPoints(points);
    const all = [
        points.neck,
        points.back,
        points.pelvis,
        points.buttocks,
        points.head,
        drawn.neck,
        drawn.back,
        drawn.head,
        drawn.elbows[0],
        drawn.elbows[1],
        drawn.hands[0],
        drawn.hands[1],
        drawn.knees[0],
        drawn.knees[1],
        drawn.feet[0],
        drawn.feet[1],
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

/** 4-connected body, and no empty pocket sealed inside the figure. */
export function climberSilhouetteReport(raster: ClimberRaster): SilhouetteReport {
    const { indices, width, height } = raster;
    const bodyAt = (i: number): boolean => (indices[i] ?? 0) !== 0;
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
            ctx.fillStyle = PALETTE[idx] ?? "#aba17d";
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
