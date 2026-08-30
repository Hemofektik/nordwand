
var noiseIndex = 0;
function Rand()
{
	var x = noiseIndex;
	noiseIndex++;

	x = ( ( x << 13 ) ^ x ) & 0xFFFFFFFF;
	return ( x * ( ( x * x * 15731 + 789221 ) & 0xFFFFFFFF ) + 1376312589 ); 
}

function RandF()
{
	var r = Rand();
	r = ( 0x7FFFFFFF & r ) / 0x7FFFFFFF;
	return r;
}

function WallSegment()
{
	var posX;
	var posY;
}

function WallAnchor()
{
	var posX;
	var posY;
	var index; 				// index into wallAnchors array
}

function DrawDebugLineWall( ctx, cam, x0, y0, x1, y1, color )
{
	var screenPosX0 = Math.round( cam.world_to_viewport_x_pixel( x0 ) / cam.pixelScale ) * cam.pixelScale;
	var screenPosY0 = Math.round( cam.world_to_viewport_y_pixel( y0 ) / cam.pixelScale ) * cam.pixelScale;
	var screenPosX1 = Math.round( cam.world_to_viewport_x_pixel( x1 ) / cam.pixelScale ) * cam.pixelScale;
	var screenPosY1 = Math.round( cam.world_to_viewport_y_pixel( y1 ) / cam.pixelScale ) * cam.pixelScale;

	ctx.strokeStyle = color;
	ctx.lineWidth = cam.pixelScale;
	ctx.beginPath();
	ctx.moveTo( screenPosX0, screenPosY0 );
	ctx.lineTo( screenPosX1, screenPosY1 );
	ctx.stroke();

	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo( screenPosX0, screenPosY0 );
	ctx.lineTo( screenPosX0 + 500, screenPosY0 );
	ctx.lineTo( screenPosX1 + 500, screenPosY1 );
	ctx.lineTo( screenPosX1, screenPosY1 );
	ctx.closePath();
	ctx.fill();
}

function DrawDebugWallAnchor( ctx, cam, wa, color )
{
	var screenPosX = Math.round( cam.world_to_viewport_x_pixel( wa.posX ) / cam.pixelScale ) * cam.pixelScale;
	var screenPosY = Math.round( cam.world_to_viewport_y_pixel( wa.posY ) / cam.pixelScale ) * cam.pixelScale;

	ctx.fillStyle = color;
    ctx.beginPath();
	ctx.rect(screenPosX - cam.pixelScale, screenPosY - cam.pixelScale, cam.pixelScale * 2, cam.pixelScale * 2);
	ctx.closePath();
	ctx.fill();
}


function Wall_Update( deltaTime )
{
}

function Wall_Draw( ctx, cam )
{
	var n = 0;

	for ( n = 0; n < this.wallSegments.length - 1; n++ )
	{
		var ws0 = this.wallSegments[n + 0];
		var ws1 = this.wallSegments[n + 1];

		DrawDebugLineWall( ctx, cam, ws0.posX, ws0.posY, ws1.posX, ws1.posY, "#303335" );
	}

	for ( n = 0; n < this.wallAnchors.length; n++ )
	{
		var wa = this.wallAnchors[n];

		DrawDebugWallAnchor( ctx, cam, wa, "#FF0000" );
	}
}

function Wall_AddAnchor( segmentIndex )
{
	var anchorDistance = 10.0;
	var n = 0;

	var ws0 = this.wallSegments[segmentIndex + 0];
	var ws1 = this.wallSegments[segmentIndex + 1];

	var deltaX = ws1.posX - ws0.posX;
	var deltaY = ws1.posY - ws0.posY;

	var dirLength = Math.sqrt( deltaX * deltaX + deltaY * deltaY );

	var dirX = deltaX / dirLength;
	var dirY = deltaY / dirLength;

	var numAnchors = dirLength / anchorDistance;
	for (n = 0; n < numAnchors; n++) 
	{
		var wa = new WallAnchor();
		wa.posX = ws0.posX + dirX * n * anchorDistance;
		wa.posY = ws0.posY + dirY * n * anchorDistance;
		wa.index = this.wallAnchors.length;
		this.wallAnchors.push(wa);
	}
}

function Wall_GetNearbyAnchors( posX, posY, maxDistance )
{
	var result = [];

	// TODO: optimize by anticipation of height using posY
	for ( n = 0; n < this.wallAnchors.length; n++ )
	{
		var wa = this.wallAnchors[n];

		var deltaX = posX - wa.posX;
		var deltaY = posY - wa.posY;
		var distance = Math.sqrt( deltaX * deltaX + deltaY * deltaY );
		if ( distance <= maxDistance )
		{
			result.push( wa );
		}
	}

	return result;
}

function Wall( posX, posY )
{
	this.phys;

	this.wallSegments = [];
	this.wallAnchors = []; // points which the player can grab

	// methods
	this.Update = Wall_Update;
	this.Draw = Wall_Draw;

	this.AddAnchor = Wall_AddAnchor;
	this.GetNearbyAnchors = Wall_GetNearbyAnchors;

	this.Initialize = function ( initialPosX, initialPosY )
	{
		var n = 0;
		var x = 0;

		var numParticles = 32;

		//noiseIndex = 126; // seed value to get the same wall every time

		var posX = initialPosX + 45;
		var posY = initialPosY + 300;

		var wallVariationBandWidth = 100;
		var halfWallVariationBandWidth = wallVariationBandWidth * 0.5;
		var segmentLength = 40.0;
		var segmentDirRad = -Math.PI * 0.5;
		for ( x = 0; x < numParticles - 1; x++ )
		{
			var ws = new WallSegment();

			var variationDir = ( initialPosX - posX ) / halfWallVariationBandWidth;
			var variationStrength = Math.max( 0.0, 1.0 - Math.abs( variationDir ) );

			var dirRadOffset = 0.0;
			dirRadOffset += ( RandF() - 0.5 ) * variationStrength * Math.PI * 1.0; // add variable slope change as long as not at screen border
			dirRadOffset += variationDir * Math.PI * 0.2; // try to stay away from screen boorder

			// do not allow to get negative slope (downwards)
			if ( segmentDirRad + dirRadOffset > -Math.PI * 0.1 )
			{
				dirRadOffset = -Math.abs( dirRadOffset );
			}
			else if ( segmentDirRad + dirRadOffset < -Math.PI * 0.9 )
			{
				dirRadOffset = Math.abs( dirRadOffset );
			}

			segmentDirRad += dirRadOffset;

			var segmentDirX = Math.cos( segmentDirRad );
			var segmentDirY = Math.sin( segmentDirRad );

			posX += segmentDirX * segmentLength;
			posY += segmentDirY * segmentLength;

			ws.posX = posX;
			ws.posY = posY;

			this.wallSegments.push( ws );
		}

		for ( n = 0; n < this.wallSegments.length - 1; n++ )
		{
			this.AddAnchor( n );
		}
	}

	this.Initialize( posX, posY );
}
