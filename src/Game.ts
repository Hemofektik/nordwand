import { Camera } from "./Camera.ts";
import { MusicPlayer } from "./MusicPlayer.ts";
import { SpringPhysics } from "./Physics.ts";
import { PixelSprite } from "./PixelSprite.ts";
import { Player } from "./Player.ts";
import { Wall } from "./Wall.ts";
import { requiredElement, setTextOfElement } from "./dom.ts";

const MOUSE_BUTTON_LEFT = 0;
const MOUSE_BUTTON_RIGHT = 2;

interface MouseLikeEvent {
    preventDefault(): void;
    layerX?: number;
    layerY?: number;
    offsetX?: number;
    offsetY?: number;
    button?: number;
    _x?: number;
    _y?: number;
}

interface WheelLikeEvent {
    wheelDelta?: number;
    detail?: number;
}

export class Game {
    public readonly transfer_rate_k = 0.25;
    public bg_temp: PixelSprite | undefined;
    public phys: SpringPhysics | undefined;
    public wall: Wall | undefined;
    public player: Player | undefined;
    public keys: boolean[] = [];
    public canvas: HTMLCanvasElement;
    public ctx: CanvasRenderingContext2D;
    public cam: Camera;
    public _lastTick = Date.now();
    public frameSpacing = 0;
    public frame_delta = 0;
    public frame_delta_smoothed = 0;
    public bg_color = "#BAD4ED";
    public level_width = 800;
    public level_height = 800;
    public level_radius = 500;
    public won = false;
    public paused = false;
    public has_started = false;
    public debug = false;
    public shadows = true;
    public debugInfo: HTMLElement;
    public music: MusicPlayer;

    public constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const ctx = canvas.getContext("2d");
        if (ctx === null) {
            throw new Error("Canvas 2D context is not available");
        }
        this.ctx = ctx;
        this.cam = new Camera(canvas);
        this.debugInfo = requiredElement("debuginfo");
        this.music = new MusicPlayer(
            [["duncan beattie - sevenhundredbeats.mp3", "sevenhundredbeats", "duncan beattie"]],
            {
                blip: ["blip.ogg"],
                win: ["win.ogg"],
                death: ["death.ogg"],
                bounce: ["bounce.ogg"],
                bark: ["4910__NoiseCollector__barkdouble.wav"],
                m4a1: ["89006__metamorphmuses__hack.wav"],
            },
        );
        this.init();
    }

    public init(): void {
        this.canvas.addEventListener("mousemove", (ev) => {
            this.mouse_move(ev);
        });
        this.canvas.addEventListener("mousedown", (ev) => {
            this.mouse_down(ev);
        });
        this.canvas.addEventListener("mouseup", (ev) => {
            this.mouse_up(ev);
        });
        this.canvas.addEventListener("touchstart", (ev) => {
            this.touch_start(ev);
        });

        document.addEventListener("wheel", (ev) => {
            this.mouse_scroll(ev);
        });
        window.addEventListener("keydown", (ev) => {
            this.key_down(ev);
        });
        window.addEventListener("keyup", (ev) => {
            this.key_up(ev);
        });
        window.addEventListener("blur", () => {
            this.pause(true);
        });

        requiredElement("mute").addEventListener("click", () => {
            this.music.mute();
        });
        requiredElement("newlevel").addEventListener("click", () => {
            this.load_level();
        });
        requiredElement("pause").addEventListener("click", () => {
            this.pause();
        });
        requiredElement("help").addEventListener("click", () => {
            this.toggle_help();
        });
        requiredElement("pausedmessage").addEventListener("click", () => {
            this.pause();
        });
        requiredElement("deathmessage").addEventListener("click", () => {
            this.load_level();
        });
        requiredElement("warningmessage").addEventListener("click", () => {
            this.load_level();
        });
        requiredElement("successmessage").addEventListener("click", () => {
            this.load_level();
        });

        this.music.init();
    }

    public toggle_help(): void {
        const overlay = document.getElementById("helpoverlay");
        if (overlay) {
            if (overlay.style.display === "none") {
                this.pause(true);
                overlay.style.display = "block";
            } else {
                overlay.style.display = "none";
            }
        }

        if (!this.has_started) {
            this.music.play_song();
            this.has_started = true;
        }
    }

    public pause(forcepause = false): void {
        if (this.paused && !forcepause) {
            this.clear_msgs();
            this.paused = false;
            this.music.raise_volume();
            return;
        }

        this.show_message("pausedmessage");
        this.paused = true;
        this.music.lower_volume();
    }

    public load_level(): void {
        this.bg_temp = new PixelSprite("/sprites/bg_temp.png");

        const posX = 150;
        const posY = 200;

        this.phys = new SpringPhysics();
        this.wall = new Wall(posX, posY);
        this.phys.wall = this.wall;
        this.player = new Player(this.phys, this.wall, posX, posY);
        this.phys.settle();
        this.snapCameraToPlayer();

        this.won = false;
        this.clear_msgs();
        this.level_radius = 500;

        this.keys = [];
        for (let k = 0; k < 255; k++) {
            this.keys.push(false);
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
        if (this.paused) {
            return;
        }
        this.cam.viewport_to_world_x(x);
        this.cam.viewport_to_world_y(y);
    }

    public touch_start(ev: TouchEvent): void {
        ev.preventDefault();
        const touch = ev.touches[0];
        if (touch === undefined) {
            return;
        }
        this.click_at_point(touch.pageX, touch.pageY);
    }

    public mouse_move(ev: MouseEvent): void {
        ev.preventDefault();
        const point = this.readMousePoint(ev);
        point._x = this.cam.viewport_to_world_x(point._x);
        point._y = this.cam.viewport_to_world_y(point._y);
    }

    public mouse_down(ev: MouseEvent): void {
        ev.preventDefault();
        const point = this.readMousePoint(ev);
        if (ev.button === MOUSE_BUTTON_LEFT) {
            this.click_at_point(point._x, point._y);
        } else if (ev.button === MOUSE_BUTTON_RIGHT) {
            return;
        }
    }

    public mouse_up(ev: MouseEvent): void {
        ev.preventDefault();
        this.readMousePoint(ev);
        if (ev.button === MOUSE_BUTTON_RIGHT) {
            return;
        }
    }

    public mouse_scroll(event: Event): void {
        const wheelEvent = event as WheelEvent & WheelLikeEvent;
        let delta = 0;

        if (wheelEvent.wheelDelta) {
            delta = wheelEvent.wheelDelta / 60;
        } else if (wheelEvent.detail) {
            delta = -wheelEvent.detail / 2;
        } else if (wheelEvent.deltaY) {
            delta = -wheelEvent.deltaY;
        }

        if (delta === 0) {
            return;
        }

        delta = delta / Math.abs(delta);
        if (delta > 0) {
            this.cam.scale_target *= 1.2;
        }
        if (delta < 0) {
            this.cam.scale_target /= 1.2;
        }
    }

    public key_up(e: KeyboardEvent): void {
        this.keys[e.which || e.keyCode] = false;
    }

    public key_down(e: KeyboardEvent): void {
        const code = e.which || e.keyCode;
        this.keys[code] = true;

        switch (code) {
            case 80:
                this.pause();
                break;
            case 82:
                this.load_level();
                break;
            case 68:
                this.debug = !this.debug;
                break;
            case 70:
                this.letGo();
                break;
            case 72:
                this.toggle_help();
                break;
            case 83:
                this.resetPhysics();
                break;
            case 77:
                this.music.mute();
                break;
            case 78:
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

        if (!forceclear) {
            if (this.won) {
                this.show_message("successmessage");
            } else if (this.player?.isDead) {
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
        if (this.won) {
            return;
        }
        this.won = true;
        this.music.play_sound("win");
        this.show_message("successmessage");
    }

    public update(): void {
        const currentTick = Date.now();
        this.frameSpacing = currentTick - this._lastTick;
        this.frame_delta = this.frameSpacing * 0.001;
        this._lastTick = currentTick;

        this.frame_delta = Math.min(0.1, this.frame_delta);
        this.frame_delta_smoothed = this.frame_delta_smoothed * 0.7 + this.frame_delta * 0.3;
        this.frame_delta = this.frame_delta_smoothed;

        this.ctx.fillStyle = this.bg_color;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.beginPath();
        this.ctx.rect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.closePath();
        this.ctx.fill();

        if (!this.paused && this.wall && this.phys && this.player) {
            this.extendWallAhead();
            this.wall.update(this.frame_delta);
            this.phys.update(this.frame_delta);
            this.player.update(this.frame_delta);
        }

        this.followPlayerWithCamera();

        this.wall?.draw(this.ctx, this.cam);
        this.player?.draw(this.ctx, this.cam);
        this.music.update();

        const debugInfo = "FPS: " + (1.0 / this.frame_delta_smoothed).toFixed(2);
        setTextOfElement(this.debugInfo, debugInfo);
    }

    private playerPelvis(): { posX: number; posY: number } | undefined {
        const player = this.player;
        if (player === undefined) {
            return undefined;
        }
        return player.skeleton.phys.particleStates[player.skeleton.pelvisParticleIndex];
    }

    private snapCameraToPlayer(): void {
        const pelvis = this.playerPelvis();
        if (pelvis === undefined) {
            return;
        }
        this.cam.x = pelvis.posX;
        this.cam.y = pelvis.posY;
        this.cam.x_target = pelvis.posX;
        this.cam.y_target = pelvis.posY;
    }

    private followPlayerWithCamera(): void {
        const pelvis = this.playerPelvis();
        if (pelvis === undefined) {
            return;
        }
        this.cam.update(pelvis.posX, pelvis.posY, this.frame_delta);
    }

    private extendWallAhead(): void {
        const wall = this.wall;
        const pelvis = this.playerPelvis();
        if (wall === undefined || pelvis === undefined) {
            return;
        }

        const viewTop = this.cam.viewport_to_world_y(0);
        wall.ensureGeneratedTo(Math.min(pelvis.posY, viewTop) - 600);
    }

    private readMousePoint(ev: MouseEvent): { _x: number; _y: number } {
        const mouseEvent = ev as MouseLikeEvent;
        let x = 0;
        let y = 0;
        if (mouseEvent.layerX || mouseEvent.layerX === 0) {
            x = mouseEvent.layerX;
            y = mouseEvent.layerY ?? 0;
        } else if (mouseEvent.offsetX || mouseEvent.offsetX === 0) {
            x = mouseEvent.offsetX;
            y = mouseEvent.offsetY ?? 0;
        }
        return { _x: x, _y: y };
    }
}

export class Point {
    public x: number;
    public y: number;

    public constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
    }
}
