# DroneX: Roadmap

Each phase ends with `npm run typecheck && npm run lint && npm test` and the drone physics check passing, and
a look at the running app (`prototype/drone-assembly/scripts/shot.mjs`). Nothing from a later phase starts early.

## Phase 1: Drone-only configurator (done)

- Rockets, the launch complex, the rocket data and the Grok UI removed; the configurator is drone-only.
- Four real presets (5" freestyle quad, urban light quad, medical courier, fixed-wing scout): build, explode,
  part cards with sourced numbers and swap options, mission picker, verdict, take off and landing.
- Rebranded to DroneX (logo in prototype/drone-assembly/src/assets/brand/, app icons in src/app/).

## Phase 2: Browse and learn (done)

- More real drones in the datasets, every number sourced (`TODO(source)` where a value is unknown).
- Part cards explain what each part does and why the numbers matter, in plain words.
- One source of truth for the data: `prototype/drone-assembly/src/data/drone/` (done; the old generated copy in
  `src/data/drone/` was removed).

## Phase 3: Modify, test, create (done)

- Mission tests with clear pass / fail reasons for each requirement (weight, endurance, lift, speed, payload).
- Save a modified build as a new drone (name, parts, mission), and reopen it.

Shipped: eight real drones (5" freestyle/urban/courier, Eclipson fixed wing, GEPRC CineLog25 cinewhoop, iFlight
Chimera7 long range, Tarot X6 hexacopter, XUWING VTBIRD 4+1 VTOL), each drawn and flown as its type; the Hangar
(real drones + my drones), About, the Test matrix (pass / fail / not judged per requirement, per mission), New
drone (from a template or from scratch), Save / Save as / rename / duplicate / delete, and the versioned design
model `dronex.design` v1 in `prototype/drone-assembly/src/designs.js` (localStorage key `dronex.designs.v1`).
Open data gaps are listed as TODO(source) in `prototype/drone-assembly/src/data/drone/SOURCES.md`.

## Phase 4: Fly it in the simulation engine (current)

Decided on 2026-10-24: there is no export file and no hand-off. The configurator and the simulation engine
(`../dronex/DroneX_1`: UXDuck Core + ArduPilot SITL, with its own web UI over Cesium 3D tiles) are one project,
started together by `../dev.sh`. The user builds a drone, presses **Fly in simulation**, and the browser moves
to the simulation page with that drone on the map as a simulated vehicle.

- Shipped: `Fly in simulation` on a complete drone packs the exact parts on the pad as a glTF miniature in true
  metres (`simExport.js`), derives the simulation profile from the datasets and the verdict (`simProfile.js`:
  ArduPilot vehicle and frame, footprint, battery / hover / airspeed parameters), and posts both with the design
  to `/api/sim/fly`. The server (`src/lib/sim/`) starts the simulation over Core's local RPC, names and sizes the
  vehicle, attaches the model, writes the parameters once the vehicle has downloaded its own, and answers with the
  simulation page's address for that vehicle. The simulation UI draws the model (its model lookup is patched by
  `dronex/DroneX_1/scripts/patch-interface-dronex.mjs`). The vehicle's "Open in DroneX" bookmark reopens the
  design here (`?sim=<id>`).
- Known limits: SITL flies ArduPilot's standard frame dynamics; the design sets the battery model, hover
  throttle and airspeeds, not the airframe's mass or motor curves. Starts on the ground at the simulation UI's
  default spot (`DRONEX_SIM_LAT` / `LON` / `HEADING` override). Tiltrotor airframes fly as a tilt-tri quadplane.
- Next: start in the air as an option; a per-design SITL model (ArduPilot's JSON frame files) for mass and thrust.

## Out of scope

Accounts and a database, multiplayer, CFD or structural analysis, and any number that is not sourced or
computed from sourced fields.
