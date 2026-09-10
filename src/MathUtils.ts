/**
 * MathUtils - ported 1:1 from the legacy code base (js/MathUtils.js).
 */

export function Rand(): number {
    const x = GNoiseIndex;
    GNoiseIndex++;

    const masked = ((x << 13) ^ x) & 0xffffffff; // simple noise
    return (masked * (((masked * masked * 15731 + 789221) & 0xffffffff) + 1376312589)) | 0;
}

export function RandF(): number {
    const r = Rand();
    return (0x7fffffff & r) / 0x7fffffff;
}

export function GetDistance(posX0: number, posY0: number, posX1: number, posY1: number): number {
    const deltaX = posX0 - posX1;
    const deltaY = posY0 - posY1;
    const distanceSqr = deltaX * deltaX + deltaY * deltaY;
    const distance = Math.sqrt(distanceSqr);
    return distance;
}

export function GetAngleBetweenDirections(dirX0: number, dirY0: number, dirX1: number, dirY1: number): number {
    let angle = Math.atan2(dirY0, dirX0) - Math.atan2(dirY1, dirX1);

    while (angle > Math.PI * 2) {
        angle -= Math.PI * 2;
    }
    while (angle < 0) {
        angle += Math.PI * 2;
    }

    return angle;
}

export function GetAngleBetweenPositions(
    vx0: number,
    vy0: number,
    vx1: number,
    vy1: number,
    vx2: number,
    vy2: number,
): number {
    const dirX0 = vx0 - vx1;
    const dirY0 = vy0 - vy1;
    const dirX1 = vx2 - vx1;
    const dirY1 = vy2 - vy1;

    return GetAngleBetweenDirections(dirX0, dirY0, dirX1, dirY1);
}

export function GetAngleBetweenVertices(v0: { posX: number; posY: number }, v1: { posX: number; posY: number }, v2: { posX: number; posY: number }): number {
    return GetAngleBetweenPositions(v0.posX, v0.posY, v1.posX, v1.posY, v2.posX, v2.posY);
}

// Seed value for Rand().
export let GNoiseIndex = 0;

export function SetNoiseIndex(seed: number): void {
    GNoiseIndex = seed;
}
