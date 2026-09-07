import { describe, it, expect } from "vitest";
import { ClimberMotor } from "../src/ClimberMotor.ts";
import { CURATED_SEEDS, buildSettledHarness } from "./curated-seeds.test.ts";
import type { WallAnchor } from "../src/Wall.ts";

/**
 * Motor unit suite: ClimberMotor commands against a settled skeleton,
 * independent of the decision layer (concept/climbing-plan.md §9.1).
 */

function makeMotor(seed: number) {
    const harness = buildSettledHarness(seed);
    const motor = new ClimberMotor(harness.phys, harness.wall, harness.skeleton);
    return { ...harness, motor };
}

/** Advances the world while the motor animates its current command. */
function runWhile(motor: ClimberMotor, harness: ReturnType<typeof makeMotor>, seconds: number): void {
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) {
        let remaining = dt;
        while (remaining > 0) {
            const sub = Math.min(remaining, 1 / 120);
            motor.update(sub);
            harness.phys.update(sub);
            harness.skeleton.update(sub);
            remaining -= sub;
        }
    }
}

function freeAnchorAbove(harness: ReturnType<typeof makeMotor>, refY: number, maxHeight: number): WallAnchor {
    const occupied = new Set<number>();
    for (const kind of ["hand", "foot"] as const) {
        for (let side = 0; side < 2; side++) {
            if (harness.skeleton.isGrabbing(kind, side)) {
                occupied.add(harness.skeleton.grabConstraint(kind, side).wallAnchorIndex);
            }
        }
    }
    let best: WallAnchor | undefined;
    for (const a of harness.wall.wallAnchors) {
        if (occupied.has(a.index)) continue;
        if (a.posY >= refY) continue; // above = smaller y
        if (a.posY < maxHeight) continue;
        if (best === undefined || a.posY < best.posY) best = a;
    }
    expect(best, "no free anchor found in window").toBeDefined();
    return best!;
}

describe("ClimberMotor", () => {
    it("reachFoot reports unreachable for an anchor beyond the leg envelope", () => {
        const { wall, motor } = makeMotor(CURATED_SEEDS[0]!);
        const far = wall.wallAnchors[0]!; // bottom of the wall, far below
        expect(motor.reachFoot(0, far)).toBe("unreachable");
    });

    it("reachFoot animates and latches a leg-reachable anchor", () => {
        const seed = CURATED_SEEDS[0]!;
        const m = makeMotor(seed);
        const buttocks = m.skeleton.phys.particleStates[m.skeleton.buttocksParticleIndex]!;
        // Free the foot via the motor's own release, then reach a target
        // within envelope: an anchor ~15px above the buttocks.
        const target = m.wall.wallAnchors.find(
            a => a.posY < buttocks.posY - 15 && a.posY > buttocks.posY - 22,
        );
        expect(target, "test setup: no anchor in test window").toBeDefined();
        m.motor.releaseFoot(0);
        const status = m.motor.reachFoot(0, target!);
        expect(status === "in-progress" || status === "latched").toBe(true);
        // Run until latched.
        let latched = status === "latched";
        for (let t = 0; t < 4 && !latched; t += 1 / 60) {
            runWhile(m.motor, m, 1 / 60);
            if (m.motor.reachFoot(0, target!) === "latched") latched = true;
        }
        expect(latched, "foot never latched within 4s").toBe(true);
        expect(m.skeleton.isGrabbing("foot", 0)).toBe(true);
        const c = m.skeleton.grabConstraint("foot", 0);
        expect(c.wallAnchorIndex).toBe(target!.index);
    });

    it("reachHand refuses a target below the neck (hand rule) and latches one above", () => {
        const seed = CURATED_SEEDS[0]!;
        const m = makeMotor(seed);
        const neck = m.skeleton.phys.particleStates[m.skeleton.neckParticleIndex]!;
        const below = m.wall.wallAnchors.find(a => a.posY > neck.posY + 30);
        expect(below, "test setup: no anchor below neck").toBeDefined();
        expect(m.motor.reachHand(0, below!)).toBe("unreachable");

        const above = freeAnchorAbove(m, neck.posY - 5, neck.posY - 25);
        m.motor.releaseHand(1);
        expect(m.motor.reachHand(1, above)).not.toBe("unreachable");
        let latched = false;
        for (let t = 0; t < 4 && !latched; t += 1 / 60) {
            runWhile(m.motor, m, 1 / 60);
            if (m.skeleton.isGrabbing("hand", 1)) latched = true;
        }
        expect(latched, "hand never latched within 4s").toBe(true);
    });

    it("pushWithLeg extends the drive leg and the body rises; planted arms adapt", () => {
        const seed = CURATED_SEEDS[0]!;
        const m = makeMotor(seed);
        // Realistic push configuration (§5.1): only the drive leg and the
        // hands are planted - the old drive leg releases on latch in the
        // cycle. (With both feet planted and one anchor below the body, the
        // planted-leg IK legitimately hauls the body onto the lower hold.)
        m.motor.releaseFoot(1);
        const pelvis0 = m.phys.particleStates[m.skeleton.pelvisParticleIndex]!.posY;
        expect(m.motor.pushWithLeg(0)).toBe("in-progress");
        for (let t = 0; t < 2; t += 1 / 60) {
            runWhile(m.motor, m, 1 / 60);
            const status = m.motor.pushWithLeg(0);
            if (status === "latched") break;
            expect(status).toBe("in-progress");
        }
        const pelvis1 = m.phys.particleStates[m.skeleton.pelvisParticleIndex]!.posY;
        expect(pelvis0 - pelvis1, "push did not raise the pelvis").toBeGreaterThan(2);
    });

    it("the motor never writes velocities directly (angular-only contract)", () => {
        // Structural check: ClimberMotor source must contain no velocity writes.
        // (Enforced more meaningfully by the invariant suite; here we check the
        // class exposes no such API surface.)
        const m = makeMotor(CURATED_SEEDS[0]!);
        const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(m.motor));
        for (const name of proto) {
            expect(name.startsWith("setVel") || name.startsWith("applyImpulse")).toBe(false);
        }
    });
});
