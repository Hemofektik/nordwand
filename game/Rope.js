
function BeginDrawPixelLine( ctx, color )
{
	ctx.beginPath();
	ctx.fillStyle = color;
}
function DrawPixelLine( ctx, cam, x0, y0, x1, y1, invPixelScale )
{
	var dx = Math.abs(x1 - x0);
	var dy = -Math.abs(y1 - y0);
	var dist = Math.max(dx, -dy);
	var sx = x0 < x1 ? 1 : -1;
	var sy = y0 < y1 ? 1 : -1;
	var err = dx + dy;
	var e2; /* error value e_xy */

	for (var n = 0; n < dist; n++) 
    {
    	var screenPosX = Math.round( cam.world_to_viewport_x_pixel( x0 ) * invPixelScale ) * cam.pixelScale;
    	var screenPosY = Math.round( cam.world_to_viewport_y_pixel( y0 ) * invPixelScale ) * cam.pixelScale;

	    ctx.rect(screenPosX, screenPosY, cam.pixelScale, cam.pixelScale);

	    e2 = 2 * err;
	    if (e2 > dy) { err += dy; x0 += sx; } /* e_xy+e_x > 0 */
	    if (e2 < dx) { err += dx; y0 += sy; } /* e_xy+e_y < 0 */
	}
}
function EndDrawPixelLine( ctx )
{
	ctx.fill();
}

function Rope_Update( deltaTime )
{
}

function Rope_Draw( ctx, cam )
{
	var n = 0; 
	var invPixelScale = 1.0 / cam.pixelScale;

	BeginDrawPixelLine( ctx, "#2A0D03" );
	for ( n = 0; n < this.distanceConstraintIndices.length; n++ )
	{
		var c = this.phys.distanceConstraints[this.distanceConstraintIndices[n]];

		var state0 = this.phys.particleStates[c.particleIndex0];
		var state1 = this.phys.particleStates[c.particleIndex1];

		DrawPixelLine( ctx, cam, Math.round( state0.posX ), Math.round( state0.posY ), Math.round( state1.posX ), Math.round( state1.posY ), invPixelScale );
	}
	EndDrawPixelLine( ctx );
}

function FindNearbyWallAnchor( wall, posY )
{
	var n = 0;

	var nearestAnchor;
	var nearestAnchorDistanceSqr = 10000000000.0;
	for ( n = 0; n < wall.wallAnchors.length; n++ )
	{	// TODO: optimize this by height anticipation
		var wa = wall.wallAnchors[n];
		var deltaY = wa.posY - posY;
		var distanceSqr = deltaY * deltaY;
		if ( nearestAnchorDistanceSqr > distanceSqr )
		{
			nearestAnchorDistanceSqr = distanceSqr;
			nearestAnchor = wa;
		}
	}

	return nearestAnchor;
}

function Rope( phys, wall, skeleton, posX, posY )
{
	this.phys;
	this.wall;
	this.skeleton;

	this.distanceConstraintIndices = [];

	// methods
	this.Update = Rope_Update;
	this.Draw = Rope_Draw;

	this.Initialize = function ( phys, wall, skeleton, posX, posY )
	{
		this.phys = phys;
		this.wall = wall;
		this.skeleton = skeleton;

		var n = 0;
		var ropeSegmentLength = 2;

		var particleStartIndex = 0;
		var numParticlesForRope = 0;
		var lastParticleIndex = 0;

		// create first anchored rope part
		{
			var anchorStartIndex = 20;
			var wa0 = this.wall.wallAnchors[anchorStartIndex + 0];
			var wa1 = this.wall.wallAnchors[anchorStartIndex + 10];

			var deltaX = wa1.posX - wa0.posX;
			var deltaY = wa1.posY - wa0.posY;

			var dirLength = Math.sqrt( deltaX * deltaX + deltaY * deltaY );

			var dirX = deltaX / dirLength;
			var dirY = deltaY / dirLength;

			var numParticlesForFirstPart = Math.ceil( dirLength / ropeSegmentLength );
			numParticlesForRope += numParticlesForFirstPart;
			particleStartIndex = this.phys.particleStates.length;
			for ( n = 0; n < numParticlesForFirstPart; n++ )
			{
				var particlePosX = wa0.posX + dirX * n * ropeSegmentLength;
				var particlePosY = wa0.posY + dirY * n * ropeSegmentLength;

				if ( n > 0 && n < numParticlesForFirstPart - 1 )
				{
					var wa = FindNearbyWallAnchor( this.wall, particlePosY );
					particlePosX = wa.posX - 10;
				}

				lastParticleIndex = this.phys.CreateParticle( particlePosX, particlePosY );
			}

			this.phys.CreateFixedConstraint( particleStartIndex );
			this.phys.CreateFixedConstraint( particleStartIndex + numParticlesForFirstPart - 1 );
		}

		// create second rope part which is bound to the player character
		{
			var targetParticleState = this.phys.particleStates[skeleton.pelvisParticleIndex];
			var deltaX = targetParticleState.posX - wa1.posX;
			var deltaY = targetParticleState.posY - wa1.posY;

			var dirLength = Math.sqrt( deltaX * deltaX + deltaY * deltaY );

			var dirX = deltaX / dirLength;
			var dirY = deltaY / dirLength;

			var numParticlesForSecondPart = Math.ceil( dirLength / ropeSegmentLength );
			numParticlesForRope += numParticlesForSecondPart;
			for ( n = 0; n < numParticlesForSecondPart; n++ )
			{
				var particlePosX = wa1.posX + dirX * n * ropeSegmentLength;
				var particlePosY = wa1.posY + dirY * n * ropeSegmentLength;

				/*if ( n > 0 && n < numParticlesForSecondPart - 1 )
				{
					var wa = FindNearbyWallAnchor( this.wall, particlePosY );
					particlePosX = wa.posX - 10;
				}*/

				lastParticleIndex = this.phys.CreateParticle( particlePosX, particlePosY );
			}
		}

		for ( n = 0; n < numParticlesForRope - 1; n++ )
		{
			var dcIndex = this.phys.CreateDistanceConstraint( particleStartIndex + n, particleStartIndex + n + 1 );
			this.distanceConstraintIndices.push( dcIndex );
		}

		// connect rope with skeleton
		this.distanceConstraintIndices.push( this.phys.CreateDistanceConstraint( lastParticleIndex, skeleton.pelvisParticleIndex ) );
	}

	this.Initialize( phys, wall, skeleton, posX, posY );
}
