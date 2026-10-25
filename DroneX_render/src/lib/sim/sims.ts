// The simulator cap and the reapers, with their Core calls (the decisions are in limits.ts). One registry per
// server process, shared through globalThis because route modules are bundled separately. Every Fly and every
// Dispatch refly reserves a slot first; the reaper (started from src/instrumentation.ts in production) syncs the
// registry with Core every minute and stops idle, old and offline sims; the store reaper prunes old design
// folders every hour. Server-only.
import type { CoreClient } from "./core";
import { admit, planStorePrune, reapPlan, simLimits, syncEntries, type Pending, type SimEntry } from "./limits";
import { deleteFlight, storedDesigns } from "./store";
import { listVehicles, withCore, type VehicleRow } from "./tools";

interface Registry {
  entries: Map<string, SimEntry>;
  pending: Map<number, Pending>;
  nextPending: number;
  timers: NodeJS.Timeout[];
}

const g = globalThis as unknown as { __dronexSims?: Registry };
const registry = (): Registry => (g.__dronexSims ??= { entries: new Map(), pending: new Map(), nextPending: 1, timers: [] });

export const SIM_FULL = "simulator full, try again in a few minutes";

async function sync(c: CoreClient): Promise<VehicleRow[]> {
  const rows = await listVehicles(c);
  syncEntries(registry().entries, rows, Date.now());
  return rows;
}

async function stopLink(c: CoreClient, linkId: string): Promise<void> {
  try {
    await c.call("sim/stop", { id: linkId });
  } catch (e) {
    console.warn(`[dronex sims] sim/stop ${linkId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface Slot {
  /** Records the started sim against this visitor (or the agents). */
  commit(started: { vehicleId: string; linkId: string }): void;
  /** Frees the reservation; call in `finally`. */
  release(): void;
}

/**
 * Reserves room for one new sim: refuses when the cap (or the agents' share) is reached, and stops this
 * visitor's previous sim first. Returns null when full.
 */
export async function reserveSim(who: Pending): Promise<Slot | null> {
  const reg = registry();
  const decision = await withCore(async (c) => {
    const rows = await sync(c);
    const offline = new Set(rows.filter((r) => r.presence === "offline").map((r) => r.id));
    const a = admit([...reg.entries.values()], offline, [...reg.pending.values()], who, simLimits());
    if (a.kind === "ok" && a.replace) {
      await stopLink(c, a.replace.linkId);
      reg.entries.delete(a.replace.vehicleId);
    }
    return a;
  });
  if (decision.kind === "full") return null;
  const key = reg.nextPending++;
  reg.pending.set(key, who);
  return {
    commit: ({ vehicleId, linkId }) => {
      const now = Date.now();
      reg.entries.set(vehicleId, { vehicleId, linkId, ip: who.agent ? null : who.ip, agent: who.agent, startedAt: now, lastActiveAt: now });
    },
    release: () => void reg.pending.delete(key),
  };
}

/** A command reached this vehicle: it is in use, so the idle clock restarts. */
export function touchSim(vehicleId: string): void {
  const e = registry().entries.get(vehicleId);
  if (e) e.lastActiveAt = Date.now();
}

/** Stops the simulator link of one Core vehicle (the agents' TTL). False when there is no such vehicle. */
export async function stopVehicle(vehicleId: string): Promise<boolean> {
  return withCore(async (c) => {
    const v = (await listVehicles(c)).find((x) => x.id === vehicleId);
    if (!v) return false;
    await c.call("sim/stop", { id: v.linkId });
    registry().entries.delete(vehicleId);
    return true;
  });
}

/** One reaper round: sync, then stop what is idle, old or offline, and forget offline DroneX records. */
export async function reapOnce(): Promise<void> {
  await withCore(async (c) => {
    const rows = await sync(c);
    const reg = registry();
    const plan = reapPlan([...reg.entries.values()], rows, Date.now(), simLimits());
    for (const e of plan.stop) {
      console.log(`[dronex sims] stopping ${e.vehicleId} (link ${e.linkId})`);
      await stopLink(c, e.linkId);
    }
    for (const id of plan.forget) {
      try {
        await c.call("vehicle/delete", { id });
        reg.entries.delete(id);
      } catch {
        // still heard: next round
      }
    }
  });
}

const STORE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STORE_CAP_BYTES = 2 * 1024 ** 3;

/** Deletes design folders older than a day (or the oldest, past 2 GB) that are neither pinned nor flying. */
export async function pruneStore(): Promise<void> {
  const flying = await withCore(async (c) => new Set((await listVehicles(c)).map((v) => v.designId).filter((d): d is string => d !== null))).catch(() => null);
  if (!flying) return; // without Core we cannot tell what is flying: keep everything
  const doomed = planStorePrune(await storedDesigns(), flying, Date.now(), STORE_MAX_AGE_MS, STORE_CAP_BYTES);
  for (const id of doomed) await deleteFlight(id);
  if (doomed.length) console.log(`[dronex sims] pruned ${doomed.length} stored design(s)`);
}

const quietly = (what: string, fn: () => Promise<void>) => () =>
  void fn().catch((e: unknown) => console.warn(`[dronex sims] ${what}: ${e instanceof Error ? e.message : String(e)}`));

/** Starts the sim reaper (every 60 s, first round now, which rebuilds the registry) and the store reaper (hourly). */
export function startReapers(): void {
  const reg = registry();
  if (reg.timers.length) return;
  const reap = quietly("reaper", reapOnce);
  const prune = quietly("store reaper", pruneStore);
  reap();
  reg.timers.push(setInterval(reap, 60_000), setInterval(prune, 60 * 60_000));
  for (const t of reg.timers) t.unref();
}
