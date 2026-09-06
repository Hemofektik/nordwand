import { describe, it, expect } from "vitest";
import { SpringPhysics } from "../src/Physics.ts";
import { Wall } from "../src/Wall.ts";
import { Skeleton } from "../src/Skeleton.ts";
import { Rope } from "../src/Rope.ts";
import { ClimbingAI } from "../src/ClimbingAI.ts";

/** [DEBUG-a4f2] Probe: game-frame-dt stall regression guards. */
describe("probe: game frame dt", () => {
    it("control: substep physics AND AI at 1/120, game dt loop", () => {
        const h = makeClimber();
        const dt = 1 / 60;
        let sub = 0;
        const startFootY = maxFootY(h);
        let highestFootY = startFootY;
        for (let t = 0; t < 12; t += dt) {
            let remaining = dt;
            while (remaining > 0) {
                const s = Math.min(remaining, 1 / 120);
                h.phys.update(s);
                h.ai.update(s);
                remaining -= s;
                sub++;
            }
            highestFootY = Math.min(highestFootY, ...plantedFootYs(h));
        }
        const climbed = startFootY - highestFootY;
        // eslint-disable-next-line no-console
        console.log(`[probe] substep-120 climbed=${climbed.toFixed(1)}px subs=${sub}`);
        expect(climbed).toBeGreaterThan(12);
    });

    it("single 1/60 AI call per frame", () => {
        const h = makeClimber();
        const dt = 1 / 60;
        const startFootY = maxFootY(h);
        let highestFootY = startFootY;
        for (let t = 0; t < 12; t += dt) {
            h.phys.update(dt);
            h.ai.update(dt);
            highestFootY = Math.min(highestFootY, ...plantedFootYs(h));
        }
        const climbed = startFootY - highestFootY;
        // eslint-disable-next-line no-console
        console.log(`[probe] single-1/60 climbed=${climbed.toFixed(1)}px`);
        expect(climbed).toBeGreaterThan(12);
    });

    it("substepped 40s run: does the climb keep going or deadlock?", () => {
        const h = makeClimber();
        h_phys = h.phys;
        const dt = 1 / 60;
        const startFootY = maxFootY(h);
        let highestFootY = startFootY;
        const marks: string[] = [];
        for (let t = 0; t < 40; t += dt) {
            let remaining = dt;
            while (remaining > 0) {
                const s = Math.min(remaining, 1 / 120);
                h.phys.update(s);
                h.ai.update(s);
                remaining -= s;
            }
            highestFootY = Math.min(highestFootY, ...plantedFootYs(h));
            if (Math.abs(t % 5) < dt) {
                marks.push(`t=${t.toFixed(0)} grabbed=${h.ai.grabCount} state=${h.ai.state} bestY=${highestFootY.toFixed(0)}`);
            }
        }
        // eslint-disable-next-line no-console
        console.log(`[probe] substep-40s:\n${marks.join("\n")}`);
        // [DEBUG-a4f2] Dump body vs wall geometry at the end of the run.
        const pelvis = h.skeleton.phys.particleStates[h.skeleton.pelvisParticleIndex];
        const neck = h.skeleton.phys.particleStates[h.skeleton.neckParticleIndex];
        const buttocks = h.skeleton.phys.particleStates[h.skeleton.buttocksParticleIndex];
        const foot0 = h.skeleton.limbParticle("foot", 0);
        const foot1 = h.skeleton.limbParticle("foot", 1);
        const knee0 = h.skeleton.phys.angularConstraints[h.skeleton.kneeJointACIndex[0]];
        const knee1 = h.skeleton.phys.angularConstraints[h.skeleton.kneeJointACIndex[1]];
        const hip0 = h.skeleton.phys.angularConstraints[h.skeleton.hipJointACIndex[0]];
        const hip1 = h.skeleton.phys.angularConstraints[h.skeleton.hipJointACIndex[1]];
        // eslint-disable-next-line no-console
        console.log(
            `[probe] end state: pelvis=(${pelvis.posX.toFixed(0)},${pelvis.posY.toFixed(0)})` +
            ` buttocks=(${buttocks.posX.toFixed(0)},${buttocks.posY.toFixed(0)})` +
            ` neck=(${h.skeleton.phys.particleStates[h.skeleton.neckParticleIndex].posX.toFixed(0)},${h.skeleton.phys.particleStates[h.skeleton.neckParticleIndex].posY.toFixed(0)})` +
            ` feet=(${foot0.posX.toFixed(0)},${foot0.posY.toFixed(0)})/(${foot1.posX.toFixed(0)},${foot1.posY.toFixed(1)})` +
            ` wallX@buttocks=${h.wall.wallXAtY(buttocks.posY)?.toFixed(0) ?? "?"}` +
            ` grabs=[${h.skeleton.isGrabbing("hand", 0) ? "H0" : ""}${h.skeleton.isGrabbing("hand", 1) ? "H1" : ""}${h.skeleton.isGrabbing("foot", 0) ? " F0" : ""}${h.skeleton.isGrabbing("foot", 1) ? " F1" : ""}]` +
            ` aiState=${h.ai.state} legTarget=${h.ai.legTargetIndex}`,
        );
        // eslint-disable-next-line no-console
        console.log(
            `[probe] joints: hip0 target=${hip0.targetAngle.toFixed(2)} cur=${currentAngle(hip0).toFixed(2)}` +
            ` knee0 target=${knee0.targetAngle.toFixed(2)} cur=${currentAngle(knee0).toFixed(2)}` +
            ` | hip1 target=${hip1.targetAngle.toFixed(2)} cur=${currentAngle(hip1).toFixed(2)}` +
            ` knee1 target=${knee1.targetAngle.toFixed(2)} cur=${currentAngle(knee1).toFixed(2)}`,
        );
        expect(startFootY - highestFootY).toBeGreaterThan(12);
    });
});

function makeClimber() {
    const wall = new Wall(150, 200);
    const phys = new SpringPhysics();
    phys.wall = wall;
    const skeleton = new Skeleton(phys, wall, 150, 200);
    const rope = new Rope(phys, wall, skeleton, 150, 200);
    void rope;
    const ai = new ClimbingAI(rope, wall, skeleton);
    phys.settle();
    return { wall, phys, skeleton, ai };
}

function maxFootY(h: ReturnType<typeof makeClimber>): number {
    return Math.max(h.skeleton.limbParticle("foot", 0).posY, h.skeleton.limbParticle("foot", 1).posY);
}

/** [DEBUG-a4f2] current angle of an angular constraint (same math as Physics). */
function currentAngle(c: { particleIndex0: number; particleIndex1: number; particleIndex2: number }): number {
    const s = h_phys.particleStates;
    const p0 = s[c.particleIndex0]!;
    const p1 = s[c.particleIndex1]!;
    const p2 = s[c.particleIndex2]!;
    let a = Math.atan2(p0.posY - p1.posY, p0.posX - p1.posX) - Math.atan2(p2.posY - p1.posY, p2.posX - p1.posX);
    while (a > Math.PI * 2) a -= Math.PI * 2;
    while (a < 0) a += Math.PI * 2;
    return a;
}

// module-level ref set by the probe so currentAngle can reach particle states
let h_phys: ReturnType<typeof makeClimber>["phys"];

function plantedFootYs(h: ReturnType<typeof makeClimber>): number[] {
    const ys: number[] = [];
    for (let side = 0; side < 2; side++) {
        if (!h.skeleton.isGrabbing("foot", side)) continue;
        const c = h.skeleton.grabConstraint("foot", side);
        const anchor = h.wall.wallAnchors[c.wallAnchorIndex];
        if (anchor !== undefined) ys.push(anchor.posY);
    }
    return ys.length > 0 ? ys : [Number.POSITIVE_INFINITY];
}
