import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SAMPLED_CLOUDS, sampledCloudMask } from "../src/sampledClouds.ts";
import { ROCK_PATCHES, rockPatchPixels } from "../src/rockPatches.ts";

interface DecodedPng {
    width: number;
    height: number;
    indices: Uint8Array;
    palette: Array<[number, number, number]>;
}

function readIndexedPng(path: string): DecodedPng {
    const data = readFileSync(path);
    let pos = 8;
    let width = 0;
    let height = 0;
    let colorType = 0;
    const idat: Uint8Array[] = [];
    const palette: Array<[number, number, number]> = [];
    while (pos + 8 <= data.length) {
        const length = (data[pos]! << 24) | (data[pos + 1]! << 16) | (data[pos + 2]! << 8) | data[pos + 3]!;
        const type = String.fromCharCode(data[pos + 4]!, data[pos + 5]!, data[pos + 6]!, data[pos + 7]!);
        const start = pos + 8;
        const chunk = data.subarray(start, start + length);
        if (type === "IHDR") {
            width = (chunk[0]! << 24) | (chunk[1]! << 16) | (chunk[2]! << 8) | chunk[3]!;
            height = (chunk[4]! << 24) | (chunk[5]! << 16) | (chunk[6]! << 8) | chunk[7]!;
            colorType = chunk[9]!;
        } else if (type === "PLTE") {
            for (let i = 0; i < chunk.length; i += 3) {
                palette.push([chunk[i]!, chunk[i + 1]!, chunk[i + 2]!]);
            }
        } else if (type === "IDAT") {
            idat.push(chunk);
        } else if (type === "IEND") {
            break;
        }
        pos = start + length + 4;
    }
    expect(colorType).toBe(3);
    const packed = new Uint8Array(idat.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of idat) {
        packed.set(chunk, offset);
        offset += chunk.length;
    }
    const raw = inflateSync(packed);
    const indices = new Uint8Array(width * height);
    let cursor = 0;
    let prev = new Uint8Array(width);
    for (let y = 0; y < height; y++) {
        const filter = raw[cursor]!;
        cursor += 1;
        const row = raw.subarray(cursor, cursor + width);
        cursor += width;
        const out = new Uint8Array(width);
        if (filter === 0) {
            out.set(row);
        } else if (filter === 1) {
            for (let x = 0; x < width; x++) {
                out[x] = (row[x]! + (x > 0 ? out[x - 1]! : 0)) & 255;
            }
        } else if (filter === 2) {
            for (let x = 0; x < width; x++) {
                out[x] = (row[x]! + prev[x]!) & 255;
            }
        } else if (filter === 4) {
            for (let x = 0; x < width; x++) {
                const a = x > 0 ? out[x - 1]! : 0;
                const b = prev[x]!;
                const c = x > 0 ? prev[x - 1]! : 0;
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                out[x] = (row[x]! + pr) & 255;
            }
        } else {
            throw new Error(`unexpected png filter ${filter}`);
        }
        indices.set(out, y * width);
        prev = out;
    }
    return { width, height, indices, palette };
}

const ROCK_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
    [0x20, 0x1f, 0x1a],
    [0x26, 0x25, 0x1e],
    [0x2e, 0x2c, 0x25],
    [0x30, 0x2e, 0x26],
    [0x3a, 0x37, 0x2e],
    [0x3c, 0x3a, 0x30],
    [0x3f, 0x3d, 0x32],
    [0x45, 0x42, 0x36],
    [0x48, 0x45, 0x39],
    [0x4f, 0x4c, 0x3e],
    [0x56, 0x52, 0x44],
    [0x63, 0x5f, 0x4e],
    [0x5a, 0x75, 0x2e],
    [0x7a, 0xa2, 0x3a],
];

describe("sampled sprite pngs", () => {
    it("matches the embedded rock stencils and stays on the palette", () => {
        for (let i = 0; i < ROCK_PATCHES.length; i++) {
            const patch = ROCK_PATCHES[i]!;
            const png = readIndexedPng(`public/sprites/rock/${patch.name}.png`);
            expect(png.width).toBe(patch.width);
            expect(png.height).toBe(patch.height);
            expect(png.palette).toEqual(ROCK_PALETTE);
            const pixels = rockPatchPixels(i);
            expect(Array.from(png.indices)).toEqual(Array.from(pixels));
        }
    });

    it("matches the embedded cloud masks", () => {
        expect(SAMPLED_CLOUDS.length).toBeGreaterThanOrEqual(4);
        for (let i = 0; i < SAMPLED_CLOUDS.length; i++) {
            const cloud = SAMPLED_CLOUDS[i]!;
            const png = readIndexedPng(`public/sprites/clouds/${cloud.name}.png`);
            expect(png.width).toBe(cloud.width);
            expect(png.height).toBe(cloud.height);
            expect(png.palette[1]).toEqual([255, 255, 255]);
            expect(png.palette[2]).toEqual([0xe5, 0xea, 0xef]);
            const mask = sampledCloudMask(i);
            expect(Array.from(png.indices)).toEqual(Array.from(mask));
            if (cloud.tier === "large") {
                expect(cloud.width).toBeGreaterThanOrEqual(80);
            }
        }
    });
});
