// Server-only: the shared airspace's three writes, each a SpacetimeDB reducer call whose answer is read back from
// the subscription: request a corridor (granted or refused atomically against every other vehicle's), release
// it, and record which agent gave which vehicle which mission. The /api/airspace routes and the track scenarios
// both use these, so there is one way to ask.
import { randomUUID } from "node:crypto";
import { toCorridor, toMission, waitFor, withAirspace } from "@/lib/airspace/client";
import type { AirCorridor, AirMission, CorridorRequest, MissionRequest } from "@/lib/airspace/types";

export async function requestCorridor(req: CorridorRequest): Promise<AirCorridor> {
  const requestId = req.requestId || randomUUID();
  return withAirspace(async (air) => {
    await air.conn.reducers.requestCorridor({
      requestId,
      vehicleId: req.vehicleId,
      fromLat: req.from.lat,
      fromLon: req.from.lon,
      toLat: req.to.lat,
      toLon: req.to.lon,
      minAlt: req.minAltM,
      maxAlt: req.maxAltM,
      widthM: req.widthM ?? 40,
      ttlS: BigInt(Math.round(req.ttlS ?? 600)),
    });
    const row = await waitFor(
      () => [...air.conn.db.corridor.iter()].find((c) => c.requestId === requestId),
      () => true,
    );
    return toCorridor(row);
  });
}

export async function releaseCorridor(id: number): Promise<AirCorridor> {
  return withAirspace(async (air) => {
    await air.conn.reducers.releaseCorridor({ id: BigInt(id) });
    const row = await waitFor(
      () => [...air.conn.db.corridor.iter()].find((c) => c.id === BigInt(id)),
      (c) => c.status !== "granted",
    );
    return toCorridor(row);
  });
}

export async function assignMission(req: MissionRequest): Promise<AirMission> {
  const status = req.status || "proposed";
  return withAirspace(async (air) => {
    await air.conn.reducers.assignMission({ vehicleId: req.vehicleId, missionId: req.missionId, agent: req.agent || "unknown", status });
    const row = await waitFor(
      () => [...air.conn.db.missionAssignment.iter()].find((m) => m.vehicleId === req.vehicleId),
      (m) => m.missionId === req.missionId && m.status === status,
    );
    return toMission(row);
  });
}
