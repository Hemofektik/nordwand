import type { Camera } from "./Camera.ts";

export function wrapTextureCoord(world: number, size: number): number {
    if (!(size > 0)) {
        return 0;
    }
    const i = Math.floor(world) % size;
    return i < 0 ? i + size : i;
}

export function snapScreen(cam: Camera, x: number, y: number): { x: number; y: number } {
    const s = cam.pixelScale;
    return {
        x: Math.round(cam.world_to_viewport_x_pixel(x) / s) * s,
        y: Math.round(cam.world_to_viewport_y_pixel(y) / s) * s,
    };
}

/** Filled disc of whole pixels. `radius` is rounded, so the edge never anti-aliases. */
export function fillDisc(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, color: string): void {
    const r = Math.round(radius);
    if (r < 0) {
        return;
    }
    const x = Math.round(cx);
    const y = Math.round(cy);
    ctx.fillStyle = color;
    if (r === 0) {
        ctx.fillRect(x, y, 1, 1);
        return;
    }
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
        const dx = Math.floor(Math.sqrt(r2 - dy * dy));
        ctx.fillRect(x - dx, y + dy, dx * 2 + 1, 1);
    }
}

/** Ring of whole pixels with radii in the same pixel space as `fillDisc`. */
export function fillRing(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    innerRadius: number,
    outerRadius: number,
    color: string,
): void {
    const outer = Math.round(outerRadius);
    const inner = Math.round(innerRadius);
    if (outer < 0 || outer < inner) {
        return;
    }
    const x = Math.round(cx);
    const y = Math.round(cy);
    ctx.fillStyle = color;
    if (outer === 0) {
        ctx.fillRect(x, y, 1, 1);
        return;
    }
    const outer2 = outer * outer;
    const inner2 = inner > 0 ? (inner - 1) * (inner - 1) : -1;
    for (let dy = -outer; dy <= outer; dy++) {
        const span = Math.floor(Math.sqrt(outer2 - dy * dy));
        let runStart = -1;
        for (let dx = -span; dx <= span; dx++) {
            const on = dx * dx + dy * dy > inner2;
            if (on && runStart < 0) {
                runStart = dx;
            } else if (!on && runStart >= 0) {
                ctx.fillRect(x + runStart, y + dy, dx - runStart, 1);
                runStart = -1;
            }
        }
        if (runStart >= 0) {
            ctx.fillRect(x + runStart, y + dy, span - runStart + 1, 1);
        }
    }
}

interface PlotPoint {
    x: number;
    y: number;
}

function pixelLinePoints(x0: number, y0: number, x1: number, y1: number, step: number): PlotPoint[] {
    const points: PlotPoint[] = [];
    const s = Math.max(1, step);
    const dxUnits = Math.round(Math.abs(x1 - x0) / s);
    const dyUnits = Math.round(Math.abs(y1 - y0) / s);
    const sx = x0 < x1 ? s : -s;
    const sy = y0 < y1 ? s : -s;
    let err = dxUnits - dyUnits;
    let x = x0;
    let y = y0;
    const guard = dxUnits + dyUnits + 1;
    for (let n = 0; n < guard; n++) {
        points.push({ x, y });
        if (x === x1 && y === y1) {
            break;
        }
        const e2 = 2 * err;
        if (e2 > -dyUnits) {
            err -= dyUnits;
            x += sx;
        }
        if (e2 < dxUnits) {
            err += dxUnits;
            y += sy;
        }
    }
    return points;
}

/** Bresenham line of `thickness` logical pixels, with a 1-pixel light outline so it reads on the rock. */
export function strokeOutlined(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    fill: string,
    outline: string,
    thickness: number,
): void {
    const s = cam.pixelScale;
    const a = snapScreen(cam, x0, y0);
    const b = snapScreen(cam, x1, y1);
    const points = pixelLinePoints(a.x, a.y, b.x, b.y, s);
    const t = Math.max(1, thickness);
    ctx.fillStyle = outline;
    for (const p of points) {
        ctx.fillRect(p.x - s, p.y - s, s * (t + 2), s * (t + 2));
    }
    ctx.fillStyle = fill;
    for (const p of points) {
        ctx.fillRect(p.x, p.y, s * t, s * t);
    }
}
