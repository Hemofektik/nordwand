import type { Camera } from "./Camera.ts";
import type { Skeleton } from "./Skeleton.ts";
import { snapScreen, strokeOutlined } from "./pixelDraw.ts";

/**
 * The live body is still the ragdoll. This only changes how those particles
 * are drawn: a jacket, legs, and a head in whole pixels, instead of the
 * rainbow debug bones.
 */

const OUTLINE = "#efe8dc";
const JACKET = "#d24a3a";
const PANTS = "#2a241f";
const SKIN = "#f2d2b4";
const HAIR = "#2a160f";
const GLOVE = "#4a3028";
const BOOT = "#140e0c";

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

    const limb = (a: { x: number; y: number }, b: { x: number; y: number }, color: string): void => {
        strokeOutlined(ctx, cam, a.x, a.y, b.x, b.y, color, OUTLINE, 1);
    };

    limb(buttocks, leftKnee, PANTS);
    limb(leftKnee, leftFoot, PANTS);
    limb(buttocks, rightKnee, PANTS);
    limb(rightKnee, rightFoot, PANTS);

    limb(neck, leftElbow, JACKET);
    limb(leftElbow, leftHand, JACKET);
    limb(neck, rightElbow, JACKET);
    limb(rightElbow, rightHand, JACKET);

    limb(neck, back, JACKET);
    strokeOutlined(ctx, cam, back.x, back.y, pelvis.x, pelvis.y, JACKET, OUTLINE, 2);
    limb(pelvis, buttocks, PANTS);

    const s = cam.pixelScale;
    const headPx = snapScreen(cam, head.x, head.y);
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(headPx.x - 2 * s, headPx.y - 3 * s, 5 * s, 5 * s);
    ctx.fillStyle = HAIR;
    ctx.fillRect(headPx.x - s, headPx.y - 2 * s, 3 * s, 2 * s);
    ctx.fillStyle = SKIN;
    ctx.fillRect(headPx.x - s, headPx.y, 3 * s, 2 * s);

    const mark = (p: { x: number; y: number }, color: string, size: number): void => {
        const px = snapScreen(cam, p.x, p.y);
        ctx.fillStyle = color;
        ctx.fillRect(px.x, px.y, s * size, s * size);
    };
    mark(leftHand, GLOVE, 2);
    mark(rightHand, GLOVE, 2);
    mark(leftFoot, BOOT, 2);
    mark(rightFoot, BOOT, 2);
}
