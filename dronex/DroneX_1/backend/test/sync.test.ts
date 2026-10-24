import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { MAX_BUNDLE_BYTES, REMOVED } from "../src/routes/sync.ts";

let mailer: MemoryMailer;
let app: ReturnType<typeof createApp>;

const call = (method: string, path: string, body?: unknown, token?: string) =>
  app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function signIn(email: string): Promise<string> {
  await call("POST", "/v1/auth/email-otp/send-verification-otp", { email });
  const res = await call("POST", "/v1/auth/sign-in/email-otp", { email, otp: mailer.codeFor(email) });
  return res.headers.get("set-auth-token")!;
}

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const change = (id: string, version: number, body: unknown, entity = "place") => ({
  entity, id, version, digest: hex(JSON.stringify(body)), tsUs: 1_700_000_000_000_000, change: body,
});
const push = (token: string, deviceId: string, changes: unknown[]) =>
  call("POST", "/v1/sync/push", { deviceId, deviceName: `${deviceId} name`, changes }, token);
const pull = async (token: string, device: string, after = 0) =>
  (await call("GET", `/v1/sync/pull?device=${device}&after=${after}`, undefined, token)).json();

beforeEach(() => {
  mailer = new MemoryMailer();
  app = createApp({ db: openDb(":memory:"), mailer, secret: "s".repeat(40) });
});

describe("sync", () => {
  test("a computer pulls what another pushed, named by that computer", async () => {
    const t = await signIn("pilot@example.com");
    const place = { name: "Field", lat: 51.5, lon: -0.1 };
    assert.equal((await push(t, "dv1", [change("p1", 1, place)])).status, 200);
    const page = await pull(t, "dv2");
    assert.equal(page.changes.length, 1);
    assert.equal(page.changes[0].device, "dv1 name");
    assert.deepEqual(page.changes[0].change, place);
    assert.equal(page.more, false);
    assert.ok(page.cursor > 0);
  });

  test("a computer does not get its own changes back, but its cursor moves past them", async () => {
    const t = await signIn("pilot@example.com");
    await push(t, "dv1", [change("p1", 1, { a: 1 }), change("p2", 1, { b: 1 })]);
    const page = await pull(t, "dv1");
    assert.deepEqual(page.changes, []);
    assert.equal(page.cursor, 2);
  });

  test("the higher version wins, whatever order changes arrive in", async () => {
    const t = await signIn("pilot@example.com");
    await push(t, "dv1", [change("p1", 5, { v: 5 })]);
    const late = await (await push(t, "dv2", [change("p1", 3, { v: 3 })])).json();
    assert.deepEqual(late, { accepted: 0, ignored: 1 });
    const page = await pull(t, "dv3");
    assert.deepEqual(page.changes.map((c: { change: unknown }) => c.change), [{ v: 5 }]);
  });

  test("at one version the higher digest wins", async () => {
    const t = await signIn("pilot@example.com");
    const a = change("p1", 7, { v: "a" });
    const b = change("p1", 7, { v: "b" });
    const [low, high] = a.digest < b.digest ? [a, b] : [b, a];
    await push(t, "dv1", [high]);
    await push(t, "dv2", [low]);
    assert.equal((await pull(t, "dv3")).changes[0].digest, high.digest);
  });

  test("a removal outranks every edit", async () => {
    const t = await signIn("pilot@example.com");
    await push(t, "dv1", [change("p1", 9_000, { v: 1 })]);
    await push(t, "dv2", [change("p1", REMOVED, null)]);
    await push(t, "dv1", [change("p1", 9_001, { v: 2 })]);
    const [only] = (await pull(t, "dv3")).changes;
    assert.equal(only.version, REMOVED);
    assert.equal(only.change, null);
  });

  test("an updated entity is pulled again after the cursor", async () => {
    const t = await signIn("pilot@example.com");
    await push(t, "dv1", [change("p1", 1, { v: 1 })]);
    const first = await pull(t, "dv2");
    await push(t, "dv1", [change("p1", 2, { v: 2 })]);
    const second = await pull(t, "dv2", first.cursor);
    assert.deepEqual(second.changes.map((c: { change: unknown }) => c.change), [{ v: 2 }]);
    assert.deepEqual((await pull(t, "dv2", second.cursor)).changes, []);
  });

  test("pages of 200 say there is more", async () => {
    const t = await signIn("pilot@example.com");
    const many = Array.from({ length: 250 }, (_, i) => change(`p${i}`, 1, { i }));
    await push(t, "dv1", many);
    const first = await pull(t, "dv2");
    assert.equal(first.changes.length, 200);
    assert.equal(first.more, true);
    const second = await pull(t, "dv2", first.cursor);
    assert.equal(second.changes.length, 50);
    assert.equal(second.more, false);
  });

  test("accounts never see each other's changes", async () => {
    const a = await signIn("a@example.com");
    const b = await signIn("b@example.com");
    await push(a, "dv1", [change("p1", 1, { secret: true })]);
    assert.deepEqual((await pull(b, "dv2")).changes, []);
  });

  test("bad input is refused and nothing is kept", async () => {
    const t = await signIn("pilot@example.com");
    assert.equal((await push(t, "bad device!", [])).status, 400);
    assert.equal((await push(t, "dv1", [{ ...change("p1", 1, {}), entity: "nope" }])).status, 400);
    assert.equal((await push(t, "dv1", [{ ...change("p1", 1, {}), digest: "xyz" }])).status, 400);
    assert.equal((await call("POST", "/v1/sync/push", { deviceId: "dv1", changes: [] })).status, 401);
    assert.deepEqual((await pull(t, "dv2")).changes, []);
  });
});

describe("plugin bundles", () => {
  const put = (token: string, digest: string, bytes: Uint8Array) =>
    app.request(`/v1/plugins/bundles/${digest}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body: bytes as Uint8Array<ArrayBuffer>,
    });

  test("upload, then download the same bytes; only the owner can", async () => {
    const t = await signIn("pilot@example.com");
    const other = await signIn("other@example.com");
    const bytes = new TextEncoder().encode("a plugin bundle");
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal((await put(t, digest, bytes)).status, 200);
    const got = await call("GET", `/v1/plugins/bundles/${digest}`, undefined, t);
    assert.equal(got.status, 200);
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);
    assert.equal((await call("GET", `/v1/plugins/bundles/${digest}`, undefined, other)).status, 404);
  });

  test("bytes that do not match their digest are refused", async () => {
    const t = await signIn("pilot@example.com");
    const res = await put(t, hex("something else"), new TextEncoder().encode("a plugin bundle"));
    assert.equal(res.status, 400);
  });

  test("a bundle over the limit is 413, which Core skips", async () => {
    const t = await signIn("pilot@example.com");
    const big = new Uint8Array(MAX_BUNDLE_BYTES + 1);
    const res = await put(t, createHash("sha256").update(big).digest("hex"), big);
    assert.equal(res.status, 413);
  });
});

describe("routing", () => {
  test("unknown public paths are 404, not 401", async () => {
    assert.equal((await call("GET", "/v1/places/search")).status, 404);
  });
});
