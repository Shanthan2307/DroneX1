import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { buildingsFrom, heightOf, metres, tileBounds } from "../src/routes/buildings.ts";

let asked: string[];
let answers: (unknown | Error)[];
let clock: number;
let app: ReturnType<typeof createApp>;

const fakeOverpass = (async (_url: string, init: RequestInit) => {
  asked.push(new URLSearchParams(String(init.body)).get("data")!);
  const next = answers.shift();
  if (next instanceof Error) return new Response("busy", { status: 429 });
  return Response.json(next);
}) as unknown as typeof fetch;

beforeEach(() => {
  asked = [];
  answers = [];
  clock = 1_000_000;
  app = createApp({
    db: openDb(":memory:"),
    mailer: new MemoryMailer(),
    secret: "s".repeat(40),
    now: () => clock,
    buildings: { fetch: fakeOverpass },
  });
});

const post = (body: unknown) =>
  app.request("/v1/buildings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const square = (lat: number, lon: number, d = 0.0002) => [
  { lat, lon }, { lat, lon: lon + d }, { lat: lat + d, lon: lon + d }, { lat: lat + d, lon }, { lat, lon },
];

test("heights come from height, then floors, then a cautious guess", () => {
  assert.equal(metres("45"), 45);
  assert.equal(metres("45.5 m"), 45.5);
  assert.equal(Math.round(metres("100 ft")! * 10) / 10, 30.5);
  assert.equal(metres("tall"), undefined);
  assert.equal(metres("5000"), undefined);
  assert.equal(heightOf({ height: "120", "building:levels": "3" }), 120);
  assert.equal(heightOf({ "building:levels": "10" }), 33);
  assert.equal(Math.round(heightOf({ "building:levels": "2", "roof:levels": "1" }) * 10) / 10, 10.6);
  assert.equal(heightOf({ building: "yes" }), 10);
});

test("ways and relations' outer rings become buildings; building=no is skipped", () => {
  const found = buildingsFrom([
    { type: "way", id: 1, tags: { building: "yes", height: "30" }, geometry: square(37.79, -122.4) },
    { type: "way", id: 2, tags: { building: "no" }, geometry: square(37.79, -122.4) },
    { type: "way", id: 3, tags: { building: "yes" }, geometry: [{ lat: 1, lon: 1 }] },
    {
      type: "relation", id: 9, tags: { building: "office", "building:levels": "5" },
      members: [
        { type: "way", role: "outer", geometry: square(37.8, -122.41) },
        { type: "way", role: "inner", geometry: square(37.8, -122.41, 0.0001) },
      ],
    },
  ]);
  assert.deepEqual(found.map((b) => [b.id, b.heightM, b.ring.length]), [["w1", 30, 10], ["r9.0", 17, 10]]);
  assert.deepEqual(found[0].ring.slice(0, 4), [37.79, -122.4, 37.79, -122.3998]);
});

test("a tile is fetched from Overpass once, then served from the database", async () => {
  answers.push({ elements: [{ type: "way", id: 1, tags: { building: "yes", height: "50" }, geometry: square(37.79, -122.4) }] });
  const first = await post({ x: 5242, y: 12664 });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.deepEqual(body.tile, { z: 15, x: 5242, y: 12664 });
  assert.equal(body.buildings.length, 1);
  assert.equal(body.buildings[0].heightM, 50);
  assert.equal(body.attribution, "© OpenStreetMap contributors");
  const { south, west, north, east } = tileBounds(5242, 12664);
  assert.ok(asked[0].includes(`way[building](${south},${west},${north},${east})`));

  const again = await post({ x: 5242, y: 12664 });
  assert.deepEqual((await again.json()).buildings, body.buildings);
  assert.equal(asked.length, 1);
});

test("an old tile is fetched again, and kept if Overpass fails", async () => {
  answers.push({ elements: [{ type: "way", id: 1, tags: { building: "yes" }, geometry: square(37.79, -122.4) }] });
  await post({ x: 1, y: 2 });
  clock += 31 * 24 * 3600 * 1000;
  answers.push(new Error("busy"));
  const res = await post({ x: 1, y: 2 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).buildings.length, 1);
  assert.equal(asked.length, 2);
});

test("a tile Overpass can't give and nobody kept is 503; bad tiles are 400", async () => {
  answers.push(new Error("busy"));
  assert.equal((await post({ x: 3, y: 4 })).status, 503);
  assert.equal((await post({ x: -1, y: 4 })).status, 400);
  assert.equal((await post({ x: 2 ** 15, y: 4 })).status, 400);
  assert.equal((await post({ x: 1.5, y: 4 })).status, 400);
});
