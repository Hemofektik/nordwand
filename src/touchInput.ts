/**
 * Phone controls for the two things the player actually does.
 *
 * The climber's limbs are driven by joint target angles (ADR-0001). The
 * keyboard bows that posture with A/D and commits a move with W. The pad
 * is the same bow: right is toward the rock (the D key, a negative angular
 * offset) and left is out into the air (the A key).
 */

export const LEAN_DEAD_ZONE = 0.22;

export interface LeanReading {
    /** -1 (full left) .. 1 (full right), including the dead zone. Knob position. */
    visual: number;
    /** Dead-zoned and rescaled so the pad edge is a full lean. Applied to the body. */
    lean: number;
}

export function leanFromPointer(clientX: number, padLeft: number, padWidth: number): LeanReading {
    if (!(padWidth > 0)) {
        return { visual: 0, lean: 0 };
    }
    const t = (clientX - padLeft) / padWidth;
    const visual = Math.min(1, Math.max(-1, (t - 0.5) * 2));
    const magnitude = Math.abs(visual);
    if (magnitude < LEAN_DEAD_ZONE) {
        return { visual, lean: 0 };
    }
    const lean = Math.sign(visual) * ((magnitude - LEAN_DEAD_ZONE) / (1 - LEAN_DEAD_ZONE));
    return { visual, lean };
}

/** Touch lean plus the keyboard. Left (A) is -1, right (D) is +1. Clamped. */
export function combinedLean(touchLean: number, leftHeld: boolean, rightHeld: boolean): number {
    let lean = touchLean;
    if (leftHeld) {
        lean -= 1;
    }
    if (rightHeld) {
        lean += 1;
    }
    if (lean > 1) {
        return 1;
    }
    if (lean < -1) {
        return -1;
    }
    return lean;
}

/**
 * Angular offset for one frame. Positive matches the A key (`addBowOffset`
 * of a positive amount); negative matches the D key.
 */
export function bowDeltaFromLean(lean: number, bowStrength: number, deltaTime: number): number {
    if (lean === 0) {
        return 0;
    }
    return -lean * bowStrength * deltaTime;
}
