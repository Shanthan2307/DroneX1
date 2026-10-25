import { describe, expect, it } from "vitest";
import { admit, agentShare, planStorePrune, reapPlan, simLimits, syncEntries, type SimEntry, type SimRow } from "./limits";

const MIN = 60_000;
const limits = { maxSims: 4, idleMs: 10 * MIN, maxAgeMs: 30 * MIN };
const entry = (vehicleId: string, over: Partial<SimEntry> = {}): SimEntry => ({ linkId: `l-${vehicleId}`, vehicleId, ip: null, agent: false, startedAt: 0, lastActiveAt: 0, ...over });
const row = (id: string, over: Partial<SimRow> = {}): SimRow => ({ id, linkId: `l-${id}`, presence: "online", armed: false, designId: "s-000000000000", ...over });
const none = new Set<string>();

describe("simLimits", () => {
  it("defaults to 8 sims, 10 min idle, 30 min max, and stays under Core's 32", () => {
    expect(simLimits({})).toEqual({ maxSims: 8, idleMs: 10 * MIN, maxAgeMs: 30 * MIN });
    expect(simLimits({ DRONEX_MAX_SIMS: "100" }).maxSims).toBe(31);
    expect(simLimits({ DRONEX_MAX_SIMS: "-1", DRONEX_SIM_IDLE_MIN: "5" })).toMatchObject({ maxSims: 8, idleMs: 5 * MIN });
    expect(agentShare(limits)).toBe(2);
  });
});

describe("admit", () => {
  it("refuses at the cap and lets offline sims not count", () => {
    const four = ["a", "b", "c", "d"].map((id) => entry(id, { ip: id }));
    expect(admit(four, none, [], { ip: "z", agent: false }, limits)).toEqual({ kind: "full" });
    expect(admit(four, new Set(["a"]), [], { ip: "z", agent: false }, limits)).toEqual({ kind: "ok", replace: null });
  });

  it("counts sims still starting", () => {
    const three = ["a", "b", "c"].map((id) => entry(id, { ip: id }));
    expect(admit(three, none, [{ ip: "y", agent: false }], { ip: "z", agent: false }, limits)).toEqual({ kind: "full" });
  });

  it("replaces the visitor's own sim, even at the cap", () => {
    const four = ["a", "b", "c", "d"].map((id) => entry(id, { ip: id }));
    const r = admit(four, none, [], { ip: "b", agent: false }, limits);
    expect(r).toEqual({ kind: "ok", replace: four[1] });
  });

  it("refuses a second Fly from the same address while the first is starting", () => {
    expect(admit([], none, [{ ip: "1.2.3.4", agent: false }], { ip: "1.2.3.4", agent: false }, limits)).toEqual({ kind: "full" });
  });

  it("has no one-per-address rule for loopback callers", () => {
    const mine = [entry("a", { ip: "local" })];
    expect(admit(mine, none, [{ ip: "local", agent: false }], { ip: "local", agent: false }, limits)).toEqual({ kind: "ok", replace: null });
  });

  it("keeps the agents within their share and never replaces for them", () => {
    const agents = [entry("a", { agent: true }), entry("b", { agent: true })];
    expect(admit(agents, none, [], { ip: "local", agent: true }, limits)).toEqual({ kind: "full" });
    expect(admit(agents.slice(0, 1), none, [], { ip: "local", agent: true }, limits)).toEqual({ kind: "ok", replace: null });
  });
});

describe("syncEntries", () => {
  it("adds DroneX vehicles, drops vanished ones, refreshes links and marks armed ones active", () => {
    const m = new Map<string, SimEntry>([
      ["gone", entry("gone")],
      ["a", entry("a", { linkId: "old", ip: "1.1.1.1", startedAt: 5 })],
    ]);
    syncEntries(m, [row("a", { linkId: "new", armed: true }), row("b"), row("other", { designId: null })], 1000);
    expect([...m.keys()].sort()).toEqual(["a", "b"]);
    expect(m.get("a")).toMatchObject({ linkId: "new", ip: "1.1.1.1", startedAt: 5, lastActiveAt: 1000 });
    expect(m.get("b")).toMatchObject({ ip: null, startedAt: 1000, lastActiveAt: 1000 });
  });
});

describe("reapPlan", () => {
  it("stops idle, old and offline sims and forgets offline records", () => {
    const now = 40 * MIN;
    const entries = [
      entry("busy", { startedAt: now - MIN, lastActiveAt: now - 20 * MIN }),
      entry("idle", { startedAt: now - 15 * MIN, lastActiveAt: now - 11 * MIN }),
      entry("fresh", { startedAt: now - 5 * MIN, lastActiveAt: now - 5 * MIN }),
      entry("old", { startedAt: now - 31 * MIN, lastActiveAt: now }),
      entry("dead", { startedAt: now - MIN, lastActiveAt: now }),
    ];
    const rows = [row("busy", { armed: true }), row("idle"), row("fresh"), row("old", { armed: true }), row("dead", { presence: "offline" })];
    const plan = reapPlan(entries, rows, now, limits);
    expect(plan.stop.map((e) => e.vehicleId).sort()).toEqual(["dead", "idle", "old"]);
    expect(plan.forget).toEqual(["dead"]);
  });
});

describe("planStorePrune", () => {
  const DAY = 24 * 60 * MIN;
  const now = 10 * DAY;
  it("deletes old designs that are neither pinned nor flying", () => {
    const designs = [
      { id: "old", createdAt: now - 2 * DAY, bytes: 1, pinned: false },
      { id: "pinned", createdAt: now - 2 * DAY, bytes: 1, pinned: true },
      { id: "flying", createdAt: now - 2 * DAY, bytes: 1, pinned: false },
      { id: "new", createdAt: now - 1000, bytes: 1, pinned: false },
    ];
    expect(planStorePrune(designs, new Set(["flying"]), now, DAY, 1e9)).toEqual(["old"]);
  });

  it("deletes the oldest removable ones until under the size cap", () => {
    const designs = [
      { id: "a", createdAt: now - 3000, bytes: 50, pinned: false },
      { id: "b", createdAt: now - 2000, bytes: 50, pinned: false },
      { id: "c", createdAt: now - 1000, bytes: 50, pinned: false },
      { id: "p", createdAt: now - 5000, bytes: 50, pinned: true },
    ];
    expect(planStorePrune(designs, new Set(), now, DAY, 120)).toEqual(["a", "b"]);
  });
});
