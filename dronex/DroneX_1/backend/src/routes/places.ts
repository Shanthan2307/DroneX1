// Place search for the interface and Core (core/crates/uxduck/src/places.rs,
// uxduck-engine/src/places.rs): towns, landmarks and addresses through Esri's
// World Geocoding Service with this server's ArcGIS key. The page and Core
// call these without a session, so they are open to loopback pages like the
// map keys, and limited per address so nobody spends the key's credits fast.
//
//   POST /v1/places/suggest {q, limit?, near?}       -> {suggestions, attribution}
//   POST /v1/places/locate  {key, text, near?}       -> {place, attribution}
//   POST /v1/places/reverse {latitudeDeg, longitudeDeg} -> {place, attribution}

import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { type Env, refuse } from "../session.ts";

export interface PlaceSearch {
  arcgisKey?: string;
  /**
   * Ask Esri for results that may be stored. Saving a place keeps its
   * coordinates, which Esri's terms only allow for stored geocodes; the key
   * then needs the stored-geocoding privilege (billed differently).
   */
  forStorage?: boolean;
  /** Lookups one address may make a minute. */
  perMinute?: number;
  now?: () => number;
  /** Only for tests. */
  fetch?: typeof fetch;
  base?: string;
}

const ATTRIBUTION = "Powered by Esri";
const GEOCODER = "https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer";
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

interface Near { latitudeDeg: number; longitudeDeg: number }

const isLatLon = (lat: unknown, lon: unknown): boolean =>
  typeof lat === "number" && typeof lon === "number" &&
  Number.isFinite(lat) && Number.isFinite(lon) &&
  Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

function near(value: unknown): Near | undefined | null {
  if (value === undefined || value === null) return undefined;
  const n = value as Record<string, unknown>;
  return isLatLon(n.latitudeDeg, n.longitudeDeg) ? (n as unknown as Near) : null;
}

const text = (value: unknown, min: number, max: number): string | null => {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length >= min && t.length <= max ? t : null;
};

/** "Ferry Building, San Francisco, CA, USA" -> name and the rest. */
function split(label: string): { name: string; detail: string } {
  const at = label.indexOf(", ");
  return at < 0 ? { name: label, detail: "" } : { name: label.slice(0, at), detail: label.slice(at + 2) };
}

class Unavailable extends Error {}

export function placeRoutes(options: PlaceSearch): Hono<Env> {
  const p = new Hono<Env>();
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const perMinute = options.perMinute ?? 60;
  const base = options.base ?? GEOCODER;
  const recent = new Map<string, number[]>();

  p.use("/places/*", cors({ origin: (o) => (LOOPBACK.test(o) ? o : null), allowMethods: ["POST"] }));

  const guard: MiddlewareHandler<Env> = async (c, next) => {
    if (!options.arcgisKey) return c.json(refuse("Place search isn't set up on this server."), 503);
    const who = c.req.header("x-forwarded-for") ?? (c.env as any)?.incoming?.socket?.remoteAddress ?? "local";
    const t = now();
    const times = (recent.get(who) ?? []).filter((x) => t - x < 60_000);
    if (times.length >= perMinute) return c.json(refuse("Too many place searches. Try again in a minute."), 429);
    times.push(t);
    recent.set(who, times);
    await next();
  };

  async function esri(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries({ ...params, f: "json", token: options.arcgisKey! })) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await send(url, { signal: AbortSignal.timeout(8000) });
    } catch {
      throw new Unavailable();
    }
    const body = await res.json().catch(() => null);
    // Esri answers most failures with 200 and an error object.
    if (!res.ok || !body || body.error) throw new Unavailable();
    return body;
  }

  const unavailable = (c: any) => c.json(refuse("Place search isn't working right now. Try again, or enter coordinates."), 502);

  p.post("/places/suggest", guard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const q = text(body.q, 2, 200);
    const limit = body.limit === undefined ? 5 : body.limit;
    const hint = near(body.near);
    if (!q || !Number.isInteger(limit) || limit < 1 || limit > 10 || hint === null) {
      return c.json(refuse("Send q (2 to 200 characters), an optional limit up to 10 and an optional near point."), 400);
    }
    try {
      const params: Record<string, string> = { text: q, maxSuggestions: String(limit) };
      if (hint) params.location = `${hint.longitudeDeg},${hint.latitudeDeg}`;
      const found = await esri("suggest", params);
      // A collection ("coffee near me") locates to many places; keep single ones.
      const suggestions = (found.suggestions ?? [])
        .filter((s: any) => !s.isCollection && typeof s.text === "string" && typeof s.magicKey === "string")
        .slice(0, limit)
        .map((s: any) => ({ ...split(s.text), key: s.magicKey, text: s.text }));
      return c.json({ suggestions, attribution: ATTRIBUTION });
    } catch (e) {
      if (e instanceof Unavailable) return unavailable(c);
      throw e;
    }
  });

  p.post("/places/locate", guard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const key = text(body.key, 1, 1000);
    const label = text(body.text, 1, 300);
    const hint = near(body.near);
    if (!key || !label || hint === null) return c.json(refuse("Send the suggestion's key and text."), 400);
    try {
      const params: Record<string, string> = {
        SingleLine: label,
        magicKey: key,
        maxLocations: "1",
        outFields: "PlaceName,Place_addr",
        forStorage: options.forStorage ? "true" : "false",
      };
      if (hint) params.location = `${hint.longitudeDeg},${hint.latitudeDeg}`;
      const found = await esri("findAddressCandidates", params);
      const best = found.candidates?.[0];
      if (!best || !isLatLon(best.location?.y, best.location?.x)) {
        return c.json(refuse("That place couldn't be found. Try another search."), 404);
      }
      const fallback = split(label);
      return c.json({
        place: {
          name: (best.attributes?.PlaceName || best.address || fallback.name).slice(0, 300),
          detail: (best.attributes?.Place_addr || fallback.detail).slice(0, 1000),
          latitudeDeg: best.location.y,
          longitudeDeg: best.location.x,
        },
        attribution: ATTRIBUTION,
      });
    } catch (e) {
      if (e instanceof Unavailable) return unavailable(c);
      throw e;
    }
  });

  p.post("/places/reverse", guard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!isLatLon(body.latitudeDeg, body.longitudeDeg)) {
      return c.json(refuse("Send latitudeDeg within ±90 and longitudeDeg within ±180."), 400);
    }
    try {
      const found = await esri("reverseGeocode", {
        location: `${body.longitudeDeg},${body.latitudeDeg}`,
        langCode: "en",
        forStorage: options.forStorage ? "true" : "false",
      });
      const a = found.address ?? {};
      const name = String(a.ShortLabel || a.Match_addr || "").trim();
      if (!name) return c.json(refuse("Nothing is named there."), 404);
      const long = String(a.LongLabel || "");
      return c.json({
        place: {
          name: name.slice(0, 300),
          detail: (long.startsWith(`${name}, `) ? long.slice(name.length + 2) : long).slice(0, 1000),
          latitudeDeg: body.latitudeDeg,
          longitudeDeg: body.longitudeDeg,
        },
        attribution: ATTRIBUTION,
      });
    } catch (e) {
      if (e instanceof Unavailable) return unavailable(c);
      throw e;
    }
  });

  return p;
}
