import { EGameState } from "./Core.ts";

export class Exhaustion {
    public gameState: number;

    public time = 0.0;
    public exhaustionTime = 0.0;

    public exhaustion = 0.0;
    public respiration = 0.0;

    public lastInvalidMoveTime = -1000.0;
    public lastValidMoveTime = -1000.0;
    public lastValidMoveWasPerfect = false;

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

    public draw(ctx: CanvasRenderingContext2D, _cam: import("./Camera.ts").Camera): void {
        if ((this.gameState & EGameState.Game) === 0) {
            return;
        }

        const posX = ctx.canvas.width * 0.65;
        const posY = ctx.canvas.height * 0.5;

        const outerRadius = 20.0;
        const exhaustionRadius = (this.respiration * 0.1 + 1.15) * outerRadius;

        // outer expiration circle
        ctx.fillStyle = "#000000";
        ctx.beginPath();
        ctx.arc(posX, posY, exhaustionRadius * 2.0, 20, 1);
        ctx.closePath();
        ctx.fill();

        // main background circle
        ctx.beginPath();
        ctx.fillStyle = "#CCCCCC";
        ctx.arc(posX, posY, outerRadius * 2, 20, 1);
        ctx.closePath();
        ctx.fill();

        // small center circle
        ctx.fillStyle = "#000000";
        ctx.beginPath();
        ctx.arc(posX, posY, exhaustionRadius * 0.1, 20, 1);
        ctx.closePath();
        ctx.fill();

        // valid move circle
        ctx.strokeStyle = "#EEEEEE";
        ctx.lineWidth = outerRadius * 0.75;
        ctx.beginPath();
        ctx.arc(posX, posY, outerRadius, 20, 1);
        ctx.closePath();
        ctx.stroke();

        // perfect move circle
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = outerRadius * 0.25;
        ctx.beginPath();
        ctx.arc(posX, posY, outerRadius, 20, 1);
        ctx.closePath();
        ctx.stroke();

        // green valid move circle
        const validMoveAnimTime = 1.0;
        const lastValidMoveAnimTime = this.lastValidMoveTime - this.time + validMoveAnimTime;
        if (lastValidMoveAnimTime > 0.0) {
            ctx.globalAlpha = lastValidMoveAnimTime;

            if (this.lastValidMoveWasPerfect) {
                if (Math.round(lastValidMoveAnimTime * 10.0) % 2 === 0) {
                    ctx.globalAlpha = 0.0;
                }
            }

            ctx.strokeStyle = "#20FF20";
            ctx.lineWidth = outerRadius * 0.75;
            ctx.beginPath();
            ctx.arc(posX, posY, outerRadius, 20, 1);
            ctx.closePath();
            ctx.stroke();
            ctx.globalAlpha = 1.0;
        }

        // red invalid move circle
        const lastInvalidMoveAnimTime = this.lastInvalidMoveTime - this.time + validMoveAnimTime;
        if (lastInvalidMoveAnimTime > 0.0) {
            ctx.globalAlpha = lastInvalidMoveAnimTime;

            if (Math.round(lastInvalidMoveAnimTime * 10.0) % 2 === 0) {
                ctx.globalAlpha = 0.0;
            }

            ctx.strokeStyle = "#FF2020";
            ctx.lineWidth = outerRadius * 0.75;
            ctx.beginPath();
            ctx.arc(posX, posY, outerRadius, 20, 1);
            ctx.closePath();
            ctx.stroke();
            ctx.globalAlpha = 1.0;
        }

        // respiration circle
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 2.5 * (this.respiration + 1.0);
        ctx.beginPath();
        ctx.arc(posX, posY, outerRadius * (this.respiration + 1.0), 20, 1);
        ctx.closePath();
        ctx.stroke();
    }
}
