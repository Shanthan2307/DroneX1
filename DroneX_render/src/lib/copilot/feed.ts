// The copilot's ears on the simulation engine: one long-lived connection to the Core daemon's unix socket
// (newline-delimited JSON-RPC 2.0, with notifications), subscribed to telemetry and to state changes, merged
// into one snapshot per vehicle, with callouts derived in code (callouts.ts) on every change. Shared by every
// open events stream; started on the first subscriber, reconnects with backoff. Server-only.
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { coreDataDir } from "@/lib/sim/core";
import { calloutForNotification, deriveCallouts } from "./callouts";
import type { Callout, FeedEvent, VehicleListed, VehicleSnapshot } from "./types";

// ---------- a daemon client with notifications ----------

interface RpcError {
  code: number;
  message: string;
}
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };

class DaemonLink {
  private next = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private closed: Error | null = null;
  readonly notifications = new Set<(method: string, params: unknown) => void>();
  readonly onClose = new Set<(e: Error) => void>();

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    const fail = (err: Error) => {
      if (this.closed) return;
      this.closed = err;
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      for (const f of this.onClose) f(err);
    };
    socket.on("error", fail);
    socket.on("close", () => fail(this.closed ?? new Error("the simulation engine closed the connection")));
  }

  static async connect(socketPath: string): Promise<DaemonLink> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(socketPath);
      s.once("connect", () => resolve(s));
      s.once("error", (e) => reject(new Error(`cannot reach the simulation engine at ${socketPath}: ${e.message}`)));
    });
    const link = new DaemonLink(socket);
    await link.call("initialize", { clientInfo: { name: "dronex-copilot", version: "0.1.0", kind: "operator-cli" }, capabilities: { protocolVersion: 1 } });
    return link;
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: RpcError; method?: string; params?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id !== "number") {
        if (msg.method) for (const f of this.notifications) f(msg.method, msg.params);
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }

  call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close() {
    this.closed ??= new Error("closed");
    this.socket.end();
  }
}

// ---------- wire shapes we read ----------

type RawVehicle = { id: string; name: string; vehicleType: string; presence: VehicleSnapshot["presence"]; armed: boolean; mode: string };
type RawPosition = { source: string; latitudeDeg: number; longitudeDeg: number; headingDeg?: number | null; groundSpeedMps?: number | null; timeUs: number; altitudes: { meters: number; frame: string }[] };
type RawItem = { key: string; value?: number | null; text?: string | null; timeUs: number };
type RawTelemetry = { vehicleId: string; positions: RawPosition[]; items: RawItem[] };
type RawNotification = { id: string; severity: string; title: string; body?: string | null; subject?: { id?: string; vehicleId?: string } | null; state?: string };
type RawChange = { entity: string; id: string; op: string; notification?: RawNotification | null; vehicle?: RawVehicle | null };
type RawDelta = { seq: number; tsUs: number; actor?: { kind?: string; id?: string } | null; changes: RawChange[] };

interface Merged {
  positions: Map<string, RawPosition>;
  items: Map<string, RawItem>;
}

// ---------- the feed ----------

type Listener = (e: FeedEvent) => void;

const MIN_SNAPSHOT_GAP_MS = 500;
const IDLE_STOP_MS = 30_000;

class CopilotFeed {
  private link: DaemonLink | null = null;
  private listeners = new Set<Listener>();
  private vehicles = new Map<string, RawVehicle>();
  private merged = new Map<string, Merged>();
  private snapshots = new Map<string, VehicleSnapshot>();
  private lastSent = new Map<string, number>();
  private seenNotifications = new Set<string>();
  private poll: NodeJS.Timeout | null = null;
  private idle: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private backoffMs = 1000;
  lastError: string | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (this.idle) {
      clearTimeout(this.idle);
      this.idle = null;
    }
    void this.ensureStarted();
    fn({ type: "hello", vehicles: this.listed(), snapshots: [...this.snapshots.values()] });
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.idle = setTimeout(() => this.stop(), IDLE_STOP_MS);
    };
  }

  private emit(e: FeedEvent) {
    for (const f of this.listeners) {
      try {
        f(e);
      } catch {
        // a closed stream; its unsubscribe will follow
      }
    }
  }

  private listed(): VehicleListed[] {
    return [...this.vehicles.values()].map((v) => ({ id: v.id, name: v.name, presence: v.presence, armed: v.armed, mode: v.mode, vehicleType: v.vehicleType }));
  }

  private async ensureStarted(): Promise<void> {
    if (this.link) return;
    if (!this.starting) this.starting = this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(): Promise<void> {
    try {
      const dir = coreDataDir();
      const text = await readFile(path.join(dir, "daemon.json"), "utf8");
      const info = JSON.parse(text) as { socket: string };
      const link = await DaemonLink.connect(info.socket);
      this.link = link;
      this.lastError = null;
      this.backoffMs = 1000;
      link.notifications.add((method, params) => {
        if (method === "telemetry/update") this.onTelemetry(params as RawTelemetry);
        else if (method === "state/delta") this.onDelta(params as RawDelta);
      });
      link.onClose.add((e) => {
        this.link = null;
        this.lastError = e.message;
        if (this.poll) clearInterval(this.poll);
        this.poll = null;
        if (this.listeners.size > 0) setTimeout(() => void this.ensureStarted(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
      });
      await this.pollVehicles(link);
      const latest = await link.call<{ vehicles?: RawTelemetry[]; telemetry?: RawTelemetry[] } | RawTelemetry[]>("telemetry/subscribe", {});
      const initial = Array.isArray(latest) ? latest : (latest.vehicles ?? latest.telemetry ?? []);
      for (const t of initial) this.onTelemetry(t);
      try {
        const snap = await link.call<{ notifications?: RawNotification[] }>("state/subscribe", { entities: ["notification"] });
        for (const n of snap.notifications ?? []) this.seenNotifications.add(n.id); // old ones are not re-spoken
      } catch (e) {
        console.warn("[copilot feed] state/subscribe:", e instanceof Error ? e.message : e);
      }
      this.poll = setInterval(() => void this.pollVehicles(link).catch(() => undefined), 1000);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      if (this.listeners.size > 0) setTimeout(() => void this.ensureStarted(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    }
  }

  private stop() {
    this.idle = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.link?.close();
    this.link = null;
  }

  private async pollVehicles(link: DaemonLink): Promise<void> {
    const { vehicles } = await link.call<{ vehicles: RawVehicle[] }>("vehicle/list", {});
    let changed = false;
    const seen = new Set<string>();
    for (const v of vehicles) {
      seen.add(v.id);
      const prev = this.vehicles.get(v.id);
      this.vehicles.set(v.id, v);
      if (!prev || prev.presence !== v.presence || prev.armed !== v.armed || prev.mode !== v.mode || prev.name !== v.name) {
        changed = true;
        this.refresh(v.id, true);
      }
    }
    for (const id of [...this.vehicles.keys()]) {
      if (!seen.has(id)) {
        this.vehicles.delete(id);
        this.snapshots.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit({ type: "vehicles", vehicles: this.listed() });
  }

  private onTelemetry(t: RawTelemetry) {
    const m = this.merged.get(t.vehicleId) ?? { positions: new Map(), items: new Map() };
    for (const p of t.positions) m.positions.set(p.source, p);
    for (const i of t.items) m.items.set(i.key, i);
    this.merged.set(t.vehicleId, m);
    this.refresh(t.vehicleId, false);
  }

  /** Rebuilds a vehicle's snapshot, derives callouts against the previous one, and streams what changed. */
  private refresh(vehicleId: string, force: boolean) {
    const v = this.vehicles.get(vehicleId);
    if (!v) return;
    const m = this.merged.get(vehicleId);
    const pos = m?.positions.get("fused") ?? (m ? [...m.positions.values()][0] : undefined);
    const alt = (frame: string) => pos?.altitudes.find((a) => a.frame === frame)?.meters ?? null;
    const item = (key: string) => m?.items.get(key);
    const num = (key: string) => item(key)?.value ?? null;
    const timeUs = Math.max(pos?.timeUs ?? 0, ...(m ? [...m.items.values()].map((i) => i.timeUs) : [0]), Date.now() * 1000 - 1);
    const next: VehicleSnapshot = {
      vehicleId,
      name: v.name,
      presence: v.presence,
      armed: v.armed,
      mode: v.mode,
      timeUs,
      altitudeAboveHomeM: alt("above-home"),
      altitudeAmslM: alt("amsl"),
      groundSpeedMps: pos?.groundSpeedMps ?? num("speed.ground_mps"),
      headingDeg: pos?.headingDeg ?? num("heading.true_deg"),
      batteryPct: num("battery.remaining_pct"),
      batteryV: num("battery.voltage_v"),
      gpsFixType: num("gps.fix_type"),
      gpsSatellites: num("gps.satellites"),
      ekfStatus: item("ekf.status")?.text ?? null,
      homeLatitudeDeg: num("home.latitude_deg"),
      homeLongitudeDeg: num("home.longitude_deg"),
      missionCurrent: num("mission.current"),
      missionState: num("mission.state"),
    };
    const prev = this.snapshots.get(vehicleId) ?? null;
    this.snapshots.set(vehicleId, next);
    for (const c of deriveCallouts(prev, next)) this.emit({ type: "callout", callout: c });
    const now = Date.now();
    if (force || now - (this.lastSent.get(vehicleId) ?? 0) >= MIN_SNAPSHOT_GAP_MS) {
      this.lastSent.set(vehicleId, now);
      this.emit({ type: "snapshot", snapshot: next });
    }
  }

  /** Engine warnings about a vehicle (the building guard's brake, failsafes) become spoken warnings once each. */
  private onDelta(d: RawDelta) {
    for (const c of d.changes) {
      if (c.entity !== "notification" || !c.notification || c.op === "removed" || c.op === "deleted") continue;
      const n = c.notification;
      if (this.seenNotifications.has(n.id)) continue;
      this.seenNotifications.add(n.id);
      if (n.severity !== "warning" && n.severity !== "error" && n.severity !== "critical") continue;
      const vehicleId = n.subject?.id ?? n.subject?.vehicleId ?? null;
      const snap = vehicleId ? this.snapshots.get(vehicleId) : [...this.snapshots.values()][0];
      if (!snap) continue;
      const callout: Callout | null = calloutForNotification(snap, n.title, n.body ?? null);
      if (callout) this.emit({ type: "callout", callout });
    }
  }
}

const g = globalThis as unknown as { __dronexCopilotFeed?: CopilotFeed };
/** The one feed for this server process (survives Next's hot reloads of route modules). */
export const copilotFeed = (): CopilotFeed => (g.__dronexCopilotFeed ??= new CopilotFeed());
