// The build assistant's tools, without a model: they read the dataset and run the physics, so their answers are
// the same numbers the configurator shows; changes are validated before the page sees them.
import { describe, expect, it } from "vitest";
import { forSpeech, runAssistantTool, type AssistantRequest, type Change } from "./assistant";
import { catalogEntries, type Build } from "@/lib/catalog/server";

const preset = (id: string): Build => {
  const p = catalogEntries().find((e) => e.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return { ...p.build };
};

const run = (name: string, args: Record<string, unknown>, req: AssistantRequest) => {
  const out = { suggestions: [] as Change[], apply: [] as Change[] };
  const result = JSON.parse(runAssistantTool(name, args, req, out)) as Record<string, unknown>;
  return { result, out };
};

const ask = (build: Build): AssistantRequest => ({ messages: [{ role: "user", content: "?" }], build, name: "test" });

describe("build assistant tools", () => {
  it("describes the drone on the pad with its parts, estimates and mission checks", () => {
    const { result } = run("build_overview", {}, ask(preset("apex-5-medical-courier")));
    const parts = result.parts as Record<string, { name: string }>;
    expect(parts.battery.name).toMatch(/Tattu/);
    expect((result.estimates as { allUpWeight_g: number }).allUpWeight_g).toBeGreaterThan(0);
    expect((result.missionResult as { ready: boolean }).ready).toBe(false);
  });

  it("explains a part by slot, by id, or by the name the model says", () => {
    const req = ask(preset("apex-5-freestyle-quad"));
    const bySlot = run("part_info", { slot: "battery" }, req).result;
    expect((bySlot.role as { does: string }).does).toMatch(/energy/);
    expect(bySlot.fittedOnThisDrone).toBe(true);
    const byName = run("part_info", { part_id: "T-Motor F60 Pro IV V2.0" }, req).result;
    expect((byName.record as { id: string }).id).toBe("tmotor-f60-pro-iv");
  });

  it("lists a slot's options with compatibility and the mission result with each", () => {
    const { result } = run("slot_options", { slot: "motor" }, ask({ ...preset("apex-5-urban-light"), missionId: "fpv-sprint-160kmh" }));
    const f60 = (result.options as { id: string; missionReadyWithIt?: boolean }[]).find((o) => o.id === "tmotor-f60-pro-iv");
    expect(f60?.missionReadyWithIt).toBe(true);
  });

  it("finds the swap the physics passes and offers it as a button", () => {
    const { result, out } = run("find_fixes", {}, ask({ ...preset("apex-5-urban-light"), missionId: "fpv-sprint-160kmh" }));
    expect((result.fixes as unknown[]).length).toBeGreaterThan(0);
    expect(out.suggestions.some((c) => c.kind === "swap" && c.partId === "tmotor-f60-pro-iv")).toBe(true);
  });

  it("says plainly when nothing in the dataset passes", () => {
    const { result, out } = run("find_fixes", {}, ask(preset("apex-5-medical-courier")));
    expect(result.fixes).toEqual([]);
    expect(out.suggestions).toEqual([]);
  });

  it("judges a change before and after, and offers it when it turns a fail into a pass", () => {
    const { result, out } = run("try_change", { slot: "motor", part_id: "tmotor-f60-pro-iv" }, ask({ ...preset("apex-5-urban-light"), missionId: "fpv-sprint-160kmh" }));
    expect((result.missionBefore as { ready: boolean }).ready).toBe(false);
    expect((result.missionAfter as { ready: boolean }).ready).toBe(true);
    expect(out.suggestions).toHaveLength(1);
  });

  it("applies only valid changes, and later tools see the changed drone", () => {
    const req = ask({ ...preset("apex-5-urban-light"), missionId: "fpv-sprint-160kmh" });
    expect(run("apply_change", { slot: "motor", part_id: "no-such-motor", why: "x" }, req).result.error).toBeTruthy();
    const { out } = run("apply_change", { part_id: "T-Motor F60 Pro IV V2.0", why: "passes" }, req);
    expect(out.apply[0]).toMatchObject({ kind: "swap", slot: "motor", partId: "tmotor-f60-pro-iv" });
    expect(req.build.motorId).toBe("tmotor-f60-pro-iv");
    expect((run("build_overview", {}, req).result.missionResult as { ready: boolean }).ready).toBe(true);
  });

  it("reads a mission's requirements", () => {
    const { result } = run("mission_info", { mission_id: "sub-250-urban-scan" }, ask(preset("apex-5-freestyle-quad")));
    expect((result.requirements as { maxAllowableWeight_g: number }).maxAllowableWeight_g).toBe(249);
  });
});

describe("forSpeech", () => {
  it("drops the markdown a model adds so Sonic does not read it", () => {
    expect(forSpeech("This fails for **two** reasons:\n\n1. **Current:** 168 A\n2. Endurance\n- done")).toBe("This fails for two reasons: Current: 168 A Endurance done");
  });
});
