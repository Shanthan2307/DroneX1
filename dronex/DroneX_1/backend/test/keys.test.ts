import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { browserMapKeys, geocodeKey } from "../src/keys.ts";
import { MemoryMailer } from "../src/mailer.ts";

test("geocoding takes ARCGIS_GEOCODE_KEY, else ARCGIS_KEY", () => {
  assert.equal(geocodeKey({ ARCGIS_KEY: "browser", ARCGIS_GEOCODE_KEY: "server" }), "server");
  assert.equal(geocodeKey({ ARCGIS_KEY: "browser" }), "browser");
  assert.equal(geocodeKey({ ARCGIS_KEY: "browser", ARCGIS_GEOCODE_KEY: "  " }), "browser");
  assert.equal(geocodeKey({}), undefined);
});

test("the browser never gets the geocoding key", () => {
  assert.deepEqual(browserMapKeys({ ARCGIS_KEY: "browser", ARCGIS_GEOCODE_KEY: "server", GOOGLE_MAPS_KEY: "goo" }), {
    arcgis: "browser",
    google: "goo",
  });
});

test("place search sends the geocoding key while /v1/maps/key serves the browser key", async () => {
  const env = { ARCGIS_KEY: "browser", ARCGIS_GEOCODE_KEY: "server" };
  const asked: URL[] = [];
  const fakeEsri = (async (url: URL) => {
    asked.push(new URL(url));
    return Response.json({ suggestions: [] });
  }) as unknown as typeof fetch;
  const app = createApp({
    db: openDb(":memory:"),
    mailer: new MemoryMailer(),
    secret: "s".repeat(40),
    mapKeys: browserMapKeys(env),
    places: { arcgisKey: geocodeKey(env), fetch: fakeEsri },
  });

  assert.deepEqual(await (await app.request("/v1/maps/key")).json(), { key: "browser" });
  const res = await app.request("/v1/places/suggest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: "ferry building" }),
  });
  assert.equal(res.status, 200);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].searchParams.get("token"), "server");
});
