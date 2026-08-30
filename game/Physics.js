

function PhysicalParticleState()
{
	this.posX = 0;
	this.posY = 0;

	this.velX = 0;
	this.velY = 0;

	this.mass = 0.05;
	this.inverseMass = 20;              //< inverse of the mass used to add force to velocity.

	this.stress = 0;

	this.friction = 0.997;
}

function DistanceConstraint()
{
	var particleIndex0;
	var particleIndex1;
	var distance;
	var bendFactor;
	var compressionFactor;
}

function FixedConstraint() 
{
	var particleIndex;
	var posX;
	var posY;
	var isEnabled;
	var wallAnchorIndex;
}

function AngularConstraint()
{
	var particleIndex0;
	var particleIndex1;
	var particleIndex2;
	var lastAngle;
	var targetAngle;
	var tightnessFactor;
}

function ParticleIntermediateState()
{
	this.state0;
	this.state1;
	this.targetDistance;
	this.forceX0;
	this.forceY0;
	this.forceX1;
	this.forceY1;
}

function SpringPhysics_CreateParticle( posX, posY )
{
	var pps = new PhysicalParticleState();

	pps.posX = posX;
	pps.posY = posY;

	this.particleStates.push( pps );

	return this.particleStates.length - 1;
}

function SpringPhysics_CreateDistanceConstraint( particleIndex0, particleIndex1 )
{
	var deltaX = this.particleStates[particleIndex0].posX - this.particleStates[particleIndex1].posX;
	var detlaY = this.particleStates[particleIndex0].posY - this.particleStates[particleIndex1].posY;

	var c = new DistanceConstraint();
	c.particleIndex0 = particleIndex0;
	c.particleIndex1 = particleIndex1;
	c.distance = Math.sqrt( deltaX * deltaX + detlaY * detlaY );
	c.bendFactor = 0.2;
	c.compressionFactor = 0.2;

	this.distanceConstraints.push( c );

	return this.distanceConstraints.length - 1;
};

function SpringPhysics_CreateFixedConstraint(particleIndex) 
{
	var c = new FixedConstraint();
	c.particleIndex = particleIndex;
	c.posX = this.particleStates[particleIndex].posX;
	c.posY = this.particleStates[particleIndex].posY;
	c.isEnabled = true;
	c.wallAnchorIndex = -1;

	this.fixedConstraints.push( c );

	return this.fixedConstraints.length - 1;
};

function SpringPhysics_CreateAngularConstraint( particleIndex0, particleIndex1, particleIndex2 )
{
	var dirX0 = this.particleStates[particleIndex0].posX - this.particleStates[particleIndex1].posX;
	var dirY0 = this.particleStates[particleIndex0].posY - this.particleStates[particleIndex1].posY;
	var dirX1 = this.particleStates[particleIndex2].posX - this.particleStates[particleIndex1].posX;
	var dirY1 = this.particleStates[particleIndex2].posY - this.particleStates[particleIndex1].posY;

	var c = new AngularConstraint();
	c.particleIndex0 = particleIndex0;
	c.particleIndex1 = particleIndex1;
	c.particleIndex2 = particleIndex2;
	c.targetAngle = Math.atan2( dirY0, dirX0 ) - Math.atan2( dirY1, dirX1 );
	c.lastAngle = c.targetAngle;
	c.tightnessFactor = 1.0;

	while ( c.targetAngle > Math.PI * 2 ) { c.targetAngle -= Math.PI * 2; }
	while ( c.targetAngle < 0 ) { c.targetAngle += Math.PI * 2; }

	this.angularConstraints.push( c );

	return this.angularConstraints.length - 1;
};

function SpringPhysics_Update( deltaTime )
{
	//deltaTime *= 0.1;
	// update physics
	this.UpdatePhysicsConstantTimeStep( deltaTime );
}

function ComputeForces( piState, bottom )
{
	var gravity = 80.0;
	piState.forceX0 = 0.0
	piState.forceY0 = gravity * piState.state0.mass;
	piState.forceX1 = 0.0
	piState.forceY1 = gravity * piState.state1.mass;

	// F = -k(|x|-d)(x/|x|) - bv

	var tightness = 5000.0;
	var tightness0 = tightness;
	var tightness1 = tightness;
	var Damping = 0.1;
	var AirFriction = 0.01;

	var positionDeltaX = ( piState.state0.posX - piState.state1.posX );
	var positionDeltaY = ( piState.state0.posY - piState.state1.posY );
	var distance = Math.sqrt( positionDeltaX * positionDeltaX + positionDeltaY * positionDeltaY );
	if ( Math.abs( distance ) > 0.001 )
	{
		var invDistance = 1.0 / distance;
		var directionX = positionDeltaX * invDistance;
		var directionY = positionDeltaY * invDistance;

		var dampingX = ( piState.state0.velX - piState.state1.velX ) * Damping;
		var dampingY = ( piState.state0.velY - piState.state1.velY ) * Damping;

		var f0 = ( distance - piState.targetDistance ) * tightness0;
		var f1 = ( distance - piState.targetDistance ) * tightness1;

		piState.forceX0 += f0 * -directionX - dampingX - piState.state0.velX * AirFriction;
		piState.forceY0 += f0 * -directionY - dampingY - piState.state0.velY * AirFriction;
		piState.forceX1 += f1 * directionX + dampingX - piState.state1.velX * AirFriction;
		piState.forceY1 += f1 * directionY + dampingY - piState.state1.velY * AirFriction;
	}

	if ( piState.state0.posY > bottom )
	{
		piState.forceY0 += -100;
		piState.state0.velY = 0;
	}
	if ( piState.state1.posY > bottom )
	{
		piState.forceY1 += -100;
		piState.state1.velY = 0;
	}

	piState.state0.stress += piState.forceX0 * -directionX + piState.forceY0 * -directionY;
	piState.state1.stress += piState.forceX1 * directionX + piState.forceY1 * directionY;
}

function SpringPhysics_UpdatePhysicsConstantTimeStep( deltaTime )
{
	var ConstantTimeStep = 0.004; 	// 250 Hz update Frequency
	/// Update at constant time interval.

	deltaTime = Math.min( deltaTime, 0.1 );  // avoid feedback slowdown
	this.time += deltaTime;
	this.timeAccumulator += deltaTime;
	while ( this.timeAccumulator >= ConstantTimeStep )
	{
		this.UpdatePhysics( ConstantTimeStep );
		this.timeAccumulator -= ConstantTimeStep;
	}
}



function MidPointintegrate( piState, dt, bottom )
{
	/*
	The main idea behind the midpoint method is that the derivative at the midpoint is a
	better estimate of the "true" derivative than the derivative at either endpoint.

	Of course you don't have the exact midpoint, so you estimate that too by taking a half-step.
	Then you compute the derivative at the midpoint and use this to take the full step.

	x_mid = x_n + dt/2 * f(x_n, t_n)
	t_mid = t_n + dt/2

	x_n+1 = x_n + dt * f(x_mid, t_mid)
	t_n+1 = t_n + dt
	*/

	var posX0 = piState.state0.posX;
	var posY0 = piState.state0.posY;
	var posX1 = piState.state1.posX;
	var posY1 = piState.state1.posY;

	// half state
	ComputeForces( piState, bottom );

	var halfStepDeltaTime = dt * 0.5;

	var forceToDistance0 = piState.state0.inverseMass * halfStepDeltaTime * halfStepDeltaTime;
	piState.state0.posX += piState.forceX0 * forceToDistance0;
	piState.state0.posY += piState.forceY0 * forceToDistance0;

	var forceToDistance1 = piState.state1.inverseMass * halfStepDeltaTime * halfStepDeltaTime;
	piState.state1.posX += piState.forceX1 * forceToDistance1;
	piState.state1.posY += piState.forceY1 * forceToDistance1;

	piState.state0.stress = 0.0;
	piState.state1.stress = 0.0;

	// full state based on half step
	ComputeForces(piState, bottom);

	piState.state0.posX = posX0;
	piState.state0.posY = posY0;
	piState.state1.posX = posX1;
	piState.state1.posY = posY1;

	forceFactor0 = piState.state0.inverseMass * dt;
	piState.state0.velX += piState.forceX0 * forceFactor0;
	piState.state0.velY += piState.forceY0 * forceFactor0;

	forceFactor1 = piState.state1.inverseMass * dt;
	piState.state1.velX += piState.forceX1 * forceFactor1;
	piState.state1.velY += piState.forceY1 * forceFactor1;
}

function IntegrateAngularConstraint( angularC, particleStates, dt )
{
	var tightness = 1000.0;
	var damping = 100.0;

	var state0 = particleStates[angularC.particleIndex0];
	var state1 = particleStates[angularC.particleIndex1];
	var state2 = particleStates[angularC.particleIndex2];

	var dirX0 = state0.posX - state1.posX;
	var dirY0 = state0.posY - state1.posY;
	var dirX1 = state2.posX - state0.posX;
	var dirY1 = state2.posY - state0.posY;
	var dirX2 = state2.posX - state1.posX;
	var dirY2 = state2.posY - state1.posY;

	var currentAngle = Math.atan2( dirY0, dirX0 ) - Math.atan2( dirY2, dirX2 );
	while ( currentAngle > Math.PI * 2 ) { currentAngle -= Math.PI * 2; }
	while ( currentAngle < 0 ) { currentAngle += Math.PI * 2; }
	var angleDelta = angularC.targetAngle - currentAngle;
	while ( angleDelta > Math.PI ) { angleDelta -= Math.PI * 2; }
	while ( angleDelta < -Math.PI ) { angleDelta += Math.PI * 2; }

	var strength = angleDelta * tightness * dt * angularC.tightnessFactor;
	var invDistance0 = strength * state0.inverseMass / Math.sqrt( dirX0 * dirX0 + dirY0 * dirY0 );
	var invDistance1 = strength * state1.inverseMass / Math.sqrt( dirX1 * dirX1 + dirY1 * dirY1 ) * 2.0;	// center vertex has to compensate for both adjacent vertices, thus 2x
	var invDistance2 = strength * state2.inverseMass / Math.sqrt( dirX2 * dirX2 + dirY2 * dirY2 );

	var fDirX0 = -dirY0 * invDistance0;
	var fDirY0 = dirX0 * invDistance0;
	var fDirX1 = -dirY1 * invDistance1;
	var fDirY1 = dirX1 * invDistance1;
	var fDirX2 = dirY2 * invDistance2;
	var fDirY2 = -dirX2 * invDistance2;

	var angleSpeed = currentAngle - angularC.lastAngle;
	while ( angleSpeed > Math.PI ) { angleSpeed -= Math.PI * 2; }
	while ( angleSpeed < -Math.PI ) { angleSpeed += Math.PI * 2; }
	var speedDamping = Math.min( 0.5, Math.pow( ( ( angleDelta * angleSpeed ) > 0 ? Math.abs( angleDelta ) * 3 : 0.0 ), 3 ) * damping * dt );

	// apply force to velocity
	{
		state0.velX += fDirX0 - state0.velX * speedDamping;
		state0.velY += fDirY0 - state0.velY * speedDamping;
		state1.velX += fDirX1 - state1.velX * speedDamping;
		state1.velY += fDirY1 - state1.velY * speedDamping;
		state2.velX += fDirX2 - state2.velX * speedDamping;
		state2.velY += fDirY2 - state2.velY * speedDamping;
	}

	angularC.lastAngle = currentAngle;
}

/// Update physics state.
function SpringPhysics_UpdatePhysics(deltaTime) 
{
	var n = 0; 
	var bottom = 500;

	for (n = 0; n < this.distanceConstraints.length; n++ )
	{
		var c = this.distanceConstraints[n];

		var piState = new ParticleIntermediateState();
		piState.state0 = this.particleStates[c.particleIndex0];
		piState.state1 = this.particleStates[c.particleIndex1];
		piState.targetDistance = c.distance;
		piState.forceX0 = 0.0;
		piState.forceY0 = 0.0;
		piState.forceX1 = 0.0;
		piState.forceY1 = 0.0;

		MidPointintegrate( piState, deltaTime, bottom );

		/*if ( Math.abs( piState.state0.stress ) > 10000 )
		{	// cut on extreme forces
			this.distanceConstraints.splice( n, 1 );
			n--;
		}*/
	}

	for ( n = 0; n < this.angularConstraints.length; n++ )
	{
		var c = this.angularConstraints[n];

		IntegrateAngularConstraint( c, this.particleStates, deltaTime );
	}

	for ( n = 0; n < this.fixedConstraints.length; n++ )
	{
		var c = this.fixedConstraints[n];

		if ( c.isEnabled )
		{
			var state = this.particleStates[c.particleIndex];
			state.posX = c.posX;
			state.posY = c.posY;

			state.velX = 0;
			state.velY = 0;
		}
	}

	for ( n = 0; n < this.particleStates.length; n++ )
	{
		var state = this.particleStates[n];

		state.posX += deltaTime * state.velX;
		state.posY += deltaTime * state.velY;
	}

	if ( this.time < 1.0 )
	{
		this.CancelVelocities();
	}
}

SpringPhysics_CancelVelocities = function()
{
	var n;
	for ( n = 0; n < this.particleStates.length; n++ )
	{
		var state = this.particleStates[n];

		state.velX = 0;
		state.velY = 0;
	}
}

function SpringPhysics()
{
	this.particleStates = [];
	this.distanceConstraints = [];
	this.fixedConstraints = [];
	this.angularConstraints = [];

	this.time = 0.0;
	this.timeAccumulator = 0.0;


	// Methods

	this.Update = SpringPhysics_Update;

	this.UpdatePhysicsConstantTimeStep = SpringPhysics_UpdatePhysicsConstantTimeStep;
	this.UpdatePhysics = SpringPhysics_UpdatePhysics;

	this.CreateParticle = SpringPhysics_CreateParticle;
	this.CreateDistanceConstraint = SpringPhysics_CreateDistanceConstraint;
	this.CreateFixedConstraint = SpringPhysics_CreateFixedConstraint;
	this.CreateAngularConstraint = SpringPhysics_CreateAngularConstraint;

	this.CancelVelocities = SpringPhysics_CancelVelocities;
}
