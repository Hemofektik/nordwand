import type { Camera } from "./Camera.ts";
import { ClimbingAI } from "./ClimbingAI.ts";
import { EGameState } from "./Core.ts";
import { Exhaustion } from "./Exhaustion.ts";
import type { SpringPhysics } from "./Physics.ts";
import { Rope } from "./Rope.ts";
import { Skeleton } from "./Skeleton.ts";
import type { Wall } from "./Wall.ts";

export class Player {
    public posX = 0;
    public posY = 0;

    public rope: Rope = undefined as unknown as Rope;
    public skeleton: Skeleton = undefined as unknown as Skeleton;
    public ai: ClimbingAI | undefined;
    public exhaustion: Exhaustion = undefined as unknown as Exhaustion;

    public gameState: number = EGameState.None;

    public constructor(phys: SpringPhysics, wall: Wall, posX: number, posY: number, gameState: number) {
        this.initialize(phys, wall, posX, posY, gameState);
    }

    public update(time: number, deltaTime: number): void {
        this.rope.update(deltaTime);
        this.skeleton.update(deltaTime);
        this.ai?.update(deltaTime);
        this.exhaustion.update(time, deltaTime);

        const pelvis = this.skeleton.phys.particleStates[this.skeleton.pelvisParticleIndex]!;
        this.posX = pelvis.posX;
        this.posY = pelvis.posY;
    }

    public draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
        this.rope.draw(ctx, cam);
        this.skeleton.draw(ctx, cam);
        this.ai?.draw(ctx, cam);
        this.exhaustion.draw(ctx, cam);
    }

    public addBowOffset(offset: number): void {
        this.skeleton.addBowOffset(offset);
    }

    public letGo(): void {
        this.skeleton.letGo();
        this.rope.bindEndToSkeleton();
    }

    public tryClimb(): void {
        if ((this.gameState & EGameState.Game) === 0) {
            return;
        }

        const moveStrength = this.exhaustion.tryMove();
        if (moveStrength > 0.0) {
            this.ai?.applyStrength(moveStrength);
        }
    }

    public get IsDead(): boolean {
        return false;
    }

    private initialize(phys: SpringPhysics, wall: Wall, posX: number, posY: number, gameState: number): void {
        this.skeleton = new Skeleton(phys, wall, posX, posY);
        this.rope = new Rope(phys, wall, this.skeleton, posX, posY);
        if (gameState & EGameState.Climbing) {
            this.ai = new ClimbingAI(this.rope, wall, this.skeleton, gameState);
        }
        this.exhaustion = new Exhaustion(gameState);
        this.gameState = gameState;
    }
}
