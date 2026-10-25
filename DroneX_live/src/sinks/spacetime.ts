// SpacetimeDB sink: the shared airspace. Every vehicle the mirror sees is upserted, every rate-limited fix becomes
// the vehicle's current position, and flight events become incidents, all through the module's reducers, so the
// rules (corridor conflicts, staleness) run next to the data. Absent when SPACETIME_URI is not set.
import os from "node:os";
import { connectAirspace, type AirspaceConnection } from "../spacetime/client.js";
import type { FlightEvent, Fix, Sink, VehicleInfo } from "./types.js";

const incidentOf = (e: FlightEvent): { kind: string; detail: string } | null => {
  switch (e.type) {
    case "battery-threshold":
      return { kind: "battery", detail: `battery ${e.pct.toFixed(0)} % (crossed ${e.threshold} %)` };
    case "gps-quality":
      return { kind: "gps-degraded", detail: e.degraded ? `GPS degraded: ${e.satellites ?? "?"} satellites, fix type ${e.fixType ?? "?"}` : "GPS recovered" };
    case "ekf":
      return { kind: "ekf", detail: `EKF ${e.status}${e.variance !== null ? ` (variance ${e.variance.toFixed(3)})` : ""}` };
    case "mode":
      return { kind: "mode", detail: `${e.from} → ${e.to}` };
    case "armed":
      return { kind: "mode", detail: e.armed ? "armed" : "disarmed" };
    default:
      return null;
  }
};

export async function spacetimeSink(): Promise<Sink | null> {
  if (!process.env.SPACETIME_URI) return null;
  let air: AirspaceConnection | null = null;
  const operator = process.env.MIRROR_OPERATOR ?? os.hostname();
  const last = new Map<string, Fix>();
  const failures = { n: 0 };
  const guard = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
      failures.n = 0;
    } catch (e) {
      failures.n++;
      if (failures.n <= 3 || failures.n % 50 === 0) console.error(`[spacetime] ${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    name: "spacetime",
    async start() {
      air = await connectAirspace();
      console.log(`[spacetime] connected to ${process.env.SPACETIME_URI} as ${air.identity.slice(0, 8)}…, operator ${operator}`);
    },
    async onVehicle(v: VehicleInfo) {
      if (!air) return;
      const a = air;
      await guard("upsert_vehicle", () =>
        a.conn.reducers.upsertVehicle({
          id: v.id,
          name: v.name,
          designId: v.designId ?? undefined,
          vehicleType: v.vehicleType,
          operator,
          presence: v.presence,
          armed: v.armed,
          mode: v.mode,
          sizeCm: v.sizeCm ?? undefined,
        }),
      );
    },
    async onFix(f: Fix) {
      if (!air) return;
      const a = air;
      last.set(f.vehicleId, f);
      await guard("report_position", () =>
        a.conn.reducers.reportPosition({
          vehicleId: f.vehicleId,
          lat: f.latitudeDeg,
          lon: f.longitudeDeg,
          altAmsl: f.altitudeAmslM ?? undefined,
          altHome: f.altitudeAboveHomeM ?? undefined,
          heading: f.headingDeg ?? undefined,
          speed: f.groundSpeedMps ?? undefined,
          batteryPct: f.batteryPct ?? undefined,
          gpsSats: f.gpsSatellites ?? undefined,
          ekfStatus: f.ekfStatus ?? undefined,
          timeUs: BigInt(Math.round(f.timeUs)),
        }),
      );
    },
    async onEvent(e: FlightEvent) {
      if (!air) return;
      const a = air;
      const inc = incidentOf(e);
      if (!inc) return;
      const at = last.get(e.vehicleId);
      await guard("record_incident", () =>
        a.conn.reducers.recordIncident({
          vehicleId: e.vehicleId,
          kind: inc.kind,
          detail: inc.detail,
          lat: at?.latitudeDeg ?? 0,
          lon: at?.longitudeDeg ?? 0,
          timeUs: BigInt(Math.round(e.timeUs)),
        }),
      );
    },
    stop() {
      air?.close();
      air = null;
    },
  };
}
