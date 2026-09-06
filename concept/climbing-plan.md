# Nordwand Climbing Plan — the Climber

This document is the authoritative behavior specification for the climbing
system. It replaces the previous iterative `ClimbingAI` design, which was
discarded because a state machine accreted from deadlock workarounds could
not be reasoned about or debugged. Every rule here was settled in a design
interview (grilling session, 2026-09); the ADRs in `concept/adr/` record the
decisions behind the rules.

Status: **planned, not yet implemented.** Implementation follows TDD: the
behavior tests described in §9 are written first and must fail, then the
Motor (§6), then the Climber (§5).

---

## 1. Scope

| Component | Fate |
|---|---|
| `src/ClimbingAI.ts` | **Deleted** — logic and debug scaffolding alike |
| `tests/climbing.test.ts`, `tests/frame-rate-probe.test.ts` | **Deleted** — white-box peeking made them brittle |
| `src/Climber.ts` | **New** — decision layer (phases, filter chain, substitution) |
| `src/ClimberMotor.ts` | **New** — motor layer (move API, IK, angle animation) |
| `src/Player.ts` | Owns a `Climber` instead of a `ClimbingAI` |
| `src/Physics.ts`, `Skeleton.ts`, `Rope.ts` | Frozen |
| `src/Wall.ts` | One ADR'd change: optional 32-bit `seed` constructor parameter |

## 2. Layering

```
        decision layer                motor layer
┌──────────────────────────┐   ┌─────────────────────────────┐
│ Climber                  │   │ ClimberMotor                │
│ - phase state machine    │──▶│ - move commands (§6 API)    │
│ - target filter chain    │   │ - geometric 2-bone IK       │
│ - substitution policy    │   │ - joint-angle animation     │
│ - stall ladder           │   │ - planted-arm adaptation    │
└──────────────────────────┘   └─────────────────────────────┘
```

- The **Motor owns joint angles and timing**. Callers only name limbs and
  anchors and receive a `MotorStatus` back. No caller ever writes a
  `targetAngle`, a velocity, or a tightness factor.
- This seam exists so that a future player input layer can issue the same
  move commands the Climber issues today (design decision Q2).
- All motion is **angular-only**: every body position is reached by driving
  joint target angles; the angular constraint solver propagates forces
  through the limb chains. The Motor writes zero velocities.
  See `concept/adr/0001-angular-only-motion.md`.

## 3. The world model

- The wall face points in **−x**; the climber hangs on the air side.
- Anchors are studded along the wall surface at ~5px spacing; each anchor
  has a unique `index` (assigned bottom-up at generation).
- A **grab** pins a limb particle to an anchor via a fixed constraint.
  Four limbs exist: `hand 0`, `hand 1`, `foot 0`, `foot 1`.
- **At start, all four limbs are latched** to anchors (the Skeleton
  constructor already sets this up; the plan relies on it).
- The wall face is generated from a seeded noise walk
  (`concept/adr/0005-seeded-wall.md`); it grows ahead of the climber and
  the route never ends.

## 4. Vocabulary

See `concept/glossary.md` for the full pinned definitions. The load-bearing
terms: *latch, reach, pull, push, drive leg, support arm, flex, extend,
CoM proxy, gap rule, substitution, stall ladder, curated seed*.

## 5. The decision layer (Climber)

### 5.1 The climb cycle

A fixed three-phase rotation. One **full cycle** = one pass through all
three phases and back to phase 1.

```
   ┌──────────────────────────────────────────────────────────┐
   │                                                          │
   ▼                                                          │
┌───────────────┐   ┌──────────────┐   ┌──────────────────┐   │
│ 1. LegReach   │──▶│ 2. Push      │──▶│ 3. HandReach     │───┘
│ free leg      │   │ drive leg    │   │ lowest hand      │
│ flexes up to  │   │ extends,     │   │ reaches above    │
│ a higher      │   │ body rises;  │   │ the head,        │
│ anchor,       │   │ planted arms │   │ latches in       │
│ latches; old  │   │ adapt        │   │ extension        │
│ drive leg     │   │ (§6.4)       │   │                  │
│ releases      │   │              │   │                  │
└───────────────┘   └──────────────┘   └──────────────────┘
```

- **Phase 1 — LegReach.** The free foot flexes at hip and knee toward its
  chosen anchor (see §7 for choice), latches. On latch, the old drive leg
  releases. Within this phase the **arm and leg move in coordination**: the
  planted support arm continuously re-solves its IK to the body's changing
  position (same mechanism as §6.4) instead of holding a frozen angle.
- **Phase 2 — Push.** The newly latched leg extends at hip and knee and
  pushes the body up. Ends when the drive leg's extension goal is met
  (event-driven, §5.3).
- **Phase 3 — HandReach.** The **lowest** hand releases and reaches for an
  anchor above the head, latching in extension. The extended arm will pull
  together with the next free leg's flexion in the following LegReach —
  which is why step 4 of the original description ("arm pulls while leg
  reaches") is the *same phase* as step 1: the coordination happens inside
  LegReach, exactly as arm adaptation happens inside Push.

There is no separate "pull" phase: pulling is the planted arm's job during
LegReach, adaptively.

### 5.2 Substitution

The rotation is normally fixed, but when a phase's filter chain (§7)
returns **no candidates**, that phase is **substituted** by the other move
type (a LegReach that finds nothing becomes a HandReach, and a HandReach
that finds nothing becomes a leg push to get the shoulders closer to new
anchors), then the rotation resumes. Every substitution is logged —
substitutions are part of the observable contract (§9).

### 5.3 Event-driven phases

Phases end when their **physical goal** is achieved, never on a fixed
timer:

| Phase | Ends when |
|---|---|
| LegReach | foot latches the target anchor (within latch radius) |
| Push | drive leg reaches its extension target within tolerance |
| HandReach | hand latches the target anchor |

Timeouts exist **only** to trigger the stall ladder (§8). A timeout never
forces a grab, never releases a planted limb, never applies a velocity.

## 6. The motor layer (ClimberMotor)

### 6.1 Move API

```ts
type MotorStatus =
    | "in-progress"   // move is animating
    | "latched"       // end particle reached the anchor and grabbed
    | "unreachable"   // anchor outside the limb's reach envelope
    | "timeout";      // move budget exhausted (caller decides next step)

interface ClimberMotor {
    reachFoot(side: number, anchor: WallAnchor): MotorStatus;
    reachHand(side: number, anchor: WallAnchor): MotorStatus;
    pullHand(side: number, anchor: WallAnchor): MotorStatus; // planted arm flexes to haul
    pushWithLeg(side: number): MotorStatus;                  // drive leg extends; planted arms adapt
    releaseFoot(side: number): void;
    releaseHand(side: number): void;
}
```

Contract:

- The motor owns **all** joint angles, IK, angle speeds, and per-move
  timing. Callers name limbs and anchors; the motor does the rest.
- `pushWithLeg` internally includes **planted-arm adaptation**: each
  substep, every latched arm re-solves its IK toward a shortened virtual
  target (origin-scaled, see §6.4) so its elbow goes extension → flex as
  the body rises. The skeleton must adapt to the push, never fight it —
  this mirrors real climbing, where pushing with the legs changes the arms'
  geometry relative to their anchors.
- The motor rejects commands that would violate safety invariants
  (returns `unreachable` rather than executing them).

### 6.2 Reaching mechanics

- Targets are picked inside the limb's reach envelope (§7), so the
  two-bone geometric IK always has a valid solution: the law-of-cosines
  joint position for a close anchor is strongly flexed, for a far anchor
  nearly straight.
- Foot reach is **flex-first**: while the foot is far from its target the
  knee folds up (lifting the foot off its old hold); the pure geometric IK
  takes over once the foot is near the anchor. (This mechanism is carried
  over from the validated old implementation.)
- Planted limbs aim their IK at a target scaled from the limb **origin**
  toward the anchor (never the anchor itself): when the body hangs taut the
  anchor lies beyond max extension and the only IK solution is "straighten
  more", which produces a pendulum instead of progress. The shortened
  target bends the limb, and the bend hauls the body toward the wall.

### 6.3 Angle animation

Joint targets are recomputed from the IK each substep and moved toward with
a capped angle speed (smoothstep-style easing), so motion is smooth and
continuous and every limb moves in coordination with the others.

### 6.4 Planted-arm adaptation during push (settled in Q3/Q13)

During Push, latched arms are **not** held at fixed angles. Their shoulder
and elbow targets are re-solved every substep from the arm's latched anchor
and the body's current position: as the drive leg extends and the shoulders
rise past the anchor, an extended arm naturally transitions into flex,
allowing the push to proceed and reducing the load the arms must hold. This
is specified in the motor, not the decision layer.

## 7. Target selection — the hard filter chain

No scoring. A candidate anchor is valid only if it passes every rule, in
priority order. If no candidate survives, the phase is substituted (§5.2)
or the stall ladder runs (§8).

### 7.1 Constants (single source of truth; tune only via test evidence)

| Constant | Value | Notes |
|---|---|---|
| `REACH_FRACTION` | 0.90 | of limb bone sum (leg 24px → 21.6px, arm 20px → 18px) |
| `REACH_FRACTION_RELAXED` | 1.00 | stall ladder step 2 only |
| `LATCH_RADIUS` | 6px | old 8px grabbed too eagerly mid-swing |
| `FOOT_TO_LOWEST_HAND_GAP` | 15px | foot target must be ≥15px **below the lowest latched hand anchor** — feet never overtake hands |
| `HAND_MIN_ABOVE_NECK` | 5px | hand target at least this far above the neck particle |
| `COM_MAX_WALL_DISTANCE` | 35px | CoM proxy to `wallXAtY(comY)`, horizontal |

### 7.2 The rules, in order

1. **Reachability** — anchor within `REACH_FRACTION × bone sum` of the
   limb's origin particle (neck for hands, buttocks for feet). The IK must
   be able to actually place the end particle on the anchor.
2. **Foot ordering (gap rule)** — a foot target must lie at least 15px
   **below the lowest latched hand anchor**. This keeps the legs from
   overtaking the hands and keeps the body from being pushed away from the
   wall (a foot too close to the hands forces the body outward, which would
   require more strength to hold — and strength is not modeled; §7.3).
3. **CoM proximity** — the candidate must not pull the CoM proxy (§7.4)
   farther than 35px from the wall surface.
4. **Occupancy & recycling** — anchors held by other limbs are excluded;
   the anchor just released by the limb's partner is excluded for a short
   anti-flicker window (expiring by **sim time**, never by a counter).

The old 1–3/1–5 anchor-index step window from `ClimbingAI` is **dropped**;
the gap and reach rules above replace it.

### 7.3 Strength is geometry, not a meter

No stamina/grip budget exists. The load-bearing intuition — "a body far
from the wall with bent arms needs more strength" — is encoded entirely by
the geometry rules: arms hold in extension, pull deliberately in flex, feet
stay below hands, CoM stays near the wall. A future strength model may be
computed as a **byproduct** of the performed movement (per-limb load
estimated from joint-angle deviation from straight plus body-weight
distribution); that is recorded in
`concept/adr/0002-geometry-not-strength.md` and explicitly out of scope.

### 7.4 CoM proxy

Center of mass proxy = **average of the four body particles** (pelvis,
buttocks, back, neck). The pelvis alone swings with the legs and can lie
about the CoM; limb particles add noise for little benefit.

## 8. The stall ladder

A phase that exceeds its timeout (3.0s of sim time) must never force.
The ladder, in order:

1. **Re-run the filter chain** — the body may have drifted into a position
   where candidates now exist.
2. **Relaxed reach** — re-run with `REACH_FRACTION_RELAXED` (100% of bone
   sum). All safety rules (gap, ordering, CoM) still apply; only the reach
   preference relaxes.
3. **Substitute** the other move type (§5.2) — for HandReach this means a
   leg push to bring the shoulders closer to new anchors.
4. **Idle** — hold position and log loudly. If even step 3 has no
   candidates, the wall offers nothing: that is a wall-generation concern,
   not an AI one, and it must surface, not be papered over.

Every ladder transition is logged. The ladder may never violate the
one-free-limb invariant (§9.2) — it never releases a planted limb.

## 9. Testing (BDD, black-box)

### 9.1 Test files

| File | Covers |
|---|---|
| `tests/climber-behavior.test.ts` | the cycle: phases in order, latches, substitutions, event-driven endings |
| `tests/climber-invariants.test.ts` | the §9.2 invariants, checked every substep |
| motor unit suite | `ClimberMotor` commands against a settled skeleton, independent of the decision layer |

### 9.2 Observable contract

Tests may observe **only**:

- particle positions,
- `isGrabbing(kind, side)` and grab anchor indices,
- the current phase name (`LegReach | Push | HandReach | Idle`),
- `MotorStatus` values,
- sim time,
- the logged phase transitions and substitutions.

Tests may **not** observe joint target angles, filter-chain internals,
preview or shortened IK targets, or tightness factors.

Invariants checked every substep:

1. **At most one limb free** at any time (the ladder never releases a
   planted limb).
2. **Feet below hands**: every latched foot anchor is ≥15px below the
   lowest latched hand anchor.
3. **CoM within 35px of the wall.**

A violation fails with **seed + sim time** so it is reproducible.

### 9.3 Seeds (the exam, not the student)

- `Wall` takes an optional 32-bit seed; tests always pass fixed seeds,
  the game passes `Math.floor(Math.random() * 2**31)`.
  (`concept/adr/0005-seeded-wall.md`.)
- **Curation happens once, up front**: choose **5 seeds** that produce a
  valid settled initial hang (all four limbs latched, no particle below the
  floor) and varied wall shapes. After that the set is **frozen**.
- When a curated seed fails a threshold, the **implementation must
  improve** — fix the Climber/Motor or tune constants through §7.1 —
  never swap the seed for an easier one. Test thresholds are never
  weakened to keep a passing run.

### 9.4 Progress thresholds

On every curated seed, a 40s run must show:

1. **≥75px net ascent** (measured on the best latched foot anchor).
2. **No 10s window with net descent** — ascent may stall on a hard
   section, but must never go backwards.
3. **≥4px net ascent per completed full cycle**, averaged over the run.

If evidence shows a threshold is wrong for the wall's difficulty, tune the
§7.1 constants and record the tuning — never the threshold.

## 10. Debug tooling

- The `DEBUG` console-log flag of the old AI dies with the file. The new
  implementation **always** logs phase transitions and substitutions
  (a few lines per second at most) — that logging is part of the
  observable contract, not debug noise.
- A debug draw hook on the motor (targets, IK solutions, CoM proxy) behind
  the existing `D` key, same as today.

## 11. Implementation order

1. Seed API on `Wall` + seed-curation script/tests → curate the 5 seeds.
2. Write `tests/climber-invariants.test.ts` against the **old** skeleton
   setup (they should pass trivially with no AI moving) and the behavior
   tests against the new API — both fail.
3. Implement `ClimberMotor` until the motor unit suite passes.
4. Implement `Climber` until the behavior + invariant suites pass on all
   5 curated seeds.
5. Wire into `Player`, delete `ClimbingAI` and its tests, update README.
