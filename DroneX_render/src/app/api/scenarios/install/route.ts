// POST /api/scenarios/install: put every track scenario's mission into the simulator's plan library (named
// "DroneX · <track> · …"), creating or updating by name, so they are on the simulator's Plans page. It writes to the
// engine's library, so it is operator work: agent-only (x-dronex-agent) when deployed, open on the laptop.
import { connection } from "next/server";
import { requireAgent } from "@/lib/agentAuth";
import { installPlans } from "@/lib/scenarios/run";

export async function POST(request: Request) {
  await connection();
  const denied = requireAgent(request);
  if (denied) return denied;
  try {
    return Response.json({ plans: await installPlans() });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
