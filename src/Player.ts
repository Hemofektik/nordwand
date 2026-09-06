import type { Camera } from "./Camera.ts";
import { ClimbingAI } from "./ClimbingAI.ts";
import type { SpringPhysics } from "./Physics.ts";
import { Rope } from "./Rope.ts";
import { Skeleton } from "./Skeleton.ts";
import type { Wall } from "./Wall.ts";

export class Player {
    public rope: Rope;
    public skeleton: Skeleton;
    public climbingAI: ClimbingAI;
    public isDead = false;
    private readonly phys: SpringPhysics;

    public constructor(phys: SpringPhysics, wall: Wall, posX: number, posY: number) {
        this.phys = phys;
        this.skeleton = new Skeleton(phys, wall, posX, posY);
        this.rope = new Rope(phys, wall, this.skeleton, posX, posY);
        this.climbingAI = new ClimbingAI(this.rope, wall, this.skeleton);
    }

    public update(deltaTime: number): void {
        // The climbing AI's IK, grab sampling and velocity nudges were tuned
        // and TDD'd at a fixed 1/120 timestep. With one big per-frame call the
        // limbs overshoot their targets, grabs are missed and the climb
        // deadlocks within a few steps (relaxed targeting then finds nothing
        // in reach). Substep the whole simulation so the AI always runs at its
        // validated timestep regardless of frame rate.
        let remaining = Math.min(deltaTime, 0.1);
        while (remaining > 0) {
            const sub = Math.min(remaining, 1 / 120);
            this.rope.update(sub);
            this.phys.update(sub);
            this.skeleton.update(sub);
            this.climbingAI.update(sub);
            remaining -= sub;
        }
    }

    public draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
        this.rope.draw(ctx, cam);
        this.skeleton.draw(ctx, cam);
        this.climbingAI.draw(ctx, cam);
    }

    public letGo(): void {
        this.skeleton.letGo();
        this.climbingAI.stopClimbing();
    }
}
