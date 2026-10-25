// POST /api/airspace/corridor: ask the shared airspace for a corridor (a segment, a width, an altitude band above
// home, for a while). The SpacetimeDB reducer grants it or refuses it atomically against every corridor held by
// another vehicle; the answer row (status, reason) is returned once it arrives in the subscription.
import { connection } from "next/server";
import { randomUUID } from "node:crypto";
import { toCorridor, waitFor, withAirspace } from "@/lib/airspace/client";
import type { CorridorRequest } from "@/lib/airspace/types";
import { CORS } from "../route";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function POST(request: Request) {
  await connection();
  let body: Partial<CorridorRequest>;
  try {
    body = (await request.json()) as Partial<CorridorRequest>;
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400, headers: CORS });
  }
  const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId : "";
  const from = body.from ?? { lat: NaN, lon: NaN };
  const to = body.to ?? { lat: NaN, lon: NaN };
  const minAlt = num(body.minAltM);
  const maxAlt = num(body.maxAltM);
  if (!vehicleId || num(from.lat) === null || num(from.lon) === null || num(to.lat) === null || num(to.lon) === null || minAlt === null || maxAlt === null) {
    return Response.json({ error: "vehicleId, from {lat, lon}, to {lat, lon}, minAltM and maxAltM are required" }, { status: 400, headers: CORS });
  }
  const requestId = typeof body.requestId === "string" && body.requestId ? body.requestId : randomUUID();
  const widthM = num(body.widthM) ?? 40;
  const ttlS = Math.round(num(body.ttlS) ?? 600);
  try {
    const corridor = await withAirspace(async (air) => {
      await air.conn.reducers.requestCorridor({
        requestId,
        vehicleId,
        fromLat: from.lat,
        fromLon: from.lon,
        toLat: to.lat,
        toLon: to.lon,
        minAlt,
        maxAlt,
        widthM,
        ttlS: BigInt(ttlS),
      });
      const row = await waitFor(
        () => [...air.conn.db.corridor.iter()].find((c) => c.requestId === requestId),
        () => true,
      );
      return toCorridor(row);
    });
    return Response.json({ corridor, granted: corridor.status === "granted" }, { status: corridor.status === "granted" ? 200 : 409, headers: CORS });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 503, headers: CORS });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
