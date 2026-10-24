// DroneX's dataset. airframes/motors/propellers/batteries/payloads/missions.json in drone/ are the single
// source of truth for every real-world number (SOURCES.md lists the citation behind every record), and
// drone/presets.json holds the buildable drones. This module serves the records, the preset list, the slot
// options, and the readiness panel's wording. The verdict itself is dronePhysics.js's job; nothing here decides whether a
// vehicle flies, it only reads the verdict's fields (docs/drone-integration.md §7) and puts them in words.
import airframes from "./drone/airframes.json";
import motors from "./drone/motors.json";
import propellers from "./drone/propellers.json";
import batteries from "./drone/batteries.json";
import payloads from "./drone/payloads.json";
import missions from "./drone/missions.json";
import presets from "./drone/presets.json";
import { DRONE_RULES } from "../dronePhysics.js";

export const droneCatalog = {
  airframes,
  motors,
  propellers,
  batteries,
  payloads,
  missions,
  presets,
};

// Its own one-liner rather than catalog.js's, so loading a drone never pulls the whole rocket dataset in.
const byId = (list, id) => (list ?? []).find((x) => x.id === id);

// Display order for [ / ] switching; the 5" freestyle quad first, as the Falcon 9 is first for rockets.
export const dronePresetIds = [
  "apex-5-freestyle-quad",
  "apex-5-urban-light",
  "apex-5-medical-courier",
  "eclipson-model-a-scout",
  "cinelog25-urban-whoop",
  "chimera7-longrange",
  "tarot-x6-mapping",
  "vtbird-vtol-mapping",
];

export function getDronePreset(id) {
  return byId(presets, id);
}

// Livery is part of the team's BuildState and the drone cards take their colours from the materials, not from
// the build; this is the same neutral default catalog.js uses for rockets.
const DEFAULT_LIVERY = { primary: "#ffffff", accent: "#111111", stripe: false, patch: null };

// Preset -> the drone BuildState (docs/drone-integration.md §1, the object evaluateDrone takes). Drops the
// preset's own note and source, which are prose for the human, not inputs to the physics.
export function dronePresetToBuild(preset) {
  return {
    airframeId: preset.airframeId,
    motorId: preset.motorId,
    propellerId: preset.propellerId,
    batteryId: preset.batteryId,
    payloadId: preset.payloadId,
    missionId: preset.missionId,
    // A quadplane preset also names its forward cruise motor and propeller; they have no shelf slot, and
    // dronePhysics.evaluateDrone ignores them on any airframe without cruise motors.
    ...(preset.cruiseMotorId ? { cruiseMotorId: preset.cruiseMotorId } : {}),
    ...(preset.cruisePropellerId ? { cruisePropellerId: preset.cruisePropellerId } : {}),
    livery: { ...DEFAULT_LIVERY },
  };
}

// --- slots: every part can be swapped for another record of its kind -------------------------------------
// slot: "airframe" | "motor" | "propeller" | "battery" | "payload" (singular and plural both accepted, as
// catalog.js's KIND map does, because the manifest's PartSpec.slot is singular while callers often say the
// plural). Derived parts (the electronics stack, the tail) have no records: no options, and applyDroneOption
// leaves the build as it is.
const SLOT = {
  airframe: "airframe",
  airframes: "airframe",
  motor: "motor",
  motors: "motor",
  propeller: "propeller",
  propellers: "propeller",
  battery: "battery",
  batteries: "battery",
  payload: "payload",
  payloads: "payload",
};

// Which build field each slot writes. One place, so applyDroneOption and the option list cannot drift apart.
const SLOT_FIELD = {
  airframe: "airframeId",
  motor: "motorId",
  propeller: "propellerId",
  battery: "batteryId",
  payload: "payloadId",
};

const SLOT_LIST = {
  airframe: () => droneCatalog.airframes,
  motor: () => droneCatalog.motors,
  propeller: () => droneCatalog.propellers,
  battery: () => droneCatalog.batteries,
  payload: () => droneCatalog.payloads,
};

// Ties break on name so the shelf order never depends on the dataset's file order.
const byNumbersThenName = (...values) => (a, b) => {
  for (const value of values) {
    const d = (value(a) ?? 0) - (value(b) ?? 0);
    if (d) return d;
  }
  return a.name.localeCompare(b.name);
};

// Airframe type order is the story order the configurator tells, not alphabetical: the quad is the vehicle the
// demo opens on, the fixed wing is the second thing it can become, and the two VTOLs sit after them. An
// unknown type sorts last, by its own name, so a new record never disappears off the shelf.
const AIRFRAME_TYPE_ORDER = ["multirotor", "fixed_wing_3dprint", "vtol_quadplane", "vtol_tiltrotor"];
const airframeTypeRank = (a) => {
  const i = AIRFRAME_TYPE_ORDER.indexOf(a.type);
  return i === -1 ? AIRFRAME_TYPE_ORDER.length : i;
};
// The widest horizontal extent a record states: a multirotor gives a wheelbase, a winged airframe a wingspan.
const airframeSpan_mm = (a) => a.wheelbase_mm ?? a.wingspan_mm ?? 0;

// All records for a slot, in the order the option shelf shows them, smallest first in each case:
//   airframes  by type (quad, wing, VTOL) then wheelbase or wingspan;
//   motors     by stator diameter then stator height then KV — stator size is how motors are ranked, and the
//              two numbers together are the size; KV separates the windings of one stator;
//   propellers by diameter then pitch then blade count;
//   batteries  by cell count then capacity, which is how a pack is named;
//   payloads   by weight, the number that decides whether a vehicle can carry one.
// build is accepted for the slot's context but does not filter: whether a part fits is droneCompat.js's job
// and whether it flies is dronePhysics.js's, exactly as catalog.optionsFor leaves mismatches to the physics.
export function droneOptionsFor(slot, build) {
  const s = SLOT[slot];
  switch (s) {
    case "airframe":
      return [...droneCatalog.airframes].sort(
        (a, b) => airframeTypeRank(a) - airframeTypeRank(b) || byNumbersThenName(airframeSpan_mm)(a, b),
      );
    case "motor":
      return [...droneCatalog.motors].sort(
        byNumbersThenName((m) => m.statorDiameter_mm, (m) => m.statorHeight_mm, (m) => m.kv),
      );
    case "propeller":
      return [...droneCatalog.propellers].sort(
        byNumbersThenName((p) => p.diameter_mm, (p) => p.pitch_in, (p) => p.bladeCount),
      );
    case "battery":
      return [...droneCatalog.batteries].sort(byNumbersThenName((b) => b.cells_s, (b) => b.capacity_mAh));
    case "payload":
      return [...droneCatalog.payloads].sort(byNumbersThenName((p) => p.weight_g));
    default:
      return [];
  }
}

// A NEW drone BuildState with recordId swapped into the slot. Unknown slots, unknown record ids and picking
// the record that is already there all return an unchanged copy, so a caller can swap first and ask questions
// after. Nothing is mutated: the shelf keeps the old build to compare against.
export function applyDroneOption(build, slot, recordId) {
  const next = { ...build, livery: build?.livery ? { ...build.livery } : build?.livery };
  const s = SLOT[slot];
  const field = SLOT_FIELD[s];
  if (!field || next[field] === recordId || !byId(SLOT_LIST[s](), recordId)) return next;
  next[field] = recordId;
  return next;
}

// ---------- destination picker + flight readiness (the drone half of catalog.js's destinations/readiness) ----------
// droneDestinations(): one entry per mission, labels short enough for a button. `to` finishes the panel's
// sentence the way "to orbit" does for a rocket; a drone goes somewhere a lot nearer.
const DESTINATIONS = [
  { id: "urban-scan", label: "Urban scan", missionId: "sub-250-urban-scan", to: "over the city blocks" },
  { id: "medical-run", label: "Medical run", missionId: "medical-delivery-15km", to: "to the next clinic" },
  { id: "search-rescue", label: "Search & rescue", missionId: "sar-thermal-grid-40min", to: "over the search grid" },
  { id: "fpv-sprint", label: "FPV sprint", missionId: "fpv-sprint-160kmh", to: "down the canyon line" },
  { id: "ridge-run", label: "Long-range run", missionId: "longrange-fpv-10km", to: "along the ridge and back" },
  { id: "crop-survey", label: "Crop survey", missionId: "multispectral-survey-hex", to: "over the survey field" },
];
export const droneDestinations = () =>
  DESTINATIONS.filter((d) => byId(droneCatalog.missions, d.missionId)).map(({ id, label, missionId }) => ({ id, label, missionId }));

// Warnings in plain words, the same trick catalog.js's PLAIN_PROBLEM pulls: a rule's own wording is precise
// but technical, and the readiness panel is the one place that speaks to someone who has never built a drone.
// A warning no row matches is shown as it is, so a new rule is never silently swallowed.
const PLAIN_PROBLEM = [
  [/discharge|current/i, "pack can't supply the current"],
  [/wider than|prop diameter|too big for/i, "propeller too big for this frame"],
  [/mount|bolt pattern/i, "motor doesn't bolt to this frame"],
  [/cells|voltage|volts/i, "wrong number of cells for this motor"],
  [/wing loading/i, "wing loading too high to fly safely"],
  [/payload/i, "payload too heavy for this vehicle"],
];
const plainProblem = (w) => PLAIN_PROBLEM.find(([re]) => re.test(w))?.[1] ?? w;

const minutes = (m) => `${Math.round(m)} min`;

// The app's own lift rule for this vehicle, the same one dronePhysics' twrOk applies: a rotorcraft (multirotor or
// VTOL) must hover with HOVER_TWR_OK to spare; a pure wing only needs static thrust to climb away from a launch.
export const appLiftRule = (verdict) =>
  verdict?.airframeType === "multirotor" || String(verdict?.airframeType ?? "").startsWith("vtol")
    ? DRONE_RULES.HOVER_TWR_OK
    : DRONE_RULES.WING_STATIC_TWR_MIN;

// droneReadiness(verdict, mission) -> { ready, title, to, lines: [{ key: "lift" | "endurance" | "weight" |
// "parts" | "speed", ok, text }], toFix } — the same shape catalog.readiness returns, so the panel renders it unchanged.
// verdict: dronePhysics.evaluateDrone of the finished drone; mission: a missions.json record (or its id), or none.
// Each line's threshold is the binding one and is shown, so the words and the verdict can never disagree:
//   lift      the rule's hover TWR or the mission's, whichever is higher;
//   endurance the mission's target, so with no mission there is nothing to be ready for (catalog.js says
//             "Destination: not picked" in the same spot);
//   weight    the mission's own ceiling, or the 250 g registration threshold when no mission is picked.
export function droneReadiness(verdict, mission) {
  const m = typeof mission === "string" ? byId(droneCatalog.missions, mission) : mission ?? null;
  const problems = [...new Set((verdict.warnings ?? []).filter((w) => !/TWR|thrust-to-weight/i.test(w)).map(plainProblem))];

  const twr = verdict.hoverTWR ?? verdict.liftoffTWR ?? 0;
  const needTWR = Math.max(appLiftRule(verdict), m?.requiredHoverTWR ?? 0);
  const liftOk = twr >= needTWR;

  // The mission flies a mixed profile, not a pure hover, so its endurance is the mixed figure where there is one.
  // No figure at all (a wing without drag data cannot be flown in the model) is "not judged", never 0 min.
  const endurance = verdict.mixedTime_min ?? verdict.hoverTime_min ?? null;
  const needEndurance = m?.targetEndurance_min ?? 0;
  const enduranceOk = endurance === null || endurance >= needEndurance;

  const weight_g = verdict.allUpWeight_g ?? 0;
  const weightLimit = m?.maxAllowableWeight_g ?? DRONE_RULES.SUB_250_G;
  const weightOk = weight_g <= weightLimit;

  const lines = [
    {
      key: "lift",
      ok: liftOk,
      text: liftOk ? `Lift: ${twr.toFixed(1)}× weight` : `Lift: ${twr.toFixed(1)}× · need ${needTWR.toFixed(1)}×`,
    },
    m
      ? {
          key: "endurance",
          ok: enduranceOk,
          text: endurance === null
            ? "Endurance: not judged · no drag data to model the flight"
            : enduranceOk
            ? `Endurance: ${minutes(endurance)} · needs ${minutes(needEndurance)}`
            : `Endurance: ${minutes(endurance)} · ${minutes(needEndurance - endurance)} short`,
        }
      : { key: "endurance", ok: false, text: "Mission: not picked" },
    {
      key: "weight",
      ok: weightOk,
      text: weightOk
        ? `Weight: ${Math.round(weight_g)} g · under ${Math.round(weightLimit)} g`
        : `Weight: ${Math.round(weight_g)} g · over the ${Math.round(weightLimit)} g limit`,
    },
    {
      key: "parts",
      ok: problems.length === 0,
      text: problems.length === 0 ? "Parts: all good" : `Parts: ${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems[0]}`,
    },
  ];
  // The mission's speed bar has no warning of its own in the verdict, so without this line a build that is too
  // slow would read CLEARED here while the Test panel says it fails. Shown only when the verdict judged it short
  // (missionOk.speed === false); a speed it could not judge is the Test panel's "not judged", not a failure.
  if (m && verdict.missionOk?.speed === false) {
    const have = verdict.cruiseSpeed_ms ?? verdict.maxSpeed_ms ?? 0;
    lines.push({ key: "speed", ok: false, text: `Speed: ${have.toFixed(1)} m/s · needs ${Number(m.minCruiseSpeed_ms).toFixed(1)} m/s` });
  }

  // feasible says the vehicle can fly at all, and only the physics decides that. The mission's own bars
  // (§7 reports them as missionOk and keeps them out of feasible) are extra: a drone that flies but misses the
  // mission is not cleared for this flight, so a panel with an unmet line never says CLEARED TO FLY.
  const ready = Boolean(verdict.feasible) && lines.every((l) => l.ok);
  const dest = m && DESTINATIONS.find((d) => d.missionId === m.id);
  return {
    ready,
    title: ready ? "CLEARED TO FLY" : "NOT READY YET",
    to: m ? dest?.to ?? `to ${m.name}` : null,
    lines,
    toFix: lines.filter((l) => !l.ok).length,
  };
}
