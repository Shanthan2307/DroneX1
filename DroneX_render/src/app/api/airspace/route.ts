// GET /api/airspace: a snapshot of the shared airspace (SpacetimeDB): every vehicle, its latest position, the
// corridors (granted, refused, released, expired), incidents and mission assignments. For the Dispatch agents and
// anything else that reads JSON rather than subscribing. Open CORS like the other routes.
import { connection } from "next/server";
import { withAirspace } from "@/lib/airspace/client";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET() {
  await connection();
  try {
    const snapshot = await withAirspace(async (air) => air.snapshot());
    return Response.json(snapshot, { headers: { ...CORS, "Cache-Control": "no-cache" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 503, headers: CORS });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
