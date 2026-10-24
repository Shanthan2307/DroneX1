# UXDuck cloud API: what Core expects

Everything here was read from the open-source client side, UXDuck Core
(Apache-2.0, `../uxduck-core`, commit `6bae9dd`), and checked against the
strings in the installed UXDuck 0.6.0 binary. The server itself
(`api.uxduck.com`) is closed; this is the contract a replacement must meet.

Paths in the Source column are relative to `../uxduck-core/crates/`.

## Conventions

- **Base URL**: Core uses `UXDUCK_API_URL`. Debug builds default to
  `http://localhost:45103` (`uxduck/src/dev_api.rs`). Set it to `none` for no
  account server at all.
- **Auth**: `Authorization: Bearer <token>`. The token comes from the
  `set-auth-token` response header at sign-in and is kept in
  `~/.uxduck/credentials.json`.
- **401** on any authed call means "token no longer valid": Core forgets it.
- **JSON** bodies are camelCase. Times are milliseconds (`...AtMs`) or
  microseconds (`...Us`) since the Unix epoch, as noted.
- **IDs**: devices are `dv` + 16 hex digits; watch links are `wl` + 16 hex.
- **503** on media routes means "live video not set up on this server"; Core
  shows that message instead of failing hard.

## 1. Auth and account (better-auth compatible)

The auth routes match the [better-auth](https://www.better-auth.com) library's
email-OTP and bearer plugins mounted at `/v1/auth`. Using better-auth is the
shortest path.

| Method | Path | Body / query | Response | Source |
|---|---|---|---|---|
| POST | `/v1/auth/email-otp/send-verification-otp` | `{email, type:"sign-in"}` | 2xx; email the code | `uxduck/src/account.rs:441` |
| POST | `/v1/auth/sign-in/email-otp` | `{email, otp}` | Header `set-auth-token: <token>`; body `{isNew: bool, ...}` | `uxduck/src/account.rs:455` |
| POST | `/v1/auth/sign-out` | `{}` | 2xx | `uxduck/src/account.rs:405` |
| GET | `/v1/me` | | `{user:{id,email,name?,username?}, productUpdates, analyticsExcluded?, signedSession:{token}}` | `uxduck/src/account.rs:75`, `:1210` |
| PUT | `/v1/me/username` | `{username}` | 2xx | `uxduck/src/account.rs:548` |
| PUT | `/v1/updates/me` | `{subscribed: bool}` | 2xx | `uxduck/src/account.rs:1071` |
| GET | `/v1/me/sessions` | | `{sessions:[{id, current: bool, name, ...}]}` | `uxduck/src/account.rs:763` |
| PUT | `/v1/me/sessions/current` | `{name}` (computer name, max 64 chars) | 2xx | `uxduck/src/account.rs:493` |
| DELETE | `/v1/me/sessions/{id}` | | 2xx | `uxduck/src/account.rs:~725` |
| POST | `/v1/me/sessions/sign-out-others` | | 2xx | same |
| POST | `/v1/me/delete` (+ `/check`, `/confirm`) | | 2xx; emails a confirmation | same |

`signedSession.token` is a **5-minute signed session** used only as the API key
for the hosted model (section 2). Core caches it until a minute before expiry.

## 2. Hosted AI model (optional)

`uxduck-agent/src/provider/hosted.rs`. Core speaks the normal Anthropic or
OpenAI wire format to `{api}/v1/model` instead of the vendor's URL, with:

- the signed session (from `/v1/me`) as the API key (`x-api-key` /
  `Authorization`)
- `x-uxduck-share: conversations | none` (whether the turn may be kept)
- `x-uxduck-thread: <random chat id>`

So this is a **pass-through proxy**: forward `/v1/model/messages` to
`https://api.anthropic.com/v1/messages` (or `/v1/model/responses` to OpenAI)
with your own key, checking the signed session and metering usage.
**Skippable:** Core also calls Anthropic and OpenAI directly when the user sets
their own key.

| Method | Path | Body | Source |
|---|---|---|---|
| POST | `/v1/turns/send` | `{thread, model, items, rating, comment}` | `uxduck/src/account.rs:638` |
| POST | `/v1/turns/feedback` | `{responseId, rating, comment}`; 404 = "not kept" | `uxduck/src/account.rs:615` |
| GET/DELETE | `/v1/turns/mine` | the account's shared conversations | `uxduck/src/account.rs:671` |

## 3. Cloud sync (settings, plans, vehicles across computers)

`uxduck/src/sync.rs:188-330`. Last-writer-wins is decided by the engine; the
server only stores and orders changes.

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/v1/sync/push` | `{deviceId, deviceName, changes:[...]}` (batched) | 2xx |
| GET | `/v1/sync/pull` | `?device=<id>&after=<cursor>` | `{changes:[...], cursor: number, more: bool}`. Return only other devices' changes after `cursor`. |
| PUT | `/v1/plugins/bundles/{sha256}` | raw `application/octet-stream`; 413 if too large | 2xx |
| GET | `/v1/plugins/bundles/{sha256}` | | bytes; 404 if missing |

Server model: an append-only `changes` table `(seq, account, device, payload)`.
`cursor` = last `seq` returned.

## 4. Flight and recording storage

`uxduck/src/uploader.rs:330-640`. Chunked uploads go straight to object
storage through pre-signed URLs (S3 or R2 style).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/v1/storage` | | `{bytes}` used by the account |
| POST | `/v1/ingest/grants` | `{deviceId, chunks:[{name,size,sha256}]}` | `{grants:[{name, url}]}` (pre-signed PUT URLs) |
| PUT | `<grant url>` | chunk bytes | 2xx (from the storage provider) |
| POST | `/v1/ingest/complete` | `{deviceId, chunks:[{name,size,sha256,firstUs,lastUs}]}` | 2xx |
| GET | `/v1/flights`, `/v1/recordings` | | `{flights:[{id, deviceId, computer, firstUs, lastUs, bytes}]}` (key matches the path) |
| GET | `/v1/{flights or recordings}/{device}/{id}` | | the item with its chunk list; Core checks each chunk's sha256 and joins them back into a tlog or MP4 |

## 5. Computers, relay and remote control ("edge")

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/v1/computers` | `{computers:[{id,name,online,lastSeenAtMs?,daemonVersion?}]}`, online first | `uxduck-contracts/src/dto/edge.rs:66` |
| WS | `/v1/computers/edge?device=&name=` | **Each computer's persistent connection to the relay.** JSON-RPC 2.0 frames both ways. Includes ping/pong (`sentAtMs`, `relayAtMs`) and `edge/left {userId}`. The relay forwards remote viewers' RPC calls to the computer. | `uxduck/src/edge.rs:287` |
| WS | `/v1/computers/{id}/live` | A viewer's connection to a computer through the relay | `uxduck/src/watch.rs:100` |
| GET | `/v1/computers/keys` | `{keys:[{kid, x}]}`: Ed25519 public keys, base64url | `uxduck/src/grants.rs` |

**Grants:** the relay attaches a grant `<payload>.<sig>` (both base64url) to
each remote command. The payload is `{kid, sub, name, dev, exp}` (exp in ms)
and the signature is Ed25519 over the payload text. The computer verifies it
against `/v1/computers/keys`, so your server needs an Ed25519 signing key.

## 6. Live video from away (WebRTC)

`uxduck-contracts/src/dto/edge.rs:425-500`. The server is only a
**coordinator**: it hands out media-node URLs and grants. The video itself
flows through a WHIP/WHEP media server such as MediaMTX, LiveKit or Cloudflare
Stream.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/v1/media/publish` | `{deviceId, cameraId, recordingId?, store}` | `{streamId, protocol:"whip" or "srt", nodes:[{id,region,whipUrl,srtUrl?}], grant, expiresAtMs}` |
| POST | `/v1/media/watch` | `{deviceId, cameraId, nodeId?}` | `{streamId, whepUrl, grant, expiresAtMs, iceServers:[...]}` |

## 7. Watch links (share a live flight)

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/v1/watch-links` | `{deviceId, vehicleId?, vehicleName?, flownBy, hours?}` (default 24, max 168) | `{link: WatchLink, token}` (store only the token's hash) |
| GET | `/v1/watch-links?device=` | | `{links:[WatchLink]}` |
| DELETE | `/v1/watch-links/{id}` or `?device=` | | 2xx |
| GET | `/v1/watch/{token}` (no auth) | | `{vehicleId?, vehicleName?, flownBy, expiresAtMs}` |
| POST | `/v1/watch/{token}/video` | `{cameraId, nodeId?}` | same shape as a media watch grant |

`WatchLink` = `{id, deviceId, vehicleId?, vehicleName?, flownBy, createdAtMs, expiresAtMs}`.

## 8. Plugin sharing, places, feedback, misc

| Method | Path | Notes | Source |
|---|---|---|---|
| GET/POST/DELETE | `/v1/plugins` | Share plugins with others: `{pluginId, name, version, path, module, capabilities}` | `uxduck/src/account.rs:910` |
| POST | `/v1/places/{search or locate}` | Geocoding proxy (no auth); wrap Nominatim, Mapbox or Google | `uxduck/src/places.rs:51` |
| POST | `/v1/feedback` | multipart (report + `attachment` parts); bearer optional | `uxduck/src/feedback.rs:332` |
| GET | `/v1/feedback/mine` | | `uxduck/src/account.rs:573` |
| POST | `/v1/feedback/claim` | `{reports:[{id,key}]}` | `uxduck/src/account.rs:587` |
| GET | `/v1/maps/key`, `/v1/maps/google-key` | Hand out map tile API keys | binary strings |
| POST | `/v1/logs`, `/v1/viewport` | Telemetry/analytics; return 204 | binary strings |

Also outside `/v1`: `app.uxduck.com/interface/manifest.json` (the closed web
UI that Core downloads) and the Sparkle update feed. Neither is needed if you
ship your own UI (your fork already has `apps/web`).
