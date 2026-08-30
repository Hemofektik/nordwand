
var ECLimbingState = Object.freeze(
{
	None : 0,
	Raise: 1,	// flex arm and extend leg to get higher
	Reach: 2	// use free arm and leg to grab now reachable anchors
});

function FlexArm( skeleton, sideIndex, deltaTime )
{
	var elbowDelta = ( Math.PI * 1.8 - skeleton.phys.angularConstraints[skeleton.elbowACIndex[sideIndex]].targetAngle ) * deltaTime;
	var shoulderDelta = ( Math.PI * 0.2 - skeleton.phys.angularConstraints[skeleton.shoulderACIndex[sideIndex]].targetAngle ) * deltaTime;
	skeleton.phys.angularConstraints[skeleton.elbowACIndex[sideIndex]].targetAngle += elbowDelta;
	skeleton.phys.angularConstraints[skeleton.shoulderACIndex[sideIndex]].targetAngle += shoulderDelta;

	return Math.abs( shoulderDelta ) + Math.abs( elbowDelta );
}

function ExtendLeg( skeleton, sideIndex, deltaTime )
{
	var hipJointDelta = ( Math.PI * 1.2 - skeleton.phys.angularConstraints[skeleton.hipJointACIndex[sideIndex]].targetAngle ) * deltaTime;
	var kneeJointDelta = ( Math.PI * 0.8 - skeleton.phys.angularConstraints[skeleton.kneeJointACIndex[sideIndex]].targetAngle ) * deltaTime;
	skeleton.phys.angularConstraints[skeleton.hipJointACIndex[sideIndex]].targetAngle += hipJointDelta;
	skeleton.phys.angularConstraints[skeleton.kneeJointACIndex[sideIndex]].targetAngle += kneeJointDelta;

	return Math.abs( hipJointDelta ) + Math.abs( kneeJointDelta );
}

function ClimbingAI_UpdateRaise( deltaTime )
{
	var n = 0;
	var raised = false;
	var accumulatedDelta = 0.0;
	for ( n = 0; n < this.skeleton.handGrabConstraintIndex.length; n++ )
	{
		if ( this.skeleton.phys.fixedConstraints[this.skeleton.handGrabConstraintIndex[n]].isEnabled )
		{
			accumulatedDelta += FlexArm( this.skeleton, n, deltaTime );
			raised = true;
		}
	}
	for ( n = 0; n < this.skeleton.footGrabConstraintIndex.length; n++ )
	{
		if ( this.skeleton.phys.fixedConstraints[this.skeleton.footGrabConstraintIndex[n]].isEnabled )
		{
			accumulatedDelta += ExtendLeg( this.skeleton, n, deltaTime );
			raised = true;
		}
	}
	if ( raised )
	{
		if ( accumulatedDelta < 0.01 )
		{
			this.climbinState = ECLimbingState.Reach;
		}
	}
	else
	{
		this.climbinState = ECLimbingState.None;
	}
}


function ClimbingAI_UpdateReachTargets()
{
	if ( this.targetHandAnchorIndex >= 0 &&
		 this.targetFootAnchorIndex >= 0 )
	{
		return;
	}

	// TODO: test whether next next anchor would be reachable for all limbs as well for bigger move (e.g. on perfect hit by user)

	if ( this.targetHandAnchorIndex == -1 )
	{
		// look whether next arm anchor is in reach of neckParticleState

		var maxHandWallAnchorIndex = -1;
		for ( n = 0; n < this.skeleton.handGrabConstraintIndex.length; n++ )
		{
			if ( this.skeleton.phys.fixedConstraints[this.skeleton.handGrabConstraintIndex[n]].isEnabled )
			{
				maxHandWallAnchorIndex = Math.max( maxHandWallAnchorIndex, this.skeleton.phys.fixedConstraints[this.skeleton.handGrabConstraintIndex[n]].wallAnchorIndex );
			}
		}

		var neckParticleState = this.skeleton.phys.particleStates[this.skeleton.neckParticleIndex];

		var nextHandAnchor = this.wall.wallAnchors[maxHandWallAnchorIndex + 1];

		var deltaX = nextHandAnchor.posX - neckParticleState.posX;
		var deltaY = nextHandAnchor.posY - neckParticleState.posY;
		var distanceSqr = deltaX * deltaX + deltaY * deltaY;

		if ( distanceSqr <= this.skeleton.armlength * this.skeleton.armlength )
		{
			this.targetHandAnchorIndex = nextHandAnchor.index;
		}
	}

	if ( this.targetFootAnchorIndex == -1 )
	{
		// look whether next foot anchors are in reach of buttocksParticleIndex
		var n = 0;
		var maxFootWallAnchorIndex = -1;
		for ( n = 0; n < this.skeleton.footGrabConstraintIndex.length; n++ )
		{
			if ( this.skeleton.phys.fixedConstraints[this.skeleton.footGrabConstraintIndex[n]].isEnabled )
			{
				maxFootWallAnchorIndex = Math.max( maxFootWallAnchorIndex, this.skeleton.phys.fixedConstraints[this.skeleton.footGrabConstraintIndex[n]].wallAnchorIndex );
			}
		}

		var buttocksParticleState = this.skeleton.phys.particleStates[this.skeleton.buttocksParticleIndex];

		var nextFootAnchor = this.wall.wallAnchors[maxFootWallAnchorIndex + 1];

		var deltaX = nextFootAnchor.posX - buttocksParticleState.posX;
		var deltaY = nextFootAnchor.posY - buttocksParticleState.posY;
		var distanceSqr = deltaX * deltaX + deltaY * deltaY;

		if ( distanceSqr <= this.skeleton.leglength * this.skeleton.leglength )
		{
			this.targetFootAnchorIndex = nextFootAnchor.index;
		}
	}
}

function ClimbingAI_UpdateReachLimbAngles()
{
	if ( this.targetHandAnchorIndex >= 0 )
	{
		var sourceParticleState = this.skeleton.phys.particleStates[this.skeleton.neckParticleIndex];
		var targetAnchor = this.wall.wallAnchors[this.targetHandAnchorIndex];
		// TODO: try to reach target

		// TODO: compute both angles
		// TODO: compute elbow angle first based on distance -> shoulder angle is dependent on that
	}

	if ( this.targetFootAnchorIndex >= 0 )
	{
		// TODO: try to reach target
	}
}

function ClimbingAI_UpdateReach( deltaTime )
{
	this.UpdateReachTargets( deltaTime );
	this.UpdateReachLimbAngles( deltaTime );

	// TODO: update arm and leg to target angles
}

function ClimbingAI_Update( deltaTime )
{
	if ( this.climbinState == ECLimbingState.Raise )
	{
		this.UpdateRaise( deltaTime );
	}
	else if ( this.climbinState == ECLimbingState.Reach )
	{
		this.UpdateReach( deltaTime );
	}
}

function ClimbingAI_Draw( ctx, cam )
{
}


function ClimbingAI( rope, wall, skeleton )
{
	this.rope;
	this.skeleton;
	this.wall;

	this.climbinState = ECLimbingState.Raise;

	this.targetHandAnchorIndex = -1;
	this.targetFootAnchorIndex = -1;

	// methods
	this.Update = ClimbingAI_Update;
	this.Draw = ClimbingAI_Draw;

	this.UpdateRaise = ClimbingAI_UpdateRaise;
	this.UpdateReach = ClimbingAI_UpdateReach;
	this.UpdateReachTargets = ClimbingAI_UpdateReachTargets;
	this.UpdateReachLimbAngles = ClimbingAI_UpdateReachLimbAngles;

	this.Initialize = function( rope, wall, skeleton )
	{
		this.rope = rope;
		this.wall = wall;
		this.skeleton = skeleton;
	}

	this.Initialize( rope, wall, skeleton );
}
