// POST /api/scenarios/install: put every track scenario's mission into the simulator's plan library (named
// "DroneX · <track> · …"), creating or updating by name, so they are on the simulator's Plans page.
import { connection } from "next/server";
import { installPlans } from "@/lib/scenarios/run";

export async function POST() {
  await connection();
  try {
    return Response.json({ plans: await installPlans() });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
