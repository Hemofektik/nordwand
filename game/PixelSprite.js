

function PixelSprite(srcPath)
{
	this.scale = 0.0
	this.image;

	this.rawPixels = null;
	
	this.sprite;

	this.numTilesX = 1;
	this.numTilesY = 1;

	this.tileWidth = 1;
	this.tileHeight = 1;

	this.scaledTileWidth = 1;
	this.scaledTileHeight = 1;

	this.Draw = PixelSprite_Draw;
	this.DrawTile = PixelSprite_DrawTile;
	this.DrawTiled = PixelSprite_DrawTiled;

	this.Initialize = function (ctx)
	{
	    ctx.clearRect(0, 0, this.image.naturalWidth, this.image.naturalHeight);
	    ctx.drawImage(this.image, 0, 0);
	    var imageData = ctx.getImageData(0, 0, this.image.naturalWidth, this.image.naturalHeight);
	    var pix = imageData.data;

	    this.tileWidth = Math.round(this.image.naturalWidth / this.numTilesX);
	    this.tileHeight = Math.round(this.image.naturalHeight / this.numTilesY);

	    this.rawPixels = [];
	    this.rawPixels.length = this.image.naturalHeight;

	    var channelIndex = 0;
	    for (var y = 0; y < this.image.naturalHeight; y++)
	    {
	        this.rawPixels[y] = [];
	        this.rawPixels[y].length = this.image.naturalWidth;

	        for (var x = 0; x < this.image.naturalWidth; x++)
	        {
	            var red = pix[channelIndex + 0];
	            var green = pix[channelIndex + 1];
	            var blue = pix[channelIndex + 2];
	            var alpha = pix[channelIndex + 3];

	            var pixel = new Pixel();
	            pixel.r = red;
	            pixel.g = green;
	            pixel.b = blue;
	            pixel.a = alpha;
	            this.rawPixels[y][x] = pixel;

	            channelIndex += 4;
	        }
	    }
	}

	this.InitPixelSprite = function (srcPath) 
    {
	    this.image = new Image();
	    this.image.src = srcPath;
	}

	this.InitPixelSprite(srcPath);
}

function PixelSprite_Draw(ctx, cam, posX, posY) 
{
    this.DrawTiled(ctx, cam, posX, posY, 0, 0);
}

function PixelSprite_DrawTile(ctx, pixelScale, posX, posY, sourceX, sourceY, width, height)
{
    if (!this.image.complete) return;
    if (this.rawPixels == null)
    {
        this.Initialize(ctx);
    }

    if (this.scale != pixelScale)
    {
        // adapt size to pixelScale using image.naturalWidth and naturalHeight
        var newWidth = Math.round(this.image.naturalWidth * pixelScale);
        var newHeight = Math.round(this.image.naturalHeight * pixelScale);
        var img = new Image(newWidth, newHeight);

        this.scaledTileWidth = this.tileWidth * pixelScale;
        this.scaledTileHeight = this.tileHeight * pixelScale;

        var p = new PNGlib(newWidth, newHeight, 256); // construcor takes height, weight and color-depth
        var background = p.color(0, 0, 0, 0); // set the background transparent

        for (var y = 0; y < this.image.naturalHeight; y++)
        {
            for (var x = 0; x < this.image.naturalWidth; x++)
            {
                var pixel = this.rawPixels[y][x];

                var newY = Math.round(y * pixelScale);
                var newYMax = Math.round(newY + pixelScale);
                for (; newY < newYMax; newY++)
                {
                    var newX = Math.round(x * pixelScale);
                    var newXMax = Math.round(newX + pixelScale);
                    for (; newX < newXMax; newX++)
                    {
                        p.buffer[p.index(newX, newY)] = p.color(pixel.r, pixel.g, pixel.b, pixel.a);
                    }
                }
            }
        }

        img.src = "data:image/png;base64," + p.getBase64();
        delete this.sprite;
        this.sprite = img;

        this.scale = pixelScale;
    }

    ctx.drawImage(this.sprite,
                    sourceX,
                    sourceY,
                    width,
                    height,
                    posX,
                    posY,
                    width,
                    height);
}

function PixelSprite_DrawTiled(ctx, cam, posX, posY, tileX, tileY)
{
	var screenPosX = Math.round(cam.world_to_viewport_x_pixel(posX) / cam.pixelScale) * cam.pixelScale;
	var screenPosY = Math.round(cam.world_to_viewport_y_pixel(posY) / cam.pixelScale) * cam.pixelScale;

	this.DrawTile(ctx, cam.pixelScale,
                    screenPosX,
                    screenPosY,
                    tileX * this.scaledTileWidth,
                    tileY * this.scaledTileHeight,
                    this.scaledTileWidth,
                    this.scaledTileHeight);
}

function Pixel()
{
    this.r = 0;
    this.g = 0;
    this.b = 0;
    this.a = 0;
}


