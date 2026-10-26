import { Game } from "./Game.ts";
import { EGameState } from "./Core.ts";

document.oncontextmenu = (): boolean => false;

function main(): void {
    const canvas = document.getElementById("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
        return;
    }
    if (canvas.getContext === undefined) {
        return;
    }

    // The on-screen canvas is sized in device pixels by Game, then the
    // picture is blitted up by an integer scale. Don't pin it to CSS pixels.
    const game = new Game(canvas);
    game.loadLevel(EGameState.Menu | EGameState.Game | EGameState.Climbing, 12345);

    // Animate!
    const animloop = (): void => {
        game.update();
        window.requestAnimationFrame(animloop);
    };
    animloop();
}

window.addEventListener("load", main);
