import type { Camera } from "./Camera.ts";
import { EGameState } from "./Core.ts";
import { fillDisc, fillRing } from "./pixelDraw.ts";

export class Exhaustion {
    public gameState: number;

    public time = 0.0;
    public exhaustionTime = 0.0;

    public exhaustion = 0.0;
    public respiration = 0.0;

    public lastInvalidMoveTime = -1000.0;
    public lastValidMoveTime = -1000.0;
    public lastValidMoveWasPerfect = false;

    /** Logical pixels to keep clear at the bottom for the touch controls. */
    public hudInsetBottom = 0;

    public constructor(gameState: number) {
        this.gameState = gameState;
    }

    /// <summary>Returns move strength which is possible at the moment of this call. Call may influence exhaustion.</summary>
    public tryMove(): number {
        const perfectMoveDistance = Math.abs(this.respiration);
        if (perfectMoveDistance < 0.2) {
            this.exhaustion += 0.05;
            this.lastValidMoveTime = this.time;
            this.lastValidMoveWasPerfect = true;
            return 3.0;
        } else if (perfectMoveDistance < 0.6) {
            this.exhaustion += 0.1;
            this.lastValidMoveTime = this.time;
            this.lastValidMoveWasPerfect = false;

            return 2.0;
        } else {
            this.exhaustion += 0.2;
            this.lastInvalidMoveTime = this.time;

            return 0.01;
        }
    }

    public update(time: number, deltaTime: number): void {
        this.time = time;
        this.exhaustionTime += deltaTime * (Math.PI * 1.0 + this.exhaustion);

        // TODO: implement phase based exhaustion acceleration (Je weniger man wartet zwischen dem klettern desto schneller wird die Geschwindigkeit des Kreises)

        this.respiration = Math.sin(this.exhaustionTime);

        this.exhaustion = this.exhaustion * Math.pow(0.8, deltaTime);
    }

    public draw(ctx: CanvasRenderingContext2D, _cam: Camera): void {
        if ((this.gameState & EGameState.Game) === 0) {
            return;
        }

        // The breath ring crosses the white mark when respiration is 0,
        // which is the same moment tryMove() counts as perfect.
        const onPhone = this.hudInsetBottom > 16 || ctx.canvas.width < 500;
        const unit = onPhone ? Math.max(8, Math.round(Math.min(ctx.canvas.width, ctx.canvas.height) / 28)) : 16;
        let posX = onPhone ? ctx.canvas.width - unit * 2 - 8 : Math.round(ctx.canvas.width * 0.72);
        let posY = onPhone ? ctx.canvas.height - this.hudInsetBottom - unit * 2 - 6 : Math.round(ctx.canvas.height * 0.55);
        posX = Math.max(unit * 2 + 2, Math.min(posX, ctx.canvas.width - unit * 2 - 2));
        posY = Math.max(unit * 2 + 2, Math.min(posY, ctx.canvas.height - unit * 2 - 2));

        fillDisc(ctx, posX, posY, unit * 2 + 1, "#000000");
        fillDisc(ctx, posX, posY, unit + 3, "#3a3a3a");
        fillDisc(ctx, posX, posY, unit - 1, "#cccccc");
        fillRing(ctx, posX, posY, unit - 1, unit + 1, "#ffffff");

        const validMoveAnimTime = 1.0;
        const lastValidMoveAnimTime = this.lastValidMoveTime - this.time + validMoveAnimTime;
        if (lastValidMoveAnimTime > 0.0) {
            ctx.globalAlpha = lastValidMoveAnimTime;

            if (this.lastValidMoveWasPerfect) {
                if (Math.round(lastValidMoveAnimTime * 10.0) % 2 === 0) {
                    ctx.globalAlpha = 0.0;
                }
            }

            fillRing(ctx, posX, posY, unit - 2, unit + 2, "#20FF20");
            ctx.globalAlpha = 1.0;
        }

        const lastInvalidMoveAnimTime = this.lastInvalidMoveTime - this.time + validMoveAnimTime;
        if (lastInvalidMoveAnimTime > 0.0) {
            ctx.globalAlpha = lastInvalidMoveAnimTime;

            if (Math.round(lastInvalidMoveAnimTime * 10.0) % 2 === 0) {
                ctx.globalAlpha = 0.0;
            }

            fillRing(ctx, posX, posY, unit - 2, unit + 2, "#FF2020");
            ctx.globalAlpha = 1.0;
        }

        const breathR = unit * (this.respiration + 1.0);
        fillRing(ctx, posX, posY, breathR - 1.25, breathR + 0.75, "#000000");
    }
}
