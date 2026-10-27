import { describe, expect, it } from "vitest";
import { cloudInstance } from "../src/cloudSprites.ts";
import { climberSilhouetteReport, rasterClimber, STUDY_POSES } from "../src/pixelClimber.ts";
import { rockIndexAt } from "../src/rockTexture.ts";
import { Wall } from "../src/Wall.ts";
import { wrapTextureCoord } from "../src/pixelDraw.ts";
import { clientToLogical, computePixelViewport } from "../src/pixelViewport.ts";
import { bowDeltaFromLean, combinedLean, leanFromPointer } from "../src/touchInput.ts";

describe("computePixelViewport", () => {
    const samples: Array<[number, number, number]> = [
        [390, 844, 3],
        [390, 844, 2],
        [1440, 900, 1],
        [1920, 1080, 1],
        [360, 640, 1],
        [375, 667, 2],
        [800, 600, 1],
        [320, 568, 2],
    ];

    it("scales by a whole number of device pixels and stays near the concept frame", () => {
        for (const [cssWidth, cssHeight, dpr] of samples) {
            const view = computePixelViewport(cssWidth, cssHeight, dpr);
            expect(view.scale).toBeGreaterThanOrEqual(1);
            expect(Number.isInteger(view.scale)).toBe(true);
            expect(view.logicalWidth * view.scale).toBeLessThanOrEqual(view.deviceWidth);
            expect(view.logicalHeight * view.scale).toBeLessThanOrEqual(view.deviceHeight);
            expect(view.offsetX).toBeGreaterThanOrEqual(0);
            expect(view.offsetY).toBeGreaterThanOrEqual(0);
            expect(view.logicalWidth).toBeGreaterThan(0);
            expect(view.logicalHeight).toBeGreaterThan(0);
            expect(view.logicalHeight).toBeLessThanOrEqual(500);
            expect(view.deviceWidth).toBe(Math.round(cssWidth * dpr));
            expect(view.deviceHeight).toBe(Math.round(cssHeight * dpr));
        }
    });

    it("gives a 390×844 phone at 3× the concept height", () => {
        const view = computePixelViewport(390, 844, 3);
        expect(view.scale).toBe(6);
        expect(view.logicalWidth).toBe(195);
        expect(view.logicalHeight).toBe(422);
        expect(view.offsetX).toBe(0);
        expect(view.offsetY).toBe(0);
    });

    it("letterboxes nothing on a 1440×900 desktop and keeps pixels at 2×", () => {
        const view = computePixelViewport(1440, 900, 1);
        expect(view.scale).toBe(2);
        expect(view.logicalWidth).toBe(720);
        expect(view.logicalHeight).toBe(450);
    });
});

describe("clientToLogical", () => {
    it("converts a CSS point through device pixels into the logical frame", () => {
        const layout = computePixelViewport(100, 200, 2);
        expect(layout.scale).toBeGreaterThanOrEqual(1);
        const point = clientToLogical(50, 100, { left: 0, top: 0, width: 100, height: 200 }, layout);
        const deviceX = (50 / 100) * layout.deviceWidth;
        const deviceY = (100 / 200) * layout.deviceHeight;
        expect(point.x).toBeCloseTo((deviceX - layout.offsetX) / layout.scale, 5);
        expect(point.y).toBeCloseTo((deviceY - layout.offsetY) / layout.scale, 5);
    });
});

describe("lean pad", () => {
    it("dead-zones the middle and reaches a full lean at the edge", () => {
        expect(leanFromPointer(50, 0, 100).lean).toBe(0);
        expect(leanFromPointer(100, 0, 100).lean).toBeCloseTo(1, 5);
        expect(leanFromPointer(0, 0, 100).lean).toBeCloseTo(-1, 5);
        expect(leanFromPointer(55, 0, 100).lean).toBe(0);
    });

    it("bows the same direction as the A and D keys", () => {
        const step = 0.5;
        const strength = 2;
        expect(bowDeltaFromLean(combinedLean(0, true, false), strength, step)).toBeGreaterThan(0);
        expect(bowDeltaFromLean(combinedLean(0, false, true), strength, step)).toBeLessThan(0);
        expect(bowDeltaFromLean(1, strength, step)).toBe(-strength * step);
        expect(bowDeltaFromLean(-1, strength, step)).toBe(strength * step);
        expect(bowDeltaFromLean(0, strength, step)).toBe(0);
    });

    it("does not stack the pad and a key past a full lean", () => {
        expect(combinedLean(0.8, false, true)).toBe(1);
        expect(combinedLean(-0.4, true, false)).toBe(-1);
        expect(combinedLean(0, true, true)).toBe(0);
    });
});

describe("wrapTextureCoord", () => {
    it("wraps negative world coordinates into the tile", () => {
        expect(wrapTextureCoord(0, 128)).toBe(0);
        expect(wrapTextureCoord(128, 128)).toBe(0);
        expect(wrapTextureCoord(129.9, 128)).toBe(1);
        expect(wrapTextureCoord(-0.2, 128)).toBe(127);
        expect(wrapTextureCoord(-1.2, 128)).toBe(126);
    });
});

describe("seeded wall", () => {
    it("keeps seed 12345 on the same rock", () => {
        const wall = new Wall(150, 200, 12345);
        const first = wall.wallSegments[0]!;
        const anchor = wall.wallAnchors[10]!;
        expect({
            segments: wall.wallSegments.length,
            anchors: wall.wallAnchors.length,
            firstX: first.posX,
            firstY: first.posY,
            anchorX: anchor.posX,
            anchorY: anchor.posY,
        }).toMatchInlineSnapshot(`
          {
            "anchorX": 157.00819414708178,
            "anchorY": 418.98715824520235,
            "anchors": 91,
            "firstX": 178.08643299427098,
            "firstY": 463.7518103742723,
            "segments": 12,
          }
        `);
    });
});

describe("rock composite", () => {
    it("is deterministic, varied, and follows the wall seed", () => {
        expect(rockIndexAt(12, 40, 12345)).toBe(rockIndexAt(12, 40, 12345));
        const colors = new Set<number>();
        let differs = false;
        for (let i = 0; i < 48; i++) {
            const a = rockIndexAt(i * 3, i * 7, 12345);
            const b = rockIndexAt(i * 3, i * 7, 99);
            colors.add(a);
            if (a !== b) {
                differs = true;
            }
        }
        expect(colors.size).toBeGreaterThan(4);
        expect(differs).toBe(true);
    });
});

describe("cloud sprites", () => {
    it("repeats a layout from the seed and scales by whole pixels only", () => {
        expect(cloudInstance(12345, 4, 0)).toEqual(cloudInstance(12345, 4, 0));
        const seen = new Set<number>();
        for (let i = 0; i < 6; i++) {
            const cloud = cloudInstance(12345, 2, i);
            expect(cloud.scale === 1 || cloud.scale === 2).toBe(true);
            expect(cloud.sprite).toBeGreaterThanOrEqual(0);
            expect(cloud.sprite).toBeLessThan(6);
            seen.add(cloud.drift);
        }
        expect(seen.size).toBeGreaterThan(1);
    });
});

describe("climber silhouette", () => {
    it("stays one piece, with no holes, across extreme poses", () => {
        for (const pose of STUDY_POSES) {
            const report = climberSilhouetteReport(rasterClimber(pose));
            expect(report.body).toBeGreaterThan(40);
            expect(report.components).toBe(1);
            expect(report.holes).toBe(0);
        }
    });
});
