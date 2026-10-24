import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { MemoryMailer } from "../src/mailer.ts";

const app = (mapKeys = {}) =>
  createApp({ db: openDb(":memory:"), mailer: new MemoryMailer(), secret: "s".repeat(40), mapKeys });

test("each key is served as {key}, without signing in", async () => {
  const a = app({ arcgis: "arc-key", google: "goo-key" });
  assert.deepEqual(await (await a.request("/v1/maps/key")).json(), { key: "arc-key" });
  assert.deepEqual(await (await a.request("/v1/maps/google-key")).json(), { key: "goo-key" });
});

test("a key that is not set is 503", async () => {
  const res = await app().request("/v1/maps/google-key");
  assert.equal(res.status, 503);
  assert.match((await res.json()).message, /Google/);
});

test("loopback pages may read the keys; other sites may not", async () => {
  const a = app({ arcgis: "arc-key" });
  const ours = await a.request("/v1/maps/key", { headers: { origin: "http://127.0.0.1:45010" } });
  assert.equal(ours.headers.get("access-control-allow-origin"), "http://127.0.0.1:45010");
  const theirs = await a.request("/v1/maps/key", { headers: { origin: "https://evil.example" } });
  assert.equal(theirs.headers.get("access-control-allow-origin"), null);
});
