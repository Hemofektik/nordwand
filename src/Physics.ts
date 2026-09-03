import {
    type b2Body,
    type b2DistanceJoint,
    b2BodyType,
    b2CircleShape,
    b2DistanceJointDef,
    b2LinearStiffness,
    b2MassData,
    b2World,
} from "@box2d/core";
import type { Wall } from "./Wall.ts";

const PIXELS_TO_METERS = 0.05;
const METERS_TO_PIXELS = 1 / PIXELS_TO_METERS;
const GRAVITY_PX = 80;
const TIME_STEP = 0.004;
const VELOCITY_ITERATIONS = 8;
const POSITION_ITERATIONS = 3;
const DISTANCE_FREQUENCY_HZ = 12;
const DISTANCE_DAMPING_RATIO = 0.7;
const PARTICLE_RADIUS_PX = 3;
const LINEAR_DAMPING = 0.2;
const BOTTOM_PX = 500;
const POS_EPSILON_PX = 0.05;
const VEL_EPSILON_PX = 0.05;
const ANGULAR_TIGHTNESS = 1000;
const ANGULAR_DAMPING = 100;

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

function wrapAngle0To2Pi(angle: number): number {
    while (angle > Math.PI * 2) {
        angle -= Math.PI * 2;
    }
    while (angle < 0) {
        angle += Math.PI * 2;
    }
    return angle;
}

function wrapAngleNegPiToPi(angle: number): number {
    while (angle > Math.PI) {
        angle -= Math.PI * 2;
    }
    while (angle < -Math.PI) {
        angle += Math.PI * 2;
    }
    return angle;
}

function toMeters(pixels: number): number {
    return pixels * PIXELS_TO_METERS;
}

function toPixels(meters: number): number {
    return meters * METERS_TO_PIXELS;
}

export class SpringPhysics {
    public particleStates: PhysicalParticleState[] = [];
    public distanceConstraints: DistanceConstraint[] = [];
    public fixedConstraints: FixedConstraint[] = [];
    public angularConstraints: AngularConstraint[] = [];

    public time = 0.0;
    public timeAccumulator = 0.0;
    public wall: Wall | undefined;

    private readonly world: b2World;
    private readonly bodies: b2Body[] = [];
    private readonly distanceJoints: b2DistanceJoint[] = [];
    private readonly pinned: boolean[] = [];
    private readonly massData = new b2MassData();
    private readonly particleShape = new b2CircleShape(toMeters(PARTICLE_RADIUS_PX));

    public constructor() {
        this.world = b2World.Create({ x: 0, y: toMeters(GRAVITY_PX) });
    }

    public createParticle(posX: number, posY: number): number {
        const pps = new PhysicalParticleState();
        pps.posX = posX;
        pps.posY = posY;
        this.particleStates.push(pps);

        const body = this.world.CreateBody({
            type: b2BodyType.b2_dynamicBody,
            position: { x: toMeters(posX), y: toMeters(posY) },
            fixedRotation: true,
            linearDamping: LINEAR_DAMPING,
            allowSleep: false,
            awake: true,
            bullet: false,
        });
        body.CreateFixture({
            shape: this.particleShape,
            density: 1,
            friction: 0.2,
            restitution: 0,
            filter: {
                categoryBits: 1,
                maskBits: 0,
                groupIndex: -1,
            },
        });
        this.applyMass(body, pps.mass);
        this.bodies.push(body);
        this.pinned.push(false);
        return this.particleStates.length - 1;
    }

    public createDistanceConstraint(particleIndex0: number, particleIndex1: number): number {
        const particle0 = this.particleStates[particleIndex0];
        const particle1 = this.particleStates[particleIndex1];
        const body0 = this.bodies[particleIndex0];
        const body1 = this.bodies[particleIndex1];
        if (particle0 === undefined || particle1 === undefined || body0 === undefined || body1 === undefined) {
            throw new Error("Cannot create distance constraint for missing particles");
        }

        this.syncMass(particleIndex0);
        this.syncMass(particleIndex1);

        const deltaX = particle0.posX - particle1.posX;
        const deltaY = particle0.posY - particle1.posY;

        const c = new DistanceConstraint();
        c.particleIndex0 = particleIndex0;
        c.particleIndex1 = particleIndex1;
        c.distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        c.bendFactor = 0.2;
        c.compressionFactor = 0.2;

        const def = new b2DistanceJointDef();
        def.Initialize(body0, body1, body0.GetPosition(), body1.GetPosition());
        b2LinearStiffness(def, DISTANCE_FREQUENCY_HZ, DISTANCE_DAMPING_RATIO, body0, body1);
        const restLength = Math.max(toMeters(c.distance), 0.01);
        def.length = restLength;
        def.minLength = restLength * 0.85;
        def.maxLength = restLength * 1.15;

        this.distanceJoints.push(this.world.CreateJoint(def));
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
        c.targetAngle = wrapAngle0To2Pi(Math.atan2(dirY0, dirX0) - Math.atan2(dirY1, dirX1));
        c.lastAngle = c.targetAngle;
        c.tightnessFactor = 1.0;

        this.angularConstraints.push(c);
        return this.angularConstraints.length - 1;
    }

    public update(deltaTime: number): void {
        this.updatePhysicsConstantTimeStep(deltaTime);
    }

    public settle(duration = 8.0): void {
        const minSteps = Math.ceil(2.0 / TIME_STEP);
        const maxSteps = Math.ceil(duration / TIME_STEP);
        const restSpeed = 0.05;
        const damping = 0.88;

        this.time = Math.max(this.time, 1.0);
        for (let n = 0; n < maxSteps; n++) {
            this.updatePhysics(TIME_STEP);

            let maxSpeed = 0;
            for (const state of this.particleStates) {
                state.velX *= damping;
                state.velY *= damping;
                maxSpeed = Math.max(maxSpeed, Math.hypot(state.velX, state.velY));
            }
            this.pushVelocitiesToWorld();

            if (n + 1 >= minSteps && maxSpeed < restSpeed) {
                break;
            }
        }

        this.time = Math.max(this.time, duration);
        this.timeAccumulator = 0;
        this.cancelVelocities();
    }

    public updatePhysicsConstantTimeStep(deltaTime: number): void {
        deltaTime = Math.min(deltaTime, 0.1);
        this.time += deltaTime;
        this.timeAccumulator += deltaTime;
        while (this.timeAccumulator >= TIME_STEP) {
            this.updatePhysics(TIME_STEP);
            this.timeAccumulator -= TIME_STEP;
        }
    }

    public updatePhysics(deltaTime: number): void {
        this.pushStatesToWorld();
        this.syncDistanceJoints();
        this.syncFixedConstraints();
        this.applyAngularConstraints(deltaTime);

        this.world.Step(deltaTime, {
            velocityIterations: VELOCITY_ITERATIONS,
            positionIterations: POSITION_ITERATIONS,
        });

        this.pullStatesFromWorld();
        this.collideWallAndFloor();
        this.applyFixedConstraints();

        if (this.time < 1.0) {
            this.cancelVelocities();
        }
    }

    public applyFixedConstraints(): void {
        this.syncFixedConstraints();
        for (const c of this.fixedConstraints) {
            if (!c.isEnabled) {
                continue;
            }

            const state = this.particleStates[c.particleIndex];
            const body = this.bodies[c.particleIndex];
            if (state === undefined || body === undefined) {
                continue;
            }

            state.posX = c.posX;
            state.posY = c.posY;
            state.velX = 0;
            state.velY = 0;
            body.SetTransformXY(toMeters(c.posX), toMeters(c.posY), 0);
            body.SetLinearVelocity({ x: 0, y: 0 });
            body.SetAwake(true);
        }
    }

    public cancelVelocities(): void {
        for (let i = 0; i < this.particleStates.length; i++) {
            const state = this.particleStates[i];
            const body = this.bodies[i];
            if (state === undefined || body === undefined) {
                continue;
            }
            state.velX = 0;
            state.velY = 0;
            body.SetLinearVelocity({ x: 0, y: 0 });
            body.SetAwake(true);
        }
    }

    private applyMass(body: b2Body, mass: number): void {
        const safeMass = Math.max(mass, 0.001);
        this.massData.mass = safeMass;
        this.massData.I = 1;
        this.massData.center.Set(0, 0);
        body.SetMassData(this.massData);
    }

    private syncMass(particleIndex: number): void {
        const state = this.particleStates[particleIndex];
        const body = this.bodies[particleIndex];
        if (state === undefined || body === undefined) {
            return;
        }
        if (Math.abs(body.GetMass() - state.mass) > 1e-8) {
            this.applyMass(body, state.mass);
        }
    }

    private pushStatesToWorld(): void {
        for (let i = 0; i < this.particleStates.length; i++) {
            if (this.pinned[i] === true) {
                continue;
            }

            const state = this.particleStates[i];
            const body = this.bodies[i];
            if (state === undefined || body === undefined) {
                continue;
            }

            this.syncMass(i);

            const bodyPos = body.GetPosition();
            const bodyVel = body.GetLinearVelocity();
            const posX = toPixels(bodyPos.x);
            const posY = toPixels(bodyPos.y);
            const velX = toPixels(bodyVel.x);
            const velY = toPixels(bodyVel.y);

            if (Math.abs(state.posX - posX) > POS_EPSILON_PX || Math.abs(state.posY - posY) > POS_EPSILON_PX) {
                body.SetTransformXY(toMeters(state.posX), toMeters(state.posY), 0);
                body.SetAwake(true);
            }
            if (Math.abs(state.velX - velX) > VEL_EPSILON_PX || Math.abs(state.velY - velY) > VEL_EPSILON_PX) {
                body.SetLinearVelocity({ x: toMeters(state.velX), y: toMeters(state.velY) });
                body.SetAwake(true);
            }
        }
    }

    private pushVelocitiesToWorld(): void {
        for (let i = 0; i < this.particleStates.length; i++) {
            if (this.pinned[i] === true) {
                continue;
            }

            const state = this.particleStates[i];
            const body = this.bodies[i];
            if (state === undefined || body === undefined) {
                continue;
            }
            body.SetLinearVelocity({ x: toMeters(state.velX), y: toMeters(state.velY) });
            body.SetAwake(true);
        }
    }

    private pullStatesFromWorld(): void {
        for (let i = 0; i < this.particleStates.length; i++) {
            const state = this.particleStates[i];
            const body = this.bodies[i];
            if (state === undefined || body === undefined) {
                continue;
            }
            const bodyPos = body.GetPosition();
            const bodyVel = body.GetLinearVelocity();
            state.posX = toPixels(bodyPos.x);
            state.posY = toPixels(bodyPos.y);
            state.velX = toPixels(bodyVel.x);
            state.velY = toPixels(bodyVel.y);
        }
    }

    private syncDistanceJoints(): void {
        for (let i = 0; i < this.distanceConstraints.length; i++) {
            const c = this.distanceConstraints[i];
            const joint = this.distanceJoints[i];
            if (c === undefined || joint === undefined) {
                continue;
            }
            const restLength = Math.max(toMeters(c.distance), 0.01);
            if (Math.abs(joint.GetLength() - restLength) > 1e-6) {
                joint.SetLength(restLength);
                joint.SetMinLength(restLength * 0.85);
                joint.SetMaxLength(restLength * 1.15);
            }
        }
    }

    private syncFixedConstraints(): void {
        this.pinned.fill(false);

        for (const c of this.fixedConstraints) {
            const body = this.bodies[c.particleIndex];
            const state = this.particleStates[c.particleIndex];
            if (body === undefined || state === undefined) {
                continue;
            }

            if (!c.isEnabled) {
                if (body.GetType() !== b2BodyType.b2_dynamicBody) {
                    body.SetType(b2BodyType.b2_dynamicBody);
                    this.applyMass(body, state.mass);
                    body.SetAwake(true);
                }
                continue;
            }

            this.pinned[c.particleIndex] = true;
            if (body.GetType() !== b2BodyType.b2_kinematicBody) {
                body.SetType(b2BodyType.b2_kinematicBody);
            }

            body.SetTransformXY(toMeters(c.posX), toMeters(c.posY), 0);
            body.SetLinearVelocity({ x: 0, y: 0 });
            state.posX = c.posX;
            state.posY = c.posY;
            state.velX = 0;
            state.velY = 0;
            body.SetAwake(true);
        }
    }

    private applyAngularConstraints(dt: number): void {
        for (const angularC of this.angularConstraints) {
            const state0 = this.particleStates[angularC.particleIndex0];
            const state1 = this.particleStates[angularC.particleIndex1];
            const state2 = this.particleStates[angularC.particleIndex2];
            const body0 = this.bodies[angularC.particleIndex0];
            const body1 = this.bodies[angularC.particleIndex1];
            const body2 = this.bodies[angularC.particleIndex2];
            if (
                state0 === undefined ||
                state1 === undefined ||
                state2 === undefined ||
                body0 === undefined ||
                body1 === undefined ||
                body2 === undefined
            ) {
                continue;
            }

            const dirX0 = state0.posX - state1.posX;
            const dirY0 = state0.posY - state1.posY;
            const dirX1 = state2.posX - state0.posX;
            const dirY1 = state2.posY - state0.posY;
            const dirX2 = state2.posX - state1.posX;
            const dirY2 = state2.posY - state1.posY;

            const length0 = Math.sqrt(dirX0 * dirX0 + dirY0 * dirY0);
            const length1 = Math.sqrt(dirX1 * dirX1 + dirY1 * dirY1);
            const length2 = Math.sqrt(dirX2 * dirX2 + dirY2 * dirY2);
            if (length0 < 0.001 || length1 < 0.001 || length2 < 0.001) {
                continue;
            }

            const currentAngle = wrapAngle0To2Pi(Math.atan2(dirY0, dirX0) - Math.atan2(dirY2, dirX2));
            const angleDelta = wrapAngleNegPiToPi(angularC.targetAngle - currentAngle);
            const strength = angleDelta * ANGULAR_TIGHTNESS * dt * angularC.tightnessFactor;

            const invDistance0 = (strength * state0.inverseMass) / length0;
            const invDistance1 = ((strength * state1.inverseMass) / length1) * 2.0;
            const invDistance2 = (strength * state2.inverseMass) / length2;

            const fDirX0 = -dirY0 * invDistance0;
            const fDirY0 = dirX0 * invDistance0;
            const fDirX1 = -dirY1 * invDistance1;
            const fDirY1 = dirX1 * invDistance1;
            const fDirX2 = dirY2 * invDistance2;
            const fDirY2 = -dirX2 * invDistance2;

            const angleSpeed = wrapAngleNegPiToPi(currentAngle - angularC.lastAngle);
            const speedDamping = Math.min(
                0.5,
                Math.pow(angleDelta * angleSpeed > 0 ? Math.abs(angleDelta) * 3 : 0.0, 3) * ANGULAR_DAMPING * dt,
            );

            this.applyVelocityDelta(body0, state0, fDirX0 - state0.velX * speedDamping, fDirY0 - state0.velY * speedDamping);
            this.applyVelocityDelta(body1, state1, fDirX1 - state1.velX * speedDamping, fDirY1 - state1.velY * speedDamping);
            this.applyVelocityDelta(body2, state2, fDirX2 - state2.velX * speedDamping, fDirY2 - state2.velY * speedDamping);

            angularC.lastAngle = currentAngle;
        }
    }

    private applyVelocityDelta(body: b2Body, state: PhysicalParticleState, deltaVelX: number, deltaVelY: number): void {
        if (body.GetType() === b2BodyType.b2_kinematicBody) {
            return;
        }

        const mass = Math.max(state.mass, 0.001);
        body.ApplyLinearImpulseToCenter(
            {
                x: mass * toMeters(deltaVelX),
                y: mass * toMeters(deltaVelY),
            },
            true,
        );
    }

    private collideWallAndFloor(): void {
        for (let i = 0; i < this.particleStates.length; i++) {
            if (this.pinned[i] === true) {
                continue;
            }

            const state = this.particleStates[i];
            const body = this.bodies[i];
            if (state === undefined || body === undefined) {
                continue;
            }

            let collided = false;
            if (this.wall !== undefined) {
                collided = this.wall.collideParticle(state);
            }

            if (state.posY > BOTTOM_PX) {
                state.posY = BOTTOM_PX;
                if (state.velY > 0) {
                    state.velY = 0;
                }
                collided = true;
            }

            if (collided) {
                body.SetTransformXY(toMeters(state.posX), toMeters(state.posY), 0);
                body.SetLinearVelocity({ x: toMeters(state.velX), y: toMeters(state.velY) });
                body.SetAwake(true);
            }
        }
    }
}
