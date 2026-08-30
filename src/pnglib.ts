function write(buffer: string[], offs: number, ...values: string[]): void {
    for (const value of values) {
        for (let j = 0; j < value.length; j++) {
            buffer[offs++] = value.charAt(j);
        }
    }
}

function byte2(w: number): string {
    return String.fromCharCode((w >> 8) & 255, w & 255);
}

function byte4(w: number): string {
    return String.fromCharCode((w >> 24) & 255, (w >> 16) & 255, (w >> 8) & 255, w & 255);
}

function byte2lsb(w: number): string {
    return String.fromCharCode(w & 255, (w >> 8) & 255);
}

export class PNGlib {
    public readonly width: number;
    public readonly height: number;
    public readonly depth: number;
    public readonly pix_size: number;
    public readonly data_size: number;
    public readonly ihdr_offs: number;
    public readonly ihdr_size: number;
    public readonly plte_offs: number;
    public readonly plte_size: number;
    public readonly trns_offs: number;
    public readonly trns_size: number;
    public readonly idat_offs: number;
    public readonly idat_size: number;
    public readonly iend_offs: number;
    public readonly iend_size: number;
    public readonly buffer_size: number;
    public readonly buffer: string[];
    public readonly palette: Record<number, string> = {};
    public pindex = 0;
    private readonly crc32: number[] = [];

    public constructor(width: number, height: number, depth: number) {
        this.width = width;
        this.height = height;
        this.depth = depth;

        this.pix_size = height * (width + 1);
        this.data_size = 2 + this.pix_size + 5 * Math.floor((0xfffe + this.pix_size) / 0xffff) + 4;

        this.ihdr_offs = 0;
        this.ihdr_size = 4 + 4 + 13 + 4;
        this.plte_offs = this.ihdr_offs + this.ihdr_size;
        this.plte_size = 4 + 4 + 3 * depth + 4;
        this.trns_offs = this.plte_offs + this.plte_size;
        this.trns_size = 4 + 4 + depth + 4;
        this.idat_offs = this.trns_offs + this.trns_size;
        this.idat_size = 4 + 4 + this.data_size + 4;
        this.iend_offs = this.idat_offs + this.idat_size;
        this.iend_size = 4 + 4 + 4;
        this.buffer_size = this.iend_offs + this.iend_size;

        this.buffer = [];
        for (let i = 0; i < this.buffer_size; i++) {
            this.buffer[i] = "\x00";
        }

        write(this.buffer, this.ihdr_offs, byte4(this.ihdr_size - 12), "IHDR", byte4(width), byte4(height), "\x08\x03");
        write(this.buffer, this.plte_offs, byte4(this.plte_size - 12), "PLTE");
        write(this.buffer, this.trns_offs, byte4(this.trns_size - 12), "tRNS");
        write(this.buffer, this.idat_offs, byte4(this.idat_size - 12), "IDAT");
        write(this.buffer, this.iend_offs, byte4(this.iend_size - 12), "IEND");

        let header = ((8 + (7 << 4)) << 8) | (3 << 6);
        header += 31 - (header % 31);
        write(this.buffer, this.idat_offs + 8, byte2(header));

        for (let i = 0; (i << 16) - 1 < this.pix_size; i++) {
            let size: number;
            let bits: string;
            if (i + 0xffff < this.pix_size) {
                size = 0xffff;
                bits = "\x00";
            } else {
                size = this.pix_size - (i << 16) - i;
                bits = "\x01";
            }
            write(this.buffer, this.idat_offs + 8 + 2 + (i << 16) + (i << 2), bits, byte2lsb(size), byte2lsb(~size));
        }

        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) {
                if (c & 1) {
                    c = -306674912 ^ ((c >> 1) & 0x7fffffff);
                } else {
                    c = (c >> 1) & 0x7fffffff;
                }
            }
            this.crc32[i] = c;
        }
    }

    public index(x: number, y: number): number {
        const i = y * (this.width + 1) + x + 1;
        return this.idat_offs + 8 + 2 + 5 * Math.floor(i / 0xffff + 1) + i;
    }

    public color(red: number, green: number, blue: number, alpha = 255): string {
        const resolvedAlpha = alpha >= 0 ? alpha : 255;
        const color = (((((resolvedAlpha << 8) | red) << 8) | green) << 8) | blue;
        const existing = this.palette[color];
        if (existing !== undefined) {
            return existing;
        }

        if (this.pindex === this.depth) {
            return "\x00";
        }

        const ndx = this.plte_offs + 8 + 3 * this.pindex;
        this.buffer[ndx + 0] = String.fromCharCode(red);
        this.buffer[ndx + 1] = String.fromCharCode(green);
        this.buffer[ndx + 2] = String.fromCharCode(blue);
        this.buffer[this.trns_offs + 8 + this.pindex] = String.fromCharCode(resolvedAlpha);

        const paletteIndex = String.fromCharCode(this.pindex++);
        this.palette[color] = paletteIndex;
        return paletteIndex;
    }

    public getBase64(): string {
        const s = this.getDump();
        const ch = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
        let i = 0;
        let r = "";
        const l = s.length;

        do {
            const c1 = s.charCodeAt(i);
            const e1 = c1 >> 2;
            const c2 = s.charCodeAt(i + 1);
            const e2 = ((c1 & 3) << 4) | (c2 >> 4);
            const c3 = s.charCodeAt(i + 2);
            const e3 = l < i + 2 ? 64 : ((c2 & 0xf) << 2) | (c3 >> 6);
            const e4 = l < i + 3 ? 64 : c3 & 0x3f;
            r += ch.charAt(e1) + ch.charAt(e2) + ch.charAt(e3) + ch.charAt(e4);
        } while ((i += 3) < l);

        return r;
    }

    public getDump(): string {
        const BASE = 65521;
        const NMAX = 5552;
        let s1 = 1;
        let s2 = 0;
        let n = NMAX;

        for (let y = 0; y < this.height; y++) {
            for (let x = -1; x < this.width; x++) {
                const sample = this.buffer[this.index(x, y)] ?? "\x00";
                s1 += sample.charCodeAt(0);
                s2 += s1;
                n -= 1;
                if (n === 0) {
                    s1 %= BASE;
                    s2 %= BASE;
                    n = NMAX;
                }
            }
        }
        s1 %= BASE;
        s2 %= BASE;
        write(this.buffer, this.idat_offs + this.idat_size - 8, byte4((s2 << 16) | s1));

        const crc32 = (png: string[], offs: number, size: number): void => {
            let crc = -1;
            for (let i = 4; i < size - 4; i += 1) {
                const value = png[offs + i] ?? "\x00";
                const tableValue = this.crc32[(crc ^ value.charCodeAt(0)) & 0xff] ?? 0;
                crc = tableValue ^ ((crc >> 8) & 0x00ffffff);
            }
            write(png, offs + size - 4, byte4(crc ^ -1));
        };

        crc32(this.buffer, this.ihdr_offs, this.ihdr_size);
        crc32(this.buffer, this.plte_offs, this.plte_size);
        crc32(this.buffer, this.trns_offs, this.trns_size);
        crc32(this.buffer, this.idat_offs, this.idat_size);
        crc32(this.buffer, this.iend_offs, this.iend_size);

        return "\x89PNG\r\n\x1a\n" + this.buffer.join("");
    }
}
