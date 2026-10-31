/**
 * Integer zoom. One step is one logical pixel per world unit.
 * The original wheel multiplied `scale_target` by 1.2 and the camera
 * drew `round(scale)`, clamped to 1..10. Pinch uses the same clamp.
 */

export const MIN_PIXEL_ZOOM = 1;
export const MAX_PIXEL_ZOOM = 10;
const WHEEL_FACTOR = 1.2;

export function clampZoomTarget(scaleTarget: number): number {
    if (!Number.isFinite(scaleTarget)) {
        return MIN_PIXEL_ZOOM;
    }
    if (scaleTarget < MIN_PIXEL_ZOOM) {
        return MIN_PIXEL_ZOOM;
    }
    if (scaleTarget > MAX_PIXEL_ZOOM) {
        return MAX_PIXEL_ZOOM;
    }
    return scaleTarget;
}

/** Logical pixels per world unit. Always a whole number inside the clamp. */
export function pixelZoom(scaleTarget: number): number {
    const rounded = Math.round(clampZoomTarget(scaleTarget));
    if (rounded < MIN_PIXEL_ZOOM) {
        return MIN_PIXEL_ZOOM;
    }
    if (rounded > MAX_PIXEL_ZOOM) {
        return MAX_PIXEL_ZOOM;
    }
    return rounded;
}

/**
 * One wheel notch. Positive zooms in (scroll up / positive wheelDelta),
 * negative zooms out. Matches the original `scale_target *= 1.2` step.
 */
export function zoomFromWheel(scaleTarget: number, direction: number): number {
    const current = clampZoomTarget(scaleTarget);
    if (!Number.isFinite(direction) || direction === 0) {
        return current;
    }
    const next = direction > 0 ? current * WHEEL_FACTOR : current / WHEEL_FACTOR;
    return clampZoomTarget(next);
}

/** Original wheel-event normalization: positive means zoom in. */
export function wheelZoomDirection(wheelDelta: number | undefined, detail: number | undefined, deltaY: number | undefined): number {
    let delta = 0;
    if (wheelDelta) {
        delta = wheelDelta / 60;
    } else if (detail) {
        delta = -detail / 2;
    } else if (deltaY) {
        delta = -deltaY;
    }
    if (!Number.isFinite(delta) || delta === 0) {
        return 0;
    }
    return delta > 0 ? 1 : -1;
}

/** Scale after a pinch. `startScale` is the target at gesture start, distances are in CSS pixels. */
export function zoomFromPinch(startScale: number, startDistance: number, distance: number): number {
    if (!(startDistance > 0) || !Number.isFinite(distance) || distance <= 0) {
        return clampZoomTarget(startScale);
    }
    return clampZoomTarget(startScale * (distance / startDistance));
}

export function pinchDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface PinchPointer {
    x: number;
    y: number;
    onControl: boolean;
}

/** Two fingers that are both off the lean pad and the buttons. Otherwise the thumbs keep their controls. */
export function freePinchPair(pointers: readonly PinchPointer[]): [PinchPointer, PinchPointer] | null {
    const free: PinchPointer[] = [];
    for (const pointer of pointers) {
        if (!pointer.onControl) {
            free.push(pointer);
        }
    }
    const first = free[0];
    const second = free[1];
    if (first === undefined || second === undefined) {
        return null;
    }
    return [first, second];
}
