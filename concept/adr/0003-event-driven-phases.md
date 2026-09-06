# ADR-0003: Event-driven phases with a substitution policy

**Status:** Accepted

## Context

The discarded ClimbingAI used fixed phase timers (`PUSH_TIME = 1.6` etc.).
Timers were a recurring deadlock source: a phase ended (or a target was
re-picked, or a relaxed flag toggled) on a clock boundary regardless of the
body's physical state, producing single-frame decisions that never committed
and states that fought the physics.

## Decision

- Phases are **event-driven**: a phase ends when its physical goal is met —
  latch (LegReach, HandReach) or extension target reached within tolerance
  (Push).
- Timeouts exist **only** to trigger the stall ladder (re-filter → relaxed
  reach → substitute → Idle). A timeout never forces a grab, never releases
  a planted limb, never applies velocity.
- The cycle is a **fixed rotation** (LegReach → Push → HandReach) with
  **substitution**: when a phase's filter chain yields no candidates, the
  other move type runs instead, then the rotation resumes. Every
  substitution is logged and is part of the test-observable contract.
- The old "pull" step is not a separate phase: arm-and-leg coordination
  happens inside LegReach (the support arm re-solving its IK), and
  arm adaptation happens inside Push — the same coordination pattern,
  mirrored.

## Consequences

- Phase sequences are legible in logs and assertable in tests.
- Deadlocks surface as ladder transitions (visible) instead of timer
  thrash (invisible).

## References

- `concept/climbing-plan.md` §5, §8.
