import type { Camera } from "./Camera.ts";
import { Climber } from "./Climber.ts";
import type { SpringPhysics } from "./Physics.ts";
import { Rope } from "./Rope.ts";
import { Skeleton } from "./Skeleton.ts";
import type { Wall } from "./Wall.ts";

export class Player {
    public rope: Rope;
    public skeleton: Skeleton;
    public climber: Climber;
    public isDead = false;
    private readonly phys: SpringPhysics;

    public constructor(phys: SpringPhysics, wall: Wall, posX: number, posY: number) {
        this.phys = phys;
        this.skeleton = new Skeleton(phys, wall, posX, posY);
        this.rope = new Rope(phys, wall, this.skeleton, posX, posY);
        this.climber = new Climber(phys, wall, this.skeleton);
    }

    public update(deltaTime: number): void {
        // The Climber's IK, grab sampling and angle animation were tuned and
        // TDD'd at a fixed 1/120 timestep. With one big per-frame call the
        // limbs overshoot their targets, grabs are missed and the climb
        // deadlocks within a few steps. Substep the whole simulation so the
        // Climber always runs at its validated timestep regardless of frame
        // rate.
        let remaining = Math.min(deltaTime, 0.1);
        while (remaining > 0) {
            const sub = Math.min(remaining, 1 / 120);
            this.rope.update(sub);
            this.phys.update(sub);
            this.skeleton.update(sub);
            this.climber.update(sub);
            remaining -= sub;
        }
    }

    public draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
        this.rope.draw(ctx, cam);
        this.skeleton.draw(ctx, cam);
        this.climber.draw(ctx, cam);
    }

    public letGo(): void {
        this.skeleton.letGo();
        this.climber.stopClimbing();
    }
}
