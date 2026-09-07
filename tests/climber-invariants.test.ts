import { describe, it, expect } from "vitest";
import { CURATED_SEEDS, buildSettledHarness } from "./curated-seeds.test.ts";
import { Climber } from "../src/Climber.ts";
import type { WallAnchor } from "../src/Wall.ts";

/**
 * Black-box invariant tests (concept/climbing-plan.md §9.2).
 *
 * Observables: particle positions, isGrabbing, grab anchor indices, phase
 * name, MotorStatus, sim time. Never angles, filter internals, or IK
 * targets.
 *
 * These invariants must hold on EVERY substep of any run, with any driver
 * (Climber or future player input). Violations report seed + sim time.
 */

export interface Observation {
    time: number;
    phase: string;
    freeLimbCount: number;
    footAnchorYs: number[];
    lowestHandAnchorY: number;
    comDistToWall: number;
}

export function observe(harness: ReturnType<typeof buildSettledHarness>, climber: Climber | undefined): Observation {
    const { wall, skeleton } = harness;
    let freeLimbCount = 0;
    const footAnchorYs: number[] = [];
    let lowestHandAnchorY = Number.POSITIVE_INFINITY;
    for (const kind of ["hand", "foot"] as const) {
        for (let side = 0; side < 2; side++) {
            if (!skeleton.isGrabbing(kind, side)) {
                freeLimbCount++;
                continue;
            }
            const anchor = wall.wallAnchors[skeleton.grabConstraint(kind, side).wallAnchorIndex];
            if (anchor === undefined) {
                continue;
            }
            if (kind === "foot") {
                footAnchorYs.push(anchor.posY);
            } else {
                lowestHandAnchorY = Math.min(lowestHandAnchorY, anchor.posY);
            }
        }
    }
    // CoM proxy: average of the four body particles.
    const idx = [
        skeleton.pelvisParticleIndex,
        skeleton.buttocksParticleIndex,
        skeleton.backParticleIndex,
        skeleton.neckParticleIndex,
    ];
    let comX = 0;
    let comY = 0;
    for (const i of idx) {
        const p = harness.phys.particleStates[i]!;
        comX += p.posX;
        comY += p.posY;
    }
    comX /= idx.length;
    comY /= idx.length;
    const wallX = wall.wallXAtY(comY);
    const comDistToWall = wallX === undefined ? 0 : Math.abs(wallX - comX);
    return {
        time: climber?.clock ?? 0,
        phase: climber?.phase ?? "Idle",
        freeLimbCount,
        footAnchorYs,
        lowestHandAnchorY,
        comDistToWall,
    };
}

export function checkInvariants(obs: Observation, seed: number, where: string): void {
    expect(
        obs.freeLimbCount,
        `seed ${seed} t=${obs.time.toFixed(2)} ${where}: ${obs.freeLimbCount} limbs free (max 1)`,
    ).toBeLessThanOrEqual(1);
    for (const footY of obs.footAnchorYs) {
        expect(
            footY,
            `seed ${seed} t=${obs.time.toFixed(2)} ${where}: foot anchor y=${footY.toFixed(1)}` +
            ` not ≥15px below lowest hand y=${obs.lowestHandAnchorY.toFixed(1)}`,
        ).toBeGreaterThanOrEqual(obs.lowestHandAnchorY + 15);
    }
    expect(
        obs.comDistToWall,
        `seed ${seed} t=${obs.time.toFixed(2)} ${where}: CoM ${obs.comDistToWall.toFixed(1)}px from wall (max 35)`,
    ).toBeLessThanOrEqual(35);
}

/** Runs the climber on a harness, checking invariants every substep. */
export function runWithInvariants(
    harness: ReturnType<typeof buildSettledHarness>,
    climber: Climber,
    seconds: number,
    seed: number,
): void {
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) {
        let remaining = dt;
        while (remaining > 0) {
            const sub = Math.min(remaining, 1 / 120);
            climber.update(sub);
            harness.phys.update(sub);
            harness.skeleton.update(sub);
            remaining -= sub;
            checkInvariants(observe(harness, climber), seed, "every substep");
        }
    }
}

describe("climber invariants during climbing", () => {
    // Fails until Climber exists (red phase of TDD).
    for (const seed of CURATED_SEEDS) {
        it(`seed ${seed}: invariants hold for 6s of climbing`, () => {
            const harness = buildSettledHarness(seed);
            const climber = new Climber(harness.phys, harness.wall, harness.skeleton);
            runWithInvariants(harness, climber, 6, seed);
        });
    }

    it("initial hang satisfies the invariants before any climbing", () => {
        for (const seed of CURATED_SEEDS) {
            const harness = buildSettledHarness(seed);
            checkInvariants(observe(harness, undefined), seed, "initial");
        }
    });
});

// Type-only import usage guard (WallAnchor used in doc context above).
export type { WallAnchor };
