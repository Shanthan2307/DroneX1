// POST /api/airspace/mission: record which agent gave which vehicle which mission, and where it stands
// (proposed, accepted, flying, done, failed, released). The Dispatch agents coordinate through this table.
import { connection } from "next/server";
import { toMission, waitFor, withAirspace } from "@/lib/airspace/client";
import type { MissionRequest } from "@/lib/airspace/types";
import { CORS } from "../route";

export async function POST(request: Request) {
  await connection();
  let body: Partial<MissionRequest>;
  try {
    body = (await request.json()) as Partial<MissionRequest>;
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400, headers: CORS });
  }
  const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId : "";
  const missionId = typeof body.missionId === "string" ? body.missionId : "";
  const agent = typeof body.agent === "string" && body.agent ? body.agent : "unknown";
  const status = typeof body.status === "string" && body.status ? body.status : "proposed";
  if (!vehicleId || !missionId) return Response.json({ error: "vehicleId and missionId are required" }, { status: 400, headers: CORS });
  try {
    const mission = await withAirspace(async (air) => {
      await air.conn.reducers.assignMission({ vehicleId, missionId, agent, status });
      const row = await waitFor(
        () => [...air.conn.db.missionAssignment.iter()].find((m) => m.vehicleId === vehicleId),
        (m) => m.missionId === missionId && m.status === status,
      );
      return toMission(row);
    });
    return Response.json({ mission }, { headers: CORS });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 503, headers: CORS });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
