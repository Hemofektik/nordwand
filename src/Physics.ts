import type { Wall } from "./Wall.ts";

export class PhysicalParticleState {
    public posX = 0;
    public posY = 0;

    public velX = 0;
    public velY = 0;

    public mass = 0.05;
    public inverseMass = 20;

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

export class ParticleIntermediateState {
    public state0: PhysicalParticleState;
    public state1: PhysicalParticleState;
    public targetDistance = 0;
    public forceX0 = 0;
    public forceY0 = 0;
    public forceX1 = 0;
    public forceY1 = 0;

    public constructor(state0: PhysicalParticleState, state1: PhysicalParticleState) {
        this.state0 = state0;
        this.state1 = state1;
    }
}

function computeForces(piState: ParticleIntermediateState, bottom: number): void {
    const gravity = 80.0;
    piState.forceX0 = 0.0;
    piState.forceY0 = gravity * piState.state0.mass;
    piState.forceX1 = 0.0;
    piState.forceY1 = gravity * piState.state1.mass;

    const tightness = 5000.0;
    const tightness0 = tightness;
    const tightness1 = tightness;
    const damping = 0.1;
    const airFriction = 0.01;

    const positionDeltaX = piState.state0.posX - piState.state1.posX;
    const positionDeltaY = piState.state0.posY - piState.state1.posY;
    const distance = Math.sqrt(positionDeltaX * positionDeltaX + positionDeltaY * positionDeltaY);

    let directionX = 0;
    let directionY = 0;

    if (Math.abs(distance) > 0.001) {
        const invDistance = 1.0 / distance;
        directionX = positionDeltaX * invDistance;
        directionY = positionDeltaY * invDistance;

        const dampingX = (piState.state0.velX - piState.state1.velX) * damping;
        const dampingY = (piState.state0.velY - piState.state1.velY) * damping;

        const f0 = (distance - piState.targetDistance) * tightness0;
        const f1 = (distance - piState.targetDistance) * tightness1;

        piState.forceX0 += f0 * -directionX - dampingX - piState.state0.velX * airFriction;
        piState.forceY0 += f0 * -directionY - dampingY - piState.state0.velY * airFriction;
        piState.forceX1 += f1 * directionX + dampingX - piState.state1.velX * airFriction;
        piState.forceY1 += f1 * directionY + dampingY - piState.state1.velY * airFriction;
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
    const posX0 = piState.state0.posX;
    const posY0 = piState.state0.posY;
    const posX1 = piState.state1.posX;
    const posY1 = piState.state1.posY;

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

function integrateAngularConstraint(
    angularC: AngularConstraint,
    particleStates: readonly PhysicalParticleState[],
    dt: number,
): void {
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

    let currentAngle = Math.atan2(dirY0, dirX0) - Math.atan2(dirY2, dirX2);
    while (currentAngle > Math.PI * 2) {
        currentAngle -= Math.PI * 2;
    }
    while (currentAngle < 0) {
        currentAngle += Math.PI * 2;
    }
    let angleDelta = angularC.targetAngle - currentAngle;
    while (angleDelta > Math.PI) {
        angleDelta -= Math.PI * 2;
    }
    while (angleDelta < -Math.PI) {
        angleDelta += Math.PI * 2;
    }

    const strength = angleDelta * tightness * dt * angularC.tightnessFactor;
    const invDistance0 = (strength * state0.inverseMass) / Math.sqrt(dirX0 * dirX0 + dirY0 * dirY0);
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
    const speedDamping = Math.min(
        0.5,
        Math.pow((angleDelta * angleSpeed > 0 ? Math.abs(angleDelta) * 3 : 0.0), 3) * damping * dt,
    );

    state0.velX += fDirX0 - state0.velX * speedDamping;
    state0.velY += fDirY0 - state0.velY * speedDamping;
    state1.velX += fDirX1 - state1.velX * speedDamping;
    state1.velY += fDirY1 - state1.velY * speedDamping;
    state2.velX += fDirX2 - state2.velX * speedDamping;
    state2.velY += fDirY2 - state2.velY * speedDamping;

    angularC.lastAngle = currentAngle;
}

export class SpringPhysics {
    public particleStates: PhysicalParticleState[] = [];
    public distanceConstraints: DistanceConstraint[] = [];
    public fixedConstraints: FixedConstraint[] = [];
    public angularConstraints: AngularConstraint[] = [];

    public time = 0.0;
    public timeAccumulator = 0.0;
    public wall: Wall | undefined;

    public createParticle(posX: number, posY: number): number {
        const pps = new PhysicalParticleState();
        pps.posX = posX;
        pps.posY = posY;
        this.particleStates.push(pps);
        return this.particleStates.length - 1;
    }

    public createDistanceConstraint(particleIndex0: number, particleIndex1: number): number {
        const particle0 = this.particleStates[particleIndex0];
        const particle1 = this.particleStates[particleIndex1];
        if (particle0 === undefined || particle1 === undefined) {
            throw new Error("Cannot create distance constraint for missing particles");
        }

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
        const particle = this.particleStates[particleIndex];
        if (particle === undefined) {
            throw new Error("Cannot create fixed constraint for missing particle");
        }

        const c = new FixedConstraint();
        c.particleIndex = particleIndex;
        c.posX = particle.posX;
        c.posY = particle.posY;
        c.isEnabled = true;
        c.wallAnchorIndex = -1;

        this.fixedConstraints.push(c);
        return this.fixedConstraints.length - 1;
    }

    public createAngularConstraint(particleIndex0: number, particleIndex1: number, particleIndex2: number): number {
        const particle0 = this.particleStates[particleIndex0];
        const particle1 = this.particleStates[particleIndex1];
        const particle2 = this.particleStates[particleIndex2];
        if (particle0 === undefined || particle1 === undefined || particle2 === undefined) {
            throw new Error("Cannot create angular constraint for missing particles");
        }

        const dirX0 = particle0.posX - particle1.posX;
        const dirY0 = particle0.posY - particle1.posY;
        const dirX1 = particle2.posX - particle1.posX;
        const dirY1 = particle2.posY - particle1.posY;

        const c = new AngularConstraint();
        c.particleIndex0 = particleIndex0;
        c.particleIndex1 = particleIndex1;
        c.particleIndex2 = particleIndex2;
        c.targetAngle = Math.atan2(dirY0, dirX0) - Math.atan2(dirY1, dirX1);
        c.lastAngle = c.targetAngle;
        c.tightnessFactor = 1.0;

        while (c.targetAngle > Math.PI * 2) {
            c.targetAngle -= Math.PI * 2;
        }
        while (c.targetAngle < 0) {
            c.targetAngle += Math.PI * 2;
        }

        this.angularConstraints.push(c);
        return this.angularConstraints.length - 1;
    }

    public update(deltaTime: number): void {
        this.updatePhysicsConstantTimeStep(deltaTime);
    }

    public updatePhysicsConstantTimeStep(deltaTime: number): void {
        const constantTimeStep = 0.004;

        deltaTime = Math.min(deltaTime, 0.1);
        this.time += deltaTime;
        this.timeAccumulator += deltaTime;
        while (this.timeAccumulator >= constantTimeStep) {
            this.updatePhysics(constantTimeStep);
            this.timeAccumulator -= constantTimeStep;
        }
    }

    public updatePhysics(deltaTime: number): void {
        const bottom = 500;

        for (const c of this.distanceConstraints) {
            const state0 = this.particleStates[c.particleIndex0];
            const state1 = this.particleStates[c.particleIndex1];
            if (state0 === undefined || state1 === undefined) {
                continue;
            }

            const piState = new ParticleIntermediateState(state0, state1);
            piState.targetDistance = c.distance;
            midPointIntegrate(piState, deltaTime, bottom);
        }

        for (const c of this.angularConstraints) {
            integrateAngularConstraint(c, this.particleStates, deltaTime);
        }

        this.applyFixedConstraints();

        for (const state of this.particleStates) {
            state.posX += deltaTime * state.velX;
            state.posY += deltaTime * state.velY;
        }

        if (this.wall !== undefined) {
            for (const state of this.particleStates) {
                this.wall.collideParticle(state);
            }
            this.applyFixedConstraints();
        }

        if (this.time < 1.0) {
            this.cancelVelocities();
        }
    }

    public applyFixedConstraints(): void {
        for (const c of this.fixedConstraints) {
            if (!c.isEnabled) {
                continue;
            }

            const state = this.particleStates[c.particleIndex];
            if (state === undefined) {
                continue;
            }

            state.posX = c.posX;
            state.posY = c.posY;
            state.velX = 0;
            state.velY = 0;
        }
    }

    public cancelVelocities(): void {
        for (const state of this.particleStates) {
            state.velX = 0;
            state.velY = 0;
        }
    }
}
