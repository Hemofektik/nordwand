# ADR-0005: Seeded wall generation

**Status:** Accepted

## Context

`Wall`'s constructor calls `resetWallNoise()`, so every wall in a session is
identical — the "world is different each time" requirement is not actually
met, while tests also cannot select a wall shape.

## Decision

- `Wall` gains an optional third constructor parameter: a 32-bit integer
  seed. `new Wall(posX, posY)` without a seed defaults to a random one
  (`Math.random()`); `Game.load_level()` passes
  `Math.floor(Math.random() * 2**31)`.
- The global `resetWallNoise()`/module-level `noiseIndex` mechanism is
  replaced by per-wall noise state initialized from the seed (the only
  change to the otherwise frozen world layer).
- Tests always pass fixed seeds from the curated set.

## Seed policy (the exam, not the student)

- **Curation happens once, up front**: 5 seeds are selected that produce a
  valid settled initial hang (all four limbs latched, nothing below the
  floor) and varied wall shapes. After that the set is **frozen**.
- When a curated seed fails a progress threshold, the **implementation
  must improve** — fix the Climber/Motor or tune the plan's constants.
  Seeds are never swapped for easier ones, and test thresholds are never
  weakened to keep a passing run.

## Consequences

- Deterministic, reproducible failures (seed + sim time identify any bug).
- The curated set becomes a permanent benchmark the implementation must
  clear.

## References

- `concept/climbing-plan.md` §9.3.
