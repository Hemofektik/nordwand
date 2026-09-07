import { describe, it, expect } from "vitest";
import { Climber } from "../src/Climber.ts";
import { CURATED_SEEDS, buildSettledHarness } from "./curated-seeds.test.ts";

/**
 * Behavior tests (concept/climbing-plan.md §9.1): the cycle - phases in
 * order, latches, substitutions, event-driven endings. Strictly black-box:
 * positions, grabs, phase names, sim time, and logs only.
 */

function makeClimber(seed: number) {
    const harness = buildSettledHarness(seed);
    const climber = new Climber(harness.phys, harness.wall, harness.skeleton);
    return { harness, climber };
}

describe("Climber cycle behavior", () => {
    it("starts in a phase after the first update (not stuck in Idle)", () => {
        const { harness, climber } = makeClimber(CURATED_SEEDS[0]!);
        climber.update(1 / 120);
        harness.phys.update(1 / 120);
        expect(climber.phase).not.toBe("Idle");
    });

    it("walks the rotation LegReach -> Push -> HandReach via latches", () => {
        // Phases complete via physical events and can do so within a single
        // substep (an instant latch), so the observable phase history is the
        // always-on log (part of the observable contract, §9.2).
        const { harness, climber } = makeClimber(CURATED_SEEDS[0]!);
        const logs: string[] = [];
        const orig = console.log;
        console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
        const dt = 1 / 60;
        for (let t = 0; t < 12; t += dt) {
            let remaining = dt;
            while (remaining > 0) {
                const sub = Math.min(remaining, 1 / 120);
                climber.update(sub);
                harness.phys.update(sub);
                harness.skeleton.update(sub);
                remaining -= sub;
            }
        }
        console.log = orig;
        const findFirstCycle = (): boolean => {
            // The first complete LegReach -> Push -> HandReach pass in order.
            let stage = 0;
            for (const line of logs) {
                if (!line.includes("phase -> ")) continue;
                if (stage === 0 && line.includes("phase -> LegReach")) stage = 1;
                else if (stage === 1 && line.includes("phase -> Push")) stage = 2;
                else if (stage === 2 && line.includes("phase -> HandReach")) return true;
            }
            return false;
        };
        expect(
            findFirstCycle(),
            `the first cycle must walk LegReach -> Push -> HandReach; logs were:\n${logs.join("\n")}`,
        ).toBe(true);
    });

    it("completes full cycles: grab count grows over 12s on all curated seeds", () => {
        for (const seed of CURATED_SEEDS) {
            const { harness, climber } = makeClimber(seed);
            const startGrabs = climber.grabCount;
            const dt = 1 / 60;
            for (let t = 0; t < 12; t += dt) {
                let remaining = dt;
                while (remaining > 0) {
                    const sub = Math.min(remaining, 1 / 120);
                    climber.update(sub);
                    harness.phys.update(sub);
                    harness.skeleton.update(sub);
                    remaining -= sub;
                }
            }
            // Each cycle latches a foot and a hand: >= 6 cycles in 12s is
            // generous; require at least 4 latches total.
            expect(
                climber.grabCount - startGrabs,
                `seed ${seed}: only ${climber.grabCount - startGrabs} latches in 12s`,
            ).toBeGreaterThanOrEqual(4);
        }
    }, 60_000);

    it("climbs: feet latch strictly higher anchors over repeated cycles (40s threshold)", () => {
        for (const seed of CURATED_SEEDS) {
            const { harness, climber } = makeClimber(seed);
            let startFootY = -Number.POSITIVE_INFINITY;
            for (let side = 0; side < 2; side++) {
                if (harness.skeleton.isGrabbing("foot", side)) {
                    const c = harness.skeleton.grabConstraint("foot", side);
                    const a = harness.wall.wallAnchors[c.wallAnchorIndex];
                    if (a !== undefined) startFootY = Math.max(startFootY, a.posY);
                }
            }
            expect(Number.isFinite(startFootY), `seed ${seed}: no planted foot at start`).toBe(true);

            // High-water mark of latched foot anchors over the run.
            let highWater = startFootY;
            const dt = 1 / 60;
            for (let t = 0; t < 40; t += dt) {
                let remaining = dt;
                while (remaining > 0) {
                    const sub = Math.min(remaining, 1 / 120);
                    climber.update(sub);
                    harness.phys.update(sub);
                    harness.skeleton.update(sub);
                    remaining -= sub;
                }
                for (let side = 0; side < 2; side++) {
                    if (!harness.skeleton.isGrabbing("foot", side)) continue;
                    const c = harness.skeleton.grabConstraint("foot", side);
                    const a = harness.wall.wallAnchors[c.wallAnchorIndex];
                    if (a !== undefined) highWater = Math.min(highWater, a.posY);
                }
            }

            const climbed = startFootY - highWater;
            expect(
                climbed,
                `seed ${seed}: climbed only ${climbed.toFixed(1)}px in 40s (threshold 75)`,
            ).toBeGreaterThanOrEqual(75);
        }
    }, 120_000);

    it("no 10s window with net descent (high-water mark of latched feet)", () => {
        const { harness, climber } = makeClimber(CURATED_SEEDS[0]!);
        const dt = 1 / 60;
        const marks: number[] = [];
        let highWater = Number.POSITIVE_INFINITY;
        for (let t = 0; t <= 40; t += dt) {
            let remaining = dt;
            while (remaining > 0) {
                const sub = Math.min(remaining, 1 / 120);
                climber.update(sub);
                harness.phys.update(sub);
                harness.skeleton.update(sub);
                remaining -= sub;
            }
            for (let side = 0; side < 2; side++) {
                if (!harness.skeleton.isGrabbing("foot", side)) continue;
                const c = harness.skeleton.grabConstraint("foot", side);
                const a = harness.wall.wallAnchors[c.wallAnchorIndex];
                // High-water: the highest anchor any foot has EVER latched.
                if (a !== undefined) highWater = Math.min(highWater, a.posY);
            }
            if (t % 10 < dt) {
                marks.push(highWater);
            }
        }
        // The high-water mark is monotone by construction; the meaningful
        // assertion is that it reaches at least the starting height + some
        // progress in EVERY window (no window ends without new progress).
        for (let i = 1; i < marks.length; i++) {
            expect(
                marks[i]!,
                `10s window ${i - 1}->${i}: no new progress (high-water stuck at ${marks[i]!.toFixed(1)})`,
            ).toBeLessThan(marks[i - 1]!);
        }
    });
});
