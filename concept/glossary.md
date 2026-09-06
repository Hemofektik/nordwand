# Nordwand Glossary

Pinned definitions for the climbing system. When a term is used in the plan
(`concept/climbing-plan.md`), ADRs, code, or tests, it means exactly this.

---

## World

**Wall** — the generated rock face. Points in −x; the climber hangs on the
air side. Grows ahead of the climber; the route never ends.

**Seed** — the 32-bit integer that drives the wall's noise walk. Same seed
⇒ same wall. Tests pass fixed seeds; the game passes a random one.

**Anchor** — a grip point on the wall surface, ~5px from its neighbors,
with a unique `index` assigned bottom-up at generation.

**Latch** — a limb pinned to an anchor via a fixed constraint. A latched
limb's particle is exactly at the anchor.

**Grab radius / latch radius** — the distance within which an end particle
counts as "on the anchor" and the motor performs the latch. Set to 6px.

## Limbs & body

**Hand / foot (side 0/1)** — the four limbs. Each limb is a two-bone chain:
hand = neck → elbow → wrist; foot = buttocks → knee → ankle.

**Origin (of a limb)** — the body particle the limb hangs from: the neck
for hands, the buttocks for feet. Targets are measured in reach from the
origin, not the end particle.

**Flex** — a joint bending (hip/knee angle shrinking toward the fold,
elbow bending). A flexed leg lifts the foot; a flexed arm hauls.

**Extend** — a joint straightening. An extended leg pushes the body up; an
extended arm holds with minimal effort.

**Drive leg** — the leg currently pushing the body up (in Push), or the
most recently latched leg (in LegReach). One per climb, swaps sides each
cycle.

**Support arm** — the arm currently latched and holding while the other
reaches. Swaps sides after each HandReach.

**CoM proxy** — the center-of-mass estimate: the average of the four body
particles (pelvis, buttocks, back, neck). Used for the keep-close-to-wall
rule.

## Decisions

**Phase** — one step of the climb cycle: `LegReach`, `Push`, `HandReach`,
or `Idle`. A fixed rotation, entered and exited by events (latch, extension
goal met), never by a timer.

**LegReach** — phase: the free foot flexes up, latches a higher anchor, and
the old drive leg releases. Arm and leg move in coordination within this
phase (the planted support arm re-solves its IK continuously).

**Push** — phase: the drive leg extends and the body rises; latched arms
adapt their angles to the body's new position instead of fighting.

**HandReach** — phase: the lowest hand releases and reaches above the head,
latching in extension.

**Pull** — a planted arm deliberately flexing to haul the body (the
planted-arm behavior inside LegReach coordination).

**Filter chain** — the ordered hard rules a candidate anchor must pass:
reachability → foot-below-lowest-hand gap → CoM proximity → occupancy.
No scoring; a candidate passes everything or is rejected.

**Gap rule** — the foot-ordering rule: a foot target must be ≥15px below
the **lowest latched hand anchor**. Feet never overtake hands.

**Substitution** — when a phase's filter chain yields no candidates, the
phase is replaced by the other move type (leg move ⇄ hand move), then the
rotation resumes. Always logged.

**Stall ladder** — the ordered response to a phase timeout: re-filter →
relaxed reach → substitute → Idle + loud log. Never forces a grab, never
releases a planted limb, never applies velocity.

**Idle** — the hold-position state. Reached only when even substitution
finds nothing; logged loudly because it indicates a wall-generation gap.

## Layers

**Climber** — the umbrella term for the whole system: the decision layer
that chooses which limb moves where, on top of the motor that executes.

**Decision layer** — the Climber class: phase state machine, filter chain,
substitution policy, stall ladder.

**Motor (`ClimberMotor`)** — the execution layer: the move commands
(`reachFoot`, `reachHand`, `pullHand`, `pushWithLeg`, `releaseFoot`,
`releaseHand`), geometric two-bone IK, joint-angle animation, and
planted-arm adaptation. **Owns all joint angles and timing.**

**MotorStatus** — the result of a motor command: `in-progress`, `latched`,
`unreachable`, or `timeout`.

**Planted-arm adaptation** — during Push, latched arms re-solve their IK
every substep toward a shortened virtual target so the elbow naturally goes
extension → flex as the body rises.

**Shortened (origin-scaled) target** — a virtual IK target placed a fraction
of the way from the limb's origin toward the anchor, so the IK solution is
bent (hauling) rather than taut (pendulum).

**Angular-only motion** — all movement is produced by driving joint target
angles; the motor writes zero velocities.

**Flex-first foot reach** — while the foot is far from its target, the knee
folds up first (lifting the foot off its hold); geometric IK takes over
near the anchor.

## Testing

**Black-box** — the test policy: tests observe only positions, grabs,
phase names, `MotorStatus`, sim time, and the always-on log. Never joint
angles, filter internals, or IK targets.

**Curated seed** — one of the 5 fixed seeds selected once during curation
(valid settled initial hang, varied wall shapes). The set is frozen; a
failing seed means the implementation must improve, never that the seed is
replaced.

**Curated-seed curation** — the one-time documented procedure for choosing
the 5 seeds (see plan §9.3).
