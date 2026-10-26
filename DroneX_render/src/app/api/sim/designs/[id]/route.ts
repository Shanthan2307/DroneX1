// GET /api/sim/designs/<id>: a design sent to the simulator, with its simulation profile, so the configurator can
// reopen it (?sim=<id>) from the simulation UI's "Open in DroneX" bookmark.
import { connection } from "next/server";
import { limitRequest } from "@/lib/rateLimit";
import { readFlight } from "@/lib/sim/store";
import { requireSimulator } from "@/lib/mode";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const off = requireSimulator();
  if (off) return off;
  const limited = limitRequest(request, "dataset");
  if (limited) return limited;
  const { id } = await params;
  const flight = await readFlight(id);
  if (!flight) return Response.json({ error: "no such design" }, { status: 404 });
  return Response.json(flight, { headers: { "Cache-Control": "no-cache" } });
}
