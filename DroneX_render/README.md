# DroneX

A drone configurator. Browse real drones, take them apart, learn what every part does, swap parts and test the
result against missions. Whether a drone can fly a mission is computed in code from sourced part data, never by
a model. Then press **Fly in simulation**: the exact drone goes to the simulation engine (`../dronex/DroneX_1`,
ArduPilot SITL over real-world 3D tiles) and the browser follows it there.

## What you can do

- **Browse**: the Hangar holds eight real drones (5" freestyle, urban light and courier quads, a 3D-printed fixed
  wing, a 2.5" cinewhoop, a 7" long-range quad, a folding hexacopter and a 4+1 VTOL quadplane) and your own
  saved drones; About explains each one in plain words.
- **Learn**: build a drone part by part or all at once, explode it, click any part for its card. Every number
  is clickable and shows its source or its formula.
- **Modify**: a part's card lists the alternatives for its slot with their compatibility; picking one swaps the
  part in 3D and updates the verdict.
- **Test**: the Test panel runs the drone against every mission (pass / fail / not judged per requirement); the
  HUD shows all-up weight, lift and endurance, and Take off flies it.
- **Create**: New drone from any drone as a template or from scratch; Save / Save as new drone, rename,
  duplicate, delete. Designs are stored in the browser as versioned `dronex.design` documents.
- **Fly in simulation**: on a complete drone, the bar's Fly in simulation button packs the parts on the pad as a
  glTF miniature in true metres, derives the ArduPilot vehicle, frame and parameters from the design, starts the
  simulation in the engine and opens the simulation page on that vehicle. Needs the engine running (`../dev.sh`).

## How it works

- `prototype/drone-assembly/` is the configurator: vanilla three.js + anime.js, mounted by the Next app
  (`src/components/assembly/AssemblyStage.tsx`). The contract is
  `prototype/drone-assembly/docs/drone-integration.md`.
- `prototype/drone-assembly/src/data/drone/` holds the datasets (motors, propellers, batteries, airframes,
  payloads, missions, presets), each record with a source; `SOURCES.md` there lists them. It is the single
  source of truth; `scripts/check-drone-physics.mjs` validates it.
- `dronePhysics.js` computes the verdict (thrust from the motor and propeller records, hover thrust-to-weight,
  power, endurance, range, discharge, mission checks). Every computed number is labelled `est.`.

## Run it

Needs Node 20 or newer.

```bash
npm install
npm run dev        # http://localhost:3000 (configurator only)
../dev.sh          # from the project root: configurator + simulation engine, for Fly in simulation
```

URL flags: `?build=<preset-id>` opens a preset directly (e.g. `?build=eclipson-model-a-scout`), `?panel=1`
shows the full readiness panel, `?lite=1` drops post-processing and shadows for weak GPUs.

Keys: `Space` explode / assemble · `B` build all · `L` take off · `R` reset · `[` `]` change drone ·
`X` see-through · `N` day / night · `W` weather · `1`–`9` build or remove the n-th part · `Esc` close.

## Checks

```bash
npm run typecheck && npm run lint && npm test
node prototype/drone-assembly/scripts/check-drone-physics.mjs
```

Docs: [`docs/SPEC.md`](docs/SPEC.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/ROADMAP.md`](docs/ROADMAP.md).
