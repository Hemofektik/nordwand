import type { Camera } from "./Camera.ts";
import type { Skeleton } from "./Skeleton.ts";
import { snapScreen } from "./pixelDraw.ts";

/**
 * Pixel climber posed on the ragdoll. Joints still come from the particles;
 * only the ink changes. Colors are the mockup 04 figure: ochre helmet,
 * lamp, khaki shirt, olive trousers, backpack, dark boots.
 */

const OUTLINE = "#201f1a";
const SHIRT = "#aba17d";
const SHIRT_SHADE = "#8a8264";
const PANTS = "#665f46";
const PANTS_DARK = "#414722";
const PANTS_DEEP = "#22260d";
const SKIN = "#e7a96c";
const BOOT = "#1b1a15";
const PACK = "#6b4a32";
const PACK_DARK = "#4a3022";

const INK: Record<string, string> = {
    h: "#995d00",
    H: "#ac6900",
    L: "#daffff",
    s: SKIN,
    e: "#21548f",
    a: "#de7947",
    c: SHIRT,
    o: OUTLINE,
    b: PACK,
    B: PACK_DARK,
};

/** Helmet, lamp, face. Origin is the bottom center, so it sits on the neck. */
const HEAD: readonly string[] = [
    "..hhhHH..",
    ".hHHHLHh.",
    ".hHssssh.",
    ".ohseash.",
    "..osssso.",
    "..occcco.",
];

const PACK_SPRITE: readonly string[] = [
    ".bbb.",
    "bBBBb",
    "bBBBb",
    "bbbbb",
    ".bbb.",
];

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

function drawSpan(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    fromW: number,
    toW: number,
    color: string,
): void {
    const s = Math.max(1, cam.pixelScale);
    const a = snapScreen(cam, ax, ay);
    const b = snapScreen(cam, bx, by);
    const x0 = a.x / s;
    const y0 = a.y / s;
    const x1 = b.x / s;
    const y1 = b.y / s;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(len));
    const px = len < 0.001 ? 1 : -dy / len;
    const py = len < 0.001 ? 0 : dx / len;
    ctx.fillStyle = color;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = x0 + dx * t;
        const y = y0 + dy * t;
        for (let w = fromW; w <= toW; w++) {
            ctx.fillRect(Math.round(x + px * w) * s, Math.round(y + py * w) * s, s, s);
        }
    }
}

function limb(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    a: { x: number; y: number },
    b: { x: number; y: number },
    half: number,
    fill: string,
    shade: string,
): void {
    drawSpan(ctx, cam, a.x, a.y, b.x, b.y, -half - 1, half + 1, OUTLINE);
    drawSpan(ctx, cam, a.x, a.y, b.x, b.y, -half, half, fill);
    drawSpan(ctx, cam, a.x, a.y, b.x, b.y, -half, -half, shade);
}

function blit(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    worldX: number,
    worldY: number,
    rows: readonly string[],
    originCol: number,
    originRow: number,
): void {
    const s = Math.max(1, cam.pixelScale);
    const origin = snapScreen(cam, worldX, worldY);
    for (let row = 0; row < rows.length; row++) {
        const line = rows[row]!;
        for (let col = 0; col < line.length; col++) {
            const color = INK[line[col]!];
            if (color === undefined) {
                continue;
            }
            ctx.fillStyle = color;
            ctx.fillRect(origin.x + (col - originCol) * s, origin.y + (row - originRow) * s, s, s);
        }
    }
}

function drawBoot(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    knee: { x: number; y: number },
    foot: { x: number; y: number },
): void {
    const dx = foot.x - knee.x;
    const dy = foot.y - knee.y;
    const len = Math.hypot(dx, dy) || 1;
    const tx = foot.x + (dx / len) * 3;
    const ty = foot.y + (dy / len) * 3;
    drawSpan(ctx, cam, foot.x, foot.y, tx, ty, -2, 2, OUTLINE);
    drawSpan(ctx, cam, foot.x, foot.y, tx, ty, -1, 1, BOOT);
}

function drawHand(ctx: CanvasRenderingContext2D, cam: Camera, hand: { x: number; y: number }): void {
    const s = Math.max(1, cam.pixelScale);
    const p = snapScreen(cam, hand.x, hand.y);
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(p.x - s, p.y - s, s * 4, s * 3);
    ctx.fillStyle = SKIN;
    ctx.fillRect(p.x, p.y - s, s * 2, s * 2);
    ctx.fillRect(p.x + 2 * s, p.y, s, s);
}

export function drawPixelClimber(ctx: CanvasRenderingContext2D, cam: Camera, skeleton: Skeleton): void {
    const neck = at(skeleton, skeleton.neckParticleIndex);
    const back = at(skeleton, skeleton.backParticleIndex);
    const pelvis = at(skeleton, skeleton.pelvisParticleIndex);
    const buttocks = at(skeleton, skeleton.buttocksParticleIndex);
    const head = endParticle(skeleton, skeleton.bodyConstraintIndices[3]!, 1);

    const leftElbow = endParticle(skeleton, skeleton.leftArmConstraintIndices[0]!, 1);
    const rightElbow = endParticle(skeleton, skeleton.rightArmConstraintIndices[0]!, 1);
    const leftHand = at(skeleton, skeleton.handParticleIndex[0]!);
    const rightHand = at(skeleton, skeleton.handParticleIndex[1]!);
    const leftKnee = endParticle(skeleton, skeleton.leftLegConstraintIndices[0]!, 1);
    const rightKnee = endParticle(skeleton, skeleton.rightLegConstraintIndices[0]!, 1);
    const leftFoot = at(skeleton, skeleton.footParticleIndex[0]!);
    const rightFoot = at(skeleton, skeleton.footParticleIndex[1]!);

    const dx = pelvis.x - neck.x;
    const dy = pelvis.y - neck.y;
    const len = Math.hypot(dx, dy) || 1;
    let packX = -dy / len;
    let packY = dx / len;
    if (packX > 0) {
        packX = -packX;
        packY = -packY;
    }
    blit(ctx, cam, back.x + packX * 5, back.y + packY * 1, PACK_SPRITE, 2, 2);

    limb(ctx, cam, buttocks, leftKnee, 2, PANTS_DARK, PANTS_DEEP);
    limb(ctx, cam, leftKnee, leftFoot, 1, PANTS_DARK, PANTS_DEEP);
    limb(ctx, cam, buttocks, rightKnee, 2, PANTS, PANTS_DARK);
    limb(ctx, cam, rightKnee, rightFoot, 1, PANTS, PANTS_DARK);
    drawBoot(ctx, cam, leftKnee, leftFoot);
    drawBoot(ctx, cam, rightKnee, rightFoot);

    limb(ctx, cam, neck, back, 3, SHIRT, SHIRT_SHADE);
    limb(ctx, cam, back, pelvis, 3, SHIRT, SHIRT_SHADE);
    limb(ctx, cam, pelvis, buttocks, 2, PANTS, PANTS_DARK);

    limb(ctx, cam, neck, leftElbow, 1, SHIRT, SHIRT_SHADE);
    limb(ctx, cam, leftElbow, leftHand, 1, SHIRT, SHIRT_SHADE);
    limb(ctx, cam, neck, rightElbow, 1, SHIRT, SHIRT_SHADE);
    limb(ctx, cam, rightElbow, rightHand, 1, SHIRT, SHIRT_SHADE);
    drawHand(ctx, cam, leftHand);
    drawHand(ctx, cam, rightHand);

    // Head sits on the neck particle so the short head bone does not leave a gap.
    const headX = (neck.x + head.x) * 0.5;
    const headY = (neck.y + head.y) * 0.5;
    blit(ctx, cam, headX, headY, HEAD, 4, 5);
}
