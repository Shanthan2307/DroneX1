// POST /api/sim/refly/<id>: start a design that was already sent to the simulator once (its model, design and
// profile are in the store) as a new simulated vehicle, without a browser to export the model. The Dispatch flight
// agent uses this: the hangar drones are packed once from the configurator, then flown on request from ASI:One.
// Agent-only (x-dronex-agent); goes through the same simulator cap as a Fly, within the agents' share.
import { connection } from "next/server";
import { requireAgent } from "@/lib/agentAuth";
import type { Place } from "@/lib/sim/fly";
import { reflyDesign } from "@/lib/sim/refly";
import { reserveSim, SIM_FULL } from "@/lib/sim/sims";
import { readFlight } from "@/lib/sim/store";
import { configuratorOrigin } from "@/lib/publicUrls";
import { clientIp } from "@/lib/rateLimit";
import { requireSimulator } from "@/lib/mode";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const off = requireSimulator();
  if (off) return off;
  const denied = requireAgent(request);
  if (denied) return denied;
  const { id } = await params;
  if (!(await readFlight(id))) return Response.json({ error: "no such design" }, { status: 404 });
  const origin = configuratorOrigin(request);
  // Optional body {place: {latitudeDeg, longitudeDeg, headingDeg}}: start there instead of the default spot.
  const body = (await request.json().catch(() => ({}))) as { place?: Place };
  let slot;
  try {
    slot = await reserveSim({ ip: clientIp(request.headers), agent: true });
  } catch (e) {
    console.error("[dronex sim] refly", id, e instanceof Error ? e.message : String(e));
    return Response.json({ error: "the simulation engine is not running" }, { status: 502 });
  }
  if (!slot) return Response.json({ error: SIM_FULL }, { status: 503 });
  try {
    const flown = await reflyDesign(id, origin, body.place ?? null);
    if (!flown) return Response.json({ error: "no such design" }, { status: 404 });
    slot.commit(flown);
    return Response.json(flown);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dronex sim] refly", id, message);
    return Response.json({ error: message }, { status: 502 });
  } finally {
    slot.release();
  }
}
