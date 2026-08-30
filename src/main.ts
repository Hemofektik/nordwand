import { Game } from "./Game.ts";

document.oncontextmenu = (): boolean => false;

function main(): void {
    const canvas = document.getElementById("canvas");
    if (!(canvas instanceof HTMLCanvasElement) || canvas.getContext("2d") === null) {
        return;
    }

    canvas.width = 560;
    canvas.height = 840;

    const game = new Game(canvas);
    game.load_level();

    const animloop = (): void => {
        game.update();
        window.requestAnimationFrame(animloop);
    };
    animloop();
}

window.addEventListener("load", main);
