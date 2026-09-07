import { describe, it, expect } from "vitest";
import { Wall } from "../src/Wall.ts";

describe("Wall seed API", () => {
    it("same seed produces the same wall", () => {
        const a = new Wall(150, 200, 12345);
        const b = new Wall(150, 200, 12345);
        expect(a.wallSegments.length).toBe(b.wallSegments.length);
        for (let i = 0; i < a.wallSegments.length; i++) {
            const sa = a.wallSegments[i]!;
            const sb = b.wallSegments[i]!;
            expect(sa.posX).toBeCloseTo(sb.posX, 6);
            expect(sa.posY).toBeCloseTo(sb.posY, 6);
        }
        expect(a.wallAnchors.length).toBe(b.wallAnchors.length);
        for (let i = 0; i < a.wallAnchors.length; i++) {
            const aa = a.wallAnchors[i]!;
            const ba = b.wallAnchors[i]!;
            expect(aa.posX).toBeCloseTo(ba.posX, 6);
            expect(aa.posY).toBeCloseTo(ba.posY, 6);
            expect(aa.index).toBe(ba.index);
        }
    });

    it("different seeds produce different walls", () => {
        const a = new Wall(150, 200, 1);
        const b = new Wall(150, 200, 2);
        // Segment count is fixed by the generation rules; the seeds differ in
        // where the wall wanders.
        expect(a.wallSegments.length).toBe(b.wallSegments.length);
        const differs = a.wallSegments.some((s, i) => {
            const t = b.wallSegments[i]!;
            return Math.abs(s.posX - t.posX) > 0.01 || Math.abs(s.posY - t.posY) > 0.01;
        });
        expect(differs).toBe(true);
    });

    it("default construction is random (two walls differ)", () => {
        // With a random default, two freshly constructed walls virtually
        // never match. Not a hard mathematical guarantee, but the collision
        // probability is ~2^-31 per comparison.
        const a = new Wall(150, 200);
        const b = new Wall(150, 200);
        const differs = a.wallSegments.some((s, i) => {
            const t = b.wallSegments[i]!;
            return Math.abs(s.posX - t.posX) > 0.01 || Math.abs(s.posY - t.posY) > 0.01;
        });
        expect(differs).toBe(true);
    });

    it("a seeded wall is unaffected by other walls constructed around it", () => {
        const a = new Wall(150, 200, 777);
        const snapshot = a.wallSegments.map(s => ({ x: s.posX, y: s.posY }));
        new Wall(150, 200, 888);
        new Wall(150, 200); // random one
        const b = new Wall(150, 200, 777);
        expect(b.wallSegments.length).toBe(snapshot.length);
        for (let i = 0; i < snapshot.length; i++) {
            expect(b.wallSegments[i]!.posX).toBeCloseTo(snapshot[i]!.x, 6);
            expect(b.wallSegments[i]!.posY).toBeCloseTo(snapshot[i]!.y, 6);
        }
    });

    it("extends deterministically under ensureGeneratedTo", () => {
        const a = new Wall(150, 200, 42);
        const b = new Wall(150, 200, 42);
        a.ensureGeneratedTo(-500);
        b.ensureGeneratedTo(-500);
        expect(a.wallSegments.length).toBe(b.wallSegments.length);
        for (let i = 0; i < a.wallSegments.length; i++) {
            expect(a.wallSegments[i]!.posX).toBeCloseTo(b.wallSegments[i]!.posX, 6);
            expect(a.wallSegments[i]!.posY).toBeCloseTo(b.wallSegments[i]!.posY, 6);
        }
    });

    it("accepts seed 0 as a valid seed", () => {
        const a = new Wall(150, 200, 0);
        const b = new Wall(150, 200, 0);
        expect(a.wallSegments.length).toBe(b.wallSegments.length);
    });
});
