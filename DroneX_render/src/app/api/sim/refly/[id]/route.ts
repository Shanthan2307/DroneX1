// POST /api/sim/refly/<id>: start a design that was already sent to the simulator once (its model, design and
// profile are in the store) as a new simulated vehicle, without a browser to export the model. The Dispatch flight
// agent uses this: the hangar drones are packed once from the configurator, then flown on request from ASI:One.
import { connection } from "next/server";
import { flyDesign, modelBookmarkUrl, type SimProfile } from "@/lib/sim/fly";
import { readFlight } from "@/lib/sim/store";
import { configuratorOrigin } from "@/lib/publicUrls";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const flight = await readFlight(id);
  if (!flight) return Response.json({ error: "no such design" }, { status: 404, headers: CORS });
  const profile = flight.profile as SimProfile;
  const origin = configuratorOrigin(request);
  try {
    const flown = await flyDesign(id, profile, { modelUrl: modelBookmarkUrl(origin, id, profile), openUrl: `${origin}/?sim=${id}` });
    const design = flight.design as { name?: string };
    return Response.json({ id, name: design.name ?? profile.name, ...flown }, { headers: CORS });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dronex sim] refly", id, message);
    return Response.json({ error: message }, { status: 502, headers: CORS });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
