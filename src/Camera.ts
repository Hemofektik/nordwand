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
    public scale = 2;
    public scale_target: number;
    public pixelScale: number;

    public constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.scale_target = Math.ceil(canvas.height / 500.0);
        this.pixelScale = this.scale_target;
    }

    public world_to_viewport_x_pixel(x: number): number {
        return (x * this.pixelScale) + (this.canvas.width / 2) - (this.posX * this.pixelScale);
    }

    public world_to_viewport_y_pixel(y: number): number {
        return (y * this.pixelScale) + (this.canvas.height / 2) - (this.posY * this.pixelScale);
    }

    public viewport_to_world_x_pixel(x: number): number {
        return (x + (this.posX * this.pixelScale) - (this.canvas.width / 2)) / this.pixelScale;
    }

    public viewport_to_world_y_pixel(y: number): number {
        return (y + (this.posY * this.pixelScale) - (this.canvas.height / 2)) / this.pixelScale;
    }

    public update(target_x: number, target_y: number, deltaTime: number): void {
        this.posXTarget = target_x;
        this.posYTarget = target_y;

        const minScale = 1.0;
        const maxScale = 10.0;

        if (this.scale_target < minScale) {
            this.scale_target = minScale;
        }

        if (this.scale_target > maxScale) {
            this.scale_target = maxScale;
        }

        // Gently move to target
        if (this.scale !== this.scale_target) {
            this.scale = Math.abs(
                this.scale + Math.max(1.0, deltaTime * this.scale_smoothness) * (Math.round(this.scale_target) - this.scale),
            );
        }

        if (this.scale < minScale) {
            this.scale = minScale;
        }

        if (this.scale > maxScale) {
            this.scale = maxScale;
        }

        this.pixelScale = Math.round(this.scale);

        if (this.posX !== this.posXTarget) {
            this.posX += deltaTime * (this.posXTarget - this.posX) * this.move_smoothness;
        }

        if (this.posY !== this.posYTarget) {
            this.posY += deltaTime * (this.posYTarget - this.posY) * this.move_smoothness;
        }
    }
}
