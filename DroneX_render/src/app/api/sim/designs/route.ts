// GET /api/sim/designs: every design in the store (sent to the simulator at least once), newest first, with its
// profile. The Dispatch flight agent picks the stored design that matches the hangar drone it was asked to fly.
// Agent-only (x-dronex-agent).
import { connection } from "next/server";
import { requireAgent } from "@/lib/agentAuth";
import { listFlights } from "@/lib/sim/store";
import { requireSimulator } from "@/lib/mode";

export async function GET(request: Request) {
  await connection();
  const off = requireSimulator();
  if (off) return off;
  const denied = requireAgent(request);
  if (denied) return denied;
  return Response.json({ designs: await listFlights() }, { headers: { "Cache-Control": "no-cache" } });
}
