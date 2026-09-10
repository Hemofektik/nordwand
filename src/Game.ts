import { Camera } from "./Camera.ts";
import { EGameState } from "./Core.ts";
import { MusicPlayer } from "./MusicPlayer.ts";
import { SpringPhysics } from "./Physics.ts";
import { PixelSprite } from "./PixelSprite.ts";
import { Player } from "./Player.ts";
import { Wall } from "./Wall.ts";
import { requiredElement, setTextOfElement } from "./dom.ts";

const MOUSE_BUTTON_LEFT = 0;
const MOUSE_BUTTON_RIGHT = 2;

export class Game {
    public static readonly KEY_W = 87;
    public static readonly KEY_A = 65;
    public static readonly KEY_S = 83;
    public static readonly KEY_D = 68;

    public static readonly KEY_Up = 38;
    public static readonly KEY_Left = 37;
    public static readonly KEY_Down = 40;
    public static readonly KEY_Right = 39;

    // Constants
    public readonly transfer_rate_k = 0.25;

    // Variables and setup
    public gameState: number = EGameState.None;
    public climbingStartHeight = 0.0;
    public climbingMaxEndHeight = 0.0;
    public bg_temp: PixelSprite | undefined;
    public phys: SpringPhysics | undefined;
    public wall: Wall | undefined;
    public player: Player | undefined;
    public currentKeys: boolean[] = [];
    public lastKeys: boolean[] = [];
    public canvas: HTMLCanvasElement;
    public ctx: CanvasRenderingContext2D;
    public cam: Camera;
    public gameTime: number = (new Date()).getTime() * 0.001;
    public frame_delta: number | undefined;
    public frame_delta_smoothed = 0;
    public loadingScreenCloseTimeStamp = -1;
    public bg_color = "#BAD4ED"; // Background color of the level (inside the boundaries)
    public won = false; // Indicates if the player has won (and is now just basking in his own glory)
    public paused = false;
    public has_started = false; // Indicates if the intro menu has been dismissed at least once
    public debug = false;
    public shadows = true;
    public debugInfo: HTMLElement | null = null;
    public altimeter_data: HTMLElement | null = null;
    public music: MusicPlayer;

    public constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const ctx = this.canvas.getContext("2d");
        if (ctx === null) {
            throw new Error("Canvas 2D context is not available");
        }
        this.ctx = ctx;
        this.cam = new Camera(canvas);
        this.music = new MusicPlayer(
            [ // Music tracks (filename, song name, artist)
                ["duncan beattie - sevenhundredbeats.mp3", "sevenhundredbeats", "duncan beattie"],
            ],
            { // Sound effects (identifier, filename)
                blip: ["blip.ogg"],
                win: ["win.ogg"],
                death: ["death.ogg"],
                bounce: ["bounce.ogg"],
                bark: ["4910__NoiseCollector__barkdouble.wav"],
                m4a1: ["89006__metamorphmuses__hack.wav"],
            },
        );

        // Methods
        this.init();
    }

    public init(): void {
        const style = this.canvas.style as CSSStyleDeclaration & { msTouchAction?: string };
        if (typeof style.msTouchAction !== "undefined") {
            style.msTouchAction = "none"; // prevent canvas from being moved by touch gestures
        }

        // Event registration
        this.canvas.addEventListener("mousemove", (ev) => this.mouse_move(ev), false);
        this.canvas.addEventListener("mousedown", (ev) => this.mouse_down(ev), false);
        this.canvas.addEventListener("mouseup", (ev) => this.mouse_up(ev), false);
        this.canvas.addEventListener("touchstart", (ev) => this.touch_start(ev), false);
        {
            document.addEventListener("DOMMouseScroll", (ev) => this.mouse_scroll(ev), false);
            document.addEventListener("mousewheel", (ev) => this.mouse_scroll(ev), false);
            window.addEventListener("keydown", (ev) => this.key_down(ev), false);
            window.addEventListener("keyup", (ev) => this.key_up(ev), false);
            window.addEventListener("blur", () => this.pause(true), false);

            requiredElement("mute").addEventListener("click", () => this.music.mute(), false);
            requiredElement("pause").addEventListener("click", () => this.pause(), false);
            requiredElement("help").addEventListener("click", () => this.toggle_help(), false);
            requiredElement("pausedmessage").addEventListener("click", () => this.pause(), false);

            this.debugInfo = document.getElementById("debuginfo");
            this.altimeter_data = document.getElementById("altimeter_data");

            //document.getElementById("playbutton").addEventListener('click', function() {game.toggle_help();}, false);
        }

        this.music.init();
    }

    public toggle_help(): void {
        const overlay = document.getElementById("helpoverlay");

        // If overlay is hidden
        if (overlay !== null && overlay.style.display === "none") {
            this.pause(true); // Pause the game
            overlay.style.display = "block"; // Show overlay
        } else if (overlay !== null) {
            overlay.style.display = "none"; // Hide overlay
        }

        // If we're just now starting the game
        if (!this.has_started) {
            //this.LoadLevel();
            this.music.play_song();
            this.has_started = true;
        }
    }

    public pause(forcepause = false): void {
        if (this.paused && !forcepause) {
            // Unpause
            this.clear_msgs();
            this.paused = false;
            this.music.raise_volume();
        } else {
            // Pause
            this.show_message("pausedmessage");
            this.paused = true;
            this.music.lower_volume();
        }
    }

    public loadLevel(gameState: number, wallSeed: number): void {
        this.bg_temp = new PixelSprite("sprites/bg_temp.png");

        const posX = 150;
        const posY = 200;

        this.climbingStartHeight = 0.0;
        this.climbingMaxEndHeight = 0.0;

        this.gameState = gameState;

        this.loadingScreenCloseTimeStamp = -1;

        this.phys = new SpringPhysics();
        this.wall = new Wall(posX, posY, wallSeed);
        this.phys.wall = this.wall;
        this.player = new Player(this.phys, this.wall, posX, posY, this.gameState);

        this.won = false;
        this.clear_msgs();

        this.currentKeys = [];
        this.lastKeys = [];
        for (let k = 0; k < 255; k++) {
            this.currentKeys.push(false);
            this.lastKeys.push(false);
        }
    }

    public resetPhysics(): void {
        if (this.phys === undefined) {
            return;
        }
        for (const state of this.phys.particleStates) {
            state.velX = 0;
            state.velY = 0;
        }
    }

    public letGo(): void {
        this.player?.letGo();
    }

    public click_at_point(x: number, y: number): void {
        if (!this.paused) {
            // Convert view coordinates (clicked) to world coordinates
            x = this.cam.viewport_to_world_x_pixel(x);
            y = this.cam.viewport_to_world_y_pixel(y);

            this.player?.tryClimb();
        }
    }

    public touch_start(ev: TouchEvent): void {
        ev.preventDefault(); // Prevent dragging
        const touch = ev.touches[0]; // Just pay attention to first touch
        if (touch === undefined) {
            return;
        }

        this.click_at_point(touch.pageX, touch.pageY);
    }

    public mouse_move(ev: MouseEvent): void {
        ev.preventDefault();
        const point = this.readMousePoint(ev);
        const worldX = this.cam.viewport_to_world_x_pixel(point.x);
        const worldY = this.cam.viewport_to_world_y_pixel(point.y);
        void worldX;
        void worldY;
        //game.SetAimTarget(ev._x, ev._y);
    }

    public mouse_down(ev: MouseEvent): void {
        ev.preventDefault();
        const point = this.readMousePoint(ev);
        if (ev.button === MOUSE_BUTTON_LEFT) {
            this.click_at_point(point.x, point.y);
        } else if (ev.button === MOUSE_BUTTON_RIGHT) {
            //game.player.state = CREATURE_STATE_AIMING;
        }
    }

    public mouse_up(ev: MouseEvent): void {
        ev.preventDefault();
        this.readMousePoint(ev);
        if (ev.button === MOUSE_BUTTON_RIGHT) {
            //game.player.state = CREATURE_STATE_NORMAL;
        }
    }

    public mouse_scroll(event: Event): void {
        let delta = 0;

        const wheelEvent = event as WheelEvent & { wheelDelta?: number; detail?: number };

        // normalize the delta
        if (wheelEvent.wheelDelta) {
            // IE and Opera
            delta = wheelEvent.wheelDelta / 60;
        } else if (wheelEvent.detail) {
            // W3C
            delta = -wheelEvent.detail / 2;
        } else if (wheelEvent.deltaY) {
            delta = -wheelEvent.deltaY;
        }
        delta = delta / Math.abs(delta);

        if (delta !== 0) {
            if (delta > 0) {
                this.cam.scale_target *= 1.2;
            }
            if (delta < 0) {
                this.cam.scale_target /= 1.2;
            }
        }
    }

    public key_up(e: KeyboardEvent): void {
        let code: number;
        if (e.keyCode) code = e.keyCode;
        else code = e.which;

        this.currentKeys[code] = false;
    }

    public key_down(e: KeyboardEvent): void {
        let code: number;
        if (e.keyCode) code = e.keyCode;
        else code = e.which;

        this.currentKeys[code] = true;

        switch (code) {
            case 80: // P
                this.pause();
                break;
            case 82: // R
                this.loadLevel(this.gameState, Math.floor(Math.random() * 0x80000000));
                break;
            case 68: // D
                this.debug = !this.debug;
                break;
            case 70: // F
                this.letGo();
                break;
            case 72: // H
                this.toggle_help();
                break;
            case 83: // S
                this.resetPhysics();
                break;
            case 77: // M
                this.music.mute();
                break;
            case 78: // N
                this.music.next_song();
                break;
            default:
                break;
        }
    }

    public clear_msgs(forceclear = false): void {
        const msgs = document.getElementsByClassName("messages");
        for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i];
            if (msg instanceof HTMLElement) {
                msg.style.display = "none";
            }
        }

        // Re-show important messages that are still relevant
        if (!forceclear) {
            if (this.won) {
                this.show_message("successmessage");
            } else if (this.player && this.player.IsDead) {
                this.show_message("deathmessage");
            }
        }
    }

    public show_message(id: string): void {
        this.clear_msgs(true);
        const div = document.getElementById(id);
        if (div) {
            div.style.display = "block";
        }
    }

    public player_did_die(): void {
        this.music.play_sound("death");
        this.show_message("deathmessage");
    }

    public player_did_win(): void {
        if (!this.won) {
            this.won = true;
            this.music.play_sound("win");
            this.show_message("successmessage");
        }
    }

    public update(): void {
        /*if (!this.has_started)
        {
            this.toggle_help();
        }*/

        // Advance timer
        const newGameTime = (new Date()).getTime() * 0.001; // convert ms to s
        let frameDelta = newGameTime - this.gameTime;
        this.gameTime = newGameTime;

        frameDelta = Math.min(0.1, frameDelta); // minimum 10 Hertz

        this.frame_delta_smoothed = this.frame_delta_smoothed * 0.7 + frameDelta * 0.3;
        this.frame_delta = this.frame_delta_smoothed; // smooth real delta to have smoother movements

        // Canvas maintenance
        if (this.canvas.width !== window.innerWidth || this.canvas.height !== window.innerHeight) {
            this.canvas.width = window.innerWidth;
            this.canvas.height = window.innerHeight;

            // TODO: react on resolution change (adapt pixel zoom, letterboxes, HUD, etc.)
        }

        this.ctx.fillStyle = this.bg_color;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.beginPath();
        this.ctx.rect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.closePath();
        this.ctx.fill();

        this.handleInput(this.frame_delta_smoothed);

        if (this.player !== undefined) {
            this.cam.update(this.player.posX, this.player.posY, this.frame_delta!);
        }

        if (!this.paused) { // update world
            if (this.wall !== undefined) {
                this.wall.update(this.frame_delta!);
            }

            let physicsIsReady = false;
            if (this.phys !== undefined) {
                physicsIsReady = this.phys.update(this.frame_delta!);
            }

            if (physicsIsReady && this.loadingScreenCloseTimeStamp < 0 && this.player !== undefined) {
                this.loadingScreenCloseTimeStamp = this.gameTime;

                const pos = this.player.skeleton.getPosition();
                this.climbingStartHeight = pos.posY;
            }

            this.player?.update(this.gameTime, this.frame_delta!);
        }

        // rendering
        {
            // render World
            this.wall?.draw(this.ctx, this.cam);

            //this.bg_temp.draw(this.ctx, this.cam, 0, 0);
            this.player?.draw(this.ctx, this.cam);
        }

        // Update music player
        this.music.update();

        this.drawWorldBounds();

        this.drawLoadingScreen(this.frame_delta!);

        const debugInfo = "FPS: " + (1.0 / this.frame_delta_smoothed).toFixed(2);
        if (this.debugInfo !== null) {
            setTextOfElement(this.debugInfo, debugInfo);
        }

        const player = this.player;
        if (player !== undefined) {
            const currentClimbingPos = player.skeleton.getPosition();
            this.climbingMaxEndHeight = Math.max(this.climbingMaxEndHeight, (this.climbingStartHeight - currentClimbingPos.posY) * 0.05);

            if (this.altimeter_data !== null) {
                setTextOfElement(this.altimeter_data, this.climbingMaxEndHeight.toFixed(2) + " m");
            }
        }
    }

    private drawWorldBounds(): void {
        // left border
        {
            const leftBorderStart = this.canvas.width * 0.3;
            const leftBorderEnd = leftBorderStart + 30;

            const grd = this.ctx.createLinearGradient(leftBorderStart, 0, leftBorderEnd, 0);
            grd.addColorStop(0, "rgba(0, 0, 0, 1.0)");
            grd.addColorStop(1, "rgba(0, 0, 0, 0.0)");
            this.ctx.fillStyle = grd;

            this.ctx.beginPath();
            this.ctx.rect(0, 0, leftBorderEnd, this.canvas.height);
            this.ctx.closePath();
            this.ctx.fill();
        }

        // right border
        {
            const rightBorderStart = this.canvas.width * 0.7;
            const rightBorderEnd = rightBorderStart + 30;

            const grd = this.ctx.createLinearGradient(rightBorderStart, 0, rightBorderEnd, 0);
            grd.addColorStop(0, "rgba(0, 0, 0, 0.0)");
            grd.addColorStop(1, "rgba(0, 0, 0, 1.0)");
            this.ctx.fillStyle = grd;

            this.ctx.beginPath();
            this.ctx.rect(rightBorderStart, 0, this.canvas.width * 0.5, this.canvas.height);
            this.ctx.closePath();
            this.ctx.fill();
        }
    }

    private drawLoadingScreen(deltaTime: number): void {
        void deltaTime;
        const loadingScreenAlphaStart = 0.5;
        const loadingScreenAlphaFadeSpeed = 5.0;

        if (this.loadingScreenCloseTimeStamp < 0) {
            this.ctx.globalAlpha = loadingScreenAlphaStart;
        } else {
            const timeDelta = this.gameTime - this.loadingScreenCloseTimeStamp;
            this.ctx.globalAlpha = Math.max(0.0, loadingScreenAlphaStart - timeDelta * loadingScreenAlphaFadeSpeed);
        }
        this.ctx.fillStyle = "#000000";
        this.ctx.beginPath();
        this.ctx.rect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.closePath();
        this.ctx.fill();
        this.ctx.globalAlpha = 1.0;
    }

    public handleInput(deltaTime: number): void {
        const bowStrength = 2.0;

        if (
            (this.currentKeys[Game.KEY_W] && !this.lastKeys[Game.KEY_W]) ||
            (this.currentKeys[Game.KEY_Up] && this.lastKeys[Game.KEY_Up])
        ) {
            this.player?.tryClimb();
        }
        /*if (this.currentKeys[Game.KEY_S] || this.currentKeys[Game.KEY_Down]) {
            this.player.entity.velY += playerSpeed;
        }*/
        if (this.currentKeys[Game.KEY_A] || this.currentKeys[Game.KEY_Left]) {
            this.player?.addBowOffset(bowStrength * deltaTime);
        }
        if (this.currentKeys[Game.KEY_D] || this.currentKeys[Game.KEY_Right]) {
            this.player?.addBowOffset(-bowStrength * deltaTime);
        }

        for (let k = 0; k < this.currentKeys.length; k++) {
            this.lastKeys[k] = this.currentKeys[k]!;
        }
    }

    private readMousePoint(ev: MouseEvent): { x: number; y: number } {
        const mouseEvent = ev as MouseEvent & { layerX?: number; layerY?: number; offsetX?: number; offsetY?: number };
        let x = 0;
        let y = 0;
        if (mouseEvent.layerX !== undefined) {
            // Firefox
            x = mouseEvent.layerX;
            y = mouseEvent.layerY ?? 0;
        } else if (mouseEvent.offsetX !== undefined) {
            // Opera
            x = mouseEvent.offsetX;
            y = mouseEvent.offsetY ?? 0;
        }
        return { x, y };
    }
}
