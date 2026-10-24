// Vehicle facade: the one place main.js reaches the drone modules through (catalog, layout, physics,
// compatibility, readiness). Contract: docs/drone-integration.md.
import { droneCatalog } from "./data/droneCatalog.js";
import * as droneCatalogModule from "./data/droneCatalog.js";
import { droneBuildManifest, droneSceneBounds } from "./droneLayout.js";
import { evaluateDrone, droneDetails } from "./dronePhysics.js";
import { droneOptionsWithCompat } from "./droneCompat.js";

// Which drone slot a drawn drone part can be swapped in. The part spec carries this as spec.slot, but the
// card only hands us a kind, so the map lives here too. Derived structure (the avionics stack, the tail group)
// has no slot: it has no dataset record to choose between.
const DRONE_SLOT_OF_KIND = {
  "drone-frame": "airframe",
  "drone-fuselage": "airframe",
  "drone-wing": "airframe",
  "drone-arm": "motor",
  "drone-nose-motor": "motor",
  "drone-propeller": "propeller",
  "drone-nose-propeller": "propeller",
  "drone-battery": "battery",
  "drone-camera": "payload",
  "drone-electronics": null,
  "drone-tail": null,
};
export const droneSlotOfKind = (kind) => DRONE_SLOT_OF_KIND[kind] ?? null;

// ---------- presets ----------

// The Vehicles list and the [ / ] keys walk this list.
export const presetIds = droneCatalogModule.dronePresetIds;
export const getPreset = (id) => droneCatalogModule.getDronePreset(id) ?? null;
export const presetToBuild = (preset) => droneCatalogModule.dronePresetToBuild(preset);

// ---------- layout ----------

export const buildManifest = (build) => droneBuildManifest(build, droneCatalog);
export const sceneBounds = (manifest) => droneSceneBounds(manifest);

// ---------- physics ----------

export const evaluateBuild = (build) => evaluateDrone(build, droneCatalog);
export const partDetails = (build) => droneDetails(build, droneCatalog);

// ---------- options ----------

// kind is the part's kind as the card has it ("drone-arm", "drone-propeller", …). A part with no slot has no
// alternatives.
export function optionsWithCompat(build, kind) {
  const slot = droneSlotOfKind(kind);
  return slot ? droneOptionsWithCompat(build, droneCatalog, slot) : [];
}

export function applyOption(build, kind, recordId) {
  const slot = droneSlotOfKind(kind);
  return slot ? droneCatalogModule.applyDroneOption(build, slot, recordId) : { ...build };
}

// ---------- missions, readiness ----------

export const missionOf = (build) => droneCatalog.missions.find((m) => m.id === build?.missionId) ?? null;
export const destinations = () => droneCatalogModule.droneDestinations?.() ?? [];
export const readiness = (verdict, build) => droneCatalogModule.droneReadiness?.(verdict, missionOf(build)) ?? null;

// ---------- the one-line summary of a build, for the Vehicles list ----------

// "4-arm · 225 mm · 5.1" props → Urban scan".
export function droneMetaLine(build) {
  const airframe = droneCatalog.airframes.find((x) => x.id === build.airframeId);
  const propeller = droneCatalog.propellers.find((x) => x.id === build.propellerId);
  const mission = missionOf(build);
  const size =
    airframe?.type === "multirotor"
      ? `${airframe.motorCount}-arm · ${airframe.wheelbase_mm} mm`
      : `fixed wing · ${airframe?.wingspan_mm ?? "?"} mm span`;
  const prop = propeller ? ` · ${propeller.diameter_in}" props` : "";
  const dest = mission ? ` → ${mission.name}` : "";
  return `${size}${prop}${dest}`.replace(/\s+/g, " ").trim();
}
