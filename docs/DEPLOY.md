# Deploying DroneX live

**Summary**
1. **Topology:** one Ubuntu 24.04 LTS VM runs Core with its SITL children, the account backend, the Next.js configurator, the DroneX_live mirror, the Dispatch agents and Caddy. All of them run under systemd as a `dronex` user. SpacetimeDB (Maincloud), Elastic Serverless, Agentverse/ASI:One, Cartesia and the intent LLM are hosted services.
2. **Public URLs:**
   - `https://dronex.DOMAIN`: the configurator, Ask DroneX, `/copilot`, `/dispatch` and analytics.
   - `https://sim.DOMAIN`: the 3D simulator page.
   - The `@dronex-dispatch` agent on Agentverse/ASI:One.

   Visitors' browsers read the shared airspace straight from `wss://maincloud.spacetimedb.com`.
3. **The one big code change:** a public guest mode in Core. A new loopback listener (127.0.0.1:45020) sits behind Caddy and serves `sim.DOMAIN`. It gives every visitor a guest session that has Fly rights, is capped, expires and is never saved. It shows no pairing code and never makes a visitor an operator. It refuses methods that touch the host and never escalates a request to an operator.
4. **Also required before launch:**
   - a sim cap and an idle reaper;
   - per-visitor vehicle ownership;
   - rate limits and budgets on paid APIs;
   - a writer allow-list in the SpacetimeDB module;
   - limits on the agents.
5. **What you must provide:**
   - a domain and DNS, and the VM;
   - browser map keys restricted to `https://sim.DOMAIN/*`, plus a server-side geocoding key restricted by API and IP;
   - keys for Cartesia, ASI:One, Elastic and Agentverse, with spend limits;
   - a SpacetimeDB login;
   - three newly generated agent seeds.

---

## What has to change in the code before launch

Part A lists everything that blocks launch or is a security issue. Part B lists cost and polish items. Effort is S, M or L. "Unverified" means a review read the code but did not run it.

### Part A: blocks launch or security

#### Simulation engine: `dronex/DroneX_1/core`

1. **Public guest mode listener.** Effort L in total for items 1 to 5. Severity: blocks launch.
   - Files: `core/crates/uxduck/src/cli/mod.rs` (DaemonArgs ~254), `core/crates/uxduck/src/daemon/mod.rs` (DaemonOptions :51, `run()` ~205), `core/crates/uxduck/src/api/listeners/http.rs`, `core/crates/uxduck/src/network.rs`.
   - Add the flags `--public-origin https://sim.DOMAIN` and `--public-port 45020`, and pass them into `DaemonOptions` as `public: Option<Public{origin, port}>`.
   - When the flags are set, bind `127.0.0.1:<public-port>` and serve the existing `network_router` with ConnectInfo, the same way `crates/uxduck/src/network.rs:139-157` does.
     - Build it with `http::Network{host: "sim.DOMAIN", origin: "https://sim.DOMAIN", stopped, referrer: None}`. `stopped` is required.
     - `http::Network` has no `public` field (http.rs:118-128), so add one or carry the public flag some other way.
   - Every connection on this listener is `Trust::NetworkBrowser`, which is never an operator (`admission.rs:37`).
   - `session_status` (http.rs:659): when the listener is public and there is no session, call a new `Engine::mint_guest(peer)`.
     - Take the peer from `X-Forwarded-For`. Caddy is the only proxy and is trusted.
     - Answer `paired: true` with the cookie, or 503 "Simulator is full" when the caps are reached. The page then skips pairing.
   - `current_session` (http.rs:646-654) accepts a network session only if its `clnet<hash>` client is in `state.clients`. Guests have no ClientRecord, so without a guest branch here `/api/session` and `/rpc` return 401.
   - `rpc()` hard-codes `client: network_client(&token)`, which always gives a `clnet…` id (http.rs:773-778, pairing.rs:98-103). Add a guest branch so guests get their `clguest…` id. Items 2 and 3 depend on that id.
   - On the public listener, lower the `/rpc` WebSocket frame and message size. Today it is `RPC_MESSAGE`, about 38 MB (http.rs:788-794), and Caddy's `request_body` does not limit WebSocket frames.
   - `set_cookie` adds `; Secure` on the public listener.
   - `pairing_start` and `pairing_poll` return 404 on the public listener, so no code path exists there.
   - Leave `/api/maps/relay` (http.rs:236) out of the public router. Pages on https fetch tiles directly.

2. **A guest session store that is never saved, capped and expiring.** Effort M. Severity: blocks launch.
   - Files: `core/crates/uxduck-engine/src/pairing.rs`, `core/crates/uxduck-engine/src/lib.rs`, `core/crates/uxduck-engine/src/rpc/handlers.rs` (initialize, 1056-1068), `http.rs` (`current_session` and `rpc()`, see item 1), `daemon/mod.rs` (housekeeping loop, 725-737).
   - Add `guests: HashMap<token_hash, Guest{origin, created_us, seen_us, peer}>` to `Sessions`. Never call `store.save_session` for these entries.
   - Add these constants:
     - `MAX_GUESTS`, e.g. 100;
     - `MAX_GUESTS_PER_PEER`, e.g. 3;
     - `GUEST_IDLE_US`, e.g. 1 h;
     - `GUEST_MAX_US`, e.g. 12 h.
   - Add `mint_guest`, `guest(token)` and `expire_guests(clock)`:
     - `guest(token)` updates `seen_us`.
     - `expire_guests` disconnects the guest's connections the same way `forget_network_client` does (lib.rs:1047-1056). Call it at 1 Hz next to `e.expire_pairings()`.
   - Guest client ids are `clguest<hash16>`. `initialize` grants `NetworkAccess::Fly.capabilities()` (Read and Control) to these ids without `admit_network`, and writes no ClientRecord.

3. **A gate on guest RPCs.** Effort M. Severity: security.
   - File: `core/crates/uxduck-engine/src/rpc/handlers.rs`, in `handle()` right after `admitted` (line 46).
   - A guest is a connection with NetworkBrowser trust whose record starts with `clguest`. For guests:
     - Never call `engine.escalate` (line 53). Return CapabilityDenied, so no operator approvals pile up.
     - Deny every method that is not on an allowlist. Use `method_of` from `approvals.rs`. It is a private `fn` (approvals.rs:796), so make it `pub(crate)`.
   - Starting allowlist:
     - `initialize`, `state/subscribe`, `layout/open`
     - `vehicle/list|get`
     - `telemetry/subscribe|get|window`
     - `terrain/at|status`
     - `lease/take|release`
     - `controller/claim|release|keyboardStart|keyboardInput|keyboardStop|setTarget|inputs`
     - `command/send`
     - `mission/refresh|upload`
     - `plan/list|get|check|examples`
     - `param/get|list|search`
     - `place/search|locate`
   - Finalise the allowlist by capturing the `/rpc` frames the 3D page sends in Fly and Cockpit modes, including a page opened with `?vehicle=<id>`.
   - Methods that must be refused:
     - `storage/reveal`, `video/reveal`
     - `daemon/logs`, `socket/inspect`, `router/events`, `link/diagnose`
     - `plugin/*`, `sim/start`
     - `files/*`, `find/*`, `location/*`, `analytics/*`
     - the account and feedback families
     - `client/display*`: `client/displayList` lists other visitors' UIs and `client/displayPull` pulls their snapshot (uxduck-contracts/src/rpc.rs:270-280). Allow them later only if they are limited to the guest's own connections.
     - `sim/pause` until item 31 is done. It needs only Control (rpc.rs:908-912), so any guest could freeze other visitors' sims.

4. **The loopback listener must never accept a guest or https-origin session.** Effort S. Severity: security.
   - Files: `http.rs:654`, `pairing.rs:109-116` (`network_origin`).
   - Today a session with an https origin is treated as a loopback PairedBrowser, which can be an operator.
   - Guests live in their own map, so `Sessions::session()` (pairing.rs:369) never returns them.
   - Also refuse, on the loopback listener, any session whose origin starts with `https://` or equals the public origin.

5. **Host/Origin allowlist on the public listener only.** Effort S. Severity: security.
   - The public listener accepts Host `sim.DOMAIN` (and `sim.DOMAIN:443`; it is unverified whether any client sends that form) and Origin `https://sim.DOMAIN`.
   - Do not widen the loopback allowlist.
   - Caddy must never rewrite Host or Origin to loopback. That would make every visitor a loopback PairedBrowser.
   - The operator listener 45010 and `HOSTED_ORIGINS` (cli/mod.rs:2793) are never proxied.

6. **Release build with the key compiled in.** Effort S. Severity: blocks launch.
   - Build command: `UXDUCK_RELEASE_PUBLIC_KEY=RWSzgl9fdAptLFtOnN956tu/GY+/ANg5Of8nZVlOBgWsZTpGzJQbMyfP cargo build --release --locked -p uxduck --no-default-features`.
   - Release builds ignore `UXDUCK_TERRAIN_KEY`, `UXDUCK_SIM_CATALOGUE_KEY` and `UXDUCK_SITL_DIR` (terrain.rs:43-45, sim/catalogue.rs:91-93, sim/mod.rs:146-148). The key is read only at compile time, through `option_env!` (update.rs:41).
   - Always run with `--no-update-check`, because a compiled-in key also enables self-update.
   - `--no-default-features` drops `gamepad`, so libudev is not needed.
     - It does not remove `plugin/draft` and `plugin/test`. They are still routed (uxduck-engine/src/rpc/handlers.rs:215-218, plugins.rs:74,273,313). The `NoPlugins` port only makes them return an error (runtime.rs:731-746).
     - The guest allowlist (item 3) is still what protects you.
     - It is unverified that this build compiles. If it does not, build with `--features plugins`.
   - Never pass `--dev` in production. It changes the terrain key path, enables DevCli and logs a 60 s operator bootstrap URL (daemon/mod.rs:143,158-161,229-232,247-255).

7. **Tests for the guest mode.** Effort M. Severity: blocks launch, because this is the security boundary.
   - `pairing.rs` unit tests: the global cap, the per-peer cap, idle and maximum expiry, guests not returned by `session()`, and nothing saved.
   - An `http.rs` tower test of the public router:
     - a wrong Host gets 403;
     - `GET /api/session` sets a Secure cookie and returns `paired: true`;
     - a guest cookie is accepted by `current_session` and `/rpc` and gets a `clguest` client id;
     - `POST /api/pairing` gets 404.
   - Extend `crates/uxduck/tests/smoke.rs` with `--public-origin http://localhost:<p>`:
     - a guest's `initialize` grants exactly `[read, control]`;
     - `storage/reveal`, `daemon/logs`, `plugin/draft`, `sim/start`, `sim/pause` and `client/displayList` are denied, and no approval is created.

#### Interface bundle and account backend: `dronex/DroneX_1`

8. **Point the interface at the public origin.** Effort S. Severity: blocks launch.
   - Files: `scripts/point-interface.mjs`, `scripts/patch-interface-dronex.mjs`, `scripts/patch-interface-tracks.mjs`.
   - Today the repoint does nothing:
     - `point-interface.mjs` only replaces the literal `` `https://api.uxduck.com` `` (scripts/point-interface.mjs:16,26).
     - The committed bundle contains `http://localhost:45103` instead (`assets/shell-Y4cT0_Eb.js`, `daemon.worker-Dtq11vZh.js`), and `api.uxduck.com` appears nowhere.
     - The script therefore prints "nothing to change".
   - Fix: add a `--from http://localhost:45103` option to the script, or run a sed replace from `http://localhost:45103` to `https://sim.DOMAIN`. Then confirm that no `localhost:45103` is left in the bundle.
   - On `sim.DOMAIN`, Caddy routes `/v1/maps/key`, `/v1/maps/google-key` and `/v1/places*` to the backend, so these calls are same-origin and need no CORS header.
     - The 3D page POSTs place searches to `${accountBase}/v1/places…` itself (interface `assets/lookup-SHjWSecM.js`).
     - The backend's place bucket is per IP from XFF (`backend/src/routes/places.ts:74`). `PLACE_SEARCHES_PER_MINUTE` defaults to 60 (`server.ts:28`).

9. **Inject `window.DRONEX_RENDER_URL`.** Effort S. Severity: blocks launch.
   - Write `<script>window.DRONEX_RENDER_URL='https://dronex.DOMAIN'</script>` into `interface/<version>/index.html`. Without it, `dronex-tracks.js:6` falls back to `http://localhost:3000`.
   - `patch-interface-tracks.mjs:21-23` skips index.html when `dronex-tracks.js` is already in it, and the committed index.html is already patched. So give this line its own marker check, or write it in a separate step.

9a. **A separate server-side geocoding key.** Effort S. Severity: blocks launch.
   - The backend uses the same `ARCGIS_KEY` for the browser basemap and for server-side geocoding (`server.ts:24,26`). The geocode fetch sends no Referer (`places.ts:88`).
   - Restricting the key by referrer therefore breaks `place/search` and the copilot's `goto_place`.
   - Add `ARCGIS_GEOCODE_KEY` for the server-side calls, restricted by API and by the VM's IP. Keep `ARCGIS_KEY` restricted by referrer for the browser.

#### Configurator: `DroneX_render`

10. **Sim cap, one sim per IP, and a reaper.** Effort M. Severity: blocks launch.
    - Add `src/lib/sim/limits.ts` and `src/instrumentation.ts`; neither exists yet. Wire them into `src/lib/sim/fly.ts` (sim/start at :95), `src/app/api/sim/fly/route.ts` and `src/app/api/sim/refly/[id]/route.ts`.
    - Keep an in-memory registry `{linkId, vehicleId, ip, startedAt, lastActiveAt}`.
    - Refuse new sims with 429/503 "simulator full, try in a few minutes" when the number of running DroneX sims reaches `DRONEX_MAX_SIMS`.
      - DroneX sims are the `vehicle/list` rows that carry the "DroneX model" bookmark, which `designIdOf` in `tools.ts:49-53` parses.
      - Set the cap from measurement and keep it below Core's 32.
    - A new Fly from the same IP first calls `sim/stop` on the old link.
    - Every 60 s, call `sim/stop {id: linkId}` for sims that are offline, disarmed longer than `DRONEX_SIM_IDLE_MIN` (e.g. 10) or older than `DRONEX_SIM_MAX_MIN` (e.g. 30). Then call `vehicle/delete` on offline records.
    - Rebuild the registry from `vehicle/list` when the server starts.
    - Dispatch reflies go through the same cap.

11. **Per-visitor vehicle ownership.** Effort M. Severity: security.
    - Files: a new signed-cookie helper (HMAC with `node:crypto`, secret in env), `src/lib/sim/tools.ts` (`pickVehicle` :74-85), `src/lib/ai/intent.ts` (:44-79), `src/app/api/copilot/intent/route.ts`, `src/app/api/copilot/events/route.ts`.
    - `/api/sim/fly` sets an HttpOnly cookie that lists the vehicleIds this browser created.
    - `/api/copilot/intent` and `/api/copilot/events` act on and stream only those vehicles: pass `allowedIds` into `pickVehicle` and `listVehicles`.
    - Today any visitor can arm, land or goto any other visitor's drone.
    - Add a `lockVehicle` flag to intent that ignores the model's `vehicle` argument. Dispatch uses it.

12. **Agent-only routes behind a token.** Effort S. Severity: security.
    - Routes: `src/app/api/sim/refly/[id]/route.ts`, `src/app/api/sim/vehicles/[id]/route.ts` (POST), `src/app/api/airspace/mission/route.ts`, `src/app/api/sim/designs/route.ts` (list).
    - Require the header `x-dronex-agent: $DRONEX_AGENT_TOKEN`. The public designs list returns pinned designs only.
    - Add a new agent-only stop route (e.g. `POST /api/sim/stop/[id]`) for the Dispatch TTL in item 22.
    - Caddy also returns 404 for these paths publicly, as defence in depth. The agents call `http://127.0.0.1:3000` directly.

13. **Replace CORS `*` on 11 route files.** Effort S. Severity: security.
    - Add one `src/lib/cors.ts`. Only `/api/sim/designs/<id>/model.glb` and `/api/tracks` send `Access-Control-Allow-Origin: https://sim.DOMAIN` with `Vary: Origin`.
    - Drop the CORS headers from intent, refly, vehicles, `airspace/*`, analytics, verdict, catalog and designs.

14. **Rate limits and daily budgets on paid APIs.** Effort M. Severity: blocks launch, because the host must be protected from abuse.
    - Add `src/lib/rateLimit.ts`. It is in-memory, keyed on the `X-Forwarded-For` that Caddy sets, and returns 429 with Retry-After.
    - Add a global daily counter per provider that returns 503 "demo budget used up today".
    - Suggested per-IP limits:

      | Route | Limit |
      |---|---|
      | assistant | 10/min, 100/day |
      | copilot/intent | 15/min, 150/day |
      | copilot/token | 6/hour |
      | copilot/speak | 30/min, 300/day |
      | copilot/transcribe | 10/min |
      | sim/fly | 3/10 min, 20/day |
      | analytics | 30/min |
      | airspace writes | 20/min |
      | airspace GET | 60/min |
      | dispatch | 30/min |
      | cheap dataset routes | 120/min |

    - Agent calls arrive from `127.0.0.1` with no XFF (`dispatcher.py:307`; `render_api.py`). Without an exception, every Dispatch session shares one bucket on `/api/copilot/intent`, `/api/airspace/*` and the dataset routes. Requests with a valid `x-dronex-agent` token skip the per-IP limits and count against the Dispatch share instead.
    - Also:
      - delete the GET handler in `src/app/api/copilot/speak/route.ts`;
      - cap intent text at 500 characters;
      - pass `max_tokens` (about 400) in `src/lib/ai/assistant.ts` and `src/lib/ai/intent.ts`;
      - in `/api/assistant`, cap the number of messages and the total size as well as the `name` field (`route.ts:23`). Today each message is cut to 2,000 characters, but the number of messages is unlimited (`route.ts:17`), and there are up to 5 model rounds (`lib/ai/assistant.ts:332`).
    - The limiter lives in-process, so run exactly one `next start` instance.

15. **Cartesia token minting.** Effort S. Severity: cost, but the launch should wait for it.
    - File: `src/app/api/copilot/token/route.ts`.
    - Rate limit at 6/hour/IP, require Origin equal to `DRONEX_PUBLIC_URL`, and cap the total mints per day.
    - Lower `expires_in` from 600 to 120 s, but only after testing that an open Cartesia socket survives token expiry (unverified).

16. **Public URLs are baked in at build time.** Effort S. Severity: blocks launch.
    - Files: `src/app/copilot/page.tsx`, `src/app/dispatch/page.tsx`, `src/lib/publicUrls.ts` (still uncommitted, so commit it), `src/lib/airspace/client.ts`.
    - Under `cacheComponents: true` the `/copilot` and `/dispatch` simulator links are prerendered. So `DRONEX_SIM_UI_URL`, `DRONEX_PUBLIC_URL` and the `NEXT_PUBLIC_SPACETIME_*` values must be set during `next build`.
    - Add `src/instrumentation.ts`. In production it fails fast when `DRONEX_PUBLIC_URL` or `DRONEX_SIM_UI_URL` is unset, or when `NEXT_PUBLIC_SPACETIME_URI` does not start with `wss://`.
    - After the build, grep `.next/server/app/copilot.html` for the simulator URL.

17. **A production build that passes.** Effort S. Severity: blocks launch.
    - `next build` has never been run. Run `npm run typecheck && npm run lint && npm test && npm run build` on Linux, and fix any "uncached data accessed outside Suspense" errors.
    - Drop `partialPrefetching` in `next.config.ts` if it causes trouble.

#### Live layer: `DroneX_live` and the airspace routes

18. **Writer allow-list in the SpacetimeDB module.** Effort M. Severity: security.
    - Files: `DroneX_live/spacetime/src/lib.rs` (reducers 136-321), `DroneX_live/src/spacetime/client.ts`, `DroneX_render/src/lib/airspace/client.ts` (the server branch of `connectAirspace`). Run `DroneX_live/scripts/spacetime-generate.sh` afterwards.
    - SpacetimeDB has no built-in owner. Have `init` (lib.rs:129-130) store the publisher's identity, so that an owner-only `add_writer` reducer can check against it.
    - Add a private `writer` table that `add_writer` fills. Every mutating reducer checks `ctx.sender` against it.
    - `tick` is a plain `#[spacetimedb::reducer]` (lib.rs:325-326), so clients can call it. Guard it with `ctx.sender == ctx.identity()`.
    - The mirror and the Next server connect with a persisted token (`withToken`, `SPACETIME_TOKEN`). Their identities are registered once.
    - Browsers stay read-only subscribers.

19. **Ownership and rate limits on the airspace write routes.** Effort M. Severity: security.
    - Files: `DroneX_render/src/app/api/airspace/route.ts`, `.../corridor/route.ts`, `.../corridor/[id]/release/route.ts`, `.../mission/route.ts`.
    - Agent callers send `DRONEX_AGENT_TOKEN`; `DroneX_agents/dronex_agents/airspace.py` and `render_api.py` must send it.
    - Browser callers may only request or release corridors for vehicles in their ownership cookie (item 11).
    - Rate limit these routes and drop CORS `*`.

20. **The mirror exits so systemd restarts it.** Effort S. Severity: blocks launch.
    - Files: `DroneX_live/src/mirror.ts` (180-190), `DroneX_live/src/daemon.ts` (54-60), `DroneX_live/src/spacetime/client.ts`.
    - Call `process.exit(1)` when the Core socket closes, or after N tick failures in a row.
    - Add `.onDisconnect(() => process.exit(1))` to the SpacetimeDB connection.

21. **Maincloud idle pause and browser reconnect.** Effort S. Severity: blocks launch.
    - The mirror makes a small keepalive reducer call every few hours.
    - `DroneX_render/src/components/.../AirspaceView.tsx` (around :150) reconnects with backoff.

#### Dispatch agents: `DroneX_agents`

22. **Limits on the flight agent.** Effort M. Severity: blocks launch.
    - Files: `dronex_agents/flight.py` (on_order 213-228, refly :128, replies 206-212), `dronex_agents/dispatcher.py` (review, :263-268).
    - Accept a FlightOrder only when the sender equals `dispatcher_address(s)`.
    - Today progress and results go to `order.reply_to`, not to `sender`. Ignore `reply_to` unless it equals the dispatcher's address.
    - Allow at most one active Dispatch vehicle per ASI:One user and at most N in total (e.g. 3). Refuse politely beyond that.
    - Stop the vehicle 10 minutes after FlightResult, through the agent-only stop route.
    - Add a per-sender cooldown in `dispatcher.review`.

23. **Split API URLs from public links.** Effort S. Severity: blocks launch.
    - File: `dronex_agents/config.py` (:100, :117), used in `flight.py:124,132-133` and `dispatcher.py:199,218,224`.
    - Add `DRONEX_PUBLIC_URL` for the links sent to users. Keep `DRONEX_RENDER_URL=http://127.0.0.1:3000` for API calls, and set `DRONEX_SIM_UI_URL=https://sim.DOMAIN`.

24. **Bind Dispatch commands to the session's own vehicle.** Effort S. Severity: security.
    - `dispatcher.py:307-309` passes `lockVehicle` to `/api/copilot/intent` (item 11), or uses a fixed command set: rtl, land, status.

25. **Refuse to start with the development seeds.** Effort S. Severity: security.
    - Today the `DRONEX_*_SEED=` lines in `.env.local` are empty, so the public `DEFAULT_SEEDS` are used (`config.py:32-36,98`). Anyone can sign as these agents.
    - In `config.py:32-36,127-128`, exit when any `DRONEX_*_SEED` is still the public default while `DRONEX_MAILBOX=1`.
    - The seeds must be rotated, and the agents re-registered on Agentverse (Phase 8).

26. **Payments.** Effort S. Severity: security.
    - Run live with `DRONEX_PAYMENTS=0`, or at least `DRONEX_PAYMENTS_LEDGER=0`.
    - If payments stay on:
      - the buyer in `payment.py` (:131-141) pays only the flight agent, only for an open order, and never more than the configured price;
      - the seller (:83-96) accepts commits only from the dispatcher.

27. **Per-sender rate limits.** Effort S. Severity: blocks launch (cost).
    - In `dispatcher.on_chat`, add:
      - 10 messages/min and 100/day per sender;
      - a global daily cap on model calls;
      - a cap on input length;
      - pruning of sessions older than a day.

#### Deployment tooling (new `deploy/` directory)

28. **Units, Caddyfile, deploy script and CI.** Effort M. Severity: blocks launch.
    - New files: `deploy/systemd/*.service`, `deploy/Caddyfile`, `deploy/deploy.sh`, `.github/workflows/ci.yml`.
    - Their contents are under "Step-by-step deployment" below.

29. **Move state out of the checkout.** Effort S. Severity: blocks launch.
    - Use `/var/lib/dronex/{core,backend.db,render-sim,agents-logs,spacetime}`.
    - Symlink these into each release:
      - `DroneX_render/.dronex`;
      - `DroneX_agents/logs`;
      - `DroneX_render/.env.local`, which points to `/etc/dronex/env`.
    - `ProtectSystem=strict` makes `/opt` read-only, but two services write inside the release:
      - uagents writes `<agent>_data.json` into its working directory, `DroneX_agents` (`uagents/storage/__init__.py:65-66,96`; `run.py:24` sets `cwd=ROOT`). The file names depend on the seed or address.
      - `next start` writes `.next/cache`.
    - Either add these paths to `ReadWritePaths`, or point those files and directories at `/var/lib/dronex` before the first start. Pre-made symlinks only work when the names are known in advance.

### Part B: cost and polish

#### Simulation engine
30. **Engine-side backstop.** Effort M. Severity: cost. When public mode is on, a 1 Hz check at `daemon/mod.rs:736` stops simulator links older than a `--sim-max-age` flag.
31. **Guests control only their own vehicle.** Effort M. Severity: polish, but recommended.
    - Store the guest's allowed vehicle ids. The configurator passes them through `?vehicle=` or a socket RPC.
    - Refuse Control methods on other vehicles. Without this, a guest on the 3D page can steer other visitors' sims.
    - Only after this is done may `sim/pause` go on the guest allowlist.

#### Configurator
32. **Request bodies and disk.** Effort M. Severity: cost.
    - Caddy caps bodies.
    - Lower `MODEL_MAX_BYTES` (fly/route.ts:10) to 10 MB.
    - A store reaper deletes `.dronex/sim/<id>` folders that are older than 24 h and that no running vehicle references, under a 2 GB total cap.
    - Hangar designs are pinned (`"pinned": true` in `design.json`, or `DRONEX_PINNED_DESIGNS`).
33. **SSE and Dispatch polling.** Effort S. Severity: cost.
    - Allow 3 SSE streams per IP and about 200 in total.
    - Cache `/api/dispatch` for 30 s. Raise the `DispatchPanel.tsx:73` interval to 15-30 s.
    - Behind a public flag, replace the operator hints ("Start the agents...", port numbers) with "temporarily unavailable".
34. **Headers, errors and timeouts.** Effort S. Severity: polish.
    - Add HSTS, and a CSP in Report-Only mode first.
    - Return generic 502 text instead of the `core.ts:28` paths.
    - Add a 15 s timeout to `CoreClient.call`, and a longer one for `sim/start`.

#### Live layer
35. **Prune tables in the module tick.** Effort S. Severity: cost. In `lib.rs:326-348`, delete:
    - corridors that were never granted and are older than 1 h;
    - incidents older than 1 h;
    - vehicles that have been offline for 10 min, with their positions and missions.
36. **Elastic retention.** Effort M. Severity: cost. In `DroneX_live/src/elastic/setup.ts:129-135`, make `dronex-telemetry` and `dronex-events` data streams with a retention lifecycle, e.g. 7 days. The exact Serverless syntax is unverified.
37. **Operator name.** Effort S. Set `MIRROR_OPERATOR=DroneX`. Without it, the server hostname shows to every visitor.

#### Agents
38. **Logs.** Effort S. Either `run.py:24` writes to stdout so journald collects it, or add logrotate on `DroneX_agents/logs/*.log`.
39. **State lost on restart.** Effort S. Optionally persist orders in `ctx.storage`. The TTL reaper (item 22) cleans up orphaned vehicles.

---

## Target layout

```
                         Internet (only 80/443 open; 22 from your IP)
                                        |
                                   +---------+
                                   |  Caddy  |  TLS, HSTS, body caps, path blocks
                                   +---------+
             https://dronex.DOMAIN   |       |   https://sim.DOMAIN
                    +----------------+       +-------------------------+
                    v                                 /v1/maps/key     v  everything else
          +-------------------+                       /v1/maps/google-key
          | dronex-render     |                       /v1/places*      |
          | next start        |                         v              v
          | 127.0.0.1:3000    |              +----------------+  +------------------------+
          +-------------------+              | dronex-backend |  | dronex-core (release)  |
             |  unix socket (operator-cli)   | 127.0.0.1:45103|  | public guest listener  |
             +------------------------------>| SQLite         |  | 127.0.0.1:45020        |
             |                               +----------------+  | operator listener      |
             |                                      ^            | 127.0.0.1:45010 (never |
             |                    UXDUCK_API_URL    +------------|  proxied)              |
             |                                                   | unix socket in         |
             +-------------------------------------------------->| /var/lib/dronex/core   |
                                                                 +-----------+------------+
          +-------------------+   unix socket                                | children
          | dronex-mirror     |----------------------------------------------+
          | (DroneX_live)     |                                  +-----------v------------+
          +-------------------+                                  | ArduPilot SITL x N     |
             |         |                                         | (cap set by sizing)    |
             |         +--> Elastic Serverless (dronex-*)        | tcp 5760+10i, udp RC   |
             +------------> SpacetimeDB Maincloud  <-- browsers  | (firewalled)           |
                            (dronex-airspace, wss)    read-only  +------------------------+
          +-------------------+
          | dronex-agents     |--> http://127.0.0.1:3000 (x-dronex-agent token)
          | 8001-8003 (fw'd)  |--> Agentverse mailbox / ASI:One (outbound only)
          +-------------------+
```

Paths:
- Releases: `/opt/dronex/releases/<sha>`, with `/opt/dronex/current` pointing at the live one.
- State: `/var/lib/dronex/`.
- Secrets: `/etc/dronex/`.

The configurator, the mirror and `/api/dispatch` reach Core and the agents through the filesystem and loopback. So everything except the hosted services must stay on one VM.

The 45020 listener replaces an earlier idea of proxying `sim.DOMAIN` to 45010 with a Host rewrite. Do not do that: the operator listener must never be reachable from the proxy.

---

## Step-by-step deployment

Replace `DOMAIN` everywhere. Commands assume Ubuntu 24.04 and a sudo user.

### Phase 0: before you touch the VM
- Every item in Part A above is merged and tested locally.
- DNS A/AAAA records for `dronex.DOMAIN` and `sim.DOMAIN` point at the VM.
- The map keys are created and restricted, and spend limits are set on every paid provider.
- Three new random seeds are generated by running `openssl rand -hex 32` three times. Never reuse the development defaults.

### Phase 1: provision the VM
```sh
sudo adduser --system --group --home /var/lib/dronex dronex
sudo apt update && sudo apt install -y git build-essential pkg-config cmake clang libssl-dev \
  python3 python3-venv python3-dev libxml2-dev libxslt1-dev ffmpeg curl sqlite3 caddy ufw
# Node >= 24.11 (the backend runs .ts natively)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
# Rust (core/rust-toolchain.toml pins 1.98.1) and uv, for the dronex user
sudo -u dronex -H sh -c 'curl -sSf https://sh.rustup.rs | sh -s -- -y'
sudo -u dronex -H sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
# Firewall: SITL, video and agent ports bind every interface
sudo ufw default deny incoming
sudo ufw allow from <YOUR_IP> to any port 22 proto tcp
sudo ufw allow 80,443/tcp
sudo ufw enable
sudo mkdir -p /opt/dronex/releases /var/lib/dronex/{core/simulators/bin,render-sim,agents-logs,spacetime} /etc/dronex
sudo chown -R dronex:dronex /opt/dronex /var/lib/dronex && sudo chmod 700 /var/lib/dronex/core
```

### Phase 2: secrets
`/etc/dronex/env` is owned `root:dronex` with mode `0640`. It is symlinked as `DroneX_render/.env.local`, because the mirror and the agents read that path.

Env files hold plain `KEY=VALUE` lines with no inline comments. systemd `EnvironmentFile`, the DroneX_live `loadEnv` (`src/env.ts:17-25`) and python-dotenv all keep any `# ...` text as part of the value.
```
DRONEX_PUBLIC_URL=https://dronex.DOMAIN
DRONEX_SIM_UI_URL=https://sim.DOMAIN
DRONEX_CORE_DATA_DIR=/var/lib/dronex/core
DRONEX_AGENT_TOKEN=<openssl rand -hex 32>
DRONEX_COOKIE_SECRET=<openssl rand -hex 32>
DRONEX_MAX_SIMS=<from sizing>
DRONEX_SIM_IDLE_MIN=10
DRONEX_SIM_MAX_MIN=30
CARTESIA_API_KEY=...
CARTESIA_VOICE_ID=...
INTENT_API_KEY=...
INTENT_API_BASE=...
INTENT_MODEL=asi1-mini
ELASTIC_URL=...
ELASTIC_API_KEY=<reader key>
ELASTIC_INDEX_PREFIX=dronex
SPACETIME_URI=wss://maincloud.spacetimedb.com
SPACETIME_DB=dronex-airspace
NEXT_PUBLIC_SPACETIME_URI=wss://maincloud.spacetimedb.com
NEXT_PUBLIC_SPACETIME_DB=dronex-airspace
SPACETIME_TOKEN_FILE=/var/lib/dronex/spacetime/render.token
MIRROR_OPERATOR=DroneX
DRONEX_DISPATCHER_SEED=<new>
DRONEX_FLEET_SEED=<new>
DRONEX_FLIGHT_SEED=<new>
DRONEX_MAILBOX=1
DRONEX_PAYMENTS=0
DRONEX_RENDER_URL=http://127.0.0.1:3000
```

Notes:
- Leave `DRONEX_AGENTS_DIR` unset. The default `../DroneX_agents`, together with the `DroneX_agents/logs` symlink, is what `/api/dispatch` reads (`DroneX_render/src/app/api/dispatch/route.ts:11,15`). Pointing it anywhere else makes the agents show as down.
- `SPACETIME_TOKEN_FILE` is the variable that items 18 and 19 introduce. Name it to match the code.

`/etc/dronex/mirror.env` holds the Elastic writer key. For the mirror, process env wins over `.env.local`.
```
ELASTIC_API_KEY=<writer key>
SPACETIME_TOKEN_FILE=/var/lib/dronex/spacetime/mirror.token
```

`/etc/dronex/backend.env`:
```
PORT=45103
HOST=127.0.0.1
DATABASE_PATH=/var/lib/dronex/backend.db
SESSION_SECRET=<openssl rand -base64 48>
ARCGIS_KEY=...
ARCGIS_GEOCODE_KEY=...
GOOGLE_MAPS_KEY=...
```
- `ARCGIS_GEOCODE_KEY` exists only after item 9a.
- Leave `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` unset.

`/etc/dronex/core.env`:
```
UXDUCK_NO_TRAY=1
UXDUCK_NO_ANALYTICS=1
UXDUCK_INTERFACE_URL=none
UXDUCK_SIM_CATALOGUE_URL=none
UXDUCK_API_URL=http://127.0.0.1:45103
```

### Phase 3: build a release (this is what `deploy/deploy.sh` automates)
The whole phase runs as `dronex`, with dronex's cargo and uv on the PATH.
```sh
SHA=$(git ls-remote <repo-url> main | cut -c1-12); R=/opt/dronex/releases/$SHA
sudo -u dronex -H env R=$R SHA=$SHA \
  PATH=/var/lib/dronex/.cargo/bin:/var/lib/dronex/.local/bin:$PATH bash -eu <<'EOF'
git clone <repo-url> $R && cd $R && git checkout $SHA
# state symlinks
ln -sfn /var/lib/dronex/render-sim $R/DroneX_render/.dronex
ln -sfn /var/lib/dronex/agents-logs $R/DroneX_agents/logs
ln -sfn /etc/dronex/env $R/DroneX_render/.env.local

# 1. Core (release, key compiled in)
cd $R/dronex/DroneX_1/core
UXDUCK_RELEASE_PUBLIC_KEY=RWSzgl9fdAptLFtOnN956tu/GY+/ANg5Of8nZVlOBgWsZTpGzJQbMyfP \
  cargo build --release --locked -p uxduck --no-default-features

# 2. SITL for Linux (first deploy, or when the ArduPilot pin changes)
cd $R/dronex/DroneX_1 && sh scripts/build-sitl.sh copter plane
cp .dev/ardupilot/src/build-sitl/sitl/bin/arducopter .dev/ardupilot/src/build-sitl/sitl/bin/arduplane \
   /var/lib/dronex/core/simulators/bin/

# 3. Interface pointed at the public origin (items 8 and 9)
git checkout -- interface/
node scripts/point-interface.mjs --from http://localhost:45103 https://sim.DOMAIN
#   without the --from option, use instead:
#   grep -rl 'http://localhost:45103' interface/ | xargs sed -i 's#http://localhost:45103#https://sim.DOMAIN#g'
! grep -rq 'localhost:45103' interface/ || { echo "interface still points at localhost"; exit 1; }
node scripts/patch-interface-dronex.mjs
node scripts/patch-interface-tracks.mjs
# window.DRONEX_RENDER_URL: own marker check or separate step (item 9)
ln -sfn "$R/dronex/DroneX_1/interface/$(cat interface/current)" $R/ui

# 4. Backend
cd $R/dronex/DroneX_1/backend && npm ci

# 5. Configurator (public values must be in the environment at build time)
cd $R/DroneX_render && set -a && . /etc/dronex/env && set +a
npm ci && npm run typecheck && npm test && npm run build
grep -q "https://sim.DOMAIN" .next/server/app/copilot.html || { echo "sim URL not baked in"; exit 1; }
node prototype/drone-assembly/scripts/check-drone-physics.mjs

# 6. Live layer
cd $R/DroneX_live && npm ci --omit=dev

# 7. Agents
cd $R/DroneX_agents && uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python -r requirements.txt
EOF
```

Notes on Phase 3:
- `build-sitl.sh` itself only copies into `.dev/core-data*`, which is why the `cp` line is needed.
- The `$R/ui` symlink exists because `interface/current` is a file that holds the version, and systemd cannot run `$(cat ...)`. The link target is absolute, because a relative target would resolve against `$R`.
- `next/font/google` downloads fonts during the build, so the build needs outbound network.

### Phase 4: SpacetimeDB (from your laptop, one time)
```sh
curl -sSf https://install.spacetimedb.com | sh
spacetime login                       # browser, GitHub auth
rustup toolchain install 1.98.1 && rustup target add wasm32-unknown-unknown --toolchain 1.98.1
SPACETIME_SERVER=maincloud SPACETIME_DB=dronex-airspace DroneX_live/scripts/spacetime-publish.sh
DroneX_live/scripts/spacetime-generate.sh   # after any module change; commit the bindings
```
- If `dronex-airspace` is taken on Maincloud, pick a unique name. Set it in all four `*SPACETIME_DB` variables, then rebuild the configurator.
- Never pass `--delete-data` / `-c` against production.
- The publishing identity is stored by `init` as the owner (item 18).
- Register the writers after the mirror and the configurator have run once and saved their token files (Phase 6):
  - Signed in as the publishing identity, run `spacetime call` against `add_writer` with each saved identity.
  - The exact `spacetime call` syntax is unverified; check `spacetime call --help`.

### Phase 5: systemd units (`deploy/systemd/`)

Common hardening for every unit:
```
User=dronex
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/dronex
PrivateTmp=yes
Restart=always
RestartSec=5
```

`dronex-backend.service`
```
[Service]
WorkingDirectory=/opt/dronex/current/dronex/DroneX_1/backend
EnvironmentFile=/etc/dronex/backend.env
ExecStart=/usr/bin/node src/server.ts
```

`dronex-core.service`
```
[Unit]
After=dronex-backend.service
[Service]
EnvironmentFile=/etc/dronex/core.env
ExecStart=/opt/dronex/current/dronex/DroneX_1/core/target/release/uxduck daemon \
  --data-dir /var/lib/dronex/core --port 45010 --ui-dir /opt/dronex/current/ui \
  --video-port off --no-update-check --no-analytics --no-gamepads \
  --public-origin https://sim.DOMAIN --public-port 45020
CPUQuota=<from sizing>
MemoryMax=<from sizing>
TasksMax=<from sizing>
```
Every SITL process is a child of this unit. These three limits therefore cap the whole simulator fleet and protect the other services.

`dronex-render.service`
```
[Unit]
After=dronex-core.service
[Service]
WorkingDirectory=/opt/dronex/current/DroneX_render
EnvironmentFile=/etc/dronex/env
Environment=NODE_ENV=production
ExecStart=/opt/dronex/current/DroneX_render/node_modules/.bin/next start -p 3000 -H 127.0.0.1
```
- `next start` writes `.next/cache`. Add that directory to `ReadWritePaths`, or point it at `/var/lib/dronex` before the first start (item 29).

`dronex-mirror.service`
```
[Unit]
After=dronex-core.service
[Service]
WorkingDirectory=/opt/dronex/current/DroneX_live
EnvironmentFile=/etc/dronex/env
EnvironmentFile=/etc/dronex/mirror.env
ExecStart=/usr/bin/npm run --silent mirror
```

`dronex-agents.service`
```
[Unit]
After=dronex-render.service
[Service]
WorkingDirectory=/opt/dronex/current/DroneX_agents
EnvironmentFile=/etc/dronex/env
ExecStart=/opt/dronex/current/DroneX_agents/dev.sh
```
- `run.py` kills all three children when one dies, and systemd then restarts the unit.
- uagents writes `<agent>_data.json` into the `DroneX_agents` working directory, and the names depend on the seed or address. Add that directory to `ReadWritePaths`, or point the files at `/var/lib/dronex` before the first start. Otherwise the writes fail under `ProtectSystem=strict`, and the files are lost on every release.

```sh
sudo cp deploy/systemd/*.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo ln -sfn $R /opt/dronex/current
sudo systemctl enable --now dronex-backend dronex-core dronex-render dronex-mirror dronex-agents
```

### Phase 6: Caddy (`deploy/Caddyfile` goes to `/etc/caddy/Caddyfile`)
```
dronex.DOMAIN {
	header Strict-Transport-Security "max-age=31536000"

	@agentonly path /api/sim/refly/* /api/airspace/mission /api/sim/stop/*
	respond @agentonly 404
	@vehpost {
		method POST
		path /api/sim/vehicles/*
	}
	respond @vehpost 404

	@fly path /api/sim/fly
	request_body @fly {
		max_size 42MB
	}
	@stt path /api/copilot/transcribe
	request_body @stt {
		max_size 11MB
	}
	@small not path /api/sim/fly /api/copilot/transcribe
	request_body @small {
		max_size 256KB
	}

	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
		header_up X-Forwarded-For {remote_host}
	}
}

sim.DOMAIN {
	header Strict-Transport-Security "max-age=31536000"
	request_body {
		max_size 256KB
	}

	@backend path /v1/maps/key /v1/maps/google-key /v1/places*
	handle @backend {
		reverse_proxy 127.0.0.1:45103 {
			header_up X-Forwarded-For {remote_host}
		}
	}
	handle /v1/* {
		respond 404
	}
	handle {
		reverse_proxy 127.0.0.1:45020 {
			header_up X-Forwarded-For {remote_host}
		}
	}
}
```
- `flush_interval -1` lets the SSE stream on `/api/copilot/events` through unbuffered.
- On `sim.DOMAIN`, Host and Origin pass through unchanged, and WebSocket upgrades on `/rpc` work by default. Never add `header_up Host 127.0.0.1...` and never rewrite Origin.
- `request_body` does not limit WebSocket frames. Core enforces the `/rpc` frame cap itself (item 1).
- Do not add COEP headers on `sim.DOMAIN`, because they could break cross-origin map tiles.
- The `@vehpost` block assumes the browser never POSTs to `/api/sim/vehicles/*`, which the reviews say is agent-only. Confirm that before launch.
```sh
sudo systemctl reload caddy
```
TLS comes automatically from ACME, so ports 80 and 443 must be open.

### Phase 7: Elastic (one time)
- Create a Serverless Elasticsearch project at cloud.elastic.co.
- Create two API keys:
  - a writer with create_index, write, read and manage on `dronex-*`;
  - a reader with read on `dronex-*`.
```sh
mkdir -p /tmp/dronex-data
curl -fsSL -o /tmp/dronex-data/apm.pdef.xml https://autotest.ardupilot.org/Parameters/ArduCopter/apm.pdef.xml
cd /opt/dronex/current/DroneX_live
ELASTIC_URL=... ELASTIC_API_KEY=<writer> DRONEX_RENDER_URL=http://127.0.0.1:3000 npm run elastic:setup
```
- Watch the output for "verdicts skipped".
- The Kibana steps in `elastic/README.md:51-53` (agent.md, workflow.yaml, dashboard.md) are manual.
- Set a spend alert on the project.

### Phase 8: Agentverse (one time, on the VM, after the agents are up)
```sh
cd /opt/dronex/current/DroneX_agents
AGENTVERSE_API_KEY=... .venv/bin/python scripts/connect_agentverse.py
.venv/bin/python scripts/connect_agentverse.py --status
.venv/bin/python scripts/asi1_e2e.py
```
- The seeds are new (item 25), so the agents have new addresses. They must be registered again, and the `@dronex-dispatch` listing must point at the new dispatcher.
- Repeat this step whenever the seeds change.
- Treat ASI:One routing as unverified until `asi1_e2e.py` passes.

### Phase 9: hangar designs
- The agents only refly designs that are already stored.
- From a browser, export each hangar preset in the configurator and Fly it once on the live site. Then mark those designs pinned (item 32) so the reapers keep them.
- Confirm that the agents' token-authenticated designs list shows them.

### Phase 10: first-run checks
```sh
systemctl --failed
journalctl -u dronex-core -n 50
sudo ss -ltnup                                   # 45010/45020/45103/3000 on 127.0.0.1; SITL/agent ports blocked by ufw
curl -sI https://dronex.DOMAIN/api/tracks
curl -s https://sim.DOMAIN/api/session -i | grep -i 'set-cookie.*Secure'
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://sim.DOMAIN/api/pairing          # 404
curl -s -o /dev/null -w '%{http_code}\n' https://sim.DOMAIN/v1/auth                       # 404
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: 127.0.0.1:45010' https://sim.DOMAIN/   # not served as operator (403/421)
```
Then work through the verification checklist below.

---

## Keeping it safe and affordable for loginless visitors

- **No operator power in public.**
  - Visitors only ever reach Core's public listener. There they get NetworkBrowser trust, the Fly capability, a guest allowlist without `client/display*` or `sim/pause`, no escalation, no pairing endpoints and capped frame sizes.
  - The operator listener (45010) is loopback only and the unix socket is reachable only through the filesystem. The data directory is mode 700.
  - The configurator, the mirror and the agents hold `operator-cli` on the socket. So every configurator route that reaches Core checks per-visitor ownership (cookie), an agent token, or both.
- **CPU is bounded at three layers.**
  - In the configurator: the `DRONEX_MAX_SIMS` global cap, one sim per IP, and the reaper.
  - For Dispatch: a share of the same cap, with a TTL.
  - In systemd: `CPUQuota`, `MemoryMax` and `TasksMax` on `dronex-core`, which contain every SITL.

  Guest sessions are also capped globally and per peer, and they expire.
- **Paid APIs.**
  - In-app per-IP limits, and a daily global budget per provider that degrades to a "demo busy" answer. Agent calls with the token count against the Dispatch share.
  - `max_tokens` on every model call, caps on input length and on the assistant's message count and total size, and no GET on speak.
  - Short-lived Cartesia tokens, checked against Origin.
  - Spend limits in every provider console: Cartesia, ASI:One, Google Cloud (daily quota on Map Tiles), ArcGIS, Elastic and SpacetimeDB.
  - Optional later step if abuse shows up: Cloudflare Turnstile (invisible, no login) on first voice use.
- **Map keys.**
  - The browser keys are public by design. Restrict them by referrer to `https://sim.DOMAIN/*` and by API, and cap them per day.
  - The server-side geocoding key (`ARCGIS_GEOCODE_KEY`) is restricted by API and the VM's IP instead, because its requests carry no Referer.
- **Shared data stores.**
  - SpacetimeDB accepts writes only from the allow-listed identities. `tick` runs only as the module itself, and the tables are pruned.
  - Elastic indices have retention.
  - Design folders, vehicle directories and logs are reaped or rotated.
- **Agents.**
  - Seeds are new, never the public defaults.
  - The flight agent accepts orders only from the dispatcher and replies only to the dispatcher.
- **Network.** Inbound traffic is allowed only on 22 (your IP), 80 and 443. SITL TCP/UDP, the agent ports 8001-8003 and the phones-on-network listener are never reachable. The video listener is off.
- **No leaks.** Set `MIRROR_OPERATOR`, return generic error text, hide the operator hints on `/dispatch`, serve HSTS everywhere, and serve a CSP on the configurator.

---

## Verification checklist

**The README's two-minute demo, from a stranger's browser (private window, different network, mobile data is fine):**
- [ ] `https://dronex.DOMAIN` loads, you build a drone, and the verdict shows.
- [ ] Ask DroneX: the mic prompt appears (secure context), the voice answers, and the transcript works.
- [ ] Fly opens `https://sim.DOMAIN/?vehicle=<id>` with no pairing code and no login. The 3D map shows the model on photoreal tiles with terrain.
- [ ] Place search on the 3D page returns results.
- [ ] Take off, fly and land from the 3D page.
- [ ] `/copilot`: voice commands move your drone, `goto_place` works, and the Simulator link points at `https://sim.DOMAIN`.
- [ ] The shared airspace view connects over `wss://` and your vehicle appears. Requesting and releasing a corridor works for your own vehicle.
- [ ] Analytics shows fleet stats from Elastic.
- [ ] `/dispatch` shows the agents live and "Listed on Agentverse".
- [ ] An ASI:One chat with `@dronex-dispatch` gets a reply and goes through request, pick, approve and a flight, and its links open publicly.

**Security, from outside:**
- [ ] A visitor cannot approve pairings: `POST https://sim.DOMAIN/api/pairing` returns 404, and pairing RPCs return CapabilityDenied.
- [ ] A visitor cannot start binaries. `sim/start`, `plugin/draft` and `plugin/test` over `/rpc` are denied, and no approval appears in `journalctl -u dronex-core`. Test this with the `smoke.rs` guest test pointed at the public mode, plus one manual WebSocket test from browser devtools.
- [ ] A visitor cannot open host windows: `storage/reveal` and `video/reveal` are denied.
- [ ] A visitor cannot read daemon logs: `daemon/logs`, `socket/inspect`, `router/events` and `link/diagnose` are denied.
- [ ] A visitor cannot see or freeze other visitors: `client/displayList`, `client/displayPull` and `sim/pause` are denied.
- [ ] A very large `/rpc` frame is rejected.
- [ ] A guest `initialize` grants exactly `[read, control]`.
- [ ] A guest token sent to the loopback listener is refused.
- [ ] Visitor B cannot command visitor A's vehicle through `/api/copilot/intent` or `/api/sim/vehicles/<id>`. On the 3D page this holds only if item 31 is done.
- [ ] `/api/sim/refly/<id>`, POST `/api/sim/vehicles/<id>` and `/api/airspace/mission` return 404 publicly, and 401 on 127.0.0.1 without the token.
- [ ] `/v1/auth`, and every other `/v1/*` path except the two maps paths and `/v1/places*`, return 404.
- [ ] Repeated Fly clicks hit the per-IP limit, then the global cap (429/503), and never reach 32 SITL processes.
- [ ] Paid routes return 429 when hammered, and an oversized `/api/assistant` message list is refused. `GET /api/copilot/speak?text=` no longer works.
- [ ] An anonymous SpacetimeDB identity calling `upsert_vehicle` or `tick` gets an error.
- [ ] An external port scan of the VM shows only 22 (from your IP), 80 and 443.
- [ ] Idle sims are gone after `DRONEX_SIM_IDLE_MIN`, and Dispatch vehicles after their TTL.
- [ ] No response or row contains the server hostname or absolute paths.

---

## Operations

- **Deploy (`deploy/deploy.sh`):**
  1. Snapshot the databases: `sqlite3 /var/lib/dronex/backend.db ".backup /var/backups/dronex/backend-$SHA.db"`, and the same for `/var/lib/dronex/core/uxduck.db`.
  2. Build into `/opt/dronex/releases/<sha>` (Phase 3, as `dronex`).
  3. Repoint `/opt/dronex/current`.
  4. Run `systemctl restart dronex-backend dronex-core dronex-render dronex-mirror dronex-agents`.
  5. Smoke test with the Phase 10 curls.
  6. Tag the commit.

  Also:
  - A GitHub Actions job runs the DroneX_render typecheck, lint and test, the backend `npm test` and the DroneX_live typecheck, then SSHes in and runs `deploy.sh`.
  - Restarting Core kills running sims, so deploy at quiet times.
- **Backups:**
  - Every night, back up both SQLite files with `.backup`, plus `/var/lib/dronex/render-sim` (pinned designs) and the agents' data files. Send them to object storage with retention, and test a restore.
  - Idle vehicle directories and sessions are pruned, not backed up.
- **Monitoring:**
  - Ship journald for every unit with Elastic Agent or Filebeat to the same Serverless project as `logs-dronex-*`, using a separate least-privilege key.
  - Run uptime checks on `https://dronex.DOMAIN/api/tracks`, `https://sim.DOMAIN/` and `/api/dispatch`.
  - Alerts:
    - `dronex-core` CPU near its quota;
    - disk over 80%;
    - unit restarts;
    - Cartesia and LLM spend;
    - the Maps quota;
    - the SpacetimeDB energy budget;
    - Elastic ingest.
- **Rollback:**
  - Keep the last N release directories. Repoint `current` and restart. Restore the pre-deploy SQLite snapshots if the schema changed.
  - `NEXT_PUBLIC_*` values are baked in, so roll back whole builds, never only the env.
  - SpacetimeDB publishes do not roll back with the code. Keep module changes additive and never clear data in production.
- **Sizing:**
  - Fly 1, then 3, then 5 vehicles at speedup 1.
  - Record the CPU and RSS of each `arducopter` (`pidstat -u -r -p <pid>`, `systemd-cgtop`), the load average and the configurator's latency.
  - Then set:
    - `DRONEX_MAX_SIMS = floor(cores for dronex-core × 0.7 / per-vehicle CPU)`;
    - `CPUQuota` from the same figure;
    - the guest caps.

---

## What the human must provide

- [ ] A domain, with DNS A/AAAA records for `dronex.DOMAIN` and `sim.DOMAIN`.
- [ ] An Ubuntu 24.04 LTS VM (x86_64 or arm64), an SSH key, and billing alerts on the provider account.
- [ ] `GOOGLE_MAPS_KEY`: Map Tiles API only, referrer `https://sim.DOMAIN/*`, a daily quota cap.
- [ ] `ARCGIS_KEY`: basemap and elevation only, referrer `sim.DOMAIN`, spending limits.
- [ ] `ARCGIS_GEOCODE_KEY`: geocoding only, restricted to the VM's IP, spending limits.
- [ ] `CARTESIA_API_KEY` and `CARTESIA_VOICE_ID`, with a spend limit.
- [ ] `INTENT_API_KEY`, `INTENT_API_BASE` and `INTENT_MODEL` (ASI:One), with a spend limit.
- [ ] A SpacetimeDB Maincloud login (GitHub). Confirm the database name.
- [ ] An Elastic Cloud Serverless project, a writer key and a reader key (plus a log-shipping key if logs are shipped), and a spend alert.
- [ ] An Agentverse account and `AGENTVERSE_API_KEY`. The agents are registered again with the new seeds.
- [ ] Three new agent seeds, plus `DRONEX_AGENT_TOKEN`, `DRONEX_COOKIE_SECRET` and `SESSION_SECRET`. All of them are generated and never committed.
- [ ] Rotate every key that was ever used in development.
- [ ] Decide on payments: off, or ledger off with sender checks.
- [ ] Hangar designs packed once on the live site (Phase 9).
- [ ] Your IP for SSH.

---

## Open questions / risks

- **Guest allowlist:** which RPC methods the 3D page needs as a guest, in Fly and Cockpit modes and with `?vehicle=`. Capture them before freezing the allowlist.
- **UXDuck services:**
  - Simulators do not depend on UXDuck. With `UXDUCK_SIM_CATALOGUE_URL=none`, which release builds honour (update.rs:66-72; sim/catalogue.rs:86-88), SITL builds come only from `<data-dir>/simulators/bin` (sim/mod.rs:149).
  - Terrain and the parameter catalogue (params.rs:48-56) still come from built-in URLs. The parameter catalogue's default host has not been checked.
  - If terrain is down, `groundHeight` returns null and the sim starts at sea level (`DroneX_render/src/lib/sim/fly.ts:119-125`).
  - Self-hosting terrain needs a code change, because release builds ignore `UXDUCK_TERRAIN_URL`.
- **Build:** whether `--no-default-features` compiles and runs on Linux.
- **Backend paths:** whether the interface calls any backend paths besides `/v1/maps/*` and `/v1/places*` that break behind the Caddy `/v1/*` block.
- **Shared control:** whether guests may steer each other's sims on the 3D page. Without item 31 they can. Letting visitors see other drones read-only is a product choice.
- **Capacity:** SITL CPU per instance is not measured, so the caps cannot be set until sizing is done.
- **Cartesia:** whether an open socket survives token expiry. That decides the 120 s TTL.
- **Place search billing:** whether Core's `place/search` and `place/locate` bill against the backend's map keys on every call. If so, goto_place needs a tight limit.
  - The page's own `/v1/places` calls arrive through Caddy with XFF, so they are limited per IP.
  - Core's calls to the backend come from 127.0.0.1, so they share one bucket.
- **Maincloud limits:** whether an open subscription counts as activity for the idle pause, and whether the free-tier energy is enough at 2 Hz × the sim cap. Watch the dashboard. The fallback is self-hosting SpacetimeDB on the VM, at the cost of one more process and a wss proxy.
- **uagents:** with `forwarded_allow_ips="*"`, a spoofed `X-Forwarded-For: 127.0.0.1` may reach `/connect` (unverified). The firewall covers it.
- **ArduPilot bind address:** whether SITL `--serial0=tcp:0` binds every address. The firewall covers it either way; check with `ss -ltnup`.
- **ASI:One routing** to the dispatcher was unconfirmed at the last test. Have the `/dispatch` page and `scripts/live_chat.py` ready as fallbacks.
- **Microsoft track:** whether it requires Azure is unverified. If it does, the VM goes on Azure and nothing else changes.
- **Elastic in-cluster jobs:** the costs of Workflow and Agent Builder inside the cluster were not reviewed.
- **Caddy rules:** the `@vehpost` block assumes the browser never POSTs vehicle tools.

---

## Is everything going live?

**NO, not yet.** Today:
- the simulator requires a pairing code that an operator approves;
- public routes drive Core with operator rights;
- nothing caps sims or paid API calls;
- anyone can write to the airspace;
- the agents run on public development seeds.

**YES** once all of these are true:
1. Part A items 1 to 29 (including 9a) are merged and tested, with the Core guest mode and its tests (items 1 to 7) first.
2. The Linux release build, `next build` and the SITL build pass on the VM.
3. Every key the human provides is in place, with the right referrer or IP restrictions and spend caps, and the agent seeds are new.
4. The SpacetimeDB writer allow-list is published and the writers are registered.
5. Every box in the verification checklist passes from a stranger's browser.

At that point the configurator, Ask DroneX, `/copilot`, `/dispatch`, the 3D simulator, the shared airspace, analytics and the Dispatch agents are all public. Visitors need no login and see no pairing code. They are never operators, and CPU and spend are bounded.

Two things still depend on outside parties:
- ASI:One routing to `@dronex-dispatch`. Confirm it with `scripts/asi1_e2e.py`.
- The availability of UXDuck's terrain service. The parameter catalogue may also depend on UXDuck, if its default host turns out to be a UXDuck one.
