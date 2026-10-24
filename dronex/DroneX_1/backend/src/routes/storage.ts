// Flights and recordings in the account (core/crates/uxduck/src/uploader.rs).
// Core asks for grants, PUTs each chunk to the URL it was given with no
// session (so the URL is signed and short-lived), then completes them; the
// account acknowledges what arrived and checked out and names what is missing.
// The bytes live on disk under the storage directory; a deployment could
// point the grants at S3 or R2 instead without Core noticing.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { signToken, verifyToken } from "../crypto.ts";
import { type Ctx, type Env, refuse, requireSession } from "../session.ts";

const GRANT_TTL_MS = 15 * 60_000;
/** A tlog chunk is about 1 MB and a recording segment about 10 s of video. */
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_CHUNKS = 100;

const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
/** `<item>/<seq>-<sha256>.<ext>`; an item never starts with a dot. */
const NAME = /^([A-Za-z0-9_-][A-Za-z0-9._-]{0,127})\/(\d{1,9})-([0-9a-f]{64})\.([a-z0-9]{1,8}(?:\.[a-z0-9]{1,8})?)$/;

type Kind = "flight" | "recording";
const kindOf = (ext: string): Kind => (ext === "tlog.zst" ? "flight" : "recording");

export interface Storage {
  dir: string;
  /** How Core reaches this server, for the URLs in grants. */
  publicUrl: string;
  quotaBytes: number;
}

interface PutGrant { u: string; d: string; n: string; size: number; sha: string }
interface GetGrant { u: string; d: string; n: string }

interface ChunkIn { name: string; size: number; sha256: string; firstUs?: number; lastUs?: number }

function parse(c: unknown): (ChunkIn & { item: string; seq: number; kind: Kind }) | null {
  if (typeof c !== "object" || c === null) return null;
  const x = c as Record<string, unknown>;
  const m = typeof x.name === "string" ? NAME.exec(x.name) : null;
  if (!m || typeof x.sha256 !== "string" || x.sha256 !== m[3]) return null;
  if (typeof x.size !== "number" || !Number.isSafeInteger(x.size) || x.size < 0 || x.size > MAX_CHUNK_BYTES) return null;
  const us = (v: unknown) => (v === undefined || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0));
  if (!us(x.firstUs) || !us(x.lastUs)) return null;
  return {
    name: x.name as string, size: x.size, sha256: x.sha256,
    firstUs: x.firstUs as number | undefined, lastUs: x.lastUs as number | undefined,
    item: m[1], seq: Number(m[2]), kind: kindOf(m[4]),
  };
}

export function storageRoutes(ctx: Ctx, storage: Storage): Hono<Env> {
  const s = new Hono<Env>();
  const auth = requireSession(ctx);
  const file = (u: string, d: string, n: string) => join(storage.dir, u, d, n);
  const used = (userId: string) =>
    (ctx.db
      .prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM chunks WHERE user_id = ? AND state IN ('put', 'stored')")
      .get(userId) as { bytes: number }).bytes;
  const computer = (userId: string, deviceId: string) =>
    (ctx.db.prepare("SELECT name FROM devices WHERE user_id = ? AND device_id = ?").get(userId, deviceId) as
      | { name: string }
      | undefined)?.name ?? null;

  s.get("/storage", auth, (c) => c.json({ bytes: used(c.get("session").user_id) }));

  s.post("/ingest/grants", auth, async (c) => {
    const body = await c.req.json().catch(() => null);
    const deviceId = body?.deviceId;
    const chunks = Array.isArray(body?.chunks) ? body.chunks.map(parse) : null;
    if (typeof deviceId !== "string" || !DEVICE.test(deviceId)) return c.json(refuse("deviceId is not valid."), 400);
    if (!chunks || chunks.length > MAX_CHUNKS || chunks.some((x: unknown) => x === null)) {
      return c.json(refuse("chunks is not a list of valid chunks."), 400);
    }
    const userId = c.get("session").user_id;
    const wanted = chunks.reduce((sum: number, ch: ChunkIn) => sum + ch.size, 0);
    if (used(userId) + wanted > storage.quotaBytes) {
      return c.json(refuse("Your account's storage is full."), 413);
    }
    const now = ctx.now();
    const upsert = ctx.db.prepare(
      `INSERT INTO chunks (user_id, device_id, name, kind, item_id, seq, size, sha256, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'granted', ?)
       ON CONFLICT(user_id, device_id, name) DO NOTHING`,
    );
    const grants = chunks.map((ch: NonNullable<ReturnType<typeof parse>>) => {
      upsert.run(userId, deviceId, ch.name, ch.kind, ch.item, ch.seq, ch.size, ch.sha256, now);
      const token = signToken(ctx.secret, "put", { u: userId, d: deviceId, n: ch.name, size: ch.size, sha: ch.sha256 }, now + GRANT_TTL_MS);
      return { name: ch.name, url: `${storage.publicUrl}/v1/blobs/${token}` };
    });
    return c.json({ grants, expiresAtMs: now + GRANT_TTL_MS });
  });

  // The create-only upload a grant names. The same bytes again are fine.
  s.put("/blobs/:token", async (c) => {
    const g = verifyToken<PutGrant>(ctx.secret, "put", c.req.param("token"), ctx.now());
    if (!g) return c.json(refuse("This upload link is not valid or has expired."), 403);
    const declared = Number(c.req.header("content-length") ?? g.size);
    if (declared !== g.size) return c.json(refuse("The upload is not the size granted."), 400);
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (bytes.length !== g.size || createHash("sha256").update(bytes).digest("hex") !== g.sha) {
      return c.json(refuse("The upload does not match what was granted."), 400);
    }
    const path = file(g.u, g.d, g.n);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.part`, bytes);
      renameSync(`${path}.part`, path);
    }
    ctx.db
      .prepare("UPDATE chunks SET state = 'put' WHERE user_id = ? AND device_id = ? AND name = ? AND state = 'granted'")
      .run(g.u, g.d, g.n);
    return c.body(null, 200);
  });

  s.post("/ingest/complete", auth, async (c) => {
    const body = await c.req.json().catch(() => null);
    const deviceId = body?.deviceId;
    const chunks = Array.isArray(body?.chunks) ? body.chunks.map(parse) : null;
    if (typeof deviceId !== "string" || !DEVICE.test(deviceId)) return c.json(refuse("deviceId is not valid."), 400);
    if (!chunks || chunks.length > MAX_CHUNKS || chunks.some((x: unknown) => x === null)) {
      return c.json(refuse("chunks is not a list of valid chunks."), 400);
    }
    const userId = c.get("session").user_id;
    const row = ctx.db.prepare("SELECT state, sha256, size FROM chunks WHERE user_id = ? AND device_id = ? AND name = ?");
    const store = ctx.db.prepare(
      "UPDATE chunks SET state = 'stored', first_us = ?, last_us = ? WHERE user_id = ? AND device_id = ? AND name = ?",
    );
    const acknowledged: string[] = [];
    const missing: string[] = [];
    for (const ch of chunks as NonNullable<ReturnType<typeof parse>>[]) {
      const r = row.get(userId, deviceId, ch.name) as { state: string; sha256: string; size: number } | undefined;
      const there = r && r.sha256 === ch.sha256 && r.size === ch.size && r.state !== "granted" &&
        existsSync(file(userId, deviceId, ch.name));
      if (!there) {
        missing.push(ch.name);
        continue;
      }
      store.run(ch.firstUs ?? null, ch.lastUs ?? null, userId, deviceId, ch.name);
      acknowledged.push(ch.name);
    }
    return c.json({ acknowledged, missing });
  });

  for (const [path, kind] of [["flights", "flight"], ["recordings", "recording"]] as const) {
    s.get(`/${path}`, auth, (c) => {
      const userId = c.get("session").user_id;
      const rows = ctx.db
        .prepare(
          `SELECT device_id, item_id, MIN(first_us) AS first_us, MAX(last_us) AS last_us,
                  COUNT(*) AS chunks, SUM(size) AS bytes
           FROM chunks WHERE user_id = ? AND kind = ? AND state = 'stored'
           GROUP BY device_id, item_id ORDER BY MAX(last_us) DESC`,
        )
        .all(userId, kind) as { device_id: string; item_id: string; first_us: number | null; last_us: number | null; chunks: number; bytes: number }[];
      return c.json({
        [path]: rows.map((r) => ({
          id: r.item_id, deviceId: r.device_id, computer: computer(userId, r.device_id),
          firstUs: r.first_us, lastUs: r.last_us, chunks: r.chunks, bytes: r.bytes,
        })),
      });
    });

    s.get(`/${path}/:device/:id`, auth, (c) => {
      const userId = c.get("session").user_id;
      const { device, id } = c.req.param();
      const rows = ctx.db
        .prepare(
          `SELECT name, seq, size, sha256, first_us, last_us FROM chunks
           WHERE user_id = ? AND kind = ? AND device_id = ? AND item_id = ? AND state = 'stored' ORDER BY seq`,
        )
        .all(userId, kind, device, id) as { name: string; seq: number; size: number; sha256: string; first_us: number | null; last_us: number | null }[];
      if (rows.length === 0) return c.json(refuse(`No such ${kind}.`), 404);
      const exp = ctx.now() + GRANT_TTL_MS;
      const parts = rows.map((r) => ({
        seq: r.seq, size: r.size, sha256: r.sha256, firstUs: r.first_us, lastUs: r.last_us,
        url: `${storage.publicUrl}/v1/blobs/${signToken(ctx.secret, "get", { u: userId, d: device, n: r.name }, exp)}`,
      }));
      // Recordings say which segments never reached the account.
      const gaps: { fromSeq: number; toSeq: number }[] = [];
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].seq > rows[i - 1].seq + 1) gaps.push({ fromSeq: rows[i - 1].seq + 1, toSeq: rows[i].seq - 1 });
      }
      return c.json({
        id, deviceId: device, computer: computer(userId, device),
        ...(kind === "flight" ? { chunks: parts } : { segments: parts, gaps }),
      });
    });
  }

  s.get("/blobs/:token", (c) => {
    const g = verifyToken<GetGrant>(ctx.secret, "get", c.req.param("token"), ctx.now());
    if (!g) return c.json(refuse("This download link is not valid or has expired."), 403);
    const path = file(g.u, g.d, g.n);
    if (!existsSync(path)) return c.json(refuse("No such file."), 404);
    return c.body(readFileSync(path), 200, { "content-type": "application/octet-stream" });
  });

  return s;
}
