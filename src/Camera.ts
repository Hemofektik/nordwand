export class Camera {
    public readonly scale_smoothness = 10.0;
    public readonly move_smoothness = 1.25;

    public canvas: HTMLCanvasElement;
    public x = 0;
    public y = 0;
    public x_target = 0;
    public y_target = 0;
    public scale = 2;
    public scale_target = 2;
    public pixelScale = 2;

    public constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
    }

    public world_to_viewport(n: number, dimension: "x" | "y"): number {
        const canvas_side_length = dimension === "x" ? this.canvas.width : this.canvas.height;
        const offset = dimension === "x" ? this.x : this.y;
        return n * this.scale + canvas_side_length / 2 - offset * this.scale;
    }

    public world_to_viewport_x(x: number): number {
        return this.world_to_viewport(x, "x");
    }

    public world_to_viewport_y(y: number): number {
        return this.world_to_viewport(y, "y");
    }

    public world_to_viewport_x_pixel(x: number): number {
        return x * this.pixelScale + this.canvas.width / 2 - this.x * this.pixelScale;
    }

    public world_to_viewport_y_pixel(y: number): number {
        return y * this.pixelScale + this.canvas.height / 2 - this.y * this.pixelScale;
    }

    public viewport_to_world(n: number, dimension: "x" | "y"): number {
        const canvas_side_length = dimension === "x" ? this.canvas.width : this.canvas.height;
        const offset = dimension === "x" ? this.x : this.y;
        return (n + offset * this.scale - canvas_side_length / 2) / this.scale;
    }

    public viewport_to_world_x(x: number): number {
        return this.viewport_to_world(x, "x");
    }

    public viewport_to_world_y(y: number): number {
        return this.viewport_to_world(y, "y");
    }

    public update(target_x: number, target_y: number, frame_delta: number): void {
        this.x_target = target_x;
        this.y_target = target_y;

        const minScale = 1.0;
        const maxScale = 10.0;

        if (this.scale_target < minScale) {
            this.scale_target = minScale;
        }

        if (this.scale_target > maxScale) {
            this.scale_target = maxScale;
        }

        if (this.scale !== this.scale_target) {
            this.scale = Math.abs(
                this.scale + Math.max(1.0, frame_delta * this.scale_smoothness) * (this.scale_target - this.scale),
            );
        }

        if (this.scale < minScale) {
            this.scale = minScale;
        }

        if (this.scale > maxScale) {
            this.scale = maxScale;
        }

        this.pixelScale = Math.round(this.scale);

        if (this.x !== this.x_target) {
            this.x += frame_delta * (this.x_target - this.x) * this.move_smoothness;
        }

        if (this.y !== this.y_target) {
            this.y += frame_delta * (this.y_target - this.y) * this.move_smoothness;
        }
    }
}
