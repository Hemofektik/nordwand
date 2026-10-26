/**
 * Integer nearest-neighbour presentation for the 280×420 concept plate.
 * The mockups are that plate at 2× (560×840). The logical frame stays near
 * that height so a world unit is one logical pixel; `scale` then maps each
 * logical pixel onto an N×N block of device pixels.
 */

export const CONCEPT_LOGICAL_HEIGHT = 420;
export const MIN_LOGICAL_WIDTH = 160;
export const MIN_LOGICAL_HEIGHT = 240;
/** Camera.pixelScale stays 1 while the logical frame is at most this tall. */
export const MAX_LOGICAL_HEIGHT = 500;

export interface PixelViewport {
    deviceWidth: number;
    deviceHeight: number;
    scale: number;
    logicalWidth: number;
    logicalHeight: number;
    offsetX: number;
    offsetY: number;
}

export interface ClientRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export function computePixelViewport(cssWidth: number, cssHeight: number, devicePixelRatio: number): PixelViewport {
    const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const cssW = Math.max(1, cssWidth);
    const cssH = Math.max(1, cssHeight);
    const deviceWidth = Math.max(1, Math.round(cssW * dpr));
    const deviceHeight = Math.max(1, Math.round(cssH * dpr));

    let scale = 1;
    let bestDist = Number.POSITIVE_INFINITY;
    let found = false;
    const maxScale = Math.max(1, deviceHeight);
    for (let s = 1; s <= maxScale; s++) {
        const logicalWidth = Math.floor(deviceWidth / s);
        const logicalHeight = Math.floor(deviceHeight / s);
        if (logicalWidth < 1 || logicalHeight < 1) {
            break;
        }
        if (logicalWidth < MIN_LOGICAL_WIDTH || logicalHeight < MIN_LOGICAL_HEIGHT) {
            break;
        }
        if (logicalHeight > MAX_LOGICAL_HEIGHT) {
            continue;
        }
        const dist = Math.abs(logicalHeight - CONCEPT_LOGICAL_HEIGHT);
        if (!found || dist < bestDist || (dist === bestDist && s > scale)) {
            scale = s;
            bestDist = dist;
            found = true;
        }
    }

    const logicalWidth = Math.floor(deviceWidth / scale);
    const logicalHeight = Math.floor(deviceHeight / scale);
    const bufferWidth = logicalWidth * scale;
    const bufferHeight = logicalHeight * scale;

    return {
        deviceWidth,
        deviceHeight,
        scale,
        logicalWidth,
        logicalHeight,
        offsetX: Math.floor((deviceWidth - bufferWidth) / 2),
        offsetY: Math.floor((deviceHeight - bufferHeight) / 2),
    };
}

/** Map a pointer position on the on-screen canvas into logical pixels. */
export function clientToLogical(clientX: number, clientY: number, rect: ClientRect, layout: PixelViewport): { x: number; y: number } {
    const deviceX = rect.width === 0 ? 0 : ((clientX - rect.left) / rect.width) * layout.deviceWidth;
    const deviceY = rect.height === 0 ? 0 : ((clientY - rect.top) / rect.height) * layout.deviceHeight;
    return {
        x: (deviceX - layout.offsetX) / layout.scale,
        y: (deviceY - layout.offsetY) / layout.scale,
    };
}
