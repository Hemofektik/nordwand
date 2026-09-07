import { it, expect } from "vitest";
import { Climber } from "../src/Climber.ts";
import { CURATED_SEEDS, buildSettledHarness } from "./curated-seeds.test.ts";

it("let-go then re-grab: no crash, climber resumes when holds are re-taken", () => {
    const h = buildSettledHarness(CURATED_SEEDS[0]!);
    const climber = new Climber(h.phys, h.wall, h.skeleton);
    const dt = 1 / 120;
    // Climb briefly.
    for (let t = 0; t < 1; t += dt) {
        climber.update(dt);
        h.phys.update(dt);
        h.skeleton.update(dt);
    }
    // Let go of everything.
    h.skeleton.letGo();
    climber.stopClimbing();
    // Must not throw while nothing is planted.
    for (let t = 0; t < 1; t += dt) {
        climber.update(dt);
        h.phys.update(dt);
        h.skeleton.update(dt);
    }
    expect(climber.phase).toBe("Idle");
    // Re-grab two holds manually (as a player would) and expect the climber
    // to resume the cycle.
    const anchors = h.wall.wallAnchors;
    h.skeleton.grab("hand", 0, anchors[50]!);
    h.skeleton.grab("foot", 0, anchors[60]!);
    for (let t = 0; t < 2; t += dt) {
        climber.update(dt);
        h.phys.update(dt);
        h.skeleton.update(dt);
    }
    expect(climber.phase).not.toBe("Idle");
});
