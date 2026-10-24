// Starts the account server. Core's debug builds call http://localhost:45103
// by default; release builds take UXDUCK_API_URL.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { consoleMailer } from "./mailer.ts";

const port = Number(process.env.PORT ?? 45103);
const dbPath = process.env.DATABASE_PATH ?? "data/backend.db";
const secret = process.env.SESSION_SECRET;
if (!secret || secret.length < 32) {
  console.error("Set SESSION_SECRET to at least 32 random characters (see .env.example).");
  process.exit(1);
}

mkdirSync(dirname(dbPath), { recursive: true });
const app = createApp({
  db: openDb(dbPath),
  mailer: consoleMailer,
  secret,
  mapKeys: { arcgis: process.env.ARCGIS_KEY, google: process.env.GOOGLE_MAPS_KEY },
  places: {
    arcgisKey: process.env.ARCGIS_KEY,
    forStorage: process.env.ARCGIS_GEOCODE_FOR_STORAGE === "true",
    perMinute: Number(process.env.PLACE_SEARCHES_PER_MINUTE ?? 60),
  },
  buildings: {
    overpass: process.env.OVERPASS_URL,
  },
  model: {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    dailyTokens: Number(process.env.MODEL_DAILY_TOKENS ?? 0),
  },
  storage: {
    dir: process.env.STORAGE_DIR ?? join(dirname(dbPath), "blobs"),
    publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    quotaBytes: Number(process.env.STORAGE_QUOTA_GB ?? 10) * 1024 ** 3,
  },
});

serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" }, (info) => {
  console.log(`backend listening on http://${info.address}:${info.port}`);
});
