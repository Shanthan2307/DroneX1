// GET  /api/sim/vehicles/<id>: the vehicle's state and telemetry, with `ready` (position known, GPS 3D fix, EKF
//      good), so a caller can wait for ArduPilot's pre-arm checks before asking it to take off. With ?place=<name>,
//      also that place located near the vehicle (`place`, null when not found), e.g. to reserve a corridor to it.
// POST /api/sim/vehicles/<id> {tool, args}: one copilot tool (takeoff, goto_place, set_mode, return_to_launch,
//      land, arm, disarm, status) run directly, no model in between. The Dispatch flight agent flies through this;
//      the voice copilot keeps /api/copilot/intent, where the model picks the tool.
// GET is for the agents or the visitor who started the vehicle; POST is agent-only (x-dronex-agent) and every tool
// is pinned to <id>.
import { connection } from "next/server";
import { isAgent, requireAgent } from "@/lib/agentAuth";
import { mayActOn } from "@/lib/ownership";
import { limitRequest } from "@/lib/rateLimit";
import { runTool } from "@/lib/ai/intent";
import { isReady } from "@/lib/sim/ready";
import { findPlace, listVehicles, telemetry, withCore } from "@/lib/sim/tools";

const TOOLS = new Set(["status", "takeoff", "goto_place", "set_mode", "return_to_launch", "land", "arm", "disarm"]);


const fail = (e: unknown, status = 502) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error("[dronex sim] vehicles", message);
  return Response.json({ error: message }, { status });
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const limited = limitRequest(request, "dataset");
  if (limited) return limited;
  const { id } = await params;
  if (!mayActOn(request, id)) return Response.json({ error: "not your vehicle" }, { status: 403 });
  // The place search spends the hosted geocoding key: agents only.
  const query = !isAgent(request) ? null : (new URL(request.url).searchParams.get("place")?.trim() || null);
  try {
    return await withCore(async (c) => {
      const v = (await listVehicles(c)).find((x) => x.id === id);
      if (!v) return Response.json({ error: "no such vehicle" }, { status: 404 });
      const t = await telemetry(c, v);
      const near = t.latitudeDeg !== null && t.longitudeDeg !== null ? { latitudeDeg: t.latitudeDeg, longitudeDeg: t.longitudeDeg } : null;
      const place = query ? await findPlace(c, query, near) : null;
      return Response.json({ vehicle: v, telemetry: t, ready: v.presence === "online" && isReady(t), ...(query ? { place } : {}) });
    });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const denied = requireAgent(request);
  if (denied) return denied;
  const { id } = await params;
  let body: { tool?: string; args?: Record<string, unknown> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }
  const tool = body.tool ?? "";
  if (!TOOLS.has(tool)) return Response.json({ error: `tool must be one of ${[...TOOLS].join(", ")}` }, { status: 400 });
  try {
    const { result } = await runTool(tool, { ...(body.args ?? {}), vehicle: id }, id, { lock: id });
    return Response.json({ tool, result });
  } catch (e) {
    return fail(e);
  }
}
