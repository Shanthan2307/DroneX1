// POST /api/airspace/corridor: ask the shared airspace for a corridor (a segment, a width, an altitude band above
// home, for a while). The SpacetimeDB reducer grants it or refuses it atomically against every corridor held by
// another vehicle; the answer row (status, reason) is returned once it arrives in the subscription. A visitor may
// ask only for a vehicle in their ownership cookie; the agents (x-dronex-agent) for any.
import { connection } from "next/server";
import { mayActOn } from "@/lib/ownership";
import { limitRequest } from "@/lib/rateLimit";
import { requestCorridor } from "@/lib/airspace/actions";
import type { CorridorRequest } from "@/lib/airspace/types";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function POST(request: Request) {
  await connection();
  const limited = limitRequest(request, "airspaceWrite");
  if (limited) return limited;
  let body: Partial<CorridorRequest>;
  try {
    body = (await request.json()) as Partial<CorridorRequest>;
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }
  const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId : "";
  const from = body.from ?? { lat: NaN, lon: NaN };
  const to = body.to ?? { lat: NaN, lon: NaN };
  const minAlt = num(body.minAltM);
  const maxAlt = num(body.maxAltM);
  if (!vehicleId || num(from.lat) === null || num(from.lon) === null || num(to.lat) === null || num(to.lon) === null || minAlt === null || maxAlt === null) {
    return Response.json({ error: "vehicleId, from {lat, lon}, to {lat, lon}, minAltM and maxAltM are required" }, { status: 400 });
  }
  if (!mayActOn(request, vehicleId)) return Response.json({ error: "not your vehicle" }, { status: 403 });
  const requestId = typeof body.requestId === "string" && body.requestId ? body.requestId : undefined;
  try {
    const corridor = await requestCorridor({ requestId, vehicleId, from, to, minAltM: minAlt, maxAltM: maxAlt, widthM: num(body.widthM) ?? 40, ttlS: num(body.ttlS) ?? 600 });
    return Response.json({ corridor, granted: corridor.status === "granted" }, { status: corridor.status === "granted" ? 200 : 409 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 503 });
  }
}
