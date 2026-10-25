// The mirror: one process on the simulation engine's socket that turns its vehicle list and telemetry stream into
// a normalised feed (sinks/types.ts) for every sink: the SpacetimeDB airspace (shared, rules), the Elastic flight
// index (analytics), and a log. Fixes are rate-limited per vehicle (MIRROR_HZ, default 2) so the sinks see what
// a shared map or an index needs, not the full 10 Hz. Events (online, armed, mode, battery thresholds, GPS and
// EKF changes) are derived by diffing consecutive states. Started by dev.sh.
import { Daemon, sleep } from "./daemon.js";
import { coreDataDir, has, loadEnv } from "./env.js";
import { readDaemon } from "./daemon.js";
import { elasticSink } from "./sinks/elastic.js";
import { logSink } from "./sinks/log.js";
import { spacetimeSink } from "./sinks/spacetime.js";
import type { Fix, FlightEvent, Sink, VehicleInfo } from "./sinks/types.js";

type RawVehicle = {
  id: string;
  name: string;
  linkId: string;
  vehicleType: string;
  autopilot: string;
  firmware?: string | null;
  presence: VehicleInfo["presence"];
  armed: boolean;
  mode: string;
  sizeCm?: number | null;
  bookmarks?: { name: string; url: string }[];
  peer?: string;
};
type RawTelemetry = {
  vehicleId: string;
  positions: { source: string; latitudeDeg: number; longitudeDeg: number; headingDeg?: number | null; groundSpeedMps?: number | null; climbMps?: number | null; timeUs: number; altitudes: { meters: number; frame: string }[] }[];
  items: { key: string; value?: number | null; text?: string | null; timeUs: number }[];
};

const BATTERY_THRESHOLDS = [50, 30, 20, 10];

const designIdOf = (v: RawVehicle): string | null => {
  const b = (v.bookmarks ?? []).find((x) => x.name === "DroneX model");
  const m = b?.url.match(/designs\/(s-[a-f0-9]{12})\//);
  return m ? m[1] : null;
};

const toInfo = (v: RawVehicle): VehicleInfo => ({
  id: v.id,
  name: v.name,
  linkId: v.linkId,
  vehicleType: v.vehicleType,
  autopilot: v.autopilot,
  firmware: v.firmware ?? null,
  presence: v.presence,
  armed: v.armed,
  mode: v.mode,
  designId: designIdOf(v),
  sizeCm: v.sizeCm ?? null,
  simulated: /^127\.0\.0\.1:|^localhost:/.test(v.peer ?? "") || v.linkId.startsWith("li"),
});

// `telemetry/update` carries only what changed, so the latest full picture of a vehicle is kept here and every
// update merged into it before a fix is derived.
type Merged = { positions: Map<string, RawTelemetry["positions"][number]>; items: Map<string, RawTelemetry["items"][number]> };
const merged = new Map<string, Merged>();

function merge(t: RawTelemetry): Merged {
  const m = merged.get(t.vehicleId) ?? { positions: new Map(), items: new Map() };
  for (const p of t.positions) m.positions.set(p.source, p);
  for (const i of t.items) m.items.set(i.key, i);
  merged.set(t.vehicleId, m);
  return m;
}

function toFix(t: RawTelemetry): Fix | null {
  const m = merge(t);
  const pos = m.positions.get("fused") ?? [...m.positions.values()][0];
  if (!pos) return null;
  const alt = (frame: string) => pos.altitudes.find((a) => a.frame === frame)?.meters ?? null;
  const item = (key: string) => m.items.get(key);
  const num = (key: string) => item(key)?.value ?? null;
  return {
    vehicleId: t.vehicleId,
    timeUs: pos.timeUs,
    latitudeDeg: pos.latitudeDeg,
    longitudeDeg: pos.longitudeDeg,
    altitudeAmslM: alt("amsl"),
    altitudeAboveHomeM: alt("above-home"),
    altitudeAboveGroundM: alt("above-ground"),
    headingDeg: pos.headingDeg ?? null,
    groundSpeedMps: pos.groundSpeedMps ?? null,
    climbMps: pos.climbMps ?? null,
    batteryPct: num("battery.remaining_pct") ?? num("battery.percent") ?? num("battery.remaining"),
    batteryV: num("battery.voltage_v") ?? num("battery.voltage"),
    gpsSatellites: num("gps.satellites"),
    gpsFixType: num("gps.fix_type"),
    gpsHdop: num("gps.hdop"),
    ekfVariance: num("ekf.variance"),
    ekfStatus: item("ekf.status")?.text ?? null,
  };
}

/** A promise that rejects after `ms`, so one stuck sink cannot stop the mirror for good. */
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms))]);

export class Mirror {
  private vehicles = new Map<string, VehicleInfo>();
  private lastFixAt = new Map<string, number>();
  private lastFix = new Map<string, Fix>();
  private batteryCrossed = new Map<string, Set<number>>();
  private readonly minGapMs: number;

  constructor(
    private daemon: Daemon,
    private readonly sinks: Sink[],
    hz: number,
    /** Where to reconnect when the connection to the simulation engine dies or goes quiet. */
    private readonly socketPath: string | null = null,
  ) {
    this.minGapMs = 1000 / Math.max(0.2, hz);
  }

  private async emitEvent(e: FlightEvent) {
    const v = this.vehicles.get(e.vehicleId) ?? null;
    for (const s of this.sinks) await s.onEvent?.(e, v);
  }

  async pollVehicles(): Promise<void> {
    const { vehicles } = await this.daemon.call<{ vehicles: RawVehicle[] }>("vehicle/list", {});
    const now = Date.now() * 1000;
    const seen = new Set<string>();
    for (const raw of vehicles) {
      const info = toInfo(raw);
      seen.add(info.id);
      const prev = this.vehicles.get(info.id);
      this.vehicles.set(info.id, info);
      if (!prev) {
        if (info.presence === "online") await this.emitEvent({ type: "vehicle-online", vehicleId: info.id, timeUs: now, vehicle: info });
        for (const s of this.sinks) await s.onVehicle?.(info);
        continue;
      }
      const changed = prev.presence !== info.presence || prev.armed !== info.armed || prev.mode !== info.mode || prev.name !== info.name || prev.designId !== info.designId;
      if (!changed) continue;
      if (prev.presence !== "online" && info.presence === "online") await this.emitEvent({ type: "vehicle-online", vehicleId: info.id, timeUs: now, vehicle: info });
      if (prev.presence === "online" && info.presence !== "online") await this.emitEvent({ type: "vehicle-offline", vehicleId: info.id, timeUs: now });
      if (prev.armed !== info.armed) await this.emitEvent({ type: "armed", vehicleId: info.id, timeUs: now, armed: info.armed });
      if (prev.mode !== info.mode) await this.emitEvent({ type: "mode", vehicleId: info.id, timeUs: now, from: prev.mode, to: info.mode });
      for (const s of this.sinks) await s.onVehicle?.(info);
    }
    for (const id of [...this.vehicles.keys()]) if (!seen.has(id)) this.vehicles.delete(id);
  }

  async onTelemetry(raw: RawTelemetry): Promise<void> {
    const fix = toFix(raw);
    if (!fix) return;
    const v = this.vehicles.get(fix.vehicleId);
    if (!v) return;
    const prev = this.lastFix.get(fix.vehicleId);
    // Threshold and health events are not rate-limited: they are the callouts.
    if (fix.batteryPct !== null) {
      const crossed = this.batteryCrossed.get(fix.vehicleId) ?? new Set<number>();
      for (const th of BATTERY_THRESHOLDS) {
        if (fix.batteryPct <= th && !crossed.has(th) && (prev?.batteryPct ?? 100) > th) {
          crossed.add(th);
          await this.emitEvent({ type: "battery-threshold", vehicleId: fix.vehicleId, timeUs: fix.timeUs, pct: fix.batteryPct, threshold: th });
        }
      }
      this.batteryCrossed.set(fix.vehicleId, crossed);
    }
    const degraded = (f: Fix) => (f.gpsFixType !== null && f.gpsFixType < 3) || (f.gpsSatellites !== null && f.gpsSatellites < 6);
    if (prev && degraded(fix) !== degraded(prev)) await this.emitEvent({ type: "gps-quality", vehicleId: fix.vehicleId, timeUs: fix.timeUs, satellites: fix.gpsSatellites, fixType: fix.gpsFixType, degraded: degraded(fix) });
    if (fix.ekfStatus && prev && prev.ekfStatus !== fix.ekfStatus) await this.emitEvent({ type: "ekf", vehicleId: fix.vehicleId, timeUs: fix.timeUs, status: fix.ekfStatus, variance: fix.ekfVariance });
    this.lastFix.set(fix.vehicleId, fix);
    const now = Date.now();
    if (now - (this.lastFixAt.get(fix.vehicleId) ?? 0) < this.minGapMs) return;
    this.lastFixAt.set(fix.vehicleId, now);
    for (const s of this.sinks) await s.onFix?.(fix, v);
  }

  /** Listen to telemetry on the current connection and take the latest fix of every vehicle. */
  private async attach(): Promise<void> {
    this.daemon.onNotification((method, params) => {
      if (method === "telemetry/update") void this.onTelemetry(params as RawTelemetry).catch((e) => console.error("[mirror] telemetry", e));
    });
    await this.pollVehicles();
    const latest = await this.daemon.call<{ vehicles?: RawTelemetry[]; telemetry?: RawTelemetry[] } | RawTelemetry[]>("telemetry/subscribe", {});
    const initial = Array.isArray(latest) ? latest : (latest.vehicles ?? latest.telemetry ?? []);
    for (const t of initial) await this.onTelemetry(t);
  }

  /** A fresh connection after the old one died or stopped answering (seen after hours of running). */
  private async reconnect(): Promise<void> {
    if (!this.socketPath) return;
    this.daemon.close();
    this.daemon = await Daemon.connect(this.socketPath);
    await this.attach();
    console.log("[mirror] reconnected to the simulation engine");
  }

  async run(): Promise<never> {
    for (const s of this.sinks) await s.start?.();
    await this.attach();
    let tick = 0;
    let failures = 0;
    for (;;) {
      await sleep(1000);
      tick++;
      try {
        await this.pollVehicles();
        for (const s of this.sinks) await withTimeout(Promise.resolve(s.flush?.()), 30_000, `${s.name} flush`);
        failures = 0;
      } catch (e) {
        failures++;
        console.error("[mirror] tick", e instanceof Error ? e.message : e);
        if (failures >= 3 || this.daemon.isClosed) {
          await this.reconnect().catch((err) => console.error("[mirror] reconnect", err instanceof Error ? err.message : err));
          failures = 0;
        }
      }
      if (tick % 60 === 0) console.log(`[mirror] ${this.vehicles.size} vehicles known, ${[...this.vehicles.values()].filter((v) => v.presence === "online").length} online`);
    }
  }
}

async function main() {
  loadEnv();
  const daemonInfo = await readDaemon(coreDataDir());
  const daemon = await Daemon.connect(daemonInfo.socket);
  const sinks: Sink[] = [logSink()];
  const st = await spacetimeSink();
  if (st) sinks.push(st);
  else console.log("[mirror] SpacetimeDB sink off" + (has("SPACETIME_URI") ? " (sink not built)" : " (SPACETIME_URI not set)"));
  const es = await elasticSink();
  if (es) sinks.push(es);
  else console.log("[mirror] Elastic sink off" + (has("ELASTIC_URL") ? " (sink not built)" : " (ELASTIC_URL not set)"));
  const hz = Number(process.env.MIRROR_HZ ?? "2");
  console.log(`[mirror] on ${daemonInfo.socket}, ${hz} fixes/s per vehicle, sinks: ${sinks.map((s) => s.name).join(", ")}`);
  await new Mirror(daemon, sinks, hz, daemonInfo.socket).run();
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) main().catch((e) => {
  console.error("[mirror]", e instanceof Error ? e.message : e);
  process.exit(1);
});
