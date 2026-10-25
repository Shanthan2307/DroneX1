// POST /api/sim/stop/<vehicleId>: stop the simulator link of one Core vehicle. Agent-only (x-dronex-agent): the
// Dispatch flight agent's TTL ends its sessions' vehicles through this. Answers {ok: true} or {error}.
import { connection } from "next/server";
import { requireAgent } from "@/lib/agentAuth";
import { stopVehicle } from "@/lib/sim/sims";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const denied = requireAgent(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    if (!(await stopVehicle(id))) return Response.json({ error: "no such vehicle" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dronex sim] stop", id, message);
    return Response.json({ error: message }, { status: 502 });
  }
}
