import { describe, expect, it } from "vitest";
import { CLOUDS_PER_BAND, cloudInstance, cloudSpriteCount, cloudSpriteInfo } from "../src/cloudSprites.ts";
import { climberSilhouetteReport, drawnClimberPoints, rasterClimber, STUDY_POSES } from "../src/pixelClimber.ts";
import { ROCK_PATCHES, rockPatchPixels } from "../src/rockPatches.ts";
import { applyRockShade, quantizeEdgeColumn, rockEdgeShade, rockIndexAt, rockPixelForCamera, rockWorldPixel, screenToWorld, worldEdgeColumn, worldPitons, worldToScreen } from "../src/rockTexture.ts";
import { Wall } from "../src/Wall.ts";
import { wrapTextureCoord } from "../src/pixelDraw.ts";
import { clientToLogical, computeChromeLayout, computePixelViewport, uniformBlockMismatch } from "../src/pixelViewport.ts";
import { bowDeltaFromLean, combinedLean, leanFromPointer } from "../src/touchInput.ts";
import { clampZoomTarget, freePinchPair, pixelZoom, wheelZoomDirection, zoomFromPinch, zoomFromWheel } from "../src/zoom.ts";

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
        [844, 390, 3],
        [768, 1024, 2],
        [1024, 768, 2],
        [1280, 800, 1],
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

    it("picks a whole-pixel frame for phone, tablet, desktop, and narrow windows", () => {
        expect(computePixelViewport(844, 390, 3)).toMatchObject({ scale: 3, logicalWidth: 844, logicalHeight: 390, offsetX: 0, offsetY: 0 });
        expect(computePixelViewport(768, 1024, 2)).toMatchObject({ scale: 5, logicalWidth: 307, logicalHeight: 409 });
        expect(computePixelViewport(1024, 768, 2)).toMatchObject({ scale: 4, logicalWidth: 512, logicalHeight: 384 });
        expect(computePixelViewport(1280, 800, 1)).toMatchObject({ scale: 2, logicalWidth: 640, logicalHeight: 400, offsetX: 0, offsetY: 0 });
        expect(computePixelViewport(1920, 1080, 1)).toMatchObject({ scale: 3, logicalWidth: 640, logicalHeight: 360 });
        expect(computePixelViewport(320, 568, 2)).toMatchObject({ scale: 3, logicalWidth: 213, logicalHeight: 378 });
    });
});

describe("computeChromeLayout", () => {
    it("keeps the pad on short and narrow screens and hides it on a wide desktop", () => {
        const phone = computeChromeLayout(390, 844);
        expect(phone).toMatchObject({ showTouchHud: true, padHeight: 96, controlSize: 36, captions: true });
        expect(phone.actionWidth).toBeCloseTo(390 * 0.18, 5);
        expect(computeChromeLayout(844, 390)).toMatchObject({ showTouchHud: true, padHeight: 64, actionWidth: 96, controlSize: 36, captions: false });
        expect(computeChromeLayout(768, 1024)).toMatchObject({ showTouchHud: true, controlSize: 44, captions: true });
        expect(computeChromeLayout(1024, 768)).toMatchObject({ showTouchHud: true, padHeight: 96, controlSize: 44, captions: true });
        expect(computeChromeLayout(1280, 800)).toMatchObject({ showTouchHud: false, controlSize: 44, captions: true });
        expect(computeChromeLayout(1920, 1080)).toMatchObject({ showTouchHud: false, controlSize: 44 });
        const narrow = computeChromeLayout(320, 568);
        expect(narrow).toMatchObject({ showTouchHud: true, actionWidth: 64, controlSize: 36, captions: true });
        expect(narrow.padHeight).toBeLessThanOrEqual(96);
        expect(narrow.padHeight).toBeGreaterThanOrEqual(48);
    });
});

describe("uniformBlockMismatch", () => {
    function solid(scale: number, logicalWidth: number, logicalHeight: number, offsetX: number, offsetY: number): { pixels: Uint8ClampedArray; width: number; height: number } {
        const width = offsetX + logicalWidth * scale + 2;
        const height = offsetY + logicalHeight * scale + 1;
        const pixels = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < logicalHeight; y++) {
            for (let x = 0; x < logicalWidth; x++) {
                const r = (x * 13) & 255;
                const g = (y * 17) & 255;
                for (let dy = 0; dy < scale; dy++) {
                    for (let dx = 0; dx < scale; dx++) {
                        const i = ((offsetY + y * scale + dy) * width + (offsetX + x * scale + dx)) * 4;
                        pixels[i] = r;
                        pixels[i + 1] = g;
                        pixels[i + 2] = 40;
                        pixels[i + 3] = 255;
                    }
                }
            }
        }
        return { pixels, width, height };
    }

    it("accepts a nearest-neighbour scale and flags a single broken pixel", () => {
        for (const scale of [1, 2, 3, 6]) {
            const frame = solid(scale, 5, 4, scale === 1 ? 0 : 1, 0);
            expect(uniformBlockMismatch(frame.pixels, frame.width, frame.height, scale, scale === 1 ? 0 : 1, 0, 5, 4)).toBeNull();
        }
        const frame = solid(4, 3, 3, 2, 2);
        frame.pixels[((2 + 4) * frame.width + (2 + 5)) * 4 + 1] = 9;
        expect(uniformBlockMismatch(frame.pixels, frame.width, frame.height, 4, 2, 2, 3, 3)).toEqual({ x: 7, y: 6 });
        frame.pixels[0] = 255;
        expect(uniformBlockMismatch(frame.pixels, frame.width, frame.height, 4, 2, 2, 3, 3)).toEqual({ x: 7, y: 6 });
    });
});

describe("quantizeEdgeColumn", () => {
    it("stays on the collision sample's pixel, dithering only between floor and ceil", () => {
        const wall = new Wall(150, 200, 12345);
        const seen = new Set<number>();
        let samples = 0;
        for (let row = 0; row < 500; row++) {
            const wallX = wall.wallXAtY(row);
            if (wallX === undefined) {
                continue;
            }
            samples += 1;
            const column = quantizeEdgeColumn(wallX, row);
            expect(Math.abs(column - wallX)).toBeLessThanOrEqual(1);
            expect(column === Math.floor(wallX) || column === Math.ceil(wallX)).toBe(true);
            seen.add(quantizeEdgeColumn(10.5, row));
        }
        expect(samples).toBeGreaterThan(20);
        expect(seen.has(10)).toBe(true);
        expect(seen.has(11)).toBe(true);
        expect(quantizeEdgeColumn(4, 3)).toBe(4);
        expect(quantizeEdgeColumn(-1.2, 1)).toBeGreaterThanOrEqual(-2);
        expect(quantizeEdgeColumn(-1.2, 1)).toBeLessThanOrEqual(-1);
    });
});

describe("world-locked wall edge", () => {
    it("keeps the same world pixels at whole-pixel and sub-pixel cameras", () => {
        const wall = new Wall(150, 200, 12345);
        const rows: number[] = [];
        for (let y = 0; y < 600; y++) {
            const edge = worldEdgeColumn(wall, y);
            if (edge === undefined) {
                continue;
            }
            const sample = wall.wallXAtY(y + 0.5);
            expect(sample).toBeTypeOf("number");
            expect(Math.abs(edge - sample!)).toBeLessThanOrEqual(1);
            expect(worldEdgeColumn(wall, y + 0.2)).toBe(edge);
            expect(worldEdgeColumn(wall, y + 0.8)).toBe(edge);
            rows.push(y);
        }
        expect(rows.length).toBeGreaterThan(20);

        const probe: Array<[number, number]> = [];
        for (const y of rows) {
            const edge = worldEdgeColumn(wall, y)!;
            for (let dx = -2; dx <= 4; dx++) {
                probe.push([edge + dx, y]);
            }
            if (probe.length > 500) {
                break;
            }
        }
        const baseline = probe.map(([x, y]) => rockWorldPixel(wall, x, y));
        const edges = rows.map((y) => worldEdgeColumn(wall, y));
        const cameras = [
            [0, 0],
            [1, 0],
            [0, 1],
            [-4, 7],
            [12.2, 200.4],
            [12.8, 200.9],
            [13.5, 201.5],
            [80.1, 350.2],
        ];
        const viewWidth = 195;
        const viewHeight = 422;
        for (const [cameraX, cameraY] of cameras) {
            for (let i = 0; i < probe.length; i++) {
                const point = probe[i]!;
                const sx = worldToScreen(point[0], cameraX!, viewWidth);
                const sy = worldToScreen(point[1], cameraY!, viewHeight);
                expect(rockPixelForCamera(wall, cameraX!, cameraY!, viewWidth, viewHeight, sx, sy)).toEqual(baseline[i]);
            }
            expect(rows.map((y) => worldEdgeColumn(wall, y))).toEqual(edges);
            expect(worldToScreen(100, cameraX! + 1, viewWidth)).toBe(worldToScreen(100, cameraX!, viewWidth) - 1);
        }

        const piton = worldPitons(wall)[0];
        expect(piton).toBeDefined();
        const metal = rockWorldPixel(wall, piton!.x, piton!.y);
        expect(metal).toEqual([0xb7, 0xbc, 0xc4, 255]);
        expect(rockPixelForCamera(wall, 3.4, piton!.y + 0.6, viewWidth, viewHeight, worldToScreen(piton!.x, 3.4, viewWidth), worldToScreen(piton!.y, piton!.y + 0.6, viewHeight))).toEqual(metal);
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
        expect(rockIndexAt(-4, -9, 12345)).toBe(rockIndexAt(-4, -9, 12345));
        const colors = new Set<number>();
        let differs = false;
        let moss = 0;
        for (let y = 0; y < 160; y += 3) {
            for (let x = 0; x < 160; x += 3) {
                const a = rockIndexAt(x, y, 12345);
                const b = rockIndexAt(x, y, 99);
                expect(a).toBeGreaterThanOrEqual(0);
                expect(a).toBeLessThanOrEqual(13);
                colors.add(a);
                if (a !== b) {
                    differs = true;
                }
                if (a >= 12) {
                    moss += 1;
                }
            }
        }
        expect(colors.size).toBeGreaterThan(4);
        expect(differs).toBe(true);
        expect(moss).toBeGreaterThan(0);
    });

    it("keeps stone stencils free of moss and the moss stencil mossy", () => {
        for (const patch of ROCK_PATCHES) {
            const index = ROCK_PATCHES.indexOf(patch);
            const pixels = rockPatchPixels(index);
            expect(pixels.length).toBe(patch.width * patch.height);
            if (patch.name === "rock_moss") {
                expect(pixels.some((value) => value >= 12)).toBe(true);
            } else {
                expect(pixels.every((value) => value < 12)).toBe(true);
            }
        }
    });
});

describe("rock edge shade", () => {
    it("darkens faces turned away from the light and dithers the ramp", () => {
        const overhang = rockEdgeShade(0, 1.2, 0, 0);
        const vertical = rockEdgeShade(0, 0, 0, 0);
        const lit = rockEdgeShade(0, -1.2, 0, 0);
        expect(overhang).toBeGreaterThan(vertical);
        expect(vertical).toBeGreaterThan(lit);
        expect(vertical).toBeGreaterThanOrEqual(1);
        expect(overhang).toBeGreaterThan(rockEdgeShade(8, 1.2, 0, 0));
        expect(rockEdgeShade(9, 1.2, 4, 4)).toBe(0);
        expect(rockEdgeShade(0, 1.2, 3, 5)).toBe(rockEdgeShade(0, 1.2, 3, 5));
        const steps = new Set<number>();
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                const shade = rockEdgeShade(0, 0, x, y);
                expect(Number.isInteger(shade)).toBe(true);
                expect(shade).toBeGreaterThanOrEqual(0);
                expect(shade).toBeLessThanOrEqual(4);
                steps.add(shade);
            }
        }
        expect(steps.size).toBeGreaterThan(1);
        expect(applyRockShade(10, 3)).toBe(7);
        expect(applyRockShade(1, 4)).toBe(0);
        expect(applyRockShade(13, 1)).toBe(12);
        expect(applyRockShade(13, 3)).toBe(8);
    });
});

describe("cloud sprites", () => {
    it("repeats a layout from the seed and scales by whole pixels only", () => {
        expect(cloudInstance(12345, 4, 0)).toEqual(cloudInstance(12345, 4, 0));
        const seen = new Set<number>();
        const tiers = new Set<string>();
        let widest = 0;
        for (let band = 0; band < 12; band++) {
            for (let i = 0; i < CLOUDS_PER_BAND; i++) {
                const cloud = cloudInstance(12345, band, i);
                const info = cloudSpriteInfo(cloud.sprite);
                expect(cloud.scale === 1 || cloud.scale === 2).toBe(true);
                expect(cloud.sprite).toBeGreaterThanOrEqual(0);
                expect(cloud.sprite).toBeLessThan(cloudSpriteCount());
                if (info.tier === "large") {
                    expect(cloud.scale).toBe(1);
                    expect(info.width).toBeGreaterThanOrEqual(80);
                    expect(info.parallax).toBeGreaterThan(cloudSpriteInfo(0).parallax);
                }
                tiers.add(info.tier);
                widest = Math.max(widest, info.width);
                seen.add(cloud.drift);
            }
        }
        expect(seen.size).toBeGreaterThan(1);
        expect(tiers.has("large")).toBe(true);
        expect(tiers.has("medium")).toBe(true);
        expect(tiers.has("small")).toBe(true);
        expect(widest).toBeGreaterThanOrEqual(120);
    });
});

describe("zoom", () => {
    it("steps the wheel by 1.2 and clamps the drawn scale to a whole pixel", () => {
        expect(wheelZoomDirection(120, undefined, undefined)).toBe(1);
        expect(wheelZoomDirection(undefined, 2, undefined)).toBe(-1);
        expect(wheelZoomDirection(undefined, undefined, 40)).toBe(-1);
        expect(wheelZoomDirection(undefined, undefined, -40)).toBe(1);
        expect(wheelZoomDirection(0, 0, 0)).toBe(0);

        let target = 1;
        const drawn: number[] = [];
        for (let i = 0; i < 20; i++) {
            target = zoomFromWheel(target, 1);
            drawn.push(pixelZoom(target));
        }
        expect(drawn[0]).toBe(1);
        expect(drawn).toContain(2);
        expect(drawn[drawn.length - 1]).toBe(10);
        expect(pixelZoom(zoomFromWheel(10, 1))).toBe(10);
        expect(zoomFromWheel(1, -1)).toBe(1);
        expect(clampZoomTarget(Number.NaN)).toBe(1);
        expect(pixelZoom(1.2)).toBe(1);
        expect(pixelZoom(1.728)).toBe(2);
    });

    it("pinches on free fingers and leaves a thumb on the controls alone", () => {
        expect(zoomFromPinch(2, 100, 150)).toBeCloseTo(3, 5);
        expect(zoomFromPinch(2, 100, 10)).toBe(1);
        expect(zoomFromPinch(8, 40, 80)).toBe(10);
        expect(zoomFromPinch(4, 0, 80)).toBe(4);
        expect(pixelZoom(zoomFromPinch(1, 100, 180))).toBe(2);

        const pad = { x: 40, y: 800, onControl: true };
        const button = { x: 300, y: 800, onControl: true };
        const skyA = { x: 80, y: 200, onControl: false };
        const skyB = { x: 180, y: 260, onControl: false };
        expect(freePinchPair([pad, button])).toBeNull();
        expect(freePinchPair([pad, skyA])).toBeNull();
        expect(freePinchPair([skyA, skyB])?.[0]).toEqual(skyA);
        expect(freePinchPair([pad, skyA, skyB])?.[1]).toEqual(skyB);
    });

    it("keeps world pixels identical at every integer zoom", () => {
        const wall = new Wall(150, 200, 12345);
        let y = 0;
        let edge = 0;
        for (let row = 0; row < 600; row++) {
            const column = worldEdgeColumn(wall, row);
            if (column !== undefined) {
                y = row;
                edge = column;
                break;
            }
        }
        const color = rockWorldPixel(wall, edge, y);
        expect(color).not.toBeNull();
        for (const zoom of [1, 2, 3, 10]) {
            const sx = worldToScreen(edge, 20.4, 195, zoom);
            const sy = worldToScreen(y, 30.6, 422, zoom);
            expect(screenToWorld(sx, 20.4, 195, zoom)).toBe(edge);
            expect(screenToWorld(sy, 30.6, 422, zoom)).toBe(y);
            for (let step = 0; step < zoom; step++) {
                expect(screenToWorld(sx + step, 20.4, 195, zoom)).toBe(edge);
                expect(rockPixelForCamera(wall, 20.4, 30.6, 195, 422, sx + step, sy, zoom)).toEqual(color);
            }
            expect(screenToWorld(sx + zoom, 20.4, 195, zoom)).toBe(edge + 1);
            expect(worldToScreen(edge, 21.4, 195, zoom)).toBe(sx - zoom);
        }
    });
});

describe("climber silhouette", () => {
    it("stays one piece, with no holes, across extreme poses", () => {
        for (const pose of STUDY_POSES) {
            const report = climberSilhouetteReport(rasterClimber(pose));
            expect(report.body).toBeGreaterThan(40);
            expect(report.body).toBeLessThan(900);
            expect(report.components).toBe(1);
            expect(report.holes).toBe(0);
        }
    });

    it("keeps a bent knee, a boot, an elbow, and a glove without stretching past 15%", () => {
        const gap = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
        const offLine = (point: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number => {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            return Math.abs(dx * (a.y - point.y) - dy * (a.x - point.x)) / len;
        };
        for (const pose of STUDY_POSES) {
            const drawn = drawnClimberPoints(pose);
            const raster = rasterClimber(pose);
            expect(gap(drawn.pelvis, pose.pelvis)).toBeLessThanOrEqual(4.05);
            expect(gap(drawn.neck, drawn.pelvis)).toBeGreaterThan(9);
            expect(gap(drawn.neck, drawn.pelvis)).toBeLessThan(13);
            let boots = 0;
            let gloves = 0;
            let knees = 0;
            for (const value of raster.indices) {
                if (value === 9 || value === 10) {
                    boots += 1;
                }
                if (value === 18 || value === 19) {
                    gloves += 1;
                }
                if (value === 20) {
                    knees += 1;
                }
            }
            expect(boots).toBeGreaterThan(8);
            expect(gloves).toBeGreaterThan(4);
            expect(knees).toBeGreaterThan(2);
            for (let side = 0; side < 2; side++) {
                const thigh = gap(drawn.buttocks, drawn.knees[side]!);
                const shin = gap(drawn.knees[side]!, drawn.feet[side]!);
                const upper = gap(drawn.neck, drawn.elbows[side]!);
                const fore = gap(drawn.elbows[side]!, drawn.hands[side]!);
                expect(thigh).toBeGreaterThan(6);
                expect(thigh).toBeLessThanOrEqual(8 * 1.15 + 0.35);
                expect(shin).toBeGreaterThan(6);
                expect(shin).toBeLessThanOrEqual(8 * 1.15 + 0.35);
                expect(upper).toBeGreaterThan(5);
                expect(upper).toBeLessThanOrEqual(7 * 1.15 + 0.35);
                expect(fore).toBeGreaterThan(4);
                expect(fore).toBeLessThanOrEqual(6 * 1.15 + 0.35);
                expect(offLine(drawn.knees[side]!, drawn.buttocks, drawn.feet[side]!)).toBeGreaterThan(1.5);
                expect(offLine(drawn.elbows[side]!, drawn.neck, drawn.hands[side]!)).toBeGreaterThan(1.5);
            }
        }
    });
});
