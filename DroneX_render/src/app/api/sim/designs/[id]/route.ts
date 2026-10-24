// GET /api/sim/designs/<id>: a design sent to the simulator, with its simulation profile, so the configurator can
// reopen it (?sim=<id>) from the simulation UI's "Open in DroneX" bookmark.
import { connection } from "next/server";
import { readFlight } from "@/lib/sim/store";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const flight = await readFlight(id);
  if (!flight) return Response.json({ error: "no such design" }, { status: 404, headers: CORS });
  return Response.json(flight, { headers: { ...CORS, "Cache-Control": "no-cache" } });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
