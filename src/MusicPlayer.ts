import { requiredElement, setTextOfElement } from "./dom.ts";

export type SongTrack = readonly [filename: string, title: string, artist: string];
export type SoundEffectDefinition = readonly [filename: string];

interface SoundEffect {
    readonly src: string;
    readonly players: HTMLAudioElement[];
    index: number;
}

export class MusicPlayer {
    public readonly default_volume = 0.6;
    public readonly songs: readonly SongTrack[];
    public readonly sound_dir = "/sounds/";
    public readonly music_dir = "/music/";
    public inited = false;
    public song_volume = this.default_volume;
    public current_song = 0;
    public song_audio: HTMLAudioElement | undefined;
    public muted = false;

    private readonly sounds: Record<string, SoundEffect> = {};

    public constructor(songArray: readonly SongTrack[], sfxDict: Record<string, SoundEffectDefinition>) {
        this.songs = songArray;
        for (const [name, definition] of Object.entries(sfxDict)) {
            const src = definition[0];
            this.sounds[name] = {
                src,
                players: [],
                index: 0,
            };
        }
    }

    public init(): void {
        this.load_song();
        this.inited = true;

        for (const sound of Object.values(this.sounds)) {
            sound.players.push(
                new Audio(this.sound_dir + sound.src),
                new Audio(this.sound_dir + sound.src),
                new Audio(this.sound_dir + sound.src),
                new Audio(this.sound_dir + sound.src),
                new Audio(this.sound_dir + sound.src),
            );
        }
    }

    public load_song(): void {
        const song = this.songs[this.current_song];
        if (song === undefined) {
            return;
        }

        if (this.song_audio) {
            this.song_audio.pause();
        }

        this.song_audio = new Audio(this.music_dir + song[0]);
        this.song_audio.volume = this.default_volume;
        this.song_audio.addEventListener("ended", () => {
            this.next_song();
        });

        const infobox = document.getElementById("songinfo");
        const titlebox = document.getElementById("songtitle");
        const artistbox = document.getElementById("songartist");
        if (infobox && titlebox && artistbox) {
            setTextOfElement(titlebox, song[1]);
            setTextOfElement(artistbox, song[2]);
            infobox.className = "featured";
            window.setTimeout(() => {
                const songInfo = document.getElementById("songinfo");
                if (songInfo) {
                    songInfo.className = "idle";
                }
            }, 2000);
        }
    }

    public next_song(): void {
        this.current_song = (this.current_song + 1) % this.songs.length;
        this.load_song();
        this.play_song();
    }

    public play_song(): void {
        if (this.song_audio && !this.muted) {
            void this.song_audio.play();
        }
    }

    public pause_song(): void {
        if (this.song_audio && !this.muted) {
            this.song_audio.pause();
        }
    }

    public play_pause_song(): void {
        if (!this.song_audio) {
            return;
        }
    }

    public lower_volume(): void {
        this.song_volume = 0.2;
    }

    public raise_volume(): void {
        this.song_volume = 0.6;
    }

    public mute(): void {
        const muteButton = requiredElement("mute");
        const muteLabel = muteButton.children[0];
        if (muteLabel === undefined) {
            throw new Error("Mute button is missing its label");
        }

        if (!this.muted) {
            this.song_audio?.pause();
            this.muted = true;
            muteButton.className = "muted";
            setTextOfElement(muteLabel, "Unmute sounds [M]");
            return;
        }

        void this.song_audio?.play();
        this.muted = false;
        muteButton.className = "";
        setTextOfElement(muteLabel, "Mute sounds [M]");
    }

    public play_sound(name: string): void {
        if (this.muted) {
            return;
        }

        const sound = this.sounds[name];
        if (sound === undefined) {
            return;
        }

        const player = sound.players[sound.index];
        if (player === undefined) {
            return;
        }

        void player.play();
        sound.index = (sound.index + 1) % sound.players.length;
    }

    public update(): void {
        if (this.song_audio === undefined) {
            return;
        }
        if (this.song_audio.volume !== this.song_volume) {
            this.song_audio.volume += (this.song_volume - this.song_audio.volume) * 0.1;
        }
    }
}
