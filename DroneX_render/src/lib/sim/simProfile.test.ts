// The simulation profile (prototype/drone-assembly/src/simProfile.js): every preset maps to an ArduPilot vehicle
// and frame, its footprint and parameters are finite and sane, and the drawn propellers land in motor order.
import { describe, expect, it } from "vitest";
import { droneCatalog, dronePresetIds, dronePresetToBuild, getDronePreset } from "../../../prototype/drone-assembly/src/data/droneCatalog.js";
import { evaluateDrone } from "../../../prototype/drone-assembly/src/dronePhysics.js";
import { MOTOR_BEARINGS, assignMotors, bearingOf, simKind, simProfile } from "../../../prototype/drone-assembly/src/simProfile.js";
import { modelBookmarkUrl } from "./fly";

const FRAMES_BY_TYPE: Record<string, [string, string]> = {
  multirotor: ["multicopter", "X"],
  fixed_wing_3dprint: ["plane", "plane"],
  vtol_quadplane: ["vtol", "quadplane"],
};

describe("simulation profile", () => {
  for (const id of dronePresetIds) {
    it(`${id}: vehicle, frame, footprint and parameters`, () => {
      const build = dronePresetToBuild(getDronePreset(id));
      const verdict = evaluateDrone(build, droneCatalog);
      const p = simProfile({ build, verdict, catalog: droneCatalog, name: getDronePreset(id).name });
      const airframe = droneCatalog.airframes.find((a: { id: string }) => a.id === build.airframeId);
      if (!airframe) throw new Error(`${id}: airframe ${build.airframeId} missing`);
      const [vehicle, frame] = FRAMES_BY_TYPE[airframe.type];
      expect(p.vehicle).toBe(vehicle);
      if (airframe.type === "multirotor" && airframe.motorCount === 6) expect(p.frame).toBe("hexax");
      else expect(p.frame).toBe(frame);
      expect(p.span_m).toBeGreaterThan(0.05);
      expect(p.span_m).toBeLessThan(5);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.name.length).toBeLessThanOrEqual(64);
      for (const q of p.params) {
        expect(q.name).toMatch(/^[A-Z0-9_]{1,16}$/);
        expect(Number.isFinite(q.value)).toBe(true);
      }
      const names = p.params.map((q) => q.name);
      expect(names).toContain("BATT_CAPACITY");
      if (p.base === "multicopter") {
        const hover = p.params.find((q) => q.name === "MOT_THST_HOVER");
        expect(hover?.value).toBeGreaterThanOrEqual(0.125);
        expect(hover?.value).toBeLessThanOrEqual(0.6875);
      }
      if (p.base === "vtol") expect(names).toContain("Q_M_THST_HOVER");
      if (p.base === "plane") {
        const min = p.params.find((q) => q.name === "AIRSPEED_MIN");
        expect(min).toBeDefined();
        expect(Number.isInteger(min?.value)).toBe(true); // ArduPilot stores it as a whole number
        const cruise = p.params.find((q) => q.name === "AIRSPEED_CRUISE");
        if (cruise && min) expect(cruise.value).toBeGreaterThan(min.value);
      }
    });
  }

  it("knows the three VTOL and wing airframe kinds", () => {
    expect(simKind({ type: "vtol_tiltrotor", motorCount: 3 })).toMatchObject({ vehicle: "vtol", frame: "quadplane-tilttri" });
    expect(simKind({ type: "fixed_wing_3dprint", motorCount: 1 })).toMatchObject({ vehicle: "plane", frame: "plane", spinner: "Propeller" });
    expect(simKind({ type: "multirotor", motorCount: 8 })).toMatchObject({ frame: "octa" });
    expect(simKind(null)).toMatchObject({ vehicle: "plane" });
  });

  it("measures bearings clockwise from the nose (+Z), with +X on the left", () => {
    expect(bearingOf(0, 1)).toBeCloseTo(0);
    expect(bearingOf(-1, 0)).toBeCloseTo(90); // right
    expect(bearingOf(0, -1)).toBeCloseTo(180);
    expect(bearingOf(1, 0)).toBeCloseTo(270); // left
  });

  it("puts a quad's propellers in ArduPilot X order: front-right, rear-left, front-left, rear-right", () => {
    // The configurator's four arms: angles 45°, 135°, 225°, 315° from +X toward +Z (droneLayout.js).
    const props = [45, 135, 225, 315].map((deg, index) => {
      const a = (deg * Math.PI) / 180;
      return { index, bearing_deg: bearingOf(Math.cos(a), Math.sin(a)) };
    });
    const ordered = assignMotors(props, MOTOR_BEARINGS.X);
    expect(ordered.map((p) => p.index)).toEqual([1, 3, 0, 2]);
  });

  it("falls back to clockwise order when the count does not match the layout", () => {
    const props = [200, 10, 100].map((bearing_deg) => ({ bearing_deg }));
    expect(assignMotors(props, MOTOR_BEARINGS.X).map((p) => p.bearing_deg)).toEqual([10, 100, 200]);
  });

  it("writes the model bookmark URL the simulation UI reads", () => {
    const url = modelBookmarkUrl("http://localhost:3000", "s-0123456789ab", {
      name: "Quad",
      vehicle: "multicopter",
      frame: "X",
      base: "multicopter",
      spinner: null,
      span_m: 0.352,
      params: [],
      rotors: [{ ccw: false }, { ccw: false }, { ccw: true }, { ccw: true }],
    });
    const u = new URL(url);
    expect(u.pathname).toBe("/api/sim/designs/s-0123456789ab/model.glb");
    expect(u.searchParams.get("base")).toBe("multicopter");
    expect(u.searchParams.get("span")).toBe("0.352");
    expect(u.searchParams.get("rotors")).toBe("0011");
    expect(u.searchParams.has("spinner")).toBe(false);
  });
});
