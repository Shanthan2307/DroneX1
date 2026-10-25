// SpacetimeDB sink: the shared airspace. Every vehicle the mirror sees is upserted, every rate-limited fix becomes
// the vehicle's current position, and flight events become incidents, all through the module's reducers, so the
// rules (corridor conflicts, staleness) run next to the data. Absent when SPACETIME_URI is not set.
//
// Writes need a registered identity (SPACETIME_TOKEN, see spacetime/client.ts and scripts/spacetime-add-writer.sh).
// A lost connection ends the process (exit 1) so systemd restarts it with a fresh one, and a small keepalive
// reducer call every MIRROR_KEEPALIVE_HOURS (default 3) keeps a hosted database from pausing when nothing flies.
// The operator shown on every vehicle is MIRROR_OPERATOR; in production (NODE_ENV=production) it defaults to
// "DroneX" rather than the server's host name, which every visitor would otherwise see.
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
  const operator = process.env.MIRROR_OPERATOR || (process.env.NODE_ENV === "production" ? "DroneX" : os.hostname());
  const keepaliveMs = Math.max(0.1, Number(process.env.MIRROR_KEEPALIVE_HOURS ?? "3") || 3) * 3_600_000;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let stopping = false;
  const last = new Map<string, Fix>();
  const failures = { n: 0 };
  const guard = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
      failures.n = 0;
    } catch (e) {
      failures.n++;
      const msg = e instanceof Error ? e.message : String(e);
      if (failures.n <= 3 || failures.n % 50 === 0) console.error(`[spacetime] ${what}: ${msg}`);
      if (failures.n === 1 && msg.includes("not write to it")) {
        console.error("[spacetime] this identity is not a writer: set SPACETIME_TOKEN and register it with DroneX_live/scripts/spacetime-add-writer.sh");
      }
    }
  };
  return {
    name: "spacetime",
    async start() {
      air = await connectAirspace({
        onDisconnect: (error) => {
          if (stopping) return;
          console.error(`[spacetime] disconnected from the airspace${error ? `: ${error.message}` : ""}; exiting so the service restarts`);
          process.exit(1);
        },
      });
      console.log(`[spacetime] connected to ${process.env.SPACETIME_URI} as ${air.identity}, operator ${operator}`);
      const a = air;
      keepalive = setInterval(() => void guard("keepalive", () => a.conn.reducers.keepalive({})), keepaliveMs);
      keepalive.unref();
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
      stopping = true;
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
      air?.close();
      air = null;
    },
  };
}
