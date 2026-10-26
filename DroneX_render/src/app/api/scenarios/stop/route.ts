// POST /api/scenarios/stop: stop the simulated drones the scenarios started (nobody else's).
import { connection } from "next/server";
import { limitRequest } from "@/lib/rateLimit";
import { stopScenarioDrones } from "@/lib/scenarios/run";
import { requireSimulator } from "@/lib/mode";

export async function POST(request: Request) {
  await connection();
  const off = requireSimulator();
  if (off) return off;
  const limited = limitRequest(request, "airspaceWrite");
  if (limited) return limited;
  try {
    return Response.json({ stopped: await stopScenarioDrones() });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
