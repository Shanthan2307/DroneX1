# DroneX live layer

The processes that sit beside the simulation engine and share what it knows: the **mirror** reads the engine's
unix socket (vehicles and telemetry) and feeds every sink; the sinks are the **shared airspace** (SpacetimeDB)
and the **flight index** (Elastic). Started by `../dev.sh`; run by hand with `npm run mirror`.

```
simulation engine (Core daemon) --unix socket--> mirror.ts --> sinks/spacetime.ts --> SpacetimeDB "dronex-airspace"
                                                            \-> sinks/elastic.ts   --> Elastic Cloud Serverless
```

Keys and addresses live in `../DroneX_render/.env.local` (see `.env.local.example` there); the mirror reads the
same file.

## SpacetimeDB: the shared airspace

A city has more than one drone. The simulation engine knows only its own computer's vehicles; the airspace is
one live world for every operator and every agent: the vehicles in the air, their latest positions, the corridors
they hold, the incidents they report and the missions they carry. The rules live in the database, next to the
data, and run inside transactions.

**Module** (`spacetime/`, Rust, published as `dronex-airspace`):

| Table | What |
|---|---|
| `vehicle` | id, name, design_id (the DroneX design behind it), vehicle_type, operator, presence, armed, mode, size_cm, updated_at |
| `position` | the latest fix per vehicle: lat, lon, altitudes, heading, speed, battery, GPS satellites, EKF status |
| `corridor` | a segment, a width and an altitude band, for a while: granted, refused (with the reason), released or expired |
| `incident` | building brake, GPS degraded, EKF, battery threshold, mode change, corridor refused |
| `mission_assignment` | which agent gave which vehicle which mission, and where it stands |

**Rules** (reducers):

- `request_corridor` grants a corridor unless its centre line comes within the two corridors' half-widths plus
  10 m of a corridor another vehicle holds, with altitude bands within 10 m of each other. A refusal is written as
  a row with the reason (the holder, the distance, the band, what to climb above) and an incident, so every
  subscriber sees it. Atomic: two requests for the same air cannot both be granted.
- `release_corridor` gives one back; the housekeeping `tick` (every 2 s) expires granted corridors past their
  time and marks a vehicle stale after 7.5 s and offline after 15 s without a position. Once a minute it prunes:
  corridors never granted and requested over an hour ago, released or expired corridors an hour past their
  expiry, incidents older than an hour, and vehicles offline for 10 minutes with their position and mission.
  `tick` runs on the module's schedule only.
- `upsert_vehicle`, `report_position`, `record_incident`, `assign_mission` are what the mirror and the agents
  write (the agents through the configurator's server).

**Who may write.** Everyone may subscribe: browsers read the airspace live, anonymously. Only the owner and the
identities in the private `writer` table may call the mutating reducers above (and `keepalive`, a tiny write the
mirror makes every `MIRROR_KEEPALIVE_HOURS`, default 3, so a hosted database never looks idle). The owner is the
identity that published the database: `init` stores it in the private `config` table. Only the owner may call
`add_writer(identity)` and `remove_writer(identity)`. A database published before the allow-list existed has no
owner; republish it on a clean database.

DroneX's own server processes, the mirror and the configurator's server, share one writer identity: they connect
with the same token, `SPACETIME_TOKEN`. (Without it, `SPACETIME_TOKEN_FILE` names a file to read the token from, or
to save a freshly issued one to.) Register it once, signed in to the CLI as the publisher:

```sh
# mints a token on the server, prints the identity and SPACETIME_TOKEN=..., and calls add_writer
SPACETIME_SERVER=maincloud SPACETIME_DB=dronex-airspace DroneX_live/scripts/spacetime-add-writer.sh
# or register an existing token: SPACETIME_TOKEN=... (or a token file as the first argument)
# take it back: DroneX_live/scripts/spacetime-add-writer.sh --remove 0x<identity>
```

Put the printed `SPACETIME_TOKEN=...` in the env of both the mirror and the configurator. For local development,
run the same script without `SPACETIME_SERVER` (it targets http://127.0.0.1:3100) and put the token in
`DroneX_render/.env.local`. Without a registered token the mirror connects but every write is refused, with a log
line saying so.

**The mirror in production** exits with status 1 so systemd restarts it: when the engine's socket closes, when the
SpacetimeDB connection drops, or after `MIRROR_MAX_TICK_FAILURES` (default 10) failed ticks in a row. Set
`MIRROR_OPERATOR=DroneX`: it is the operator name every visitor sees on each vehicle. Without it the mirror uses
"DroneX" when `NODE_ENV=production` and the computer's host name otherwise.

The corridor geometry (`spacetime/src/geo.rs`) has unit tests: `cd spacetime && cargo test`.

**Where it is used**

- `src/sinks/spacetime.ts`: the mirror publishes every vehicle, every rate-limited fix and every flight event.
- `../DroneX_render/src/components/airspace/AirspaceView.tsx`: the Copilot page subscribes and draws every drone
  and corridor live, with a "Request corridor" control (select a vehicle, click two points, pick a band).
- `../DroneX_render/src/app/api/airspace/*`: JSON routes for agents that do not speak the SpacetimeDB protocol
  (the Fetch.ai Dispatch agents): `GET /api/airspace`, `POST /api/airspace/corridor`,
  `POST /api/airspace/corridor/<id>/release`, `POST /api/airspace/mission`.
- `src/spacetime/bindings/`: the TypeScript bindings (also copied to `../DroneX_render/src/lib/airspace/bindings`).

**Run it**

```sh
# once: the CLI
curl -sSf https://install.spacetimedb.com | sh            # installs ~/.local/bin/spacetime

# a local server on 127.0.0.1:3100 (the configurator has port 3000)
DroneX_live/scripts/spacetime-start.sh

# build the module and publish it as dronex-airspace (repeat after changing spacetime/src)
DroneX_live/scripts/spacetime-publish.sh

# regenerate the TypeScript bindings after changing the module
DroneX_live/scripts/spacetime-generate.sh

# the mirror, with SPACETIME_URI=ws://127.0.0.1:3100 in DroneX_render/.env.local
cd DroneX_live && npm run mirror
```

Maincloud instead of local: `spacetime login`, then `SPACETIME_SERVER=maincloud DroneX_live/scripts/spacetime-publish.sh`
and set `SPACETIME_URI=wss://maincloud.spacetimedb.com` (and the `NEXT_PUBLIC_` pair) in `.env.local`. Then register
the writer as above. Never publish with `--delete-data` against production.

**The demo**

1. Press Fly in simulation twice from the configurator (two hangar drones), or fly one and start a second from
   the simulator's New simulation. Both appear on the Copilot page's airspace map within a second.
2. Select the first drone, click two points across the pier, ask for a corridor at 30–60 m: granted, drawn as a
   band.
3. Select the second drone, click two points that cross the first corridor at the same band: refused, in red,
   with the reason naming the holder and the band to climb above.
4. Ask again at 80–110 m: granted. The routing above the buildings is the one the engine's own building-aware
   Go to takes; the airspace now says why.

Inspect the tables directly: `spacetime sql --server http://127.0.0.1:3100 dronex-airspace "SELECT * FROM corridor"`.
