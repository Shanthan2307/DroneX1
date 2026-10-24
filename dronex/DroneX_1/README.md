# DroneX

A private research clone of UXDuck: drone ground control with our own
account server. Not for distribution.

| Folder | What it is |
|---|---|
| `core/` | UXDuck Core (Apache-2.0, upstream `uxduckhq/uxduck-core` at `6bae9dd`): daemon, MAVLink, simulators, video, AI agent, plugins |
| `interface/` | UXDuck's web interface 0.6.0, as UXDuck downloads it (closed source; kept here for private research only) |
| `backend/` | Our replacement for `api.uxduck.com` (TypeScript, Hono, built-in SQLite) |
| `docs/backend/` | The cloud API Core expects, reverse-engineered from Core and the app |
| `scripts/dev.sh` | Runs everything locally |

## Run it

Needs Rust (rustup), Node 24.11+ and openssl.

```sh
cd backend && npm install && cd ..
scripts/dev.sh
```

Open http://127.0.0.1:45010/ and approve the pairing code it shows:

```sh
UXDUCK_DATA_DIR=.dev/core-data core/target/debug/uxduck rpc call pairing/approve --json '{"code":"<code>"}'
```

Sign-in codes are printed in the backend's log (`[mail] ...`). Everything runs
from `.dev/`, so it never touches an installed UXDuck (`~/.uxduck`, port 45000).

## Status

- [x] Backend phase 1: email-code sign-in, `/v1/me`, sessions, username,
      product updates, account deletion. Tested end to end from the UI.
- [x] Phase 2: sync push/pull and plugin bundles.
- [x] Phase 3: flights and recordings stored in the account.
- [x] Phase 4: hosted model. `/v1/model/messages` (and `/responses`) proxy
      to Anthropic (or OpenAI) with the server's key in `backend/.env`,
      checking the 5-minute signed session and counting tokens per day
      (`MODEL_DAILY_TOKENS`). `/v1/turns/*` keeps shared turns as previews.
- [x] Place search: `/v1/places/suggest`, `/locate` and `/reverse` look up
      addresses with Esri using `ARCGIS_KEY`, for the Places page, the map's
      search and the agent's place tools. Core change: the agent's
      `search_query` now sees the chat operator's saved places, so it can fly
      a vehicle to one when asked.
- [ ] Relay, live video, watch links (see `docs/backend/README.md`)
- [ ] Rename UXDuck to DroneX
