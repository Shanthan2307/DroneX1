// The drone path end to end, without a browser: every preset loads from the sourced datasets, lays out into
// drawable parts and gets a verdict computed in code (dronePhysics.js), with numbers that are finite and sane.
import { describe, expect, it } from "vitest";
import { droneCatalog, dronePresetIds, dronePresetToBuild, getDronePreset, droneReadiness } from "../../../prototype/drone-assembly/src/data/droneCatalog.js";
import { droneBuildManifest, droneSceneBounds } from "../../../prototype/drone-assembly/src/droneLayout.js";
import { evaluateDrone } from "../../../prototype/drone-assembly/src/dronePhysics.js";

describe("drone presets", () => {
  it("opens on the 5-inch freestyle quad", () => {
    expect(dronePresetIds[0]).toBe("apex-5-freestyle-quad");
  });

  for (const id of dronePresetIds) {
    it(`${id}: layout, verdict and readiness`, () => {
      const build = dronePresetToBuild(getDronePreset(id));
      const manifest = droneBuildManifest(build, droneCatalog);
      expect(manifest.length).toBeGreaterThan(3);
      expect(new Set(manifest.map((p) => p.id)).size).toBe(manifest.length);
      const bounds = droneSceneBounds(manifest);
      expect(bounds.radius_u).toBeGreaterThan(0);

      const verdict = evaluateDrone(build, droneCatalog);
      expect(verdict.vehicle).toBe("drone");
      expect(verdict.allUpWeight_g).toBeGreaterThan(0);
      expect(Number.isFinite(verdict.hoverTWR)).toBe(true);
      expect(verdict.hoverTWR).toBeGreaterThan(0);

      const mission = droneCatalog.missions.find((m) => m.id === build.missionId) ?? null;
      const ready = droneReadiness(verdict, mission);
      expect(typeof ready.ready).toBe("boolean");
      expect(ready.lines.length).toBeGreaterThan(0);
    });
  }
});
