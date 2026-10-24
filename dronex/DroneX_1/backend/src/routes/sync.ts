// Cloud sync and plugin bundles (core/crates/uxduck/src/sync.rs). Computers
// push changes and pull what other computers sent; the account keeps only
// the winning copy of each entity, decided as Core decides
// (uxduck-engine/src/sync.rs `wins`), so every computer converges.

import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type Ctx, type Env, refuse, requireSession } from "../session.ts";

/** The version of a removal; it outranks every edit. */
export const REMOVED = 9_007_199_254_740_991;
const ENTITIES = new Set([
  "thread", "item", "folder", "place", "snapshot", "operator", "vehicle", "history", "plugin",
]);
/** Core sends at most 200 changes and 2 MiB per push. */
const MAX_CHANGES = 500;
const MAX_PUSH_BYTES = 4 * 1024 * 1024;
const PULL_PAGE = 200;
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;

interface Change {
  entity: string;
  id: string;
  version: number;
  digest: string;
  tsUs: number;
  change: unknown;
}

interface Row {
  entity: string;
  id: string;
  version: number;
  digest: string;
  ts_us: number;
  change: string;
  device_name: string;
  seq: number;
}

const isCount = (n: unknown, max = REMOVED): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;

function valid(c: unknown): c is Change {
  if (typeof c !== "object" || c === null) return false;
  const x = c as Record<string, unknown>;
  return (
    typeof x.entity === "string" && ENTITIES.has(x.entity) &&
    typeof x.id === "string" && x.id.length > 0 && x.id.length <= 200 &&
    isCount(x.version) &&
    typeof x.digest === "string" && HEX64.test(x.digest) &&
    isCount(x.tsUs, Number.MAX_SAFE_INTEGER) &&
    "change" in x
  );
}

/** Core's `wins`: the higher (version, digest), compared in that order. */
export const wins = (v: number, d: string, current?: { version: number; digest: string }) =>
  !current || v > current.version || (v === current.version && d > current.digest);

export function syncRoutes(ctx: Ctx): Hono<Env> {
  const sync = new Hono<Env>();
  for (const path of ["/sync/*", "/plugins/bundles/*"]) sync.use(path, requireSession(ctx));

  sync.post("/sync/push", bodyLimit({ maxSize: MAX_PUSH_BYTES }), async (c) => {
    const body = await c.req.json().catch(() => null);
    const deviceId = body?.deviceId;
    const deviceName = typeof body?.deviceName === "string" ? body.deviceName.slice(0, 64) : "";
    const changes: unknown = body?.changes;
    if (typeof deviceId !== "string" || !DEVICE.test(deviceId)) {
      return c.json(refuse("deviceId is missing or not valid."), 400);
    }
    if (!Array.isArray(changes) || changes.length > MAX_CHANGES || !changes.every(valid)) {
      return c.json(refuse("changes is not a list of valid changes."), 400);
    }

    const userId = c.get("session").user_id;
    const current = ctx.db.prepare(
      "SELECT version, digest FROM sync_entities WHERE user_id = ? AND entity = ? AND id = ?",
    );
    const nextSeq = ctx.db.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM sync_entities WHERE user_id = ?",
    );
    const upsert = ctx.db.prepare(
      `INSERT INTO sync_entities
         (user_id, entity, id, version, digest, ts_us, change, device_id, device_name, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, entity, id) DO UPDATE SET
         version = excluded.version, digest = excluded.digest, ts_us = excluded.ts_us,
         change = excluded.change, device_id = excluded.device_id,
         device_name = excluded.device_name, seq = excluded.seq`,
    );

    let accepted = 0;
    ctx.db.exec("BEGIN");
    if (deviceName) {
      ctx.db
        .prepare(
          `INSERT INTO devices (user_id, device_id, name) VALUES (?, ?, ?)
           ON CONFLICT(user_id, device_id) DO UPDATE SET name = excluded.name`,
        )
        .run(userId, deviceId, deviceName);
    }
    try {
      for (const ch of changes) {
        const existing = current.get(userId, ch.entity, ch.id) as
          | { version: number; digest: string }
          | undefined;
        if (!wins(ch.version, ch.digest, existing)) continue;
        const { seq } = nextSeq.get(userId) as { seq: number };
        upsert.run(
          userId, ch.entity, ch.id, ch.version, ch.digest, ch.tsUs,
          JSON.stringify(ch.change), deviceId, deviceName, seq,
        );
        accepted++;
      }
      ctx.db.exec("COMMIT");
    } catch (err) {
      ctx.db.exec("ROLLBACK");
      throw err;
    }
    return c.json({ accepted, ignored: changes.length - accepted });
  });

  // Other computers' copies after `after`. The cursor moves past this
  // computer's own copies too, so a page of them is not read again.
  sync.get("/sync/pull", (c) => {
    const device = c.req.query("device") ?? "";
    const after = Number(c.req.query("after") ?? "0");
    if (!DEVICE.test(device) || !isCount(after)) {
      return c.json(refuse("device and after are required."), 400);
    }
    const rows = ctx.db
      .prepare(
        `SELECT entity, id, version, digest, ts_us, change, device_id, device_name, seq
         FROM sync_entities WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(c.get("session").user_id, after, PULL_PAGE) as unknown as (Row & { device_id: string })[];
    const changes = rows
      .filter((r) => r.device_id !== device)
      .map((r) => ({
        device: r.device_name,
        entity: r.entity,
        id: r.id,
        version: r.version,
        digest: r.digest,
        tsUs: r.ts_us,
        change: JSON.parse(r.change),
      }));
    return c.json({
      changes,
      cursor: rows.length ? rows[rows.length - 1].seq : after,
      more: rows.length === PULL_PAGE,
    });
  });

  sync.put("/plugins/bundles/:digest", async (c) => {
    const digest = c.req.param("digest");
    if (!HEX64.test(digest)) return c.json(refuse("Not a SHA-256 digest."), 400);
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_BUNDLE_BYTES) return c.json(refuse("The plugin is too large to sync."), 413);
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (bytes.length > MAX_BUNDLE_BYTES) return c.json(refuse("The plugin is too large to sync."), 413);
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      return c.json(refuse("The bundle does not match its digest."), 400);
    }
    ctx.db
      .prepare(
        `INSERT INTO plugin_bundles (user_id, digest, bytes, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, digest) DO NOTHING`,
      )
      .run(c.get("session").user_id, digest, bytes, ctx.now());
    return c.json({ digest, size: bytes.length });
  });

  sync.get("/plugins/bundles/:digest", (c) => {
    const row = ctx.db
      .prepare("SELECT bytes FROM plugin_bundles WHERE user_id = ? AND digest = ?")
      .get(c.get("session").user_id, c.req.param("digest")) as { bytes: Uint8Array } | undefined;
    if (!row) return c.json(refuse("No such bundle."), 404);
    return c.body(Buffer.from(row.bytes), 200, { "content-type": "application/octet-stream" });
  });

  return sync;
}
