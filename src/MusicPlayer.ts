import { setTextOfElement, requiredElement } from "./dom.ts";

// Music tracks (filename, song name, artist)
export type SongTrack = [filename: string, title: string, artist: string];
// Sound effects (identifier, filename)
export type SoundEffectEntry = [filename: string];

export class MusicPlayer {
    // Constants
    public readonly default_volume = 0.6;

    // Variables
    public songs: SongTrack[];
    public sounds: Record<string, SoundEffectEntry>;
    public sound_dir = "sounds/";
    public music_dir = "music/";
    public inited = false;
    public song_volume = this.default_volume;

    // State variables
    public current_song = 0;
    public song_audio: HTMLAudioElement | undefined;
    public muted = false;

    private readonly soundPlayers: Record<string, { players: HTMLAudioElement[]; index: number }> = {};

    public constructor(songArray: SongTrack[], sfxDict: Record<string, SoundEffectEntry>) {
        this.songs = songArray;
        this.sounds = sfxDict;
    }

    // Methods
    public init(): void {
        this.load_song();
        this.inited = true;

        for (const name in this.sounds) {
            const src = this.sounds[name]![0];
            this.soundPlayers[name] = {
                players: [
                    new Audio(this.sound_dir + src),
                    new Audio(this.sound_dir + src),
                    new Audio(this.sound_dir + src),
                    new Audio(this.sound_dir + src),
                    new Audio(this.sound_dir + src),
                ],
                index: 0,
            };
        }
    }

    // Load the current song into song_audio
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

        // Display metadata
        const infobox = document.getElementById("songinfo");
        const titlebox = document.getElementById("songtitle");
        const artistbox = document.getElementById("songartist");
        if (infobox && titlebox && artistbox) {
            setTextOfElement(titlebox, song[1]);
            setTextOfElement(artistbox, song[2]);
            infobox.className = "featured";
            window.setTimeout(() => {
                const box = document.getElementById("songinfo");
                if (box) {
                    box.className = "idle";
                }
            }, 2000);
        }
    }

    // Load and play the next song in the list
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

    // Play or pause the currently selected song
    public play_pause_song(): void {
        if (this.song_audio) {
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
        const muteLabel = muteButton.children[0]!;
        if (!this.muted) {
            // Mute
            this.song_audio?.pause();
            this.muted = true;
            muteButton.className = "muted";
            setTextOfElement(muteLabel, "Unmute sounds [M]");
        } else {
            // Unmute
            void this.song_audio?.play();
            this.muted = false;
            muteButton.className = "";
            setTextOfElement(muteLabel, "Mute sounds [M]");
        }
    }

    // Play the sound effect with the given name
    public play_sound(name: string): void {
        if (!this.muted) {
            const sound = this.soundPlayers[name];
            if (sound) {
                sound.players[sound.index]!.play(); // Play current round-robin Audio object for this sound
                sound.index = (sound.index + 1) % sound.players.length; // Increment round-robin counter
            }
        }
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
