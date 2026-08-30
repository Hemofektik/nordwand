
function Skeleton_Update( deltaTime )
{
	//this.phys.angularConstraints[this.kneeJointACIndex[1]].targetAngle += ( Math.PI * 0.8 - this.phys.angularConstraints[this.kneeJointACIndex[1]].targetAngle ) * deltaTime;
	//this.phys.angularConstraints[this.elbowACIndex[0]].targetAngle += ( Math.PI * 1.5 - this.phys.angularConstraints[this.elbowACIndex[0]].targetAngle ) * deltaTime;

	this.time += deltaTime;
}

function DrawDebugLine( ctx, cam, x0, y0, x1, y1, color )
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
}

function DrawDistanceConstraints( ctx, cam, phys, distanceConstraintIndices, color )
{
	var n; 
	for ( n = 0; n < distanceConstraintIndices.length; n++ )
	{
		// TODO: this is not sufficient to guard broken constraints -> add callback instead to notify anyone about broken constraints
		if ( distanceConstraintIndices[n] < phys.distanceConstraints.length )
		{
			var c = phys.distanceConstraints[distanceConstraintIndices[n]];

			var state0 = phys.particleStates[c.particleIndex0];
			var state1 = phys.particleStates[c.particleIndex1];

			DrawDebugLine( ctx, cam, state0.posX, state0.posY, state1.posX, state1.posY, color );
		}
	}
}

function Skeleton_Draw( ctx, cam )
{
	// Debug output to visualize the skeleton
	DrawDistanceConstraints( ctx, cam, this.phys, this.bodyConstraintIndices, "#AA6000" );
	DrawDistanceConstraints( ctx, cam, this.phys, this.leftArmConstraintIndices, "#000080" );
	DrawDistanceConstraints( ctx, cam, this.phys, this.leftLegConstraintIndices, "#00AA00" );
	DrawDistanceConstraints( ctx, cam, this.phys, this.rightArmConstraintIndices, "#3080FF" );
	DrawDistanceConstraints( ctx, cam, this.phys, this.rightLegConstraintIndices, "#00FF00" );
}

function CreateBodyParticle( phys, posX, posY, mass )
{
	var particleIndex = phys.CreateParticle( posX, posY );

	phys.particleStates[particleIndex].mass = mass;
	phys.particleStates[particleIndex].inverseMass = 1.0 / mass;

	return particleIndex;
}

function Skeleton_AddBowOffset( offset )
{
	this.phys.angularConstraints[this.hipJointACIndex[0]].targetAngle -= offset;
	this.phys.angularConstraints[this.hipJointACIndex[1]].targetAngle -= offset;

	this.phys.angularConstraints[this.shoulderACIndex[0]].targetAngle += offset;
	this.phys.angularConstraints[this.shoulderACIndex[1]].targetAngle += offset;
}


function Skeleton( phys, wall, posX, posY )
{
	this.phys;
	this.wall;

	this.time = 0;

	this.bodylength = 24;
	this.armlength = 20;
	this.leglength = 24;

	this.bodyConstraintIndices = [];
	this.leftArmConstraintIndices = [];
	this.leftLegConstraintIndices = [];
	this.rightArmConstraintIndices = [];
	this.rightLegConstraintIndices = [];

	this.pelvisParticleIndex = -1;
	this.buttocksParticleIndex = -1;
	this.neckParticleIndex = -1;

	// each of the following arrays has two elements (0 = left; 1 = right)
	this.handParticleIndex = [];
	this.footParticleIndex = [];
	this.shoulderACIndex = [];		// AC == AngularConstraint
	this.elbowACIndex = [];
	this.hipJointACIndex = [];
	this.kneeJointACIndex = [];

	this.handGrabConstraintIndex = [];
	this.footGrabConstraintIndex = [];

	// methods
	this.Update = Skeleton_Update;
	this.Draw = Skeleton_Draw;

	this.AddBowOffset = Skeleton_AddBowOffset;

	this.LetGo = function ()
	{
		this.phys.fixedConstraints[this.handGrabConstraintIndex[0]].isEnabled = false;
		this.phys.fixedConstraints[this.handGrabConstraintIndex[1]].isEnabled = false;
		this.phys.fixedConstraints[this.footGrabConstraintIndex[0]].isEnabled = false;
		this.phys.fixedConstraints[this.footGrabConstraintIndex[1]].isEnabled = false;
	}

	this.Initialize = function ( phys, wall, posX, posY )
	{
		this.phys = phys;
		this.wall = wall;

		var bodyParticleMass = 0.1;

		var anchors = wall.GetNearbyAnchors( posX, posY, 300 );

		// put skeleton at a position where the left wrist touches the selected anchor
		var armAnchorIndex = anchors[Math.round( anchors.length / 2 )].index;
		var legAnchorIndex = armAnchorIndex - 4;
		posX = anchors[armAnchorIndex].posX - this.armlength * 2.0; // x2 to get enough extra distance
		posY = anchors[armAnchorIndex].posY + this.bodylength * 0.7;

		var buttocksPosY = posY + this.bodylength * 0.3;
		var neckPosY = posY - this.bodylength * 0.7;

		var pelvisIndex = CreateBodyParticle( phys, posX, posY, bodyParticleMass );
		var buttocksIndex = CreateBodyParticle( phys, posX, buttocksPosY, bodyParticleMass );
		var backIndex = CreateBodyParticle( phys, posX, posY - this.bodylength * 0.3, bodyParticleMass );
		var neckIndex = CreateBodyParticle( phys, posX, neckPosY, bodyParticleMass );
		var headIndex = CreateBodyParticle( phys, posX, posY - this.bodylength * 0.9, bodyParticleMass );

		this.pelvisParticleIndex = pelvisIndex;
		this.buttocksParticleIndex = buttocksIndex;
		this.neckParticleIndex = neckIndex;

		var leftelbowIndex = CreateBodyParticle( phys, posX + this.armlength * 0.5, neckPosY, bodyParticleMass * 0.5 );
		var leftwristIndex = CreateBodyParticle( phys, posX + this.armlength * 1.0, neckPosY, bodyParticleMass * 0.5 );
		this.handParticleIndex.push( leftwristIndex );

		var leftkneeIndex = CreateBodyParticle( phys, posX + this.leglength * 0.5, buttocksPosY, bodyParticleMass * 0.5 );
		var leftankleIndex = CreateBodyParticle( phys, posX + this.leglength * 0.5, buttocksPosY + this.leglength * 0.5, bodyParticleMass * 0.5 );
		this.footParticleIndex.push( leftankleIndex );

		var rightelbowIndex = CreateBodyParticle( phys, posX + this.armlength * 0.5, neckPosY, bodyParticleMass * 0.5 );
		var rightwristIndex = CreateBodyParticle( phys, posX + this.armlength * 1.0, neckPosY, bodyParticleMass * 0.5 );
		this.handParticleIndex.push( rightwristIndex );

		var rightkneeIndex = CreateBodyParticle( phys, posX + this.leglength * 0.5, buttocksPosY, bodyParticleMass * 0.5 );
		var rightankleIndex = CreateBodyParticle( phys, posX + this.leglength * 0.5, buttocksPosY + this.leglength * 0.5, bodyParticleMass * 0.5 );
		this.footParticleIndex.push( rightankleIndex );

		this.bodyConstraintIndices.push( this.phys.CreateDistanceConstraint( pelvisIndex, buttocksIndex ) );
		this.bodyConstraintIndices.push( this.phys.CreateDistanceConstraint( pelvisIndex, backIndex ) );
		this.bodyConstraintIndices.push( this.phys.CreateDistanceConstraint( backIndex, neckIndex ) );
		this.bodyConstraintIndices.push( this.phys.CreateDistanceConstraint( neckIndex, headIndex ) );

		this.leftArmConstraintIndices.push( this.phys.CreateDistanceConstraint( neckIndex, leftelbowIndex ) );
		this.leftArmConstraintIndices.push( this.phys.CreateDistanceConstraint( leftelbowIndex, leftwristIndex ) );

		this.leftLegConstraintIndices.push( this.phys.CreateDistanceConstraint( buttocksIndex, leftkneeIndex ) );
		this.leftLegConstraintIndices.push( this.phys.CreateDistanceConstraint( leftkneeIndex, leftankleIndex ) );

		this.rightArmConstraintIndices.push( this.phys.CreateDistanceConstraint( neckIndex, rightelbowIndex ) );
		this.rightArmConstraintIndices.push( this.phys.CreateDistanceConstraint( rightelbowIndex, rightwristIndex ) );

		this.rightLegConstraintIndices.push( this.phys.CreateDistanceConstraint( buttocksIndex, rightkneeIndex ) );
		this.rightLegConstraintIndices.push( this.phys.CreateDistanceConstraint( rightkneeIndex, rightankleIndex ) );

		var backAC0 = this.phys.CreateAngularConstraint( buttocksIndex, pelvisIndex, backIndex );
		var backAC1 = this.phys.CreateAngularConstraint( pelvisIndex, backIndex, neckIndex );
		var backAC2 = this.phys.CreateAngularConstraint( backIndex, neckIndex, headIndex );

		this.phys.angularConstraints[backAC0].tightnessFactor = 2.0;
		this.phys.angularConstraints[backAC1].tightnessFactor = 2.0;
		this.phys.angularConstraints[backAC2].tightnessFactor = 2.0;

		this.shoulderACIndex.push( this.phys.CreateAngularConstraint( backIndex, neckIndex, leftelbowIndex ) );
		this.elbowACIndex.push( this.phys.CreateAngularConstraint( neckIndex, leftelbowIndex, leftwristIndex ) );

		this.hipJointACIndex.push( this.phys.CreateAngularConstraint( pelvisIndex, buttocksIndex, leftkneeIndex ) );
		this.kneeJointACIndex.push( this.phys.CreateAngularConstraint( buttocksIndex, leftkneeIndex, leftankleIndex ) );

		this.shoulderACIndex.push( this.phys.CreateAngularConstraint( backIndex, neckIndex, rightelbowIndex ) );
		this.elbowACIndex.push( this.phys.CreateAngularConstraint( neckIndex, rightelbowIndex, rightwristIndex ) );

		this.hipJointACIndex.push( this.phys.CreateAngularConstraint( pelvisIndex, buttocksIndex, rightkneeIndex ) );
		this.kneeJointACIndex.push( this.phys.CreateAngularConstraint( buttocksIndex, rightkneeIndex, rightankleIndex ) );

		var leftHandConstraintAnchorIndex = this.phys.CreateFixedConstraint( leftwristIndex );
		this.phys.fixedConstraints[leftHandConstraintAnchorIndex].posX = this.wall.wallAnchors[armAnchorIndex + 0].posX;
		this.phys.fixedConstraints[leftHandConstraintAnchorIndex].posY = this.wall.wallAnchors[armAnchorIndex + 0].posY;

		var rightankleConstraintAnchorIndex = this.phys.CreateFixedConstraint( rightankleIndex );
		this.phys.fixedConstraints[rightankleConstraintAnchorIndex].posX = this.wall.wallAnchors[legAnchorIndex].posX;
		this.phys.fixedConstraints[rightankleConstraintAnchorIndex].posY = this.wall.wallAnchors[legAnchorIndex].posY;

		this.handGrabConstraintIndex.push( leftHandConstraintAnchorIndex );
		this.handGrabConstraintIndex.push( this.phys.CreateFixedConstraint( rightwristIndex ) );

		this.footGrabConstraintIndex.push( this.phys.CreateFixedConstraint( leftankleIndex ) );
		this.footGrabConstraintIndex.push( rightankleConstraintAnchorIndex );

		this.phys.fixedConstraints[this.handGrabConstraintIndex[0]].isEnabled = true;
		this.phys.fixedConstraints[this.handGrabConstraintIndex[1]].isEnabled = false;
		this.phys.fixedConstraints[this.footGrabConstraintIndex[0]].isEnabled = false;
		this.phys.fixedConstraints[this.footGrabConstraintIndex[1]].isEnabled = true;

		this.phys.fixedConstraints[this.handGrabConstraintIndex[0]].wallAnchorIndex = armAnchorIndex;
		this.phys.fixedConstraints[this.footGrabConstraintIndex[1]].wallAnchorIndex = legAnchorIndex;
	}

	this.Initialize( phys, wall, posX, posY );
}















