# ADR-0002: Geometry, not strength (no stamina system)

**Status:** Accepted

## Context

Climbing heuristics naturally reference "strength": a body far from the
wall with bent arms needs more grip; a foot too close to the hands pushes
the body outward and increases the hold load. A literal stamina/grip budget
was considered as the mechanism.

## Decision

No strength, grip, or stamina mechanic exists in this build. The intuition
is encoded entirely as geometric rules in the target filter chain:

- Arms hold in **extension**, pull deliberately in **flex**.
- Feet stay ≥15px below the lowest hand anchor (feet never overtake hands).
- The CoM proxy stays ≤35px from the wall.

## Future

Strength may later be computed as a **byproduct** of the performed movement
(e.g., per-limb load estimated from joint-angle deviation from straight plus
body-weight distribution) — a readout, not a driver. That readout can then
inform difficulty tuning without introducing a feedback loop into the
climbing logic itself.

## Consequences

- Deterministic tests stay deterministic (no hidden resource state).
- The filter chain is inspectable geometry, not an opaque score.

## References

- `concept/climbing-plan.md` §7.3.
