// The decisions behind the simulator cap and the reaper, as pure functions over plain data (sims.ts does the
// Core calls). A DroneX sim is a Core vehicle carrying the "DroneX model" bookmark (designId set). The cap is
// DRONEX_MAX_SIMS running DroneX sims (default 8, kept below Core's 32); a visitor gets one at a time (a new Fly
// from the same address replaces the old one); the agents get a share of the cap. The reaper stops sims that are
// offline, disarmed for DRONEX_SIM_IDLE_MIN or older than DRONEX_SIM_MAX_MIN, and forgets offline records.

export interface SimLimits {
  maxSims: number;
  idleMs: number;
  maxAgeMs: number;
}

export interface SimEntry {
  linkId: string;
  vehicleId: string;
  /** The visitor's address; null for a sim found in Core (started before this process) or for an agent. */
  ip: string | null;
  agent: boolean;
  startedAt: number;
  lastActiveAt: number;
}

/** What the registry needs from a `vehicle/list` row. */
export interface SimRow {
  id: string;
  linkId: string;
  presence: "online" | "stale" | "offline";
  armed: boolean;
  designId: string | null;
}

const CORE_MAX_SIMS = 32;
const LOCAL = "local";

const positive = (raw: string | undefined, fallback: number): number => {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export function simLimits(env: Record<string, string | undefined> = process.env): SimLimits {
  return {
    maxSims: Math.min(Math.floor(positive(env.DRONEX_MAX_SIMS, 8)), CORE_MAX_SIMS - 1),
    idleMs: positive(env.DRONEX_SIM_IDLE_MIN, 10) * 60_000,
    maxAgeMs: positive(env.DRONEX_SIM_MAX_MIN, 30) * 60_000,
  };
}

/** How many of the cap the agents (Dispatch) may hold at once: half, rounded up. */
export const agentShare = (limits: SimLimits): number => Math.max(1, Math.ceil(limits.maxSims / 2));

/**
 * Brings the registry in line with Core's vehicle list: new DroneX vehicles are added (unknown owner), vanished
 * ones dropped, link ids refreshed, and an armed vehicle counts as active now.
 */
export function syncEntries(entries: Map<string, SimEntry>, rows: readonly SimRow[], now: number): void {
  const drones = rows.filter((r) => r.designId !== null);
  const seen = new Set(drones.map((r) => r.id));
  for (const id of [...entries.keys()]) if (!seen.has(id)) entries.delete(id);
  for (const r of drones) {
    const e = entries.get(r.id) ?? { linkId: r.linkId, vehicleId: r.id, ip: null, agent: false, startedAt: now, lastActiveAt: now };
    e.linkId = r.linkId;
    if (r.armed) e.lastActiveAt = now;
    entries.set(r.id, e);
  }
}

export interface Pending {
  ip: string;
  agent: boolean;
}

export type Admission = { kind: "ok"; replace: SimEntry | null } | { kind: "full" };

/** Whether a new sim may start now; for a visitor, which of their sims it replaces. Offline sims do not count. */
export function admit(entries: readonly SimEntry[], offline: ReadonlySet<string>, pending: readonly Pending[], who: Pending, limits: SimLimits): Admission {
  const running = entries.filter((e) => !offline.has(e.vehicleId));
  // "local" is a loopback caller with no proxy in front (a laptop, an operator): no one-per-address rule there.
  const perIp = !who.agent && who.ip !== LOCAL;
  const replace = perIp ? (running.find((e) => !e.agent && e.ip === who.ip) ?? null) : null;
  if (perIp && pending.some((p) => !p.agent && p.ip === who.ip)) return { kind: "full" };
  const total = running.length - (replace ? 1 : 0) + pending.length;
  if (total >= limits.maxSims) return { kind: "full" };
  if (who.agent && running.filter((e) => e.agent).length + pending.filter((p) => p.agent).length >= agentShare(limits)) return { kind: "full" };
  return { kind: "ok", replace };
}

export interface ReapPlan {
  /** Links to stop (sim/stop). */
  stop: SimEntry[];
  /** Offline DroneX vehicle records to forget (vehicle/delete). */
  forget: string[];
}

/** What the reaper does this round, after `syncEntries`. */
export function reapPlan(entries: readonly SimEntry[], rows: readonly SimRow[], now: number, limits: SimLimits): ReapPlan {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const stop: SimEntry[] = [];
  const forget: string[] = [];
  for (const e of entries) {
    const r = byId.get(e.vehicleId);
    if (!r) continue;
    if (r.presence === "offline") {
      forget.push(e.vehicleId);
      if (e.linkId) stop.push(e);
      continue;
    }
    const tooOld = now - e.startedAt > limits.maxAgeMs;
    const idle = !r.armed && now - e.lastActiveAt > limits.idleMs;
    if (tooOld || idle) stop.push(e);
  }
  return { stop, forget };
}

export interface StoredDesign {
  id: string;
  createdAt: number;
  bytes: number;
  pinned: boolean;
}

/**
 * Which stored designs (.dronex/sim/<id>) to delete: unpinned, not flying, older than `maxAgeMs`; then the
 * oldest unpinned, not flying ones until the total is under `capBytes`.
 */
export function planStorePrune(designs: readonly StoredDesign[], flying: ReadonlySet<string>, now: number, maxAgeMs: number, capBytes: number): string[] {
  const removable = designs.filter((d) => !d.pinned && !flying.has(d.id)).sort((a, b) => a.createdAt - b.createdAt);
  const out = new Set(removable.filter((d) => now - d.createdAt > maxAgeMs).map((d) => d.id));
  let total = designs.reduce((s, d) => s + (out.has(d.id) ? 0 : d.bytes), 0);
  for (const d of removable) {
    if (total <= capBytes) break;
    if (out.has(d.id)) continue;
    out.add(d.id);
    total -= d.bytes;
  }
  return [...out];
}
