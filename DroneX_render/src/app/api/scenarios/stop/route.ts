// POST /api/scenarios/stop: stop the simulated drones the scenarios started (nobody else's).
import { connection } from "next/server";
import { stopScenarioDrones } from "@/lib/scenarios/run";

export async function POST() {
  await connection();
  try {
    return Response.json({ stopped: await stopScenarioDrones() });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
