/**
 * PNGlib - ported 1:1 from the legacy code base (js/Game/pnglib.js).
 * A handy class to calculate color values.
 *
 * @version 1.0
 * @author Robert Eisele <robert@xarg.org>
 * @copyright Copyright (c) 2010, Robert Eisele
 * @link http://www.xarg.org/2010/03/generate-client-side-png-files-using-javascript/
 * @license http://www.opensource.org/licenses/bsd-license.php BSD License
 */

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
    public width: number;
    public height: number;
    public depth: number;

    public pix_size: number;
    public data_size: number;
    public ihdr_offs: number;
    public ihdr_size: number;
    public plte_offs: number;
    public plte_size: number;
    public trns_offs: number;
    public trns_size: number;
    public idat_offs: number;
    public idat_size: number;
    public iend_offs: number;
    public iend_size: number;
    public buffer_size: number;
    public buffer: string[];
    public palette: Record<number, string> = {};
    public pindex = 0;

    public index: (x: number, y: number) => number;
    public color: (red: number, green: number, blue: number, alpha: number) => string;
    public getBase64: () => string;
    public getDump: () => string;

    public constructor(width: number, height: number, depth: number) {
        this.width = width;
        this.height = height;
        this.depth = depth;

        // pixel data and row filter identifier size
        this.pix_size = height * (width + 1);

        // deflate header, pix_size, block headers, adler32 checksum
        this.data_size = 2 + this.pix_size + 5 * Math.floor((0xfffe + this.pix_size) / 0xffff) + 4;

        // offsets and sizes of PNG chunks
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
        this.palette = {};
        this.pindex = 0;

        const crc32Table: number[] = [];

        // initialize buffer with zero bytes
        for (let i = 0; i < this.buffer_size; i++) {
            this.buffer[i] = "\x00";
        }

        // initialize non-zero elements
        write(this.buffer, this.ihdr_offs, byte4(this.ihdr_size - 12), "IHDR", byte4(width), byte4(height), "\x08\x03");
        write(this.buffer, this.plte_offs, byte4(this.plte_size - 12), "PLTE");
        write(this.buffer, this.trns_offs, byte4(this.trns_size - 12), "tRNS");
        write(this.buffer, this.idat_offs, byte4(this.idat_size - 12), "IDAT");
        write(this.buffer, this.iend_offs, byte4(this.iend_size - 12), "IEND");

        // initialize deflate header
        let header = ((8 + (7 << 4)) << 8) | (3 << 6);
        header += 31 - (header % 31);

        write(this.buffer, this.idat_offs + 8, byte2(header));

        // initialize deflate block headers
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

        /* Create crc32 lookup table */
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) {
                if (c & 1) {
                    c = -306674912 ^ ((c >> 1) & 0x7fffffff);
                } else {
                    c = (c >> 1) & 0x7fffffff;
                }
            }
            crc32Table[i] = c;
        }

        // compute the index into a png for a given pixel
        this.index = (x: number, y: number): number => {
            const i = y * (this.width + 1) + x + 1;
            const j = this.idat_offs + 8 + 2 + 5 * Math.floor(i / 0xffff + 1) + i;
            return j;
        };

        // convert a color and build up the palette
        this.color = (red: number, green: number, blue: number, alpha: number): string => {
            alpha = alpha >= 0 ? alpha : 255;
            const color = (((((alpha << 8) | red) << 8) | green) << 8) | blue;

            if (this.palette[color] === undefined) {
                if (this.pindex === this.depth) return "\x00";

                const ndx = this.plte_offs + 8 + 3 * this.pindex;

                this.buffer[ndx + 0] = String.fromCharCode(red);
                this.buffer[ndx + 1] = String.fromCharCode(green);
                this.buffer[ndx + 2] = String.fromCharCode(blue);
                this.buffer[this.trns_offs + 8 + this.pindex] = String.fromCharCode(alpha);

                this.palette[color] = String.fromCharCode(this.pindex++);
            }
            return this.palette[color]!;
        };

        // output a PNG string, Base64 encoded
        this.getBase64 = (): string => {
            const s = this.getDump();

            const ch = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
            let c1: number;
            let c2: number;
            let c3: number;
            let e1: number;
            let e2: number;
            let e3: number;
            let e4: number;
            const l = s.length;
            let i = 0;
            let r = "";

            do {
                c1 = s.charCodeAt(i);
                e1 = c1 >> 2;
                c2 = s.charCodeAt(i + 1);
                e2 = ((c1 & 3) << 4) | (c2 >> 4);
                c3 = s.charCodeAt(i + 2);
                if (l < i + 2) {
                    e3 = 64;
                } else {
                    e3 = ((c2 & 0xf) << 2) | (c3 >> 6);
                }
                if (l < i + 3) {
                    e4 = 64;
                } else {
                    e4 = c3 & 0x3f;
                }
                r += ch.charAt(e1) + ch.charAt(e2) + ch.charAt(e3) + ch.charAt(e4);
            } while ((i += 3) < l);
            return r;
        };

        // output a PNG string
        this.getDump = (): string => {
            // compute adler32 of output pixels + row filter bytes
            const BASE = 65521; /* largest prime smaller than 65536 */
            const NMAX = 5552;
            let s1 = 1;
            let s2 = 0;
            let n = NMAX;

            for (let y = 0; y < this.height; y++) {
                for (let x = -1; x < this.width; x++) {
                    s1 += (this.buffer[this.index(x, y)] ?? "\x00").charCodeAt(0);
                    s2 += s1;
                    if ((n -= 1) === 0) {
                        s1 %= BASE;
                        s2 %= BASE;
                        n = NMAX;
                    }
                }
            }
            s1 %= BASE;
            s2 %= BASE;
            write(this.buffer, this.idat_offs + this.idat_size - 8, byte4((s2 << 16) | s1));

            // compute crc32 of the PNG chunks
            const crc32 = (png: string[], offs: number, size: number): void => {
                let crc = -1;
                for (let i = 4; i < size - 4; i += 1) {
                    crc = crc32Table[(crc ^ (png[offs + i] ?? "\x00").charCodeAt(0)) & 0xff]! ^ ((crc >> 8) & 0x00ffffff);
                }
                write(png, offs + size - 4, byte4(crc ^ -1));
            };

            crc32(this.buffer, this.ihdr_offs, this.ihdr_size);
            crc32(this.buffer, this.plte_offs, this.plte_size);
            crc32(this.buffer, this.trns_offs, this.trns_size);
            crc32(this.buffer, this.idat_offs, this.idat_size);
            crc32(this.buffer, this.iend_offs, this.iend_size);

            // convert PNG to string
            return "\x89PNG\r\n\x1a\n" + this.buffer.join("");
        };
    }
}
