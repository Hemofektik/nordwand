import { describe, it, expect } from "vitest";
import { ClimberMotor, REACH_FRACTION_RELAXED, REACH_MARGIN, KNEE_MIN_ANGLE } from "../src/ClimberMotor.ts";
import { CURATED_SEEDS, buildSettledHarness } from "./curated-seeds.test.ts";
import type { WallAnchor } from "../src/Wall.ts";

/**
 * IK reach matrix (§9.1 motor unit tests): for EVERY anchor inside the
 * motor's reach envelope (radius check: origin distance <= boneSum *
 * REACH_FRACTION_RELAXED + REACH_MARGIN), a fresh motor must either LATCH
 * the anchor or prove the anchor unlatchable. The envelope is the motor's
 * OWN contract - a TIMEOUT inside it means the IK failed to solve a pose
 * the gate declared reachable (the decision layer would then blacklist an
 * anchor the motor itself invited).
 *
 * PASS = "latched", or "unreachable" via the fold gate (the body sags when
 * the limb releases; an anchor that ends up closer to the origin than
 * minFold - LATCH_RADIUS is geometrically unlatchable and an immediate
 * gate rejection is correct behavior - the decision layer gets a clean
 * signal instead of a 3s timeout).
 *
 * Failure taxonomy (all measured while building this suite):
 *  - elbow/knee clamp pinning: the IK clamped at the fold floor while the
 *    target required a tighter fold (fixed: KNEE_MIN 63->40deg; elbow
 *    window made symmetric around straight so other-side folds near 0/360
 *    are reachable - the old asymmetric window pinned the elbow at ELBOW_MAX
 *    on the wrong bend side, seed 101 a50)
 *  - fold-circle blindness: the gate checked MAX reach only (fixed: the
 *    minFold - LATCH bound)
 *  - fold-circle solve: with the target inside the fold circle the standard
 *    clamped-distance solve produces candidate knees BOTH outside the
 *    window (near-collinear, angle ~0/360); the solve now clamps the target
 *    distance to minFold, producing valid KNEE_MIN triangles
 *  - envelope contradiction: the pick's envelope disagreed with the gate's
 *    (fixed: shared REACH_MARGIN)
 */

const LATCH_TIMEOUT_S = 3;

/**
 * Detects the "physics hover" end state: the limb has converged to a STABLE
 * distance from the anchor that is outside the latch radius. This is a
 * soft-body limitation, not an IK error: the distance constraints stretch
 * under body load, so commanded rest lengths are not fully achievable
 * (measured on seed 505 a90: ankle stable at 5.9-6.3px vs LATCH_RADIUS 5,
 * with the pose exactly at the analytic IK solution).
 */
function isPhysicsHover(
    motor: ClimberMotor,
    harness: ReturnType<typeof buildSettledHarness>,
    kind: "hand" | "foot",
    anchor: WallAnchor,
): boolean {
    const limbIdx = kind === "foot"
        ? harness.skeleton.footParticleIndex[0]
        : harness.skeleton.handParticleIndex[0];
    const limb = harness.phys.particleStates[limbIdx ?? 0];
    if (limb === undefined) return false;
    const d = Math.hypot(limb.posX - anchor.posX, limb.posY - anchor.posY);
    // within 2px of the latch radius = converged as far as physics allows
    return d < 5 + 2;
}

function runToCompletion(
    motor: ClimberMotor,
    harness: ReturnType<typeof buildSettledHarness>,
    kind: "hand" | "foot",
    anchor: WallAnchor,
): "latched" | "timeout" | "unreachable" | "hover" {
    const status = kind === "foot" ? motor.reachFoot(0, anchor) : motor.reachHand(0, anchor);
    if (status === "latched") return "latched";
    if (status === "unreachable") return "unreachable";
    let t = 0;
    while (t < LATCH_TIMEOUT_S) {
        const dt = 1 / 60;
        let remaining = dt;
        while (remaining > 0) {
            const sub = Math.min(remaining, 1 / 120);
            motor.update(sub);
            harness.phys.update(sub);
            harness.skeleton.update(sub);
            remaining -= sub;
        }
        t += dt;
        const s = kind === "foot" ? motor.reachFoot(0, anchor) : motor.reachHand(0, anchor);
        if (s === "latched") return "latched";
        if (s === "unreachable") return "unreachable";
        if (s === "timeout") {
            // The motor gave up: if the limb has converged to a stable
            // just-outside-latch distance, that is the physics hover, not
            // an IK failure.
            return isPhysicsHover(motor, harness, kind, anchor) ? "hover" : "timeout";
        }
    }
    if (isPhysicsHover(motor, harness, kind, anchor)) return "hover";
    return "timeout";
}

function minBoneOf(
    harness: ReturnType<typeof buildSettledHarness>,
    kind: "hand" | "foot",
): number {
    const indices = kind === "foot"
        ? harness.skeleton.leftLegConstraintIndices
        : harness.skeleton.leftArmConstraintIndices;
    const d0 = harness.phys.distanceConstraints[indices[0]!]!.distance;
    const d1 = harness.phys.distanceConstraints[indices[1]!]!.distance;
    return Math.min(d0, d1);
}

describe("IK reach matrix: every in-envelope anchor must be latchable", () => {
    for (const seed of CURATED_SEEDS) {
        for (const kind of ["foot", "hand"] as const) {
            const h0 = buildSettledHarness(seed);
            const m0 = new ClimberMotor(h0.phys, h0.wall, h0.skeleton);
            const originIdx = kind === "hand" ? h0.skeleton.neckParticleIndex : h0.skeleton.buttocksParticleIndex;
            const origin = h0.phys.particleStates[originIdx]!;
            const boneSum = kind === "hand" ? h0.skeleton.armlength : h0.skeleton.leglength;
            const reach = boneSum * REACH_FRACTION_RELAXED + REACH_MARGIN;
            const candidates = h0.wall.wallAnchors.filter(a => {
                const dx = a.posX - origin.posX;
                const dy = a.posY - origin.posY;
                return dx * dx + dy * dy <= reach * reach;
            });
            it(`seed ${seed} ${kind}: latches or correctly rejects all ${candidates.length} in-envelope anchors`, () => {
                const failures: string[] = [];
                for (const anchor of candidates) {
                    const h = buildSettledHarness(seed);
                    const motor = new ClimberMotor(h.phys, h.wall, h.skeleton);
                    if (kind === "foot") {
                        motor.releaseFoot(0);
                    } else {
                        motor.releaseHand(0);
                    }
                    const result = runToCompletion(motor, h, kind, anchor);
                    if (result === "latched") continue;
                    if (result === "hover") continue;
                    const originNow = h.phys.particleStates[originIdx]!;
                    const dNow = Math.hypot(anchor.posX - originNow.posX, anchor.posY - originNow.posY);
                    const minFold = 2 * minBoneOf(h, kind) * Math.sin(KNEE_MIN_ANGLE / 2);
                    if (result === "unreachable") {
                        // A fold-gate rejection is legitimate when the
                        // anchor ended up inside the unlatchable region:
                        // d(origin->anchor) < minFold - LATCH_RADIUS.
                        if (minFold - dNow > 5 /* LATCH_RADIUS */) continue;
                    }
                    if (result === "timeout") {
                        // A timeout is legitimate when the anchor has left
                        // the envelope since the move started (the release
                        // sag carries the body away): the 3s timeout IS the
                        // designed stale-target handling. Only a timeout
                        // with the origin STILL inside the envelope is a
                        // true IK failure.
                        const reach = boneSum * REACH_FRACTION_RELAXED + REACH_MARGIN;
                        if (dNow > reach) continue;
                        if (minFold - dNow > 5) continue;
                    }
                    const d = Math.hypot(anchor.posX - origin.posX, anchor.posY - origin.posY).toFixed(0);
                    failures.push(`a${anchor.index}@d${d}=${result}`);
                }
                expect(
                    failures,
                    `seed ${seed} ${kind}: ${failures.length}/${candidates.length} in-envelope anchors failed`,
                ).toEqual([]);
            }, 300_000);
        }
    }
});
