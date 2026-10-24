// Building outlines and heights for Core (uxduck-engine/src/buildings.rs),
// so simulated vehicles treat the buildings drawn on the 3D map as solid and
// route around or over them. They come from OpenStreetMap through the
// Overpass API, one web-map tile (zoom 15, about a kilometre) at a time, and
// are kept in the database for a month: Overpass is shared and slow.
//
//   POST /v1/buildings {x, y}   -> {tile, buildings, attribution}
//
// Each building is {id, heightM, ring}: its height above the ground and its
// outline as [lat, lon, lat, lon, ...]. Heights come from OSM's `height`
// tag, else its floors, else a cautious guess.

import { Hono } from "hono";
import type { Db } from "../db.ts";
import { type Env, refuse } from "../session.ts";

export interface BuildingSource {
  /** Overpass interpreter URL. */
  overpass?: string;
  /** How long a tile is kept before it is fetched again. */
  keepMs?: number;
  /** Tiles one address may ask for a minute. */
  perMinute?: number;
  now?: () => number;
  /** Only for tests. */
  fetch?: typeof fetch;
}

export const ZOOM = 15;
const OVERPASS = "https://overpass-api.de/api/interpreter";
const ATTRIBUTION = "© OpenStreetMap contributors";
const KEEP_MS = 30 * 24 * 3600 * 1000;
/** Metres per floor, and the height of a building OSM says nothing about. */
const FLOOR_M = 3.2;
const UNKNOWN_M = 10;
/** Taller than any building: a height past this is a typo. */
const TALLEST_M = 900;

export interface Building {
  id: string;
  heightM: number;
  ring: number[];
}

/** A web-map tile's edges in degrees. */
export function tileBounds(x: number, y: number, z = ZOOM) {
  const n = 2 ** z;
  const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return { south: lat(y + 1), west: (x / n) * 360 - 180, north: lat(y), east: ((x + 1) / n) * 360 - 180 };
}

/** "45", "45 m", "45.5m", "150'", "120 ft" -> metres. */
export function metres(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = value.trim().replace(",", ".").match(/^(\d+(?:\.\d+)?)\s*(m|ft|'|feet)?$/i);
  if (!m) return undefined;
  const v = Number(m[1]) * (m[2] && m[2].toLowerCase() !== "m" ? 0.3048 : 1);
  return v > 0 && v <= TALLEST_M ? v : undefined;
}

export function heightOf(tags: Record<string, string>): number {
  const tall = metres(tags.height);
  if (tall !== undefined) return tall;
  const floors = Number(tags["building:levels"]);
  if (Number.isFinite(floors) && floors > 0 && floors < 300) {
    const roof = Number(tags["roof:levels"]);
    return (floors + (Number.isFinite(roof) && roof > 0 ? roof : 0)) * FLOOR_M + 1;
  }
  return UNKNOWN_M;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Overpass `out geom` elements -> buildings. Relations give their outer rings. */
export function buildingsFrom(elements: any[]): Building[] {
  const found: Building[] = [];
  const ring = (geometry: any[] | undefined): number[] | null => {
    if (!Array.isArray(geometry) || geometry.length < 4) return null;
    const flat: number[] = [];
    for (const p of geometry) {
      if (typeof p?.lat !== "number" || typeof p?.lon !== "number") return null;
      flat.push(round(p.lat), round(p.lon));
    }
    return flat;
  };
  for (const e of elements) {
    const tags = e?.tags ?? {};
    if (tags.building === "no" || tags["building:part"] === "no") continue;
    const heightM = Math.round(heightOf(tags) * 10) / 10;
    if (e.type === "way") {
      const r = ring(e.geometry);
      if (r) found.push({ id: `w${e.id}`, heightM, ring: r });
    } else if (e.type === "relation") {
      (e.members ?? [])
        .filter((m: any) => m?.type === "way" && m.role === "outer")
        .forEach((m: any, i: number) => {
          const r = ring(m.geometry);
          if (r) found.push({ id: `r${e.id}.${i}`, heightM, ring: r });
        });
    }
  }
  return found;
}

class Unavailable extends Error {}

export function buildingRoutes(db: Db, options: BuildingSource = {}): Hono<Env> {
  const b = new Hono<Env>();
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const keepMs = options.keepMs ?? KEEP_MS;
  const perMinute = options.perMinute ?? 120;
  const overpass = options.overpass ?? OVERPASS;
  const recent = new Map<string, number[]>();
  // Overpass asks for one query at a time per client; the same tile asked
  // twice at once is fetched once.
  let queue: Promise<unknown> = Promise.resolve();
  const inFlight = new Map<string, Promise<Building[]>>();

  db.exec(`CREATE TABLE IF NOT EXISTS building_tiles (
    z INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY (z, x, y)
  )`);
  const read = db.prepare("SELECT fetched_at, body FROM building_tiles WHERE z = ? AND x = ? AND y = ?");
  const write = db.prepare(
    "INSERT INTO building_tiles (z, x, y, fetched_at, body) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT (z, x, y) DO UPDATE SET fetched_at = excluded.fetched_at, body = excluded.body",
  );

  async function fetchTile(x: number, y: number): Promise<Building[]> {
    const { south, west, north, east } = tileBounds(x, y);
    const box = `${south},${west},${north},${east}`;
    const query =
      `[out:json][timeout:60];(way[building](${box});way["building:part"](${box});` +
      `relation[building][type=multipolygon](${box}););out geom tags;`;
    let res: Response;
    try {
      res = await send(overpass, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "DroneX-backend/0.1" },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(90_000),
      });
    } catch {
      throw new Unavailable();
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(body?.elements)) throw new Unavailable();
    return buildingsFrom(body.elements);
  }

  function load(x: number, y: number): Promise<Building[]> {
    const key = `${x}/${y}`;
    const running = inFlight.get(key);
    if (running) return running;
    const next = queue.then(() => fetchTile(x, y));
    queue = next.catch(() => {});
    const tracked = next.finally(() => inFlight.delete(key));
    inFlight.set(key, tracked);
    return tracked;
  }

  b.post("/buildings", async (c) => {
    const who = c.req.header("x-forwarded-for") ?? (c.env as any)?.incoming?.socket?.remoteAddress ?? "local";
    const t = now();
    const times = (recent.get(who) ?? []).filter((v) => t - v < 60_000);
    if (times.length >= perMinute) return c.json(refuse("Too many building lookups. Try again in a minute."), 429);
    times.push(t);
    recent.set(who, times);

    const body = await c.req.json().catch(() => ({}));
    const n = 2 ** ZOOM;
    const { x, y } = body;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) {
      return c.json(refuse(`Send the tile's x and y at zoom ${ZOOM}.`), 400);
    }
    const tile = { z: ZOOM, x, y };
    const kept = read.get(ZOOM, x, y) as { fetched_at: number; body: string } | undefined;
    if (kept && t - kept.fetched_at < keepMs) {
      return c.json({ tile, buildings: JSON.parse(kept.body), attribution: ATTRIBUTION });
    }
    try {
      const buildings = await load(x, y);
      write.run(ZOOM, x, y, now(), JSON.stringify(buildings));
      return c.json({ tile, buildings, attribution: ATTRIBUTION });
    } catch (e) {
      if (!(e instanceof Unavailable)) throw e;
      // An old copy beats none.
      if (kept) return c.json({ tile, buildings: JSON.parse(kept.body), attribution: ATTRIBUTION });
      return c.json(refuse("Building data isn't available right now. Try again soon."), 503);
    }
  });

  return b;
}
