// POST /api/sim/refly/<id>: start a design that was already sent to the simulator once (its model, design and
// profile are in the store) as a new simulated vehicle, without a browser to export the model. The Dispatch flight
// agent uses this: the hangar drones are packed once from the configurator, then flown on request from ASI:One.
import { connection } from "next/server";
import type { Place } from "@/lib/sim/fly";
import { reflyDesign } from "@/lib/sim/refly";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const origin = new URL(request.url).origin;
  // Optional body {place: {latitudeDeg, longitudeDeg, headingDeg}}: start there instead of the default spot.
  const body = (await request.json().catch(() => ({}))) as { place?: Place };
  try {
    const flown = await reflyDesign(id, origin, body.place ?? null);
    if (!flown) return Response.json({ error: "no such design" }, { status: 404, headers: CORS });
    return Response.json(flown, { headers: CORS });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dronex sim] refly", id, message);
    return Response.json({ error: message }, { status: 502, headers: CORS });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
