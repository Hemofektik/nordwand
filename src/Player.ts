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

    public constructor(phys: SpringPhysics, wall: Wall, posX: number, posY: number) {
        this.skeleton = new Skeleton(phys, wall, posX, posY);
        this.rope = new Rope(phys, wall, this.skeleton, posX, posY);
        this.climbingAI = new ClimbingAI(this.rope, wall, this.skeleton);
    }

    public update(deltaTime: number): void {
        this.rope.update(deltaTime);
        this.skeleton.update(deltaTime);
        this.climbingAI.update(deltaTime);
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
