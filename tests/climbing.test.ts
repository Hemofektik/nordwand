import { describe, it, expect } from "vitest";
import { SpringPhysics } from "../src/Physics.ts";
import { Wall } from "../src/Wall.ts";
import { Skeleton } from "../src/Skeleton.ts";
import { Rope } from "../src/Rope.ts";
import { ClimbingAI, ClimbingState } from "../src/ClimbingAI.ts";
import { defined } from "../src/assert.ts";

/** Deterministic RNG so every run exercises the same wall. */
function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff;
    };
}

interface Harness {
    phys: SpringPhysics;
    wall: Wall;
    skeleton: Skeleton;
    ai: ClimbingAI;
    step(dt: number): void;
    footPos(side: number): { x: number; y: number };
    handPos(side: number): { x: number; y: number };
}

type StepOrder = "ai-then-phys" | "phys-then-ai";

/** Builds the real game stack and advances it in fixed substeps. */
function buildHarness(seed = 42, order: StepOrder = "ai-then-phys"): Harness {
    void seed;
    const wall = new Wall(150, 200);
    const phys = new SpringPhysics();
    phys.wall = wall;
    const skeleton = new Skeleton(phys, wall, 150, 200);
    const rope = new Rope(phys, wall, skeleton, 150, 200);
    void rope;
    const ai = new ClimbingAI(rope, wall, skeleton);
    phys.settle();

    return {
        phys,
        wall,
        skeleton,
        ai,
        step(dt: number) {
            let remaining = dt;
            while (remaining > 0) {
                const sub = Math.min(remaining, 1 / 120);
                if (order === "phys-then-ai") {
                    phys.update(sub);
                    skeleton.update(sub);
                    ai.update(sub);
                } else {
                    ai.update(sub);
                    phys.update(sub);
                    skeleton.update(sub);
                }
                remaining -= sub;
            }
        },
        footPos(side) {
            const p = skeleton.limbParticle("foot", side);
            return { x: p.posX, y: p.posY };
        },
        handPos(side) {
            const p = skeleton.limbParticle("hand", side);
            return { x: p.posX, y: p.posY };
        },
    };
}

function climbProgress(h: Harness, seconds: number): number {
    for (let t = 0; t < 1.5; t += 1 / 60) {
        h.step(1 / 60);
    }
    const startFootY = Math.max(h.footPos(0).y, h.footPos(1).y);
    let highestLatchedFootY = startFootY;
    for (let t = 0; t < seconds; t += 1 / 60) {
        h.step(1 / 60);
        for (let side = 0; side < 2; side++) {
            if (!h.skeleton.isGrabbing("foot", side)) {
                continue;
            }
            const c = h.skeleton.grabConstraint("foot", side);
            const anchor = h.wall.wallAnchors[c.wallAnchorIndex];
            if (anchor !== undefined) {
                highestLatchedFootY = Math.min(highestLatchedFootY, anchor.posY);
            }
        }
    }
    return startFootY - highestLatchedFootY;
}

describe("climbing AI stepping", () => {
    it("free foot reaches and latches its IK target anchor", () => {
        const h = buildHarness();
        // Let the initial push finish and the hand reach start.
        for (let t = 0; t < 2.0; t += 1 / 60) {
            h.step(1 / 60);
        }

        // Run the LegReach phase and record what the AI aims for. The AI may
        // legitimately re-choose its target after a timeout, so we collect
        // every target of the attempt and require the latch to be one of them
        // AND require the foot to approach the FINAL target. Feet planted at
        // harness start do not count as latches; we need a NEW grab.
        let sawLegReach = false;
        const aimedAnchors = new Set<number>();
        let lastTarget: { x: number; y: number } | undefined;
        let minFootDistanceToLast = Number.POSITIVE_INFINITY;
        let latched = false;
        let latchedAnchorIndex = -1;
        const initiallyPlanted = new Set<number>();
        for (let side = 0; side < 2; side++) {
            if (h.skeleton.isGrabbing("foot", side)) {
                initiallyPlanted.add(side);
            }
        }

        for (let t = 0; t < 6.0 && !latched; t += 1 / 60) {
            h.step(1 / 60);
            // lastLegTargetIndex survives the latch, so a reach that grabs
            // within a single update is still observed.
            const idx = h.ai.legTargetIndex >= 0 ? h.ai.legTargetIndex : h.ai.lastLegTargetIndex;
            if (h.ai.state === ClimbingState.LegReach || idx >= 0) {
                if (h.ai.state === ClimbingState.LegReach) {
                    sawLegReach = true;
                }
                if (idx >= 0) {
                    const anchor = defined(h.wall.wallAnchors[idx], "Missing leg target");
                    aimedAnchors.add(idx);
                    lastTarget = { x: anchor.posX, y: anchor.posY };
                    const foot = h.footPos(1 - h.ai.driveLegSide);
                    minFootDistanceToLast = Math.min(
                        minFootDistanceToLast,
                        Math.hypot(foot.x - lastTarget.x, foot.y - lastTarget.y),
                    );
                }
            }
            // A NEW foot grab: a side that was free at start now latched.
            for (let side = 0; side < 2; side++) {
                if (initiallyPlanted.has(side) || !h.skeleton.isGrabbing("foot", side)) {
                    continue;
                }
                const c = h.skeleton.grabConstraint("foot", side);
                if (h.wall.wallAnchors[c.wallAnchorIndex] !== undefined) {
                    latched = true;
                    latchedAnchorIndex = c.wallAnchorIndex;
                }
            }
        }

        expect(sawLegReach, "AI never entered LegReach").toBe(true);
        expect(lastTarget, "AI entered LegReach without a foot target").toBeDefined();
        expect(
            minFootDistanceToLast,
            "foot never got close to its (final) target anchor",
        ).toBeLessThan(24);
        expect(latched, "foot never latched an anchor within 6s").toBe(true);
        // The foot must latch an anchor the AI was aiming at during the attempt.
        expect(
            aimedAnchors.has(latchedAnchorIndex),
            `latched anchor ${latchedAnchorIndex} but aimed at [${[...aimedAnchors].join(",")}]`,
        ).toBe(true);
    });

    it("climbs upward: feet latch strictly higher anchors over repeated cycles", () => {
        const h = buildHarness();
        for (let t = 0; t < 1.5; t += 1 / 60) {
            h.step(1 / 60);
        }

        const startFootY = Math.max(h.footPos(0).y, h.footPos(1).y);
        let highestLatchedFootY = startFootY;

        for (let t = 0; t < 12.0; t += 1 / 60) {
            h.step(1 / 60);
            for (let side = 0; side < 2; side++) {
                if (!h.skeleton.isGrabbing("foot", side)) {
                    continue;
                }
                const c = h.skeleton.grabConstraint("foot", side);
                const anchor = h.wall.wallAnchors[c.wallAnchorIndex];
                if (anchor !== undefined) {
                    highestLatchedFootY = Math.min(highestLatchedFootY, anchor.posY);
                }
            }
        }

        // After 12 seconds the best planted foot must be meaningfully higher
        // (smaller Y) than at the start. One full cycle is ~2-3s and gains
        // ~8-15px per step, so 12s should show at least a few steps.
        const climbed = startFootY - highestLatchedFootY;
        expect(
            climbed,
            `no upward progress after 12s (start y=${startFootY.toFixed(1)}, best y=${highestLatchedFootY.toFixed(1)})`,
        ).toBeGreaterThan(12);
    });

    it("stepping knee flexes during travel and foot lands on the anchor", () => {
        const h = buildHarness();
        for (let t = 0; t < 2.0; t += 1 / 60) {
            h.step(1 / 60);
        }

        let sawFlex = false;
        let maxKneeFlexion = 0;
        let latchedAfterFlex = false;
        let reachSide = -1;

        for (let t = 0; t < 14.0 && !latchedAfterFlex; t += 1 / 60) {
            if (h.ai.state === ClimbingState.LegReach) {
                reachSide = 1 - h.ai.driveLegSide;
                const knee = defined(
                    h.skeleton.phys.angularConstraints[
                    defined(h.skeleton.kneeJointACIndex[reachSide], "Missing knee index")
                    ],
                    "Missing knee constraint",
                );
                // Flexion: how far the knee target is from straight (PI).
                const flexion = Math.abs(Math.PI - knee.targetAngle);
                if (flexion > 0.6) {
                    sawFlex = true;
                    maxKneeFlexion = Math.max(maxKneeFlexion, flexion);
                }
            }
            const grabCountBefore = h.ai.grabCount;
            h.step(1 / 60);
            // Latch and Push happen in the same update(), so observe the grab
            // after the step rather than requiring state to still be LegReach.
            if (
                sawFlex &&
                reachSide >= 0 &&
                h.ai.grabCount > grabCountBefore &&
                h.skeleton.isGrabbing("foot", reachSide)
            ) {
                latchedAfterFlex = true;
            }
            if (h.ai.state !== ClimbingState.LegReach) {
                reachSide = -1;
            }
        }

        expect(
            sawFlex,
            "knee never flexed during LegReach - foot travels straight-legged",
        ).toBe(true);
        expect(maxKneeFlexion, "knee flexion stayed shallow").toBeGreaterThan(0.6);
        expect(latchedAfterFlex, "foot never latched after knee flexion").toBe(true);
    });

    it("climbs with the game's update order (physics before AI)", () => {
        const h = buildHarness(42, "phys-then-ai");
        const climbed = climbProgress(h, 12.0);
        expect(
            climbed,
            `no upward progress with game update order (climbed ${climbed.toFixed(1)}px in 12s)`,
        ).toBeGreaterThan(12);
    });
});
