# DroneX: Architecture

One Next.js app, one screen. The screen is a vanilla three.js configurator in `prototype/drone-assembly/`, mounted
by the Next app. The physics runs in the browser, in plain JavaScript, from JSON datasets in the repo.

```
 src/app/page.tsx ──► components/assembly/AssemblyStage.tsx (client)
                         │  markup.ts reads prototype/drone-assembly/index.html (server) so the DOM matches
                         ▼
 prototype/drone-assembly/src/main.js   renderer, camera, lights, post, HUD, Hangar (ui/hangar.js), keys, loop
   ├─ vehicle.js            facade: presets, manifest, verdict, options, missions, readiness
   │    ├─ data/droneCatalog.js + data/drone/*.json   sourced records, presets, options, readiness
   │    ├─ droneLayout.js     build → part manifest (display scale viewK, slots, bounds)
   │    ├─ dronePhysics.js    the verdict (pure; DRONE_RULES)
   │    └─ droneCompat.js     option compatibility (ok / unusual / incompatible)
   ├─ parts.js + droneParts.js   procedural geometry: shared toolkit (KIT), materials and looks; drone builders
   ├─ choreo.js             build / remove / explode / scrub / swap / camera framing (anime.js)
   ├─ droneFlight.js        take-off, mission leg, landing; propeller spin; telemetry
   ├─ simProfile.js         pure: ArduPilot vehicle / frame, footprint, parameters from the verdict (Fly in simulation)
   ├─ simExport.js          the built parts as a glTF miniature in true metres, propellers as named nodes
   ├─ dronePad.js           landing pad on its field, fixed-wing launch stand
   ├─ world.js, planet.js, bodies.js   far layer: sky, Earth, sun; the landing page's globe
   ├─ fx/                   hologram ghost, lock flash, cloud layer, sound
   └─ ui/                   shell (DOM), card + droneCard, select, scrub, readiness panel, landing page
```

## Decisions

1. **Code decides the verdict.** `dronePhysics.evaluateDrone` is pure and deterministic; the HUD, the cards,
   the readiness panel and the flight all read the same verdict object.
2. **Data saved as JSON ahead of time**, every record with a source. No live data calls.
3. **Procedural parts.** Every part is generated from its record (true metres, drawn at the display scale
   `viewK` so any drone fills the view; see the integration doc §2).
4. **One screen.** The landing page dives from orbit to the drone pad; everything else is the configurator.
5. **One project with the simulation engine.** `Fly in simulation` posts the design, its simulation profile and
   the packed model to `/api/sim/fly`; the server (`src/lib/sim/`) starts the vehicle in Core over its local
   unix-socket RPC (no pairing, same user), names and sizes it, attaches the model as a bookmark the simulation
   UI's patched model lookup reads, writes the parameters in the background, and the browser moves to the
   simulation page (`?vehicle=<id>`). Models and designs sent are kept in `.dronex/sim/<id>/` (gitignored) and
   served by `/api/sim/designs/<id>` and `/model.glb` with open CORS, since the simulation UI is another origin.

## Stack (fixed; ask before adding a dependency)

| Layer | Choice |
|---|---|
| App shell | Next.js (App Router) + TypeScript |
| 3D | three.js 0.180 + anime.js 4 (vanilla, in `prototype/drone-assembly`) |
| Tests | Vitest (`src/**/*.test.ts`), plus `node prototype/drone-assembly/scripts/check-drone-physics.mjs` |
| Data | JSON in repo (`prototype/drone-assembly/src/data/drone/`, hand-edited, validated by `check-drone-physics.mjs`) |

Tailwind is loaded only by `src/app/globals.css`; the old app's React Three Fiber, drei, zod and zustand were
removed on 2026-10-24.

## Repo layout

```
src/app/                    layout (title, metadata), page, icon, globals.css
src/app/api/sim/            route handlers: fly (POST), designs/[id] and designs/[id]/model.glb (GET, CORS)
src/components/assembly/    AssemblyStage (mounts the configurator), markup.ts, tests
src/lib/sim/                core.ts (Core unix-socket JSON-RPC client), store.ts (.dronex/sim), fly.ts (start the
                            vehicle, name, size, bookmark, parameters), simProfile.test.ts
src/lib/ai/grokClient.ts    a standalone xAI client, not wired into the UI (kept for later use)
prototype/drone-assembly/   the configurator (its own index.html + Vite config for standalone runs)
  docs/drone-integration.md the front-end contract: build, manifest, display scale, verdict, readiness
  scripts/check-drone-physics.mjs   physics and compatibility checks (node, no deps)
  scripts/shot.mjs          screenshots of the running app over the DevTools protocol
docs/                       SPEC, ARCHITECTURE, ROADMAP
```

## Running

`npm run dev` serves the app on http://localhost:3000 (`?build=<preset-id>` opens a preset directly, skipping
the landing page; `?panel=1` shows the full readiness panel; `?lite=1` drops post-processing and shadows;
`?sim=<id>` reopens a design sent to the simulator). `Fly in simulation` needs the simulation engine running:
`../dev.sh` at the project root starts both, and `DRONEX_CORE_DATA_DIR` tells this app where Core's data folder
(and so its `daemon.json` and socket) is; it defaults to `../dronex/DroneX_1/.dev/core-data`.
