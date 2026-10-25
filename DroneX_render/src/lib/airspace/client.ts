// Connections to the shared airspace (SpacetimeDB) from the configurator: the browser view subscribes through
// `connectAirspace`; the /api/airspace routes use `withAirspace` (one short-lived connection per request) to read a
// snapshot or call a reducer for agents that cannot speak the SpacetimeDB protocol. Rows are converted to the plain
// JSON shapes in types.ts.
import { DbConnection, tables } from "./bindings/index";
import type { Corridor, Incident, MissionAssignment, Position, Vehicle } from "./bindings/types";
import type { AirCorridor, AirIncident, AirMission, AirPosition, AirspaceSnapshot, AirVehicle } from "./types";

export const DEFAULT_URI = "ws://127.0.0.1:3100";
export const DEFAULT_DB = "dronex-airspace";

/** The browser reads NEXT_PUBLIC_* at build time; the server reads the plain names. */
export function airspaceTarget(): { uri: string; db: string } {
  const isServer = typeof window === "undefined";
  const uri = (isServer ? process.env.SPACETIME_URI : process.env.NEXT_PUBLIC_SPACETIME_URI) ?? DEFAULT_URI;
  const db = (isServer ? process.env.SPACETIME_DB : process.env.NEXT_PUBLIC_SPACETIME_DB) ?? DEFAULT_DB;
  return { uri, db };
}

const n = (v: bigint | number) => (typeof v === "bigint" ? Number(v) : v);
const opt = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

export const toVehicle = (r: Vehicle): AirVehicle => ({
  id: r.id,
  name: r.name,
  designId: opt(r.designId),
  vehicleType: r.vehicleType,
  operator: r.operator,
  presence: r.presence,
  armed: r.armed,
  mode: r.mode,
  sizeCm: opt(r.sizeCm),
  updatedAtUs: n(r.updatedAt),
});

export const toPosition = (r: Position): AirPosition => ({
  vehicleId: r.vehicleId,
  lat: r.lat,
  lon: r.lon,
  altAmslM: opt(r.altAmsl),
  altHomeM: opt(r.altHome),
  headingDeg: opt(r.heading),
  speedMps: opt(r.speed),
  batteryPct: opt(r.batteryPct),
  gpsSats: opt(r.gpsSats),
  ekfStatus: opt(r.ekfStatus),
  timeUs: n(r.timeUs),
  seenAtUs: n(r.seenAt),
});

export const toCorridor = (r: Corridor): AirCorridor => ({
  id: n(r.id),
  requestId: r.requestId,
  vehicleId: r.vehicleId,
  from: { lat: r.fromLat, lon: r.fromLon },
  to: { lat: r.toLat, lon: r.toLon },
  minAltM: r.minAlt,
  maxAltM: r.maxAlt,
  widthM: r.widthM,
  status: r.status,
  requestedAtUs: n(r.requestedAt),
  expiresAtUs: n(r.expiresAt),
  reason: r.reason,
});

export const toIncident = (r: Incident): AirIncident => ({ id: n(r.id), vehicleId: r.vehicleId, kind: r.kind, detail: r.detail, lat: r.lat, lon: r.lon, timeUs: n(r.timeUs) });

export const toMission = (r: MissionAssignment): AirMission => ({ vehicleId: r.vehicleId, missionId: r.missionId, agent: r.agent, status: r.status, updatedAtUs: n(r.updatedAt) });

export interface Airspace {
  conn: DbConnection;
  identity: string;
  snapshot(): AirspaceSnapshot;
  close(): void;
}

/** Connects, subscribes to every table and resolves when the first snapshot is in the cache. */
export function connectAirspace(opts: { uri?: string; db?: string; timeoutMs?: number } = {}): Promise<Airspace> {
  const target = airspaceTarget();
  const uri = opts.uri ?? target.uri;
  const db = opts.db ?? target.db;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  return new Promise<Airspace>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error(`no answer from the airspace at ${uri} (${db}) in ${timeoutMs} ms`))), timeoutMs);
    DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(db)
      .onConnect((conn, identity) => {
        conn
          .subscriptionBuilder()
          .onApplied(() =>
            done(() =>
              resolve({
                conn,
                identity: identity.toHexString(),
                snapshot: () => ({
                  vehicles: [...conn.db.vehicle.iter()].map(toVehicle),
                  positions: [...conn.db.position.iter()].map(toPosition),
                  corridors: [...conn.db.corridor.iter()].map(toCorridor),
                  incidents: [...conn.db.incident.iter()].map(toIncident),
                  missions: [...conn.db.missionAssignment.iter()].map(toMission),
                  database: `${uri}/${db}`,
                }),
                close: () => conn.disconnect(),
              }),
            ),
          )
          .onError((ctx) => done(() => reject(ctx.event ?? new Error("subscription failed"))))
          .subscribe([tables.vehicle, tables.position, tables.corridor, tables.incident, tables.missionAssignment]);
      })
      .onConnectError((_ctx, error) => done(() => reject(error)))
      .build();
  });
}

/** Server-side: one connection for the duration of `fn`, closed afterwards. */
export async function withAirspace<T>(fn: (air: Airspace) => Promise<T>): Promise<T> {
  const air = await connectAirspace();
  try {
    return await fn(air);
  } finally {
    air.close();
  }
}

/** Waits until a row satisfying `test` appears in the cache (reducer effects arrive as subscription updates). */
export function waitFor<T>(read: () => T | undefined, test: (v: T) => boolean, timeoutMs = 4_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = read();
      if (v !== undefined && test(v)) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error("the airspace did not answer in time"));
      setTimeout(tick, 50);
    };
    tick();
  });
}
