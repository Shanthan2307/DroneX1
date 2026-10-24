import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { MemoryMailer } from "../src/mailer.ts";

const ORIGIN = "http://backend.test";
let dir: string;
let clock: number;
let mailer: MemoryMailer;
let app: ReturnType<typeof createApp>;

const call = (method: string, path: string, body?: unknown, token?: string) =>
  app.request(path.replace(ORIGIN, ""), {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const put = (url: string, bytes: Uint8Array) =>
  app.request(url.replace(ORIGIN, ""), {
    method: "PUT",
    headers: { "content-length": String(bytes.length) },
    body: bytes as Uint8Array<ArrayBuffer>,
  });

async function signIn(email: string) {
  await call("POST", "/v1/auth/email-otp/send-verification-otp", { email });
  const res = await call("POST", "/v1/auth/sign-in/email-otp", { email, otp: mailer.codeFor(email) });
  return res.headers.get("set-auth-token")!;
}

/** A chunk as Core names it. */
function chunk(item: string, seq: number, text: string, ext = "tlog.zst") {
  const bytes = new TextEncoder().encode(text);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const name = `${item}/${String(seq).padStart(6, "0")}-${sha256}.${ext}`;
  return { bytes, meta: { name, size: bytes.length, sha256 }, firstUs: seq * 1000, lastUs: seq * 1000 + 999 };
}

/** Grants, PUTs and completes, as Core's uploader does. */
async function upload(token: string, device: string, chunks: ReturnType<typeof chunk>[]) {
  const g = await (await call("POST", "/v1/ingest/grants", { deviceId: device, chunks: chunks.map((c) => c.meta) }, token)).json();
  for (const c of chunks) {
    const url = g.grants.find((x: { name: string }) => x.name === c.meta.name).url;
    assert.equal((await put(url, c.bytes)).status, 200);
  }
  const done = await call("POST", "/v1/ingest/complete", {
    deviceId: device, chunks: chunks.map((c) => ({ ...c.meta, firstUs: c.firstUs, lastUs: c.lastUs })),
  }, token);
  return done.json();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dronex-storage-"));
  clock = 1_800_000_000_000;
  mailer = new MemoryMailer();
  app = createApp({
    db: openDb(":memory:"), mailer, secret: "s".repeat(40), now: () => clock,
    storage: { dir, publicUrl: ORIGIN, quotaBytes: 1024 },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("flights", () => {
  test("upload, list and download a flight in order", async () => {
    const t = await signIn("pilot@example.com");
    const parts = [chunk("tlog-1", 1, "first part"), chunk("tlog-1", 2, "second part")];
    const done = await upload(t, "dv1", parts);
    assert.deepEqual(done, { acknowledged: parts.map((p) => p.meta.name), missing: [] });

    const { flights } = await (await call("GET", "/v1/flights", undefined, t)).json();
    assert.equal(flights.length, 1);
    assert.deepEqual(
      { id: flights[0].id, deviceId: flights[0].deviceId, chunks: flights[0].chunks, firstUs: flights[0].firstUs, lastUs: flights[0].lastUs },
      { id: "tlog-1", deviceId: "dv1", chunks: 2, firstUs: 1000, lastUs: 2999 },
    );
    assert.equal(flights[0].bytes, parts[0].bytes.length + parts[1].bytes.length);
    assert.equal((await (await call("GET", "/v1/recordings", undefined, t)).json()).recordings.length, 0);

    const flight = await (await call("GET", "/v1/flights/dv1/tlog-1", undefined, t)).json();
    const texts = [];
    for (const c of flight.chunks) {
      const got = new Uint8Array(await (await call("GET", c.url)).arrayBuffer());
      assert.equal(createHash("sha256").update(got).digest("hex"), c.sha256);
      texts.push(new TextDecoder().decode(got));
    }
    assert.deepEqual(texts, ["first part", "second part"]);
    assert.equal((await (await call("GET", "/v1/storage", undefined, t)).json()).bytes, 21);
  });

  test("a chunk never put is missing, and put later is acknowledged", async () => {
    const t = await signIn("pilot@example.com");
    const c = chunk("tlog-1", 1, "data");
    await call("POST", "/v1/ingest/grants", { deviceId: "dv1", chunks: [c.meta] }, t);
    const early = await (await call("POST", "/v1/ingest/complete", { deviceId: "dv1", chunks: [c.meta] }, t)).json();
    assert.deepEqual(early, { acknowledged: [], missing: [c.meta.name] });
    assert.deepEqual((await upload(t, "dv1", [c])).acknowledged, [c.meta.name]);
  });

  test("bytes that are not what was granted are refused", async () => {
    const t = await signIn("pilot@example.com");
    const c = chunk("tlog-1", 1, "data");
    const { grants } = await (await call("POST", "/v1/ingest/grants", { deviceId: "dv1", chunks: [c.meta] }, t)).json();
    assert.equal((await put(grants[0].url, new TextEncoder().encode("evil"))).status, 400);
  });

  test("an upload link expires after 15 minutes", async () => {
    const t = await signIn("pilot@example.com");
    const c = chunk("tlog-1", 1, "data");
    const { grants } = await (await call("POST", "/v1/ingest/grants", { deviceId: "dv1", chunks: [c.meta] }, t)).json();
    clock += 15 * 60_000 + 1;
    assert.equal((await put(grants[0].url, c.bytes)).status, 403);
  });

  test("names that could leave the storage folder are refused", async () => {
    const t = await signIn("pilot@example.com");
    const c = chunk("tlog-1", 1, "data");
    for (const name of [`../x/000001-${c.meta.sha256}.tlog.zst`, `.x/000001-${c.meta.sha256}.tlog.zst`, "a/b"]) {
      const res = await call("POST", "/v1/ingest/grants", { deviceId: "dv1", chunks: [{ ...c.meta, name }] }, t);
      assert.equal(res.status, 400, name);
    }
    assert.equal((await call("POST", "/v1/ingest/grants", { deviceId: "../dv", chunks: [c.meta] }, t)).status, 400);
  });

  test("a full account refuses new grants with 413", async () => {
    const t = await signIn("pilot@example.com");
    const big = chunk("tlog-1", 1, "x".repeat(1025));
    assert.equal((await call("POST", "/v1/ingest/grants", { deviceId: "dv1", chunks: [big.meta] }, t)).status, 413);
  });

  test("another account sees nothing and cannot read the item", async () => {
    const a = await signIn("a@example.com");
    const b = await signIn("b@example.com");
    await upload(a, "dv1", [chunk("tlog-1", 1, "secret")]);
    assert.deepEqual((await (await call("GET", "/v1/flights", undefined, b)).json()).flights, []);
    assert.equal((await call("GET", "/v1/flights/dv1/tlog-1", undefined, b)).status, 404);
  });
});

describe("recordings", () => {
  test("segments are listed as a recording, with gaps for what never arrived", async () => {
    const t = await signIn("pilot@example.com");
    await upload(t, "dv1", [chunk("rec-1", 0, "init", "mp4"), chunk("rec-1", 1, "s1", "m4s"), chunk("rec-1", 4, "s4", "m4s")]);
    const { recordings } = await (await call("GET", "/v1/recordings", undefined, t)).json();
    assert.equal(recordings[0].id, "rec-1");
    const rec = await (await call("GET", "/v1/recordings/dv1/rec-1", undefined, t)).json();
    assert.deepEqual(rec.segments.map((s: { seq: number }) => s.seq), [0, 1, 4]);
    assert.deepEqual(rec.gaps, [{ fromSeq: 2, toSeq: 3 }]);
  });
});
