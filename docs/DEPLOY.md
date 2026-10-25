# Deploying DroneX live

A plan for taking DroneX from `./dev.sh` on a laptop to a public URL. Nothing here has been deployed yet; each
step says what it rests on in the code, and the open questions are listed at the end.

## What constrains the shape

These facts in the code decide the layout before any provider is chosen:

1. **The configurator and the simulator must share a machine.** `DroneX_render/src/lib/sim/` reaches the Core
   daemon over its local unix socket (`<data dir>/uxduck.sock`, JSON-RPC, same user). The Next.js server routes
   that fly a drone cannot run on a serverless host (Vercel, Netlify) apart from the daemon.
2. **The simulator's web listener is loopback-only by design.** `core/crates/uxduck/src/api/listeners/http.rs`
   refuses any `Host` header that is not `127.0.0.1`, `localhost` or `[::1]` on its port, refuses foreign
   `Origin`s, and requires each browser to pair (a code approved with `uxduck rpc call pairing/approve`). The
   only switch that adds a public host is `--dev-origin`, and it is used only with `--dev`. Putting the
   simulator page behind a domain therefore needs either that switch (to verify) or a small patch to the
   allowlist in our fork.
3. **ArduPilot SITL is a native process per vehicle, CPU-bound.** The builds in
   `dronex/DroneX_1/.dev/core-data/simulators/` are gitignored and were built on macOS; a Linux server rebuilds
   them with `dronex/DroneX_1/scripts/build-sitl.sh copter plane`.
4. **The microphone needs HTTPS.** Ask DroneX and `/copilot` use `getUserMedia`, which browsers allow only on a
   secure origin. The public site must be served over TLS.
5. **`dev.sh` is a development runner**: it runs `next dev`, a debug Core build and the processes as children of
   one shell. Production runs `next build && next start`, a release Core build, and each process under a
   supervisor.
6. **SpacetimeDB, Elastic and Agentverse are already hosted services or can be**: SpacetimeDB Maincloud
   (`SPACETIME_SERVER=maincloud DroneX_live/scripts/spacetime-publish.sh`), Elastic Cloud Serverless, and the
   Fetch.ai agents reach Agentverse through its mailbox, so they need outbound traffic only.

## Target layout

One Linux VM runs every process that needs the socket or SITL; managed services hold the rest.

```
                   https://dronex.<domain>            https://sim.dronex.<domain>
                            │                                    │
                  ┌─────────┴────────── Caddy (TLS, WebSockets) ─┴──────────┐
                  │                                                         │
   Linux VM       │  DroneX_render   next start :3000 ─┐                    │
   (Ubuntu LTS)   │                                    │ unix socket        │
                  │  Core daemon (release) :45010 ◀────┘   + ArduPilot SITL │
                  │  account backend :45103 (private)                       │
                  │  DroneX_live mirror        DroneX_agents (uAgents)      │
                  └──────────────┬───────────────────────────┬──────────────┘
                                 │ outbound only             │ outbound only
                 SpacetimeDB Maincloud · Elastic Cloud   Agentverse / ASI:One · Cartesia · intent LLM
```

## Plan

### Phase 0: decisions and accounts (half a day)

- A domain, with two names: `dronex.<domain>` (configurator, Ask DroneX, `/copilot`, `/dispatch`) and
  `sim.dronex.<domain>` (the simulator page).
- A VM provider. Any plain Ubuntu LTS VM works; size it by the number of simultaneous flights, since each runs
  its own SITL. Start with a mid-size general-purpose instance and measure (Phase 5).
- Production keys, separate from the development ones: `INTENT_API_KEY`, `CARTESIA_API_KEY`, Elastic,
  `AGENTVERSE_API_KEY`, fresh `DRONEX_*_SEED`s (or the current ones, if the agents' Agentverse addresses must
  stay the same).
- Decide who can fly: an open demo (anyone may start a simulation) or a gated one (an access code). This sets
  how much of Phase 4 is needed.

### Phase 1: make the simulator reachable from a domain (1 to 2 days, the riskiest step)

- Try `uxduck daemon --dev --dev-origin https://sim.dronex.<domain>` behind Caddy and check that the page,
  pairing and the `/rpc` WebSocket all work, and that `--dev` changes nothing else that matters.
- If it does, or does not work at all, add a `--public-origin` (repeatable) option to our fork that extends
  `Allowlist::new` with that origin and its host, without `--dev`. It is a few lines in `daemon/mod.rs` and
  `cli/mod.rs`, plus a test next to the existing allowlist tests.
- Pairing: every new browser shows a code that the operator approves on the server. For a judged demo that is
  fine (approve the judges' browsers). For an open demo, decide between keeping pairing (safe, manual) and
  approving automatically, which must come with the access gate from Phase 4.
- `dronex/DroneX_1/scripts/patch-interface-dronex.mjs` and `patch-interface-tracks.mjs` patch the served
  interface; run them once at deploy, as `dev.sh` does.

### Phase 2: build for Linux (1 day)

On the VM (or in a CI job that produces the same artifacts):

```sh
# toolchains: Node 24.11+, Rust via rustup, Python 3.11 + uv, openssl, ffmpeg (live video), the SpacetimeDB CLI
(cd dronex/DroneX_1/core && cargo build --release --locked -p uxduck)
dronex/DroneX_1/scripts/build-sitl.sh copter plane
(cd dronex/DroneX_1/backend && npm ci)
(cd DroneX_render && npm ci && npm run build)
(cd DroneX_live && npm ci)
uv venv --python python3.11 DroneX_agents/.venv
uv pip install --python DroneX_agents/.venv/bin/python -r DroneX_agents/requirements.txt
```

- `DroneX_render/.env.local` on the server only, owned by the service user, mode `600`. It is gitignored at the
  root and must never be copied into an image layer.
- `SPACETIME_URI` and `NEXT_PUBLIC_SPACETIME_URI` point at Maincloud (`wss://maincloud.spacetimedb.com`); publish
  the module once with `SPACETIME_SERVER=maincloud DroneX_live/scripts/spacetime-publish.sh`.
- `DRONEX_RENDER_URL` is the public configurator URL, so the flight agent reaches the API through it (or keep it
  at `http://localhost:3000`, since the agents run on the same VM).

### Phase 3: run it as services (half a day)

One systemd unit per process, all as a dedicated `dronex` user, `Restart=on-failure`, logs to journald. The
environment each needs is the one `dronex/DroneX_1/scripts/dev.sh` and the root `dev.sh` set today:

| Unit | Command | Notes |
|---|---|---|
| `dronex-backend` | `node src/server.ts` in `dronex/DroneX_1/backend` | `PORT=45103`, `DATABASE_PATH`, `SESSION_SECRET` from a file; bound to localhost |
| `dronex-core` | `core/target/release/uxduck daemon --data-dir … --port 45010 --ui-dir … --no-update-check --no-analytics` | the `UXDUCK_*` variables from `scripts/dev.sh`, plus the origin from Phase 1; `After=dronex-backend` |
| `dronex-render` | `npm run start` in `DroneX_render` | `DRONEX_CORE_DATA_DIR` = the Core data dir, so it finds the socket; `After=dronex-core` |
| `dronex-mirror` | `npm run mirror` in `DroneX_live` | `After=dronex-core` (it waits for the socket) |
| `dronex-agents` | `DroneX_agents/dev.sh` | `After=dronex-render` |

Caddy in front, with automatic TLS:

```
dronex.<domain>      { reverse_proxy 127.0.0.1:3000 }
sim.dronex.<domain>  { reverse_proxy 127.0.0.1:45010 }
```

Caddy passes WebSockets through as is (`/rpc` on the simulator, the Cartesia streams go straight from the browser
to Cartesia with short-lived tokens). Ports 45103, 45011 and 3000 stay closed in the firewall; only 80 and 443
are open, plus SSH.

### Phase 4: protect what costs money (1 day)

A public URL exposes paid APIs and CPU. Before sharing it:

- **Rate-limit** `/api/assistant`, the copilot command route and the Cartesia token route per IP (in Caddy, or
  a small check in the route handlers). Each call spends LLM or voice credits.
- **Cap simultaneous simulations** (for example one per visitor and a small global limit) and stop idle ones with
  `sim/stop`, so a crowd cannot start SITL processes until the VM runs out of CPU.
- **Gate Fly in simulation** behind an access code if the demo is open, and keep the read-only parts (building,
  testing, Ask DroneX) public.
- Spending limits on the intent model and Cartesia accounts, and alerts on the Elastic project.
- Keys rotated from the development ones; nothing in `keys.txt` reused.

### Phase 5: verify (half a day)

Run the README's two-minute demo end to end on the public URL, from a browser that is not the operator's:

1. `/?build=apex-5-urban-light` → Build all → Test with FPV sprint → does not pass.
2. Ask DroneX by voice (checks HTTPS + microphone + Cartesia) → the motor swap → CLEARED.
3. Fly in simulation → the drone appears on the pier at `sim.dronex.<domain>` (checks Phase 1 and pairing).
4. `/copilot`: "take off to thirty metres", "go to Coit Tower" → the vehicle shows in the live airspace
   (SpacetimeDB) and its fixes reach Elastic.
5. `/dispatch` shows the agents connected; one ASI:One request flies.

Then measure: CPU and memory with one, three and five drones in the air, to size the VM and set the cap from
Phase 4. Run `npm run typecheck && npm run lint && npm test` and the physics check on the deployed commit.

### Phase 6: keep it running

- A deploy script (`git pull`, the Phase 2 builds, `systemctl restart dronex-*`) or a CI job that runs the tests
  and then the script over SSH.
- Back up the Core data dir and `backend.db` (accounts, vehicles); the rest is rebuilt from the repo.
- Uptime checks on both domains and on `/api/tracks`.

## Alternatives considered

- **Configurator on Vercel, simulator on a VM.** The configurator's fly and assistant routes need the daemon's
  socket, so they would have to become HTTP calls to the VM through an authenticated tunnel. It adds a network
  hop and a second auth layer to save one process. Worth it only if the configurator alone (no flying) should
  be served at the edge.
- **Containers (Docker Compose).** The same units as Phase 3 in one compose file, with the socket on a shared
  volume. A good next step once the VM layout works; SITL and the Rust build make the images large, so start
  without them.
- **Nothing public for the simulator.** Serve the configurator publicly and show the simulator from the
  operator's machine (screen share or an SSH tunnel). It avoids Phase 1 entirely and is the fallback if the
  allowlist change slips.

## Open questions

- Does `--dev` do anything besides allowing `--dev-origin` that is unwanted in production? (Phase 1)
- Does the photorealistic tile source the simulator uses (`tile.googleapis.com`) need its own key or quota for a
  public deployment, and under whose account?
- How many simultaneous SITL flights does a given VM size hold? (Phase 5 measures it.)
- Open demo or gated demo? (Phase 0)
