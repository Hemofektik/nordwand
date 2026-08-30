# Nordwand

<p align="center">
  <img src="concept/nordwand_mockup_04_large.png" alt="Nordwand concept art: a climber on a sheer north face, rope trailing into the clouds" width="100%">
</p>

<p align="center"><em>A lone climber, a rope, and a wall that never quite looks the same twice.</em></p>

**Nordwand** is a physics-driven climbing prototype. You hang from a generated rock face, lean left and right, and try not to let go. The mockup above is the look the game is aiming for: a quiet alpine north wall, pixel clouds, and a climber who is never more than one hold away from empty air.

The current build is the simulation underneath that picture — spring-particle physics, a ragdoll skeleton, a pixel rope, and a climbing AI that raises and reaches for the next anchor.

## Play

```bash
npm install
npm run dev
```

Then open [http://localhost:8000](http://localhost:8000). The canvas is 560×840, tall like the wall itself.

| Key | Action |
| --- | --- |
| **A** / **←** | Lean left |
| **D** / **→** | Lean right |
| **F** | Let go |
| **R** | New random wall |
| **P** | Pause |
| **H** | Help |
| **M** | Mute |
| **N** | Next song |
| **S** | Freeze physics (zero velocities) |
| **D** | Toggle debug |
| Mouse wheel | Zoom |

## How it feels

Every wall is generated from a noisy walk of segments, then studded with anchors. The climber is not a sprite with a jump button — they are a chain of particles:

- **Body** — pelvis, back, neck, head
- **Arms and legs** — elbows, wrists, knees, ankles
- **Grabs** — hands and feet pinned to wall anchors
- **Rope** — a Bresenham pixel line from the wall down to the pelvis

Distance springs keep limbs the right length. Angular constraints hold posture. Gravity pulls at 80 units. The climber and rope collide with the rock — they stay on the air side of the wall. If you let go, there is nothing left but the rope and the fall.

The climbing AI cycles through **raise** (flex a planted arm, extend a planted leg) and **reach** (free hand and free foot grab the next reachable anchors). Limbs leapfrog: after a grab, the lower hold is released so the next move can start.

## Project

| | |
| --- | --- |
| Language | TypeScript **7.0.2** |
| Bundler | Vite 6 |
| Loop | `requestAnimationFrame` on a 2D canvas |
| Physics | Midpoint spring integration, 4 ms fixed step |

```
src/
  main.ts          entry, canvas setup
  Game.ts          input, pause, level load, frame loop
  Physics.ts       particles, springs, angular constraints
  Wall.ts          procedural face and anchors
  Skeleton.ts      body, limbs, grabs
  Rope.ts          pixel rope
  ClimbingAI.ts    raise / reach
  Camera.ts        pixel-snapped world camera
  MusicPlayer.ts   songs and SFX
  PixelSprite.ts   nearest-neighbor scaled sprites
public/            CSS, control icons, sprites
concept/           visual target for the climb
```

```bash
npm run typecheck   # tsc --noEmit (TypeScript 7)
npm run build       # typecheck + Vite production build
```

## Concept

The image at the top is `concept/nordwand_mockup_04_large.png` — the intended mood of the finished game. Wide sky, layered mountains, a textured wall, and a climber who looks small because the drop is real. The live prototype is still drawing debug bones and wall segments; the mockup is the north face those bones are trying to become.

Music in the original build: *sevenhundredbeats* by Duncan Beattie.
