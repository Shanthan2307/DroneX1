// GET  /api/sim/vehicles/<id>: the vehicle's state and telemetry, with `ready` (position known, GPS 3D fix, EKF
//      good), so a caller can wait for ArduPilot's pre-arm checks before asking it to take off. With ?place=<name>,
//      also that place located near the vehicle (`place`, null when not found), e.g. to reserve a corridor to it.
// POST /api/sim/vehicles/<id> {tool, args}: one copilot tool (takeoff, goto_place, set_mode, return_to_launch,
//      land, arm, disarm, status) run directly, no model in between. The Dispatch flight agent flies through this;
//      the voice copilot keeps /api/copilot/intent, where the model picks the tool.
import { connection } from "next/server";
import { runTool } from "@/lib/ai/intent";
import { isReady } from "@/lib/sim/ready";
import { findPlace, listVehicles, telemetry, withCore } from "@/lib/sim/tools";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const TOOLS = new Set(["status", "takeoff", "goto_place", "set_mode", "return_to_launch", "land", "arm", "disarm"]);


const fail = (e: unknown, status = 502) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error("[dronex sim] vehicles", message);
  return Response.json({ error: message }, { status, headers: CORS });
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const query = new URL(request.url).searchParams.get("place")?.trim() || null;
  try {
    return await withCore(async (c) => {
      const v = (await listVehicles(c)).find((x) => x.id === id);
      if (!v) return Response.json({ error: "no such vehicle" }, { status: 404, headers: CORS });
      const t = await telemetry(c, v);
      const near = t.latitudeDeg !== null && t.longitudeDeg !== null ? { latitudeDeg: t.latitudeDeg, longitudeDeg: t.longitudeDeg } : null;
      const place = query ? await findPlace(c, query, near) : null;
      return Response.json({ vehicle: v, telemetry: t, ready: v.presence === "online" && isReady(t), ...(query ? { place } : {}) }, { headers: CORS });
    });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  let body: { tool?: string; args?: Record<string, unknown> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400, headers: CORS });
  }
  const tool = body.tool ?? "";
  if (!TOOLS.has(tool)) return Response.json({ error: `tool must be one of ${[...TOOLS].join(", ")}` }, { status: 400, headers: CORS });
  try {
    const { result } = await runTool(tool, { ...(body.args ?? {}), vehicle: id }, id);
    return Response.json({ tool, result }, { headers: CORS });
  } catch (e) {
    return fail(e);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
