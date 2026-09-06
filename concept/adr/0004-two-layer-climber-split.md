# ADR-0004: Two-layer Climber (decision + motor) split

**Status:** Accepted

## Context

The system must eventually support a human player issuing per-limb intents,
but is autonomous today. Embedding decisions (which anchor, which limb
next) inside the actuator code (IK, angles, timing) was one reason the
previous ClimbingAI became untestable: behavior tests had to white-box peek
at internal targets and angles.

## Decision

Split into two files with a strict contract:

- `src/Climber.ts` — decision layer: phase state machine, target filter
  chain, substitution policy, stall ladder.
- `src/ClimberMotor.ts` — motor layer: move commands (`reachFoot`,
  `reachHand`, `pullHand`, `pushWithLeg`, `releaseFoot`, `releaseHand`),
  geometric two-bone IK, joint-angle animation, planted-arm adaptation.

The motor **owns joint angles and timing**. Callers only name limbs and
anchors and receive a `MotorStatus`. A future player input layer speaks the
same motor API the Climber speaks today.

## Consequences

- The motor is unit-testable against a settled skeleton, independent of
  decisions.
- Behavior tests can be strictly black-box (positions, grabs, phase names,
  MotorStatus), which removes the brittleness that killed the old tests.
- Two files, but the seam is the point.

## References

- `concept/climbing-plan.md` §2, §6, §9.
