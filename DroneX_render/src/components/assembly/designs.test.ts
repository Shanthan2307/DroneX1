// Saved designs (prototype/drone-assembly/src/designs.js) and the Hangar's pure helpers (droneLibrary.js):
// round trip, garbage, unknown ids, incompatible parts, corrupt storage, broken designs kept, the mission matrix.
import { describe, expect, it } from "vitest";
import { droneCatalog, dronePresetIds, dronePresetToBuild, getDronePreset } from "../../../prototype/drone-assembly/src/data/droneCatalog.js";
import {
  DESIGNS_STORAGE_KEY,
  createDesign,
  designToBuild,
  duplicateDesign,
  loadDesigns,
  parseDesign,
  readDesignStore,
  removeDesign,
  renameDesign,
  saveDesigns,
  serializeDesign,
  upsertDesign,
  validateDesign,
} from "../../../prototype/drone-assembly/src/designs.js";
import { droneTypeBadge, fillFromAirframe, missionMatrix, repairBuild } from "../../../prototype/drone-assembly/src/droneLibrary.js";

const NOW = "2026-10-24T12:00:00.000Z";
const presetBuild = (id: string) => dronePresetToBuild(getDronePreset(id));
const firstPreset = dronePresetIds[0];
const sample = () => createDesign({ name: "  My   quad ", description: "for the park", basedOn: firstPreset, build: presetBuild(firstPreset) }, { id: "d-test-1", now: NOW });

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe("design model", () => {
  it("creates a clean, versioned, self-contained design", () => {
    const d = sample();
    expect(d.format).toBe("dronex.design");
    expect(d.version).toBe(1);
    expect(d.name).toBe("My quad");
    expect(d.createdAt).toBe(NOW);
    expect(d.build).not.toHaveProperty("livery");
    expect(validateDesign(d, droneCatalog).ok).toBe(true);
  });

  it("round-trips through serialize / parse", () => {
    const d = sample();
    const r = parseDesign(serializeDesign(d), droneCatalog);
    expect(r).toEqual({ ok: true, design: d });
  });

  it("every preset saves as a valid design and loads back as the same build", () => {
    for (const id of dronePresetIds) {
      const build = presetBuild(id);
      const d = createDesign({ name: id, build }, { id: `d-${id}`, now: NOW });
      const r = validateDesign(d, droneCatalog);
      expect(r.ok, id).toBe(true);
      const back = designToBuild(d);
      expect({ ...back, livery: undefined }).toEqual({ ...build, livery: undefined, payloadId: build.payloadId ?? "" });
    }
  });

  it("rejects garbage with a reason and never throws", () => {
    const junk: unknown[] = [null, undefined, 42, "x", [], {}, { format: "dronex.design" }, { ...sample(), version: 2 }, { ...sample(), name: "   " }, { ...sample(), id: "has spaces" }, { ...sample(), build: null }, { ...sample(), createdAt: "yesterday" }, { ...sample(), build: { ...sample().build, motorId: 7 } }];
    for (const j of junk) {
      const r = validateDesign(j, droneCatalog);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
    const throwing = Object.defineProperty({}, "format", { get: () => { throw new Error("boom"); } });
    expect(validateDesign(throwing, droneCatalog).ok).toBe(false);
    expect(parseDesign("{not json", droneCatalog)).toEqual({ ok: false, reason: "not valid JSON" });
    expect(parseDesign(12, droneCatalog).ok).toBe(false);
  });

  it("rejects unknown part ids, naming the part", () => {
    const d = sample();
    const r = validateDesign({ ...d, build: { ...d.build, batteryId: "no-such-pack" } }, droneCatalog);
    expect(r).toEqual({ ok: false, reason: "unknown battery id: no-such-pack" });
    expect(validateDesign({ ...d, build: { ...d.build, missionId: "moon" } }, droneCatalog).ok).toBe(false);
    expect(validateDesign({ ...d, build: { ...d.build, airframeId: "" } }, droneCatalog)).toEqual({ ok: false, reason: "no airframe chosen" });
  });

  it("rejects physically incompatible combinations with the reason", () => {
    // The largest propeller in the dataset on the smallest frame it cannot fit.
    const props = [...droneCatalog.propellers].sort((a, b) => b.diameter_in - a.diameter_in);
    const frame = droneCatalog.airframes.find((a) => typeof a.maxPropDiameter_in === "number" && a.maxPropDiameter_in < props[0].diameter_in);
    expect(frame).toBeTruthy();
    const d = sample();
    const r = validateDesign({ ...d, build: { ...d.build, airframeId: frame!.id, propellerId: props[0].id } }, droneCatalog);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^incompatible/);
  });

  it("list helpers are pure", () => {
    const d = sample();
    const list = upsertDesign([], d);
    const renamed = renameDesign(d, "Racer", NOW);
    expect(upsertDesign(list, renamed)).toEqual([renamed]);
    expect(list).toEqual([d]);
    const copy = duplicateDesign(d, { id: "d-copy", now: NOW });
    expect(copy).toMatchObject({ id: "d-copy", name: "My quad copy", basedOn: d.id, build: d.build });
    expect(removeDesign([d, copy], d.id)).toEqual([copy]);
  });
});

describe("design storage", () => {
  it("saves and loads under one versioned key", () => {
    const s = memoryStorage();
    expect(saveDesigns(s, [sample()])).toEqual({ ok: true });
    expect([...s.data.keys()]).toEqual([DESIGNS_STORAGE_KEY]);
    expect(loadDesigns(s, droneCatalog)).toEqual([sample()]);
  });

  it("tolerates corrupt, foreign or throwing storage", () => {
    for (const text of ["{oops", "null", "[]", '{"format":"other","version":1,"designs":[]}', '{"format":"dronex.designs","version":9,"designs":[]}', '{"format":"dronex.designs","version":1,"designs":"x"}']) {
      expect(loadDesigns(memoryStorage({ [DESIGNS_STORAGE_KEY]: text }), droneCatalog)).toEqual([]);
    }
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } };
    expect(loadDesigns(throwing, droneCatalog)).toEqual([]);
    expect(loadDesigns(null, droneCatalog)).toEqual([]);
    expect(saveDesigns(throwing, [sample()])).toEqual({ ok: false, reason: "full" });
  });

  it("keeps a design whose part disappeared as broken, with the reason, and writes it back", () => {
    const gone = { ...sample(), id: "d-gone", build: { ...sample().build, motorId: "retired-motor" } };
    const s = memoryStorage({ [DESIGNS_STORAGE_KEY]: JSON.stringify({ format: "dronex.designs", version: 1, designs: [sample(), gone, "junk", sample()] }) });
    const store = readDesignStore(s, droneCatalog);
    expect(store.designs.map((d) => d.id)).toEqual(["d-test-1"]);
    expect(store.broken).toHaveLength(1);
    expect(store.broken[0]).toMatchObject({ id: "d-gone", reason: "unknown motor id: retired-motor" });
    saveDesigns(s, store.designs, store.broken);
    expect(readDesignStore(s, droneCatalog).broken.map((b) => b.id)).toEqual(["d-gone"]);
    // Repair swaps only the missing part.
    const fixed = repairBuild(gone.build, droneCatalog) as { build: Record<string, unknown> | null; replaced: string[] };
    expect(fixed.replaced).toEqual(["motor"]);
    expect(fixed.build?.motorId).not.toBe("retired-motor");
    expect(fixed.build?.batteryId).toBe(gone.build.batteryId);
    expect(repairBuild({ ...gone.build, airframeId: "gone" }, droneCatalog).build).toBeNull();
  });
});

describe("hangar helpers", () => {
  it("names the drone type from the airframe record", () => {
    expect(droneTypeBadge({ type: "multirotor", motorCount: 4 }).label).toBe("quad");
    expect(droneTypeBadge({ type: "multirotor", motorCount: 6 }).label).toBe("hex");
    expect(droneTypeBadge({ type: "multirotor", motorCount: 4, ducted: true }).label).toBe("cinewhoop");
    expect(droneTypeBadge({ type: "fixed_wing_3dprint" }).label).toBe("fixed wing");
    expect(droneTypeBadge({ type: "vtol_quadplane" }).label).toBe("VTOL quadplane");
    expect(droneTypeBadge({ type: "blimp_thing" }).label).toBe("blimp thing");
    expect(droneTypeBadge(null).label).toBe("drone");
  });

  it("judges a build against every mission, never passing what it cannot judge", () => {
    const rows = missionMatrix(presetBuild(firstPreset), droneCatalog);
    expect(rows.map((r) => r.mission.id)).toEqual(droneCatalog.missions.map((m) => m.id));
    for (const r of rows) {
      expect(r.checks.map((c) => c.key)).toEqual(["parts", "weight", "endurance", "lift", "speed", "payload"]);
      for (const c of r.checks) expect(c.reason.length).toBeGreaterThan(0);
      if (r.ready) expect(r.failing).toBe(0);
    }
    // A multirotor without drag data cannot be judged on speed.
    const noDrag = droneCatalog.airframes.find((a) => a.type === "multirotor" && typeof a.dragCoefficient_cd !== "number");
    if (noDrag) {
      const fill = fillFromAirframe(noDrag.id, droneCatalog, { missionId: null });
      const speed = missionMatrix(fill.build!, droneCatalog).flatMap((r) => r.checks).filter((c) => c.key === "speed" && c.status !== "n/a");
      expect(speed.every((c) => c.status === "not-judged")).toBe(true);
    }
  });

  it("fills a new drone from any airframe, slot by slot", () => {
    for (const a of droneCatalog.airframes) {
      const { build, missing } = fillFromAirframe(a.id, droneCatalog, { missionId: null });
      expect(build?.airframeId).toBe(a.id);
      if (missing.length === 0) expect(validateDesign(createDesign({ name: a.name, build: build! }, { id: "d-x", now: NOW }), droneCatalog).ok, a.id).toBe(true);
    }
    expect(fillFromAirframe("nope", droneCatalog)).toEqual({ build: null, missing: ["airframe"] });
  });
});
