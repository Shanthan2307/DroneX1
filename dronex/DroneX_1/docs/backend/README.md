# DroneX backend

A self-hosted replacement for UXDuck's closed cloud (`api.uxduck.com`), so a
UXDuck Core fork runs with its own accounts, sync, storage and remote
viewing. The contract is in [API.md](API.md).

## What is open and what is closed

| Part | Status | Where |
|---|---|---|
| Daemon, MAVLink, simulators, video, terrain, AI agent, plugins, CLI, MCP | **Open**, Apache-2.0 | `core/` (`github.com/uxduckhq/uxduck-core`) |
| Desktop shell (Electron) | Closed, but a thin wrapper | inside `UXDuck.app` |
| Web UI the daemon serves | **Closed**, downloaded at runtime | `app.uxduck.com/interface/manifest.json` -> `~/.uxduck/interface/` |
| Cloud API, relay, media coordinator | **Closed** | `api.uxduck.com`; `backend/` replaces it |

No reverse engineering of binaries is needed for the core: read the source.
Apache-2.0 allows forking and shipping it, but not the UXDuck name or logo
(see `NOTICE`), so rename the product (the `calhacks/uxduck-core` fork already
does this as `dronex-*`).

## How the pieces talk (local)

```
 UI (browser or Electron) --HTTP + WS--> daemon 127.0.0.1:45000
 CLI / MCP / shell -----JSON-RPC 2.0, one frame per line---> ~/.uxduck/uxduck.sock
 daemon <---MAVLink UDP 14550 / serial / TCP---> vehicle or SITL
 daemon ---HTTPS + WSS---> UXDUCK_API_URL   <- this backend
```

- `~/.uxduck/daemon.json` gives the port, the socket and `uiUrl`.
- RPC methods (about 300) are `namespace/verb`, for example `vehicle/list`,
  `telemetry/subscribe`, `command/send`, `plan/upload`, `param/set` and
  `sim/start`. Their DTOs are in
  `core/crates/uxduck-contracts/src/dto/`.
- Try it: `uxduck rpc call vehicle/list`.

## Pointing Core at this backend

```sh
cd core
UXDUCK_NO_TRAY=1 UXDUCK_API_URL=http://localhost:45103 cargo run --locked -p uxduck -- daemon
```

Debug builds already default to `http://localhost:45103`
(`crates/uxduck/src/dev_api.rs`), so a `cargo run` debug daemon talks to this
backend with no flags. Release builds default to `api.uxduck.com`; set the
variable, or change `PRODUCTION` in `dev_api.rs` in your fork.

## Suggested build order

Each phase leaves Core fully usable. The core works offline with no backend
at all.

1. **Auth + `/v1/me`** (section 1): TypeScript + Hono or Fastify, Postgres, and
   better-auth with the `emailOTP` and `bearer` plugins under `/v1/auth`. This
   unlocks sign-in in Core.
2. **Sync** (section 3): one append-only table and two routes. Settings,
   plans and vehicles then follow you across computers.
3. **Flights/recordings** (section 4): S3/R2/MinIO pre-signed PUTs plus a
   chunks table.
4. **Hosted model proxy** (section 2): optional, since users can bring their own key.
5. **Relay** (section 5): a WebSocket hub that pairs `/computers/edge`
   sockets with `/computers/{id}/live` viewers, plus Ed25519 grants. This is the
   hardest part and enables remote control.
6. **Live video + watch links** (sections 6 and 7): run MediaMTX for WHIP/WHEP;
   the API only issues grants.

## Notes

- REA is installed (`~/.rea-node24/bin/rea`, registered with Claude Code as an
  MCP server). It's mainly useful for the closed web UI and the Electron
  shell; restart Claude Code to load it.
- The installed app's data folder is `~/.uxduck` (SQLite `uxduck.db` with
  tables such as `vehicles`, `links`, `missions`, `parameters`, `threads` and
  `plugins`). It's useful for seeing real sync payloads.
