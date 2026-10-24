// The /v1 API Core calls. `createApp` takes everything it depends on, so tests
// run it in memory with a fake clock and mailer.

import { Hono } from "hono";
import type { Db } from "./db.ts";
import type { Mailer } from "./mailer.ts";
import { type Ctx, type Env, refuse } from "./session.ts";
import { authRoutes } from "./routes/auth.ts";
import { meRoutes } from "./routes/me.ts";
import { syncRoutes } from "./routes/sync.ts";
import { type MapKeys, mapRoutes } from "./routes/maps.ts";
import { type Storage, storageRoutes } from "./routes/storage.ts";
import { type ModelKeys, modelRoutes } from "./routes/model.ts";
import { type PlaceSearch, placeRoutes } from "./routes/places.ts";
import { type BuildingSource, buildingRoutes } from "./routes/buildings.ts";

export interface Deps {
  db: Db;
  mailer: Mailer;
  /** Signs the short sessions for the hosted model. */
  secret: string;
  now?: () => number;
  mapKeys?: MapKeys;
  /** Where flights and recordings are kept; without it those routes are 503. */
  storage?: Storage;
  /** Vendor keys for the hosted model; without one its route refuses. */
  model?: ModelKeys;
  /** Esri place search; without a key its routes are 503. */
  places?: PlaceSearch;
  /** OpenStreetMap buildings for Core's collision guard and routing. */
  buildings?: BuildingSource;
}

export function createApp(deps: Deps): Hono<Env> {
  const ctx: Ctx = { ...deps, now: deps.now ?? Date.now };
  const app = new Hono<Env>();

  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/v1/auth", authRoutes(ctx));
  app.route("/v1", mapRoutes(deps.mapKeys ?? {}));
  app.route("/v1", placeRoutes({ now: deps.now, ...deps.places }));
  app.route("/v1", buildingRoutes(deps.db, { now: deps.now, ...deps.buildings }));
  app.route("/v1", syncRoutes(ctx));
  if (deps.storage) app.route("/v1", storageRoutes(ctx, deps.storage));
  app.route("/v1", modelRoutes(ctx, deps.model ?? {}));
  app.route("/v1", meRoutes(ctx));

  app.notFound((c) => c.json(refuse("Not found."), 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json(refuse("The server failed. Try again."), 500);
  });
  return app;
}
