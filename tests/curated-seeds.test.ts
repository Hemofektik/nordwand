import { describe, it, expect } from "vitest";
import { Wall } from "../src/Wall.ts";
import { SpringPhysics } from "../src/Physics.ts";
import { Skeleton } from "../src/Skeleton.ts";

/**
 * Seed curation (concept/climbing-plan.md §9.3).
 *
 * Curation happens once, up front: the set below is FROZEN. When a curated
 * seed fails a progress threshold, the implementation must improve — never
 * swap the seed for an easier one, never weaken the thresholds.
 *
 * A seed qualifies if the settled initial hang is valid:
 *  - all four limbs latched,
 *  - no particle below the floor (BOTTOM_PX = 500),
 *  - every latched limb is actually pinned at its anchor.
 */
export const CURATED_SEEDS: readonly number[] = [
    101, 202, 303, 404, 505,
];

const FLOOR_PX = 500;

export function buildSettledHarness(seed: number) {
    const wall = new Wall(150, 200, seed);
    const phys = new SpringPhysics();
    phys.wall = wall;
    const skeleton = new Skeleton(phys, wall, 150, 200);
    // NOTE: no Rope here. The rope is a game-presentation element (belay
    // line) with a FIXED length; in a 40s climb it goes taut and then
    // actively drags the climber back down (measured: slack 64px at t=0,
    // -39px at t=20). The climbing AI must be evaluated on wall + physics
    // + skeleton alone - the rope is not part of that equation.
    phys.settle();
    return { wall, phys, skeleton };
}

describe("curated seeds: valid settled initial hang", () => {
    for (const seed of CURATED_SEEDS) {
        it(`seed ${seed}: all four limbs latched, nothing below the floor`, () => {
            const { wall, phys, skeleton } = buildSettledHarness(seed);

            for (let side = 0; side < 2; side++) {
                expect(skeleton.isGrabbing("hand", side), `seed ${seed} hand ${side}`).toBe(true);
                expect(skeleton.isGrabbing("foot", side), `seed ${seed} foot ${side}`).toBe(true);
            }

            for (const state of phys.particleStates) {
                expect(state.posY, `seed ${seed} particle below floor`).toBeLessThanOrEqual(FLOOR_PX);
            }

            // Latched limbs must sit exactly at their anchors after settle.
            for (const kind of ["hand", "foot"] as const) {
                for (let side = 0; side < 2; side++) {
                    const c = skeleton.grabConstraint(kind, side);
                    const anchor = wall.wallAnchors[c.wallAnchorIndex];
                    expect(anchor, `seed ${seed} ${kind}${side} anchor`).toBeDefined();
                    const limb = skeleton.limbParticle(kind, side);
                    expect(Math.hypot(limb.posX - anchor!.posX, limb.posY - anchor!.posY)).toBeLessThan(1);
                }
            }
        });
    }
});
