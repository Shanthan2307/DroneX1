import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { MemoryMailer } from "../src/mailer.ts";
import type { PlaceSearch } from "../src/routes/places.ts";

let asked: URL[];
let answers: unknown[];
let app: ReturnType<typeof createApp>;

const fakeEsri = (async (url: URL) => {
  asked.push(new URL(url));
  return Response.json(answers.shift());
}) as unknown as typeof fetch;

function make(places: PlaceSearch = {}) {
  asked = [];
  answers = [];
  app = createApp({
    db: openDb(":memory:"),
    mailer: new MemoryMailer(),
    secret: "s".repeat(40),
    places: { arcgisKey: "arc-key", fetch: fakeEsri, ...places },
  });
}
beforeEach(() => make());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`/v1/places/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("suggest returns single places as Core reads them, with Esri's attribution", async () => {
  answers.push({
    suggestions: [
      { text: "Ferry Building, San Francisco, CA, USA", magicKey: "k1", isCollection: false },
      { text: "Coffee near San Francisco", magicKey: "k2", isCollection: true },
    ],
  });
  const res = await post("suggest", { q: "ferry building", limit: 5, near: { latitudeDeg: 37.79, longitudeDeg: -122.4 } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    suggestions: [{ name: "Ferry Building", detail: "San Francisco, CA, USA", key: "k1", text: "Ferry Building, San Francisco, CA, USA" }],
    attribution: "Powered by Esri",
  });
  assert.equal(asked[0].pathname.endsWith("/suggest"), true);
  assert.equal(asked[0].searchParams.get("token"), "arc-key");
  assert.equal(asked[0].searchParams.get("location"), "-122.4,37.79");
  assert.equal(asked[0].searchParams.get("maxSuggestions"), "5");
});

test("locate turns a suggestion into coordinates", async () => {
  answers.push({
    candidates: [{
      address: "Ferry Building",
      location: { x: -122.39356, y: 37.79543 },
      attributes: { PlaceName: "Ferry Building", Place_addr: "San Francisco, California" },
    }],
  });
  const res = await post("locate", { key: "k1", text: "Ferry Building, San Francisco, CA, USA" });
  assert.deepEqual(await res.json(), {
    place: { name: "Ferry Building", detail: "San Francisco, California", latitudeDeg: 37.79543, longitudeDeg: -122.39356 },
    attribution: "Powered by Esri",
  });
  assert.equal(asked[0].searchParams.get("magicKey"), "k1");
  assert.equal(asked[0].searchParams.get("forStorage"), "false");
});

test("locate asks for storable results when the server says so", async () => {
  make({ forStorage: true });
  answers.push({ candidates: [{ address: "X", location: { x: 1, y: 2 }, attributes: {} }] });
  await post("locate", { key: "k", text: "X" });
  assert.equal(asked[0].searchParams.get("forStorage"), "true");
});

test("locate with no match is 404", async () => {
  answers.push({ candidates: [] });
  assert.equal((await post("locate", { key: "k", text: "Nowhere" })).status, 404);
});

test("reverse names a point", async () => {
  answers.push({ address: { ShortLabel: "Ferry Building", LongLabel: "Ferry Building, San Francisco, CA, USA" } });
  const res = await post("reverse", { latitudeDeg: 37.7955, longitudeDeg: -122.3937 });
  const body = await res.json();
  assert.equal(body.place.name, "Ferry Building");
  assert.equal(body.place.detail, "San Francisco, CA, USA");
  assert.equal(asked[0].searchParams.get("location"), "-122.3937,37.7955");
});

test("bad input is refused before Esri is asked", async () => {
  assert.equal((await post("suggest", { q: "a" })).status, 400);
  assert.equal((await post("suggest", { q: "paris", limit: 50 })).status, 400);
  assert.equal((await post("suggest", { q: "paris", near: { latitudeDeg: 99, longitudeDeg: 0 } })).status, 400);
  assert.equal((await post("reverse", { latitudeDeg: 0 })).status, 400);
  assert.equal(asked.length, 0);
});

test("Esri's errors become 502, which the app explains", async () => {
  answers.push({ error: { code: 498, message: "Invalid token" } });
  assert.equal((await post("suggest", { q: "paris" })).status, 502);
});

test("without a key place search is 503", async () => {
  make({ arcgisKey: undefined });
  assert.equal((await post("suggest", { q: "paris" })).status, 503);
});

test("each address is limited per minute", async () => {
  let clock = 0;
  make({ perMinute: 2, now: () => clock });
  answers.push({ suggestions: [] }, { suggestions: [] }, { suggestions: [] });
  assert.equal((await post("suggest", { q: "paris" })).status, 200);
  assert.equal((await post("suggest", { q: "paris" })).status, 200);
  assert.equal((await post("suggest", { q: "paris" })).status, 429);
  clock += 61_000;
  assert.equal((await post("suggest", { q: "paris" })).status, 200);
});

test("loopback pages may call place search; other sites may not", async () => {
  answers.push({ suggestions: [] }, { suggestions: [] });
  const ours = await post("suggest", { q: "paris" }, { origin: "http://localhost:45010" });
  assert.equal(ours.headers.get("access-control-allow-origin"), "http://localhost:45010");
  const theirs = await post("suggest", { q: "paris" }, { origin: "https://evil.example" });
  assert.equal(theirs.headers.get("access-control-allow-origin"), null);
});
