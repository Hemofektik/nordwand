# ADR-0001: Angular-only motion

**Status:** Accepted (carried over from the discarded ClimbingAI; re-confirmed
for the Climber)

## Context

The skeleton is a Box2D particle body set with custom angular constraints.
The ClimbingAI iterations proved that mixing direct velocity impulses with
angular target chasing produces deadlocks: impulses are absorbed by angular
damping (displacement ≈ 0 even at high velocity), and the two force systems
fight each other at the joints.

## Decision

All climbing motion is produced exclusively by driving joint **target
angles** (hip, knee, shoulder, elbow, spine). Limb and body positions are
reached because the angular constraint solver propagates forces through the
limb chains. The motor writes zero velocities. Target angles are recomputed
from geometric two-bone IK each substep and animated toward with a capped
angle speed.

## Consequences

- Movement is emergent and physically consistent with the skeleton.
- Target selection must stay inside the limb's reach envelope, or the IK
  has no solution and the motion deadlocks (a verified failure mode).
- Planted limbs aim their IK at shortened (origin-scaled) targets so the
  solution bends and hauls instead of demanding "straighten more" against a
  taut body.

## References

- Verified failure modes recorded in the previous implementation.
- `concept/climbing-plan.md` §2, §6.
