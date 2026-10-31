import { computePixelViewport, type PixelViewport } from "./pixelViewport.ts";

/**
 * Draws the game into a small logical canvas, then blits it to the screen
 * canvas as an integer block of device pixels with smoothing off.
 */
export class PixelPresenter {
    readonly screen: HTMLCanvasElement;
    readonly logical: HTMLCanvasElement;
    readonly logicalCtx: CanvasRenderingContext2D;
    readonly screenCtx: CanvasRenderingContext2D;
    layout: PixelViewport;

    public constructor(screen: HTMLCanvasElement) {
        this.screen = screen;
        const screenCtx = screen.getContext("2d", { alpha: false });
        if (screenCtx === null) {
            throw new Error("Canvas 2D context is not available");
        }
        this.screenCtx = screenCtx;

        this.logical = document.createElement("canvas");
        const logicalCtx = this.logical.getContext("2d", { alpha: false });
        if (logicalCtx === null) {
            throw new Error("Logical canvas 2D context is not available");
        }
        this.logicalCtx = logicalCtx;
        this.logical.width = 280;
        this.logical.height = 420;
        this.layout = computePixelViewport(280, 420, 1);
    }

    public resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
        const layout = computePixelViewport(cssWidth, cssHeight, devicePixelRatio);
        this.layout = layout;
        if (this.screen.width !== layout.deviceWidth || this.screen.height !== layout.deviceHeight) {
            this.screen.width = layout.deviceWidth;
            this.screen.height = layout.deviceHeight;
        }
        if (this.logical.width !== layout.logicalWidth || this.logical.height !== layout.logicalHeight) {
            this.logical.width = layout.logicalWidth;
            this.logical.height = layout.logicalHeight;
        }
        const root = document.documentElement;
        root.dataset["pixelScale"] = String(layout.scale);
        root.dataset["logical"] = `${layout.logicalWidth}x${layout.logicalHeight}`;
    }

    public prepare(): void {
        this.logicalCtx.imageSmoothingEnabled = false;
    }

    public present(): void {
        const ctx = this.screenCtx;
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, this.screen.width, this.screen.height);
        const { offsetX, offsetY, logicalWidth, logicalHeight, scale } = this.layout;
        ctx.drawImage(this.logical, offsetX, offsetY, logicalWidth * scale, logicalHeight * scale);
    }
}
