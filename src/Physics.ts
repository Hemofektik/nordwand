// TODO: put computations in web worker

import { GetAngleBetweenVertices } from "./MathUtils.ts";

export class PhysicalParticleState {
    public posX = 0;
    public posY = 0;

    public velX = 0;
    public velY = 0;

    public mass = 0.05;
    public inverseMass = 20; //< inverse of the mass used to add force to velocity.

    public stress = 0;

    public friction = 0.997;
}

export class DistanceConstraint {
    public particleIndex0 = 0;
    public particleIndex1 = 0;
    public distance = 0;
    public bendFactor = 0;
    public compressionFactor = 0;
}

export class FixedConstraint {
    public particleIndex = 0;
    public posX = 0;
    public posY = 0;
    public isEnabled = false;
    public wallAnchorIndex = -1;
}

export class AngularConstraint {
    public particleIndex0 = 0;
    public particleIndex1 = 0;
    public particleIndex2 = 0;
    public lastAngle = 0;
    public targetAngle = 0;
    public tightnessFactor = 1;
}

class ParticleIntermediateState {
    public state0!: PhysicalParticleState;
    public state1!: PhysicalParticleState;
    public targetDistance = 0;
    public forceX0 = 0;
    public forceY0 = 0;
    public forceX1 = 0;
    public forceY1 = 0;
}

function computeForces(piState: ParticleIntermediateState, bottom: number): void {
    const gravity = 80.0;
    piState.forceX0 = 0.0;
    piState.forceY0 = gravity * piState.state0.mass;
    piState.forceX1 = 0.0;
    piState.forceY1 = gravity * piState.state1.mass;

    // F = -k(|x|-d)(x/|x|) - bv

    const tightness = 5000.0;
    const tightness0 = tightness;
    const tightness1 = tightness;
    const Damping = 0.1;
    const AirFriction = 0.01;

    const positionDeltaX = piState.state0.posX - piState.state1.posX;
    const positionDeltaY = piState.state0.posY - piState.state1.posY;
    const distance = Math.sqrt(positionDeltaX * positionDeltaX + positionDeltaY * positionDeltaY);
    // hoisted to function scope: the legacy code (var) also uses them for the
    // stress accumulation below, where they read 0 when the branch skipped
    let directionX = 0;
    let directionY = 0;
    if (Math.abs(distance) > 0.001) {
        const invDistance = 1.0 / distance;
        directionX = positionDeltaX * invDistance;
        directionY = positionDeltaY * invDistance;

        const dampingX = (piState.state0.velX - piState.state1.velX) * Damping;
        const dampingY = (piState.state0.velY - piState.state1.velY) * Damping;

        const f0 = (distance - piState.targetDistance) * tightness0;
        const f1 = (distance - piState.targetDistance) * tightness1;

        piState.forceX0 += f0 * -directionX - dampingX - piState.state0.velX * AirFriction;
        piState.forceY0 += f0 * -directionY - dampingY - piState.state0.velY * AirFriction;
        piState.forceX1 += f1 * directionX + dampingX - piState.state1.velX * AirFriction;
        piState.forceY1 += f1 * directionY + dampingY - piState.state1.velY * AirFriction;
    }

    if (piState.state0.posY > bottom) {
        piState.forceY0 += -100;
        piState.state0.velY = 0;
    }
    if (piState.state1.posY > bottom) {
        piState.forceY1 += -100;
        piState.state1.velY = 0;
    }

    piState.state0.stress += piState.forceX0 * -directionX + piState.forceY0 * -directionY;
    piState.state1.stress += piState.forceX1 * directionX + piState.forceY1 * directionY;
}

function midPointIntegrate(piState: ParticleIntermediateState, dt: number, bottom: number): void {
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

    const posX0 = piState.state0.posX;
    const posY0 = piState.state0.posY;
    const posX1 = piState.state1.posX;
    const posY1 = piState.state1.posY;

    // half state
    computeForces(piState, bottom);

    const halfStepDeltaTime = dt * 0.5;

    const forceToDistance0 = piState.state0.inverseMass * halfStepDeltaTime * halfStepDeltaTime;
    piState.state0.posX += piState.forceX0 * forceToDistance0;
    piState.state0.posY += piState.forceY0 * forceToDistance0;

    const forceToDistance1 = piState.state1.inverseMass * halfStepDeltaTime * halfStepDeltaTime;
    piState.state1.posX += piState.forceX1 * forceToDistance1;
    piState.state1.posY += piState.forceY1 * forceToDistance1;

    piState.state0.stress = 0.0;
    piState.state1.stress = 0.0;

    // full state based on half step
    computeForces(piState, bottom);

    piState.state0.posX = posX0;
    piState.state0.posY = posY0;
    piState.state1.posX = posX1;
    piState.state1.posY = posY1;

    const forceFactor0 = piState.state0.inverseMass * dt;
    piState.state0.velX += piState.forceX0 * forceFactor0;
    piState.state0.velY += piState.forceY0 * forceFactor0;

    const forceFactor1 = piState.state1.inverseMass * dt;
    piState.state1.velX += piState.forceX1 * forceFactor1;
    piState.state1.velY += piState.forceY1 * forceFactor1;
}

function integrateAngularConstraint(angularC: AngularConstraint, particleStates: PhysicalParticleState[], dt: number): void {
    const tightness = 1000.0;
    const damping = 100.0;

    const state0 = particleStates[angularC.particleIndex0];
    const state1 = particleStates[angularC.particleIndex1];
    const state2 = particleStates[angularC.particleIndex2];
    if (state0 === undefined || state1 === undefined || state2 === undefined) {
        return;
    }

    const dirX0 = state0.posX - state1.posX;
    const dirY0 = state0.posY - state1.posY;
    const dirX1 = state2.posX - state0.posX;
    const dirY1 = state2.posY - state0.posY;
    const dirX2 = state2.posX - state1.posX;
    const dirY2 = state2.posY - state1.posY;

    const currentAngle = Math.atan2(dirY0, dirX0) - Math.atan2(dirY2, dirX2);
    let angleDelta = angularC.targetAngle - currentAngle;
    while (angleDelta > Math.PI) {
        angleDelta -= Math.PI * 2;
    }
    while (angleDelta < -Math.PI) {
        angleDelta += Math.PI * 2;
    }

    const strength = angleDelta * tightness * dt * angularC.tightnessFactor;
    const invDistance0 = (strength * state0.inverseMass) / Math.sqrt(dirX0 * dirX0 + dirY0 * dirY0);
    // center vertex has to compensate for both adjacent vertices, thus 2x
    const invDistance1 = ((strength * state1.inverseMass) / Math.sqrt(dirX1 * dirX1 + dirY1 * dirY1)) * 2.0;
    const invDistance2 = (strength * state2.inverseMass) / Math.sqrt(dirX2 * dirX2 + dirY2 * dirY2);

    const fDirX0 = -dirY0 * invDistance0;
    const fDirY0 = dirX0 * invDistance0;
    const fDirX1 = -dirY1 * invDistance1;
    const fDirY1 = dirX1 * invDistance1;
    const fDirX2 = dirY2 * invDistance2;
    const fDirY2 = -dirX2 * invDistance2;

    let angleSpeed = currentAngle - angularC.lastAngle;
    while (angleSpeed > Math.PI) {
        angleSpeed -= Math.PI * 2;
    }
    while (angleSpeed < -Math.PI) {
        angleSpeed += Math.PI * 2;
    }
    const speedDamping = Math.min(0.5, Math.pow(angleDelta * angleSpeed > 0 ? Math.abs(angleDelta) * 3 : 0.0, 3) * damping * dt);

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

export class SpringPhysics {
    public particleStates: PhysicalParticleState[] = [];
    public distanceConstraints: DistanceConstraint[] = [];
    public fixedConstraints: FixedConstraint[] = [];
    public angularConstraints: AngularConstraint[] = [];

    public time = 0.0;
    public timeAccumulator = 0.0;

    public update(deltaTime: number): boolean {
        return this.updatePhysicsConstantTimeStep(deltaTime);
    }

    public createParticle(posX: number, posY: number): number {
        const pps = new PhysicalParticleState();

        pps.posX = posX;
        pps.posY = posY;

        this.particleStates.push(pps);

        return this.particleStates.length - 1;
    }

    public createDistanceConstraint(particleIndex0: number, particleIndex1: number): number {
        const particle0 = this.particleStates[particleIndex0]!;
        const particle1 = this.particleStates[particleIndex1]!;

        const deltaX = particle0.posX - particle1.posX;
        const deltaY = particle0.posY - particle1.posY;

        const c = new DistanceConstraint();
        c.particleIndex0 = particleIndex0;
        c.particleIndex1 = particleIndex1;
        c.distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        c.bendFactor = 0.2;
        c.compressionFactor = 0.2;

        this.distanceConstraints.push(c);

        return this.distanceConstraints.length - 1;
    }

    public createFixedConstraint(particleIndex: number): number {
        const c = new FixedConstraint();
        c.particleIndex = particleIndex;
        const particle = this.particleStates[particleIndex]!;
        c.posX = particle.posX;
        c.posY = particle.posY;
        c.isEnabled = true;
        c.wallAnchorIndex = -1;

        this.fixedConstraints.push(c);

        return this.fixedConstraints.length - 1;
    }

    public createAngularConstraint(particleIndex0: number, particleIndex1: number, particleIndex2: number): number {
        const c = new AngularConstraint();
        c.particleIndex0 = particleIndex0;
        c.particleIndex1 = particleIndex1;
        c.particleIndex2 = particleIndex2;
        c.targetAngle = GetAngleBetweenVertices(
            this.particleStates[particleIndex0]!,
            this.particleStates[particleIndex1]!,
            this.particleStates[particleIndex2]!,
        );
        c.lastAngle = c.targetAngle;
        c.tightnessFactor = 1.0;

        this.angularConstraints.push(c);

        return this.angularConstraints.length - 1;
    }

    public cancelVelocities(): void {
        for (const state of this.particleStates) {
            state.velX = 0;
            state.velY = 0;
        }
    }

    public updatePhysicsConstantTimeStep(deltaTime: number): boolean {
        const physicsIsReady = false;
        const constantTimeStep = 0.004; // 250 Hz update Frequency
        /// Update at constant time interval.

        deltaTime = Math.min(deltaTime, 0.1); // avoid feedback slowdown
        this.time += deltaTime;
        this.timeAccumulator += deltaTime;
        let ready = physicsIsReady;
        while (this.timeAccumulator >= constantTimeStep) {
            ready = ready || this.updatePhysics(constantTimeStep);
            this.timeAccumulator -= constantTimeStep;
        }

        return ready;
    }

    /// Update physics state.
    public updatePhysics(deltaTime: number): boolean {
        const bottom = 500;

        for (const c of this.distanceConstraints) {
            const piState = new ParticleIntermediateState();
            piState.state0 = this.particleStates[c.particleIndex0]!;
            piState.state1 = this.particleStates[c.particleIndex1]!;
            piState.targetDistance = c.distance;
            piState.forceX0 = 0.0;
            piState.forceY0 = 0.0;
            piState.forceX1 = 0.0;
            piState.forceY1 = 0.0;

            midPointIntegrate(piState, deltaTime, bottom);

            /*if (Math.abs(piState.state0.stress) > 10000) {
                // cut on extreme forces
                this.distanceConstraints.splice(this.distanceConstraints.indexOf(c), 1);
            }*/
        }

        for (const c of this.angularConstraints) {
            integrateAngularConstraint(c, this.particleStates, deltaTime);
        }

        for (const c of this.fixedConstraints) {
            if (c.isEnabled) {
                const state = this.particleStates[c.particleIndex]!;
                state.posX = c.posX;
                state.posY = c.posY;

                state.velX = 0;
                state.velY = 0;
            }
        }

        for (const state of this.particleStates) {
            state.posX += deltaTime * state.velX;
            state.posY += deltaTime * state.velY;
        }

        if (this.time < 1.0) {
            this.cancelVelocities();
            return false;
        }

        return true;
    }
}
