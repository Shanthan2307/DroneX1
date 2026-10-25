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

## Phase 4: Fly it in the simulation engine (done)

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

## Phase 5: The city has more than one drone (current)

The flying half grows a voice, a shared airspace, memory and a front door, each on a sponsor technology that does
real work and is named on screen (the "Built with" sidebar, `src/lib/tracks.ts`):

- **Voice copilot (Cartesia)** at `/copilot`: Ink streaming speech-to-text in, Sonic callouts and replies out,
  barge-in; commands go through one tool layer (`src/lib/sim/tools.ts`) chosen by function calling
  (`src/lib/ai/intent.ts`); callouts are deterministic templates over live telemetry (`/api/copilot/events`).
- **Shared airspace (SpacetimeDB)**: `DroneX_live` mirrors every vehicle into tables; corridor reservations,
  altitude bands and separation are reducers; the airspace view on `/copilot` subscribes live; `/api/airspace`
  serves agents that cannot speak Spacetime.
- **Flight analytics (Elastic)**: the mirror indexes fixes, events and verdicts; ArduPilot's parameter manual,
  the catalog notes and the physics formula notes sit in `semantic_text`; an Agent Builder agent and a Workflow
  find the signal; the mission card shows fleet statistics from `/api/analytics`.
- **DroneX Dispatch (Fetch.ai / ASI:One)**: `DroneX_agents` (dispatcher, fleet agents, flight agent) over
  `/api/catalog`, `/api/verdict`, `/api/sim/designs`, `/api/sim/refly/<id>`, `/api/sim/vehicles/<id>` (the
  copilot's tools run directly, plus pre-arm readiness), `/api/copilot/intent` (pilot commands relayed while a
  flight is on) and `/api/airspace` (corridor before the go-to, mission status), with Interactive Cards and the
  Payment Protocol as a bonus (testnet FET, checked on chain before the flight). The `/dispatch` page shows the
  agents, their addresses and whether ASI:One can reach the dispatcher (`/api/dispatch`).

Dependencies added for this phase, with the human's approval: `openai`, `@cartesia/cartesia-js`, `spacetimedb`
(configurator); `spacetimedb`, `@elastic/elasticsearch`, `tsx`, `vitest` (live layer); `uagents`, `openai`,
`httpx`, `python-dotenv`, `pytest` (agents). The verdict stays code; no model computes a number.

## Out of scope

Accounts and a database, multiplayer, CFD or structural analysis, and any number that is not sourced or
computed from sourced fields.
