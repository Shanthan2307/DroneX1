# Deploying DroneX: runbook

This runbook covers the public, loginless DroneX on one Ubuntu 24.04 VM. The design and its reasons are in [docs/DEPLOY.md](../docs/DEPLOY.md). Before you deploy, every Part A item there must be merged, above all the Core public guest mode (`--public-origin`). `deploy.sh` refuses a Core build that lacks it.

| File | What it does |
|---|---|
| `provision.sh` | One-time VM setup: packages, Node 24, Caddy, Rust, uv, the `dronex` user, directories, env files with generated secrets, a Core limits drop-in and ufw. |
| `deploy.sh` | Builds a release into `/opt/dronex/releases/<sha>`, switches `/opt/dronex/current`, restarts the units and runs the checks. Also handles `rollback` and `status`. |
| `check.sh` | The checks that can be automated: HTTPS, the guest session, 404s, closed ports and rate limits. |
| `systemd/*.service` | The five units, running as `dronex` with hardening. |
| `Caddyfile` | TLS, HSTS, body caps, agent-only path blocks and the routing for `sim.` and `dronex.`. |
| `env.example` | Every variable, split into the four files under `/etc/dronex/`. |

## 1. What you provide

- A domain, with A (and AAAA) records for `dronex.DOMAIN` and `sim.DOMAIN` pointing at the VM.
- An Ubuntu 24.04 VM (x86_64 or arm64) with 4+ cores and 8+ GB of RAM, plus 40 GB of disk for the SITL and Rust builds. You also need SSH access and your own IP.
- Keys, each with a spend limit:
  - `GOOGLE_MAPS_KEY`: Map Tiles API only, referrer `https://sim.DOMAIN/*`.
  - `ARCGIS_KEY`: basemap and elevation, restricted to the `sim.DOMAIN` referrer.
  - `ARCGIS_GEOCODE_KEY`: geocoding only, restricted to the VM's IP.
  - `CARTESIA_API_KEY` and `CARTESIA_VOICE_ID`.
  - `INTENT_API_KEY` (ASI:One).
  - An Elastic Serverless URL, a reader key and a writer key.
  - An Agentverse API key.
- A SpacetimeDB Maincloud login, on your laptop.
- If the repo is private, a read-only deploy key at `/var/lib/dronex/.ssh/id_ed25519` and an ssh `REPO_URL`.

`provision.sh` generates `DRONEX_AGENT_TOKEN`, `DRONEX_COOKIE_SECRET`, `SESSION_SECRET` and the three agent seeds. Never reuse development values.

## 2. Order of commands

On the VM:

```sh
git clone <repo-url> ~/DroneX && cd ~/DroneX

# One time
sudo DOMAIN=example.com REPO_URL=<repo-url> SSH_FROM=<your-ip> deploy/provision.sh
sudo -e /etc/dronex/env /etc/dronex/backend.env /etc/dronex/mirror.env   # fill the keys; no inline comments

# Every release (the first one takes long: Rust, ArduPilot SITL, next build)
sudo deploy/deploy.sh                 # tip of BRANCH from /etc/dronex/deploy.conf
sudo deploy/deploy.sh deploy v1.2.0   # or a branch, tag or commit
sudo deploy/deploy.sh status
```

What `deploy.sh` does, in order:
1. Checks the env files: required values, public URLs that match `DOMAIN`, `wss://`, and `DRONEX_MAX_SIMS` below 32.
2. Fetches a bare mirror and clones the commit into `/opt/dronex/releases/<sha12>`.
3. Builds as `dronex`:
   - the state symlinks (`.dronex`, `logs`, `.env.local`);
   - the Core release build (`UXDUCK_RELEASE_PUBLIC_KEY`, `--no-default-features`, plus `CORE_FEATURES` if set), with a shared cargo target in `/var/lib/dronex/build`;
   - ArduPilot SITL `copter plane`, skipped when it is already built for the pinned commit;
   - the interface repoint, using `point-interface.mjs --from http://localhost:45103 https://sim.DOMAIN`, the two `patch-interface-*.mjs` scripts and `set-render-url.mjs https://dronex.DOMAIN`, then verified;
   - the backend `npm ci` and its tests;
   - the configurator `npm ci`, typecheck, lint, test and `next build` with `/etc/dronex/env` loaded, then a check that the sim URL is baked in, and the physics check;
   - the live layer `npm ci`;
   - the agents' venv and pytest.

   `SKIP_TESTS=1` skips the tests.
4. Installs the units and the rendered Caddyfile from that release (`caddy validate` runs first), and snapshots the SQLite databases to `/var/backups/dronex`.
5. Carries the agents' `*_data.json` over through `/var/lib/dronex/agents-data`, switches `current` atomically and restarts the units. **Running sims stop**, so deploy at quiet times.
6. Runs the smoke checks and `check.sh --local`. If they fail, it rolls back to the previous release on its own (`AUTO_ROLLBACK=0` turns that off).

From your laptop, after the first deploy and again after changes:

```sh
deploy/check.sh example.com           # adds the external port scan and the 429 test
```

The rest of `docs/DEPLOY.md`'s "Verification checklist" is manual: the browser demo, guest RPC denials over `/rpc`, cross-visitor control and SpacetimeDB anonymous writes.

## 3. SpacetimeDB (laptop, one time; then after module changes)

```sh
curl -sSf https://install.spacetimedb.com | sh && spacetime login
rustup toolchain install 1.98.1 && rustup target add wasm32-unknown-unknown --toolchain 1.98.1
SPACETIME_SERVER=maincloud SPACETIME_DB=dronex-airspace DroneX_live/scripts/spacetime-publish.sh
SPACETIME_SERVER=maincloud SPACETIME_DB=dronex-airspace DroneX_live/scripts/spacetime-add-writer.sh
```

- `spacetime-add-writer.sh` prints a `SPACETIME_TOKEN`. Put it in `/etc/dronex/env`, where the mirror and the Next server share it, and then run `sudo systemctl restart dronex-render dronex-mirror`.
- If the name `dronex-airspace` is taken, change all four `*SPACETIME_DB` values and run `deploy.sh` again, because `NEXT_PUBLIC_*` values are baked in at build time.
- Never publish with `--delete-data` against production.

## 4. Elastic (one time)

1. Create a Serverless project.
2. Create a writer key (`create_index`, `write`, `read` and `manage` on `dronex-*`) and put it in `mirror.env`.
3. Create a reader key (`read` on `dronex-*`) and put it in `env`.
4. Run the setup on the VM:

```sh
mkdir -p /tmp/dronex-data && curl -fsSL -o /tmp/dronex-data/apm.pdef.xml https://autotest.ardupilot.org/Parameters/ArduCopter/apm.pdef.xml
cd /opt/dronex/current/DroneX_live
sudo -u dronex env ELASTIC_URL=... ELASTIC_API_KEY=<writer> ELASTIC_RETENTION=7d DRONEX_RENDER_URL=http://127.0.0.1:3000 npm run elastic:setup
```

5. Watch the output for "verdicts skipped".
6. Do the Kibana steps in `DroneX_live/elastic/README.md` by hand.
7. Set a spend alert.

## 5. Agentverse (one time, and after any seed change)

```sh
cd /opt/dronex/current/DroneX_agents
sudo -u dronex env AGENTVERSE_API_KEY=... .venv/bin/python scripts/connect_agentverse.py
sudo -u dronex .venv/bin/python scripts/connect_agentverse.py --status
sudo -u dronex .venv/bin/python scripts/asi1_e2e.py
```

- The new seeds give the agents new addresses, so the `@dronex-dispatch` listing must point at the new dispatcher.
- With `DRONEX_MAILBOX=1`, the agents refuse to start while any seed is still a development default. `journalctl -u dronex-agents` says which one.

## 6. Sizing: set `DRONEX_MAX_SIMS` and the Core limits

1. Fly 1, then 3, then 5 vehicles at speedup 1 from the site. For each step, record:

   ```sh
   pidstat -u -r -C arducopter 5 6     # per-SITL %CPU and RSS (sysstat is installed by provision.sh)
   systemd-cgtop -1 system.slice/dronex-core.service
   uptime
   ```

2. Then compute:
   - `per_vehicle_cpu`: the average %CPU of one `arducopter` divided by 100. For example, 35% gives 0.35 cores.
   - `DRONEX_MAX_SIMS = floor(cores_for_core * 0.7 / per_vehicle_cpu)`. Keep it below 32. Set it in `/etc/dronex/env`, then run `systemctl restart dronex-render`.
   - In `/etc/systemd/system/dronex-core.service.d/limits.conf`, set:
     - `CPUQuota = cores_for_core * 100%`;
     - `MemoryMax` from RSS × `DRONEX_MAX_SIMS`, plus about 1 GB for Core;
     - `TasksMax`.

     Then run `systemctl daemon-reload && systemctl restart dronex-core`.

## 7. Rollback

```sh
sudo deploy/deploy.sh rollback          # back to the previous release (run again to go forward)
sudo deploy/deploy.sh rollback <sha12>  # any release still in /opt/dronex/releases
```

- A rollback switches `current`, reinstalls that release's units and Caddyfile, restarts the units and runs the checks.
- It prints the command that restores the pre-deploy SQLite snapshot from `/var/backups/dronex`. Use it only if the newer release changed a schema.
- `NEXT_PUBLIC_*` values are baked into each build, so always roll back whole releases, never only the env.
- SpacetimeDB modules do not roll back.

## Layout and operations

- Releases are in `/opt/dronex/releases/<sha12>`, and `/opt/dronex/current` points at the live one. `KEEP_RELEASES=4`; the current and previous releases are never pruned.
- State is in `/var/lib/dronex`:
  - `core/` (mode 700; Core data, its socket, SITL binaries);
  - `backend.db`;
  - `render-sim/` (design folders);
  - `agents-logs/` and `agents-data/`;
  - `spacetime/`;
  - `next-cache/`;
  - `build/` (the cargo target, the ArduPilot checkout, the repo mirror).
- Secrets are in `/etc/dronex/` (`root:dronex 0640`). Deploy settings are in `/etc/dronex/deploy.conf`.
- Logs: `journalctl -u dronex-core -u dronex-render -u dronex-mirror -u dronex-agents -u dronex-backend -f`.
- Only 22 (your IP), 80 and 443 are open. 45010 (the operator listener) is loopback only and never proxied.
