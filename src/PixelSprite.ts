import type { Camera } from "./Camera.ts";
import { PNGlib } from "./pnglib.ts";

export class Pixel {
    public r = 0;
    public g = 0;
    public b = 0;
    public a = 0;
}

export class PixelSprite {
    public scale = 0.0;
    public image: HTMLImageElement;

    public rawPixels: Pixel[][] | null = null;

    public sprite: HTMLImageElement | undefined;

    public numTilesX = 1;
    public numTilesY = 1;

    public tileWidth = 1;
    public tileHeight = 1;

    public scaledTileWidth = 1;
    public scaledTileHeight = 1;

    public constructor(srcPath: string) {
        this.image = new Image();
        this.image.src = srcPath;
    }

    public initialize(ctx: CanvasRenderingContext2D): void {
        ctx.clearRect(0, 0, this.image.naturalWidth, this.image.naturalHeight);
        ctx.drawImage(this.image, 0, 0);
        const imageData = ctx.getImageData(0, 0, this.image.naturalWidth, this.image.naturalHeight);
        const pix = imageData.data;

        this.tileWidth = Math.round(this.image.naturalWidth / this.numTilesX);
        this.tileHeight = Math.round(this.image.naturalHeight / this.numTilesY);

        this.rawPixels = [];
        this.rawPixels.length = this.image.naturalHeight;

        let channelIndex = 0;
        for (let y = 0; y < this.image.naturalHeight; y++) {
            this.rawPixels[y] = [];
            this.rawPixels[y]!.length = this.image.naturalWidth;

            for (let x = 0; x < this.image.naturalWidth; x++) {
                const red = pix[channelIndex + 0]!;
                const green = pix[channelIndex + 1]!;
                const blue = pix[channelIndex + 2]!;
                const alpha = pix[channelIndex + 3]!;

                const pixel = new Pixel();
                pixel.r = red;
                pixel.g = green;
                pixel.b = blue;
                pixel.a = alpha;
                this.rawPixels[y]![x] = pixel;

                channelIndex += 4;
            }
        }
    }

    public draw(ctx: CanvasRenderingContext2D, cam: Camera, posX: number, posY: number): void {
        this.drawTiled(ctx, cam, posX, posY, 0, 0);
    }

    public drawTile(
        ctx: CanvasRenderingContext2D,
        pixelScale: number,
        posX: number,
        posY: number,
        sourceX: number,
        sourceY: number,
        width: number,
        height: number,
    ): void {
        if (!this.image.complete) return;
        if (this.rawPixels === null) {
            this.initialize(ctx);
        }

        if (this.scale !== pixelScale) {
            // adapt size to pixelScale using image.naturalWidth and naturalHeight
            const newWidth = Math.round(this.image.naturalWidth * pixelScale);
            const newHeight = Math.round(this.image.naturalHeight * pixelScale);

            this.scaledTileWidth = this.tileWidth * pixelScale;
            this.scaledTileHeight = this.tileHeight * pixelScale;

            // constructor takes height, weight and color-depth
            const p = new PNGlib(newWidth, newHeight, 256);

            const rawPixels = this.rawPixels!;
            for (let y = 0; y < this.image.naturalHeight; y++) {
                const row = rawPixels[y]!;
                for (let x = 0; x < this.image.naturalWidth; x++) {
                    const pixel = row[x]!;

                    let newY = Math.round(y * pixelScale);
                    const newYMax = Math.round(newY + pixelScale);
                    for (; newY < newYMax; newY++) {
                        let newX = Math.round(x * pixelScale);
                        const newXMax = Math.round(newX + pixelScale);
                        for (; newX < newXMax; newX++) {
                            p.buffer[p.index(newX, newY)] = p.color(pixel.r, pixel.g, pixel.b, pixel.a);
                        }
                    }
                }
            }

            const img = new Image(newWidth, newHeight);
            img.src = "data:image/png;base64," + p.getBase64();
            this.sprite = img;

            this.scale = pixelScale;
        }

        const sprite = this.sprite;
        if (sprite === undefined) {
            return;
        }

        ctx.drawImage(
            sprite,
            sourceX,
            sourceY,
            width,
            height,
            posX,
            posY,
            width,
            height,
        );
    }

    public drawTiled(
        ctx: CanvasRenderingContext2D,
        cam: Camera,
        posX: number,
        posY: number,
        tileX: number,
        tileY: number,
    ): void {
        const screenPosX = Math.round(cam.world_to_viewport_x_pixel(posX) / cam.pixelScale) * cam.pixelScale;
        const screenPosY = Math.round(cam.world_to_viewport_y_pixel(posY) / cam.pixelScale) * cam.pixelScale;

        this.drawTile(
            ctx,
            cam.pixelScale,
            screenPosX,
            screenPosY,
            tileX * this.scaledTileWidth,
            tileY * this.scaledTileHeight,
            this.scaledTileWidth,
            this.scaledTileHeight,
        );
    }
}
