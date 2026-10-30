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
 * The climber is cached pixel-art parts. Each part is rotated once, at a
 * fixed set of angles, and reused. Joints snap to whole pixels and angles
 * move only when they leave their bin, so a tiny physics jitter does not
 * change the picture. Elbows stay at least 25° from straight and knees at
 * least 80°. Hands and feet still end on the physics grips. No outline.
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

/** Traced from the reference. Face looks to +x, helmet top is the first row. */
const HEAD_SPRITE: readonly string[] = [
    "..HHHH.",
    ".HHHDLD",
    ".HHDDDk",
    ".HDkkkkk",
    ".Dkkkeka",
    ".kakkkka",
    ".kkkkhhh",
];

/**
 * Shirt, pack, and the seat of the breeches. The anchor is the pelvis.
 * Rows below it are the hip, so the thighs start inside the torso.
 */
const TORSO_SPRITE: readonly string[] = [
    "..SSSs.",
    "..SSSs.",
    ".RSSSs.",
    "RRSSSs.",
    "RRRSSS.",
    "RRRSSS.",
    "RRRSSs.",
    "RRRSSs.",
    ".RRRSs.",
    "..RRSs.",
    "..PPPPP",
    ".PPPPPP",
    "PPPPPPP",
    "PPPPPPP",
    ".PPPPP.",
];

const UPPER_ARM_SPRITE: readonly string[] = [
    "ssssssss",
    "SSSSSSSS",
    "ssssssss",
];

const FOREARM_SPRITE: readonly string[] = [
    "ssssGGGG",
    "SSSSGGGG",
    "ssssGGGG",
];

/** Knee-length breeches. Wider than the shin, hem at the knee. */
const THIGH_SPRITE: readonly string[] = [
    ".ppppppp",
    "Pppppppp",
    "pppppppK",
    "Pppppppp",
    ".ppppppp",
];

/** Sock below the hem, then the boot. Narrower than the thigh. */
const SHIN_SPRITE: readonly string[] = [
    ".ssssDDDD",
    "sssssDDDD",
    "sssssDDDB",
    "sssssDDDD",
    ".ssssDDDD",
];

const GLOVE_TIP: readonly string[] = [
    ".G.",
    "GGG",
    "GGG",
];

const BOOT_TIP: readonly string[] = [
    ".DDD.",
    "DDDDD",
    "DDDDD",
    "BBBBB",
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
    r: PACK_DARK,
    B: BOOT_SOLE,
    S: SHIRT,
    s: SHIRT_SHADE,
    P: PANTS,
    p: PANTS_DARK,
    G: GLOVE,
    D: BOOT,
    K: KNEE,
};

const INK_PRIORITY: Record<number, number> = {
    [EYE]: 6,
    [LAMP]: 5,
    [CHEEK]: 4,
    [GLOVE]: 3,
    [KNEE]: 3,
    [BOOT_SOLE]: 2,
};

/** Sixteen headings. A part is drawn from this table, never re-rotated per frame. */
const ANGLE_STEPS = 16;
const ANGLE_STEP = (Math.PI * 2) / ANGLE_STEPS;

export interface PoseLatch {
    angles: Record<string, number>;
    pos: Record<string, number>;
    facing: number;
}

export function createPoseLatch(): PoseLatch {
    return { angles: {}, pos: {}, facing: 1 };
}

const liveLatch = createPoseLatch();

interface Stamp {
    cells: readonly (readonly [number, number, number])[];
}

const stampCache = new Map<string, Stamp>();

function wrapAngle(delta: number): number {
    let value = delta;
    while (value > Math.PI) {
        value -= Math.PI * 2;
    }
    while (value < -Math.PI) {
        value += Math.PI * 2;
    }
    return value;
}

function latchScalar(latch: PoseLatch | undefined, id: string, value: number): number {
    const rounded = Math.round(value);
    if (latch === undefined) {
        return rounded;
    }
    const prev = latch.pos[id];
    if (prev === undefined) {
        latch.pos[id] = rounded;
        return rounded;
    }
    if (Math.abs(value - prev) >= 0.7) {
        latch.pos[id] = rounded;
        return rounded;
    }
    return prev;
}

function latchAngle(latch: PoseLatch | undefined, id: string, angle: number): number {
    if (latch === undefined) {
        return Math.round(angle / ANGLE_STEP) * ANGLE_STEP;
    }
    const prev = latch.angles[id];
    if (prev === undefined) {
        const quantized = Math.round(angle / ANGLE_STEP) * ANGLE_STEP;
        latch.angles[id] = quantized;
        return quantized;
    }
    const delta = wrapAngle(angle - prev);
    if (Math.abs(delta) > ANGLE_STEP * 1.5) {
        const quantized = Math.round(angle / ANGLE_STEP) * ANGLE_STEP;
        latch.angles[id] = quantized;
        return quantized;
    }
    const leave = ANGLE_STEP * 0.75;
    if (delta > leave) {
        latch.angles[id] = prev + ANGLE_STEP;
    } else if (delta < -leave) {
        latch.angles[id] = prev - ANGLE_STEP;
    }
    return latch.angles[id] ?? prev;
}

function latchFacing(latch: PoseLatch | undefined, cross: number): boolean {
    if (latch === undefined) {
        return cross < 0;
    }
    if (Math.abs(cross) >= 1.5) {
        latch.facing = cross < 0 ? -1 : 1;
    }
    return latch.facing < 0;
}

function scaleRows(rows: readonly string[], targetLength: number): { rows: string[]; anchorCol: number } {
    const sourceLength = rows[0]?.length ?? 1;
    const length = Math.max(2, targetLength);
    const scaled = rows.map((row) => {
        let line = "";
        for (let x = 0; x < length; x++) {
            const source = Math.min(sourceLength - 1, Math.floor((x * sourceLength) / length));
            line += row[source] ?? ".";
        }
        return line;
    });
    return { rows: scaled, anchorCol: 0 };
}

function bakeStamp(rows: readonly string[], anchorCol: number, anchorRow: number, angle: number, flip: boolean): Stamp {
    const width = rows[0]?.length ?? 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const pending: { x: number; y: number; color: number; priority: number }[] = [];
    for (let row = 0; row < rows.length; row++) {
        const line = rows[row] ?? "";
        for (let col = 0; col < line.length; col++) {
            const color = PART_INK[line[col] ?? "."];
            if (color === undefined) {
                continue;
            }
            const usedCol = flip ? width - 1 - col : col;
            const usedAnchor = flip ? width - 1 - anchorCol : anchorCol;
            const lx = usedCol - usedAnchor;
            const ly = row - anchorRow;
            pending.push({
                x: Math.round(cos * lx - sin * ly),
                y: Math.round(sin * lx + cos * ly),
                color,
                priority: INK_PRIORITY[color] ?? 0,
            });
        }
    }
    pending.sort((a, b) => a.priority - b.priority);
    const cells: [number, number, number][] = [];
    const seen = new Map<string, number>();
    for (const cell of pending) {
        const key = `${cell.x},${cell.y}`;
        const at = seen.get(key);
        if (at === undefined) {
            seen.set(key, cells.length);
            cells.push([cell.x, cell.y, cell.color]);
        } else {
            cells[at] = [cell.x, cell.y, cell.color];
        }
    }
    return { cells };
}

function cachedStamp(name: string, rows: readonly string[], anchorCol: number, anchorRow: number, angle: number, flip: boolean, targetLength?: number): Stamp {
    const shaped = targetLength === undefined ? { rows: [...rows], anchorCol } : scaleRows(rows, targetLength);
    const key = `${name}:${shaped.anchorCol}:${anchorRow}:${shaped.rows[0]?.length ?? 0}:${Math.round(angle * 1000)}:${flip ? 1 : 0}`;
    const hit = stampCache.get(key);
    if (hit !== undefined) {
        return hit;
    }
    const stamp = bakeStamp(shaped.rows, shaped.anchorCol, anchorRow, angle, flip);
    stampCache.set(key, stamp);
    return stamp;
}

function plot(buf: Uint8Array, width: number, height: number, x: number, y: number, color: number): void {
    if (x < 0 || y < 0 || x >= width || y >= height || color === 0) {
        return;
    }
    buf[y * width + x] = color;
}

function blitStamp(
    buf: Uint8Array,
    width: number,
    height: number,
    stamp: Stamp,
    worldX: number,
    worldY: number,
    originX: number,
    originY: number,
): void {
    for (const cell of stamp.cells) {
        plot(buf, width, height, worldX + cell[0] - originX, worldY + cell[1] - originY, cell[2]);
    }
}

/** Integer connector under a part. The pixels depend only on the snapped endpoints. */
function ribbon(
    buf: Uint8Array,
    width: number,
    height: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    fill: number,
): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    for (let i = 0; i <= steps; i++) {
        const x = Math.round(x0 + (dx * i) / steps);
        const y = Math.round(y0 + (dy * i) / steps);
        plot(buf, width, height, x, y, fill);
    }
}

function block(buf: Uint8Array, width: number, height: number, x: number, y: number, color: number): void {
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            plot(buf, width, height, x + dx, y + dy, color);
        }
    }
}

/** Wide filled band. `radius` 2 is about five pixels across. */
function band(
    buf: Uint8Array,
    width: number,
    height: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    color: number,
): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    let nx = -dy;
    let ny = dx;
    const nlen = Math.hypot(nx, ny) || 1;
    nx /= nlen;
    ny /= nlen;
    for (let i = 0; i <= steps; i++) {
        const x = x0 + (dx * i) / steps;
        const y = y0 + (dy * i) / steps;
        for (let t = -radius; t <= radius; t++) {
            plot(buf, width, height, Math.round(x + nx * t), Math.round(y + ny * t), color);
        }
    }
}

function backup(joint: Point, toward: Point, amount: number): Point {
    const dx = toward.x - joint.x;
    const dy = toward.y - joint.y;
    const len = Math.hypot(dx, dy) || 1;
    const step = Math.min(amount, len);
    return { x: joint.x + (dx / len) * step, y: joint.y + (dy / len) * step };
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

function localPoint(latch: PoseLatch | undefined, id: string, point: Point): Point {
    return { x: latchScalar(latch, `${id}x`, point.x), y: latchScalar(latch, `${id}y`, point.y) };
}

function paint(buf: Uint8Array, width: number, height: number, points: ClimberPoints, originX: number, originY: number, latch?: PoseLatch): void {
    const posed = drawnClimberPoints(points);
    const neck = localPoint(latch, "neck", posed.neck);
    const pelvis = localPoint(latch, "pelvis", posed.pelvis);
    const buttocks = localPoint(latch, "hip", posed.buttocks);
    const head = localPoint(latch, "head", posed.head);
    const elbows = [localPoint(latch, "e0", posed.elbows[0]), localPoint(latch, "e1", posed.elbows[1])] as const;
    const hands = [localPoint(latch, "h0", posed.hands[0]), localPoint(latch, "h1", posed.hands[1])] as const;
    const knees = [localPoint(latch, "k0", posed.knees[0]), localPoint(latch, "k1", posed.knees[1])] as const;
    const feet = [localPoint(latch, "f0", posed.feet[0]), localPoint(latch, "f1", posed.feet[1])] as const;

    const tdx = neck.x - pelvis.x;
    const tdy = neck.y - pelvis.y;
    const handCross = tdx * ((hands[0].y + hands[1].y) / 2 - pelvis.y) - tdy * ((hands[0].x + hands[1].x) / 2 - pelvis.x);
    const flip = latchFacing(latch, handCross);
    const into = (world: Point): Point => ({ x: world.x - originX, y: world.y - originY });

    const torsoAngle = Math.atan2(tdx, -tdy);
    const headAngle = latchAngle(latch, "head", Math.atan2(head.x - neck.x, -(head.y - neck.y)));

    ribbon(buf, width, height, ...pair(into(pelvis), into(neck)), SHIRT);
    ribbon(buf, width, height, ...pair(into(neck), into(head)), SHIRT);
    band(buf, width, height, ...pair(into(pelvis), into(buttocks)), 2, PANTS);

    const order = [0, 1].sort((a, b) => limbCross(tdx, tdy, neck, elbows[a]!) - limbCross(tdx, tdy, neck, elbows[b]!));
    for (const side of order) {
        const elbow = elbows[side]!;
        const hand = hands[side]!;
        const knee = knees[side]!;
        const foot = feet[side]!;
        const armLen = Math.max(2, Math.round(Math.hypot(elbow.x - neck.x, elbow.y - neck.y)));
        const foreLen = Math.max(2, Math.round(Math.hypot(hand.x - elbow.x, hand.y - elbow.y)));
        const thighRoot = backup(buttocks, pelvis, 4);
        const thighLen = Math.max(2, Math.round(Math.hypot(knee.x - thighRoot.x, knee.y - thighRoot.y)));
        const shinLen = Math.max(2, Math.round(Math.hypot(foot.x - knee.x, foot.y - knee.y)));
        const thighAngle = Math.atan2(knee.y - thighRoot.y, knee.x - thighRoot.x);
        const shinAngle = Math.atan2(foot.y - knee.y, foot.x - knee.x);
        const upperAngle = Math.atan2(elbow.y - neck.y, elbow.x - neck.x);
        const foreAngle = Math.atan2(hand.y - elbow.y, hand.x - elbow.x);
        const intoThigh = into(backup(buttocks, knee, 3));
        band(buf, width, height, ...pair(into(buttocks), intoThigh), 2, PANTS);
        ribbon(buf, width, height, ...pair(into(buttocks), into(knee)), PANTS);
        ribbon(buf, width, height, ...pair(into(knee), into(foot)), SHIRT_SHADE);
        ribbon(buf, width, height, ...pair(into(neck), into(elbow)), SHIRT);
        ribbon(buf, width, height, ...pair(into(elbow), into(hand)), SHIRT);
        blitStamp(buf, width, height, cachedStamp("thigh", THIGH_SPRITE, 0, 2, thighAngle, false, thighLen), thighRoot.x, thighRoot.y, originX, originY);
        blitStamp(buf, width, height, cachedStamp("shin", SHIN_SPRITE, 0, 2, shinAngle, false, shinLen), knee.x, knee.y, originX, originY);
        blitStamp(buf, width, height, cachedStamp("upper", UPPER_ARM_SPRITE, 0, 1, upperAngle, false, armLen), neck.x, neck.y, originX, originY);
        blitStamp(buf, width, height, cachedStamp("fore", FOREARM_SPRITE, 0, 1, foreAngle, false, foreLen), elbow.x, elbow.y, originX, originY);
        blitStamp(buf, width, height, cachedStamp("glove", GLOVE_TIP, 1, 1, foreAngle, false), hand.x, hand.y, originX, originY);
        blitStamp(buf, width, height, cachedStamp("boot", BOOT_TIP, 2, 1, shinAngle, false), foot.x, foot.y, originX, originY);
        block(buf, width, height, elbow.x - originX, elbow.y - originY, SHIRT_SHADE);
        block(buf, width, height, knee.x - originX, knee.y - originY, KNEE);
    }

    block(buf, width, height, neck.x - originX, neck.y - originY, SHIRT);
    block(buf, width, height, pelvis.x - originX, pelvis.y - originY, SHIRT);
    block(buf, width, height, buttocks.x - originX, buttocks.y - originY, PANTS);
    blitStamp(
        buf,
        width,
        height,
        cachedStamp("torso", TORSO_SPRITE, 3, 10, torsoAngle, flip),
        pelvis.x,
        pelvis.y,
        originX,
        originY,
    );
    blitStamp(
        buf,
        width,
        height,
        cachedStamp("head", HEAD_SPRITE, 3, 5, headAngle, flip),
        neck.x,
        neck.y,
        originX,
        originY,
    );
    bridgeDiagonals(buf, width, height);
    bridgeDiagonals(buf, width, height);
    closeHoles(buf, width, height);
}

/** Join pixels that touch only at a corner, so a rotated part stays one piece. */
function bridgeDiagonals(buf: Uint8Array, width: number, height: number): void {
    const extra: { at: number; color: number }[] = [];
    for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
            const i = y * width + x;
            const here = buf[i] ?? 0;
            const right = buf[i + 1] ?? 0;
            const down = buf[i + width] ?? 0;
            const downRight = buf[i + width + 1] ?? 0;
            if (here !== 0 && downRight !== 0 && right === 0 && down === 0) {
                extra.push({ at: i + 1, color: here });
            }
            if (right !== 0 && down !== 0 && here === 0 && downRight === 0) {
                extra.push({ at: i, color: right });
            }
        }
    }
    for (const cell of extra) {
        if ((buf[cell.at] ?? 0) === 0) {
            buf[cell.at] = cell.color;
        }
    }
}

function pair(a: Point, b: Point): [number, number, number, number] {
    return [a.x, a.y, b.x, b.y];
}

function limbCross(tdx: number, tdy: number, root: Point, joint: Point): number {
    return tdx * (joint.y - root.y) - tdy * (joint.x - root.x);
}

export function rasterClimber(points: ClimberPoints, latch?: PoseLatch): ClimberRaster {
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
    paint(indices, width, height, points, originX, originY, latch);
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
    const raster = rasterClimber(points, liveLatch);
    const s = Math.max(1, cam.pixelScale);
    ctx.imageSmoothingEnabled = false;
    blitRaster(ctx, raster, raster.originX * s, raster.originY * s, s);
}
