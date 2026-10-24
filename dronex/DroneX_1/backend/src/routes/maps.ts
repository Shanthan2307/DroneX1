// Map keys for the interface: the ArcGIS key for the 2D basemap and the
// Google Maps Platform key for Photorealistic 3D Tiles. The page asks for
// them itself, without credentials, so these are public and allow any
// loopback page. Keep each key restricted at its provider (referrers, APIs).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { type Env, refuse } from "../session.ts";

export interface MapKeys {
  arcgis?: string;
  google?: string;
}

/** Pages Core serves: http://127.0.0.1:<port>, localhost, [::1]. */
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export function mapRoutes(keys: MapKeys): Hono<Env> {
  const maps = new Hono<Env>();
  maps.use(
    "/maps/*",
    cors({ origin: (origin) => (LOOPBACK.test(origin) ? origin : null), allowMethods: ["GET"] }),
  );

  const serve = (key: string | undefined, what: string) => () =>
    key
      ? Response.json({ key }, { headers: { "cache-control": "no-store" } })
      : Response.json(refuse(`No ${what} key is set on this server.`), { status: 503 });

  maps.get("/maps/key", serve(keys.arcgis, "ArcGIS"));
  maps.get("/maps/google-key", serve(keys.google, "Google Maps"));
  return maps;
}
