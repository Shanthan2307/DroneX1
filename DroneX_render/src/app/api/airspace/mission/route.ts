// POST /api/airspace/mission: record which agent gave which vehicle which mission, and where it stands
// (proposed, accepted, flying, done, failed, released). The Dispatch agents coordinate through this table.
// Agent-only (x-dronex-agent).
import { connection } from "next/server";
import { requireAgent } from "@/lib/agentAuth";
import { limitRequest } from "@/lib/rateLimit";
import { toMission, waitFor } from "@/lib/airspace/client";
import { withAirspace } from "@/lib/airspace/server";
import type { MissionRequest } from "@/lib/airspace/types";

export async function POST(request: Request) {
  await connection();
  const denied = requireAgent(request);
  if (denied) return denied;
  const limited = limitRequest(request, "airspaceWrite");
  if (limited) return limited;
  let body: Partial<MissionRequest>;
  try {
    body = (await request.json()) as Partial<MissionRequest>;
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }
  const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId : "";
  const missionId = typeof body.missionId === "string" ? body.missionId : "";
  const agent = typeof body.agent === "string" && body.agent ? body.agent : "unknown";
  const status = typeof body.status === "string" && body.status ? body.status : "proposed";
  if (!vehicleId || !missionId) return Response.json({ error: "vehicleId and missionId are required" }, { status: 400 });
  try {
    const mission = await withAirspace(async (air) => {
      await air.conn.reducers.assignMission({ vehicleId, missionId, agent, status });
      const row = await waitFor(
        () => [...air.conn.db.missionAssignment.iter()].find((m) => m.vehicleId === vehicleId),
        (m) => m.missionId === missionId && m.status === status,
      );
      return toMission(row);
    });
    return Response.json({ mission });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 503 });
  }
}
