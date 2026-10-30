import { clampZoomTarget, pixelZoom } from "./zoom.ts";

export class Camera {
    // Constants
    public readonly scale_smoothness = 10.0;
    public readonly move_smoothness = 10.0;

    // Variables
    public canvas: HTMLCanvasElement;
    public posX = 0;
    public posY = 0;
    public posXTarget = 0;
    public posYTarget = 0;
    /**
     * Logical pixels per world unit. `scale_target` keeps the fractional wheel
     * and pinch value; `pixelScale` is the integer step that is actually drawn.
     */
    public scale = 1;
    public scale_target = 1;
    public pixelScale = 1;

    public constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
    }

    /** Drawing samples the world on whole pixels. The eased position stays fractional. */
    public drawX(): number {
        return Math.round(this.posX);
    }

    public drawY(): number {
        return Math.round(this.posY);
    }

    public world_to_viewport_x_pixel(x: number): number {
        return (x * this.pixelScale) + (this.canvas.width / 2) - (this.drawX() * this.pixelScale);
    }

    public world_to_viewport_y_pixel(y: number): number {
        return (y * this.pixelScale) + (this.canvas.height / 2) - (this.drawY() * this.pixelScale);
    }

    public viewport_to_world_x_pixel(x: number): number {
        return (x + (this.drawX() * this.pixelScale) - (this.canvas.width / 2)) / this.pixelScale;
    }

    public viewport_to_world_y_pixel(y: number): number {
        return (y + (this.drawY() * this.pixelScale) - (this.canvas.height / 2)) / this.pixelScale;
    }

    public update(target_x: number, target_y: number, deltaTime: number): void {
        this.posXTarget = target_x;
        this.posYTarget = target_y;

        this.scale_target = clampZoomTarget(this.scale_target);
        this.pixelScale = pixelZoom(this.scale_target);
        this.scale = this.pixelScale;

        if (this.posX !== this.posXTarget) {
            this.posX += deltaTime * (this.posXTarget - this.posX) * this.move_smoothness;
        }

        if (this.posY !== this.posYTarget) {
            this.posY += deltaTime * (this.posYTarget - this.posY) * this.move_smoothness;
        }
    }
}
