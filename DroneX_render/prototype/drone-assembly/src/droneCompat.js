// Drone part compatibility: which records can go in which slot, with a one-line plain-words reason per problem
// (shown next to the option). Pure: no DOM, data in, verdicts out. The mirror of compat.js for the drone path.
//   checkDroneOption(build, droneCatalog, slot, record) -> { level, reasons }
//   droneOptionsWithCompat(build, droneCatalog, slot)   -> [{ record, level, reasons }]  ok, unusual, incompatible
//   checkDroneBuild(build, droneCatalog)                -> [{ slot, level, reasons }]  every slot
// slot: "airframe" | "motor" | "propeller" | "battery" | "payload" (contract §4). level: "ok" | "unusual" |
// "incompatible".
//
// WHICH RULES ARE REAL PHYSICAL LIMITS AND WHICH ARE DESIGN THRESHOLDS — the distinction compat.js documents,
// and the one that decides a level. "incompatible" means cannot be chosen, so the test it has to pass is:
// NO CHOICE IN ANY OTHER SLOT COULD MAKE THIS WORK. A propeller wider than the frame will never fit, whatever
// else is swapped, so it is incompatible. Not enough lift is a different kind of problem: a lighter pack or a
// smaller payload fixes it, so greying the motor out would trap the user before they could get there. That is
// "unusual" — allowed, labelled, with its reason — and the verdict still blocks the build and the readiness
// panel still says NOT READY. The shelf's job is to let a build be configured, not to pass judgement on it.
//
// INCOMPATIBLE — real physical limits that nothing else can fix, read straight off the records:
//   - a propeller wider than the airframe's maxPropDiameter_in (the VTOL quadplane states liftPropDiameter_in
//     instead, used the same way): the blades would hit the arms, or each other. Nothing adapts that away.
//   - a propeller whose shaftHole_mm is smaller than the motor's propShaftDiameter_mm: the bore will not go
//     over the shaft. A LARGER bore is not incompatible — every propeller ships with reducer rings — so that
//     is "unusual" below.
// UNUSUAL — design thresholds for this check, or problems another slot can fix, NOT real-world data:
//   - not enough lift: hover thrust-to-weight under 1.0 (it cannot leave the ground as the build stands),
//     under DRONE_RULES.HOVER_TWR_MIN (no margin to hold altitude) or under HOVER_TWR_OK (sluggish). A winged
//     airframe is not judged on hover lift at all — it is carried by its wing — only on the static launch rule.
//   - a motor whose mountCircle_mm is not the airframe's motorMount_mm. This used to be incompatible and that
//     was wrong: frames carry slotted or multi-pattern mount holes and motor-mount adapters are ordinary, so a
//     pattern mismatch is a job, not an impossibility.
//   - a propeller bore wider than the shaft: needs a reducer ring.
//   - a propeller that is not on the motor's recommendedProps list, over- or under-propped by diameter.
//   - a pack-and-propeller pair the motor cannot actually take: the full-throttle solution asks for more than
//     maxCurrent_A or maxPower_W, so the ESC must throttle back. The records carry NO voltage or cell-count
//     rating field for a motor (only free-text notes, which this file never parses), so this derived current
//     test is how "a pack outside the motor's rating" is judged.
//   - a propeller whose tips pass DRONE_RULES.TIP_MACH_LIMIT on this pack.
//   - a pack that cannot supply the full-throttle current the motors want.
//   - a payload the frame has no stated room for (PAYLOAD_FIT below: both ratios are design thresholds — no
//     record states a payload bay).
//   - a build over the 250 g registration line, when this choice is what takes it over, or over the mission's
//     own maxAllowableWeight_g; and the mission's requiredPayloadId not fitted.
//
// TWO RULES ABOUT WHERE A REASON IS ALLOWED TO SHOW, both learned the hard way:
//   1. A problem in one slot must never change the level of another slot. Every rule below declares the slots
//      it belongs to, and a slot is only ever judged on its own rules — a mount mismatch between the frame and
//      the motor is not a reason the camera is incompatible. (The old version string-matched reasons onto
//      slots, which leaked a pack-current failure onto every slot in the shelf.)
//   2. A slot's own fitted record is never "incompatible". Saying so would say the build on screen cannot
//      exist. Its reasons are still reported, one level down, and the verdict's warnings say the rest.
//
// This module deliberately imports nothing but dronePhysics.js. A drone build is a flat object (contract §1),
// so "what would this choice mean" is `{ ...build, motorId: record.id }` — there is no need for a catalog
// module's applyOption, and the option list for a slot is just that slot's collection in droneCatalog.
import { DRONE_RULES, evaluateDrone } from "./dronePhysics.js";

// The payload has to live somewhere. On a multirotor the only stated bay is the frame itself, so the wheelbase
// sets what can be strapped between the props; on a winged airframe the fuselage does. Both ratios are DESIGN
// THRESHOLDS for this check, not real-world data: no record states a payload bay.
const PAYLOAD_FIT = {
  WHEELBASE_SHARE: 0.75, // a payload longer than 75 % of the wheelbase overhangs the props
  FUSELAGE_SHARE: 0.5, // a payload longer than half the fuselage leaves no room for the wing spar or the pack
};
// A propeller more than this far off the recommended list's diameter is called over- or under-propped. A design
// threshold: recommendedProps is the record's own word on what fits, and this says how far off is worth a label.
const PROP_DIAMETER_TOLERANCE_IN = 0.75;

const RANK = { ok: 0, unusual: 1, incompatible: 2 };
// Slot names, singular or plural, and the build key and catalog collection each one owns.
const SLOT = {
  airframe: { name: "airframe", key: "airframeId", list: "airframes" },
  airframes: { name: "airframe", key: "airframeId", list: "airframes" },
  motor: { name: "motor", key: "motorId", list: "motors" },
  motors: { name: "motor", key: "motorId", list: "motors" },
  propeller: { name: "propeller", key: "propellerId", list: "propellers" },
  propellers: { name: "propeller", key: "propellerId", list: "propellers" },
  battery: { name: "battery", key: "batteryId", list: "batteries" },
  batteries: { name: "battery", key: "batteryId", list: "batteries" },
  payload: { name: "payload", key: "payloadId", list: "payloads" },
  payloads: { name: "payload", key: "payloadId", list: "payloads" },
};
const SLOTS = ["airframe", "motor", "propeller", "battery", "payload"];
// Every slot: a weight or thrust change moves the whole vehicle's verdict, whatever was swapped.
const ALL = SLOTS;

const byId = (list, id) => (id ? (list ?? []).find((x) => x?.id === id) : undefined);
const fin = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const pos = (x) => (fin(x) !== null && x > 0 ? x : null);
// Units for a reason line: at most 2 decimals, trailing zeros dropped ("5.1″", "12″", "16 mm").
const inches = (x) => `${Math.round(x * 100) / 100}″`;
const mmStr = (x) => `${Math.round(x * 100) / 100} mm`;
const grams = (g) => `${Math.round(g)} g`;
const amps = (a) => `${Math.round(a)} A`;
// The largest propeller an airframe states it can swing. A plain frame says maxPropDiameter_in; the VTOL
// quadplane states its lift and cruise propellers separately, and the lift rotors are the ones on the arms.
const propLimit_in = (airframe) => pos(airframe?.maxPropDiameter_in) ?? pos(airframe?.liftPropDiameter_in);
const longestSide_mm = (record) => Math.max(pos(record?.length_mm) ?? 0, pos(record?.width_mm) ?? 0, pos(record?.height_mm) ?? 0);
const mustHover = (airframe) => airframe?.type === "multirotor" || String(airframe?.type ?? "").startsWith("vtol");
// The current a pack says it can give: its own rating if it has one, else its C rating times its capacity.
// The same fallback dronePhysics.evaluateDrone uses, so the two never quote different numbers.
const packRating_A = (battery) => {
  const rated = pos(battery?.maxDischargeCurrent_A);
  if (rated !== null) return rated;
  const c = pos(battery?.continuousC);
  const ah = (pos(battery?.capacity_mAh) ?? 0) / 1000;
  return c !== null && ah > 0 ? c * ah : 0;
};

// What a build would look like with `record` in `slot`. A drone build is flat, so this is one spread.
export const applyDroneChoice = (build, slot, recordId) => {
  const s = SLOT[slot];
  if (!s || !recordId) return { ...build };
  return { ...build, [s.key]: recordId };
};

// Every issue of one drone build, as [{ level, reason, slots }]. `slots` is the list of slots the issue is
// about: the only slots whose level it is ever allowed to change. Each rule runs only when the records it needs
// are present, so a half-built drone reports what can be judged and stays quiet about the rest.
function buildIssues(build, droneCatalog, { over250Before = null } = {}) {
  const out = [];
  const add = (level, reason, slots) => out.push({ level, reason, slots });
  const cat = droneCatalog && typeof droneCatalog === "object" ? droneCatalog : {};
  const b = build && typeof build === "object" ? build : {};
  const airframe = byId(cat.airframes, b.airframeId);
  const motor = byId(cat.motors, b.motorId);
  const propeller = byId(cat.propellers, b.propellerId);
  const battery = byId(cat.batteries, b.batteryId);
  const payload = byId(cat.payloads, b.payloadId);
  const mission = byId(cat.missions, b.missionId);

  // --- frame and propeller: does the blade fit between the arms? (real limit) ----------------------------
  const limit_in = propLimit_in(airframe);
  const prop_in = pos(propeller?.diameter_in);
  if (limit_in !== null && prop_in !== null && prop_in > limit_in) {
    add("incompatible", `${inches(prop_in)} propeller on a frame built for ${inches(limit_in)}`, ["airframe", "propeller"]);
  }
  // --- frame and motor: the bolt pattern (design threshold — adapters exist) -----------------------------
  const mount_mm = pos(airframe?.motorMount_mm);
  const circle_mm = pos(motor?.mountCircle_mm);
  if (mount_mm !== null && circle_mm !== null && Math.abs(mount_mm - circle_mm) > 0.01) {
    add("unusual", `${mmStr(circle_mm)} motor mount on a ${mmStr(mount_mm)} frame: needs an adapter`, ["airframe", "motor"]);
  }
  // --- motor and propeller: the shaft (real limit one way, a reducer ring the other) ---------------------
  const bore_mm = pos(propeller?.shaftHole_mm);
  const shaft_mm = pos(motor?.propShaftDiameter_mm);
  if (bore_mm !== null && shaft_mm !== null) {
    if (bore_mm < shaft_mm - 0.01) add("incompatible", `${mmStr(bore_mm)} bore will not go over a ${mmStr(shaft_mm)} shaft`, ["motor", "propeller"]);
    else if (bore_mm > shaft_mm + 0.01) add("unusual", `${mmStr(bore_mm)} bore on a ${mmStr(shaft_mm)} shaft needs a reducer ring`, ["motor", "propeller"]);
  }
  // --- frame and payload: is there room? (design threshold) ----------------------------------------------
  if (payload && airframe) {
    const long_mm = longestSide_mm(payload);
    const wheelbase_mm = pos(airframe.wheelbase_mm);
    const fuselage_mm = pos(airframe.fuselageLength_mm);
    if (long_mm > 0 && wheelbase_mm !== null && long_mm > PAYLOAD_FIT.WHEELBASE_SHARE * wheelbase_mm) {
      add("unusual", `${mmStr(long_mm)} payload on a ${mmStr(wheelbase_mm)} wheelbase: it will sit between the props`, ["airframe", "payload"]);
    } else if (long_mm > 0 && fuselage_mm !== null && long_mm > PAYLOAD_FIT.FUSELAGE_SHARE * fuselage_mm) {
      add("unusual", `${mmStr(long_mm)} payload in a ${mmStr(fuselage_mm)} fuselage: little room left for the wing spar`, ["airframe", "payload"]);
    }
  }
  // --- motor and propeller: a sensible pair --------------------------------------------------------------
  if (motor && propeller) {
    const list = Array.isArray(motor.recommendedProps) ? motor.recommendedProps : [];
    if (list.length > 0 && !list.includes(propeller.id)) {
      const rated = list.map((id) => pos(byId(cat.propellers, id)?.diameter_in)).filter((d) => d !== null);
      const nearest = rated.length && prop_in !== null ? rated.reduce((best, d) => (Math.abs(d - prop_in) < Math.abs(best - prop_in) ? d : best)) : null;
      if (nearest !== null && prop_in > nearest + PROP_DIAMETER_TOLERANCE_IN) add("unusual", `over-propped: ${motor.name} is rated for ${inches(nearest)}`, ["motor", "propeller"]);
      else if (nearest !== null && prop_in < nearest - PROP_DIAMETER_TOLERANCE_IN) add("unusual", `under-propped: ${motor.name} is rated for ${inches(nearest)}`, ["motor", "propeller"]);
      else add("unusual", `not on ${motor.name}'s recommended list`, ["motor", "propeller"]);
    }
  }

  // --- the whole vehicle ---------------------------------------------------------------------------------
  // One call to the real physics, so the shelf and the verdict can never disagree about thrust or weight.
  const verdict = airframe && motor && propeller && battery ? evaluateDrone(b, cat) : null;
  if (!verdict) return out;

  // Lift. Every one of these is "unusual", never "incompatible", because a lift shortfall is fixable from a
  // DIFFERENT slot — a lighter pack, a smaller payload, a bigger propeller — so greying the motor out would
  // trap the user before they could get there. The verdict still blocks the build and the readiness panel
  // still says NOT READY; the shelf's job is only to let the build be configured.
  // A winged airframe is NOT judged on hover lift at all: it is carried by its wing, and its propeller only
  // has to pull it along. Only the static launch rule applies to one.
  if (mustHover(airframe)) {
    if (verdict.hoverTWR < 1) add("unusual", `${grams(verdict.totalThrust_g)} of thrust cannot lift ${grams(verdict.allUpWeight_g)} of drone`, ALL);
    else if (verdict.hoverTWR < DRONE_RULES.HOVER_TWR_MIN) add("unusual", `hover thrust-to-weight ${verdict.hoverTWR.toFixed(2)}, under the ${DRONE_RULES.HOVER_TWR_MIN} it needs to hold altitude`, ALL);
    else if (verdict.hoverTWR < DRONE_RULES.HOVER_TWR_OK) add("unusual", `hover thrust-to-weight ${verdict.hoverTWR.toFixed(2)}, under the ${DRONE_RULES.HOVER_TWR_OK} a quad wants`, ALL);
  } else if (verdict.hoverTWR < DRONE_RULES.WING_STATIC_TWR_MIN) {
    add("unusual", `static thrust-to-weight ${verdict.hoverTWR.toFixed(2)}, little to climb away from a launch with`, ALL);
  }
  // The pack's current. A real electrical limit, but softened to "unusual": a pack is flown over its rating
  // every day at the cost of its life, and calling it incompatible left slots with nothing to offer.
  if (verdict.dischargeOk === false) {
    add("unusual", `pack can't supply the current the motors want: ${amps(verdict.maxCurrent_A)} needed, ${amps(packRating_A(battery))} rated`, ["motor", "propeller", "battery"]);
  }
  // These two come out of the same full-throttle solution the verdict uses.
  for (const w of verdict.warnings) {
    if (w.includes("over-propped on")) add("unusual", `${motor.name} hits its electrical rating on this pack`, ["motor", "propeller", "battery"]);
    if (w.includes("tips reach Mach")) add("unusual", `tips pass Mach ${DRONE_RULES.TIP_MACH_LIMIT} on a ${battery.cells_s}S pack`, ["propeller", "battery"]);
  }
  // The 250 g registration line, flagged when THIS choice is what takes the build over it (over250Before is
  // what the build weighed before the choice), so a shelf full of 300 g builds is not all labelled unusual.
  if (over250Before === false && !verdict.sub250) {
    add("unusual", `takes it to ${grams(verdict.allUpWeight_g)}, over the ${DRONE_RULES.SUB_250_G} g registration line`, ALL);
  }
  if (mission && pos(mission.maxAllowableWeight_g) !== null && verdict.allUpWeight_g > mission.maxAllowableWeight_g) {
    add("unusual", `${grams(verdict.allUpWeight_g)} all-up, over this mission's ${grams(mission.maxAllowableWeight_g)} limit`, ALL);
  }
  if (mission?.requiredPayloadId && b.payloadId !== mission.requiredPayloadId) {
    const wanted = byId(cat.payloads, mission.requiredPayloadId);
    add("unusual", `${mission.name} wants ${wanted?.name ?? mission.requiredPayloadId}`, ["payload"]);
  }
  return out;
}

// The issues one slot is answerable for: the ones whose own rule named that slot. Nothing else can reach it.
function slotIssues(build, droneCatalog, slot, opts) {
  const s = SLOT[slot];
  if (!s) return [];
  return buildIssues(build, droneCatalog, opts).filter((x) => x.slots.includes(s.name));
}

function summarize(issues, { neverIncompatible = false } = {}) {
  const seen = new Set();
  const uniq = issues.filter((x) => !seen.has(x.reason) && seen.add(x.reason));
  // A slot's own fitted record is never incompatible: that would say the build on screen cannot exist. The
  // reason is still shown, one level down, and the verdict's warnings carry the full story.
  const graded = neverIncompatible ? uniq.map((x) => (x.level === "incompatible" ? { ...x, level: "unusual" } : x)) : uniq;
  graded.sort((a, b) => RANK[b.level] - RANK[a.level]);
  const level = graded.reduce((lv, x) => (RANK[x.level] > RANK[lv] ? x.level : lv), "ok");
  return { level, reasons: graded.map((x) => x.reason) };
}

// What choosing `record` for `slot` would mean. The candidate build is made the way the UI makes it (one field
// swapped), and only the issues that slot is answerable for are reported; re-choosing the record that is
// already in the slot changes nothing and reports the slot as it stands, never as incompatible.
export function checkDroneOption(build, droneCatalog, slot, record) {
  const s = SLOT[slot];
  if (!s || !record?.id || !build || typeof build !== "object") return { level: "ok", reasons: [] };
  const fitted = build[s.key] === record.id;
  const before = evaluateDrone(build, droneCatalog ?? {});
  const next = applyDroneChoice(build, slot, record.id);
  // Whether the build was already over 250 g before this choice, so the 250 g rule can name the choice that
  // crossed the line rather than labelling every option.
  const over250Before = before.allUpWeight_g > 0 ? !before.sub250 : null;
  return summarize(slotIssues(next, droneCatalog ?? {}, slot, { over250Before }), { neverIncompatible: fitted });
}

// The slot's options (catalog order) with their verdicts: ok first, then unusual, then incompatible. The option
// list is the slot's own collection in droneCatalog — a drone slot takes any record of its kind, and the rules
// above are what narrow it.
export function droneOptionsWithCompat(build, droneCatalog, slot) {
  const s = SLOT[slot];
  if (!s) return [];
  const records = (droneCatalog?.[s.list] ?? []).filter((r) => r?.id);
  const rows = records.map((record, i) => ({ record, i, ...checkDroneOption(build, droneCatalog, slot, record) }));
  rows.sort((a, b) => RANK[a.level] - RANK[b.level] || a.i - b.i);
  return rows.map(({ record, level, reasons }) => ({ record, level, reasons }));
}

// Every slot of a drone build as it stands, in build order. This one describes the build rather than offering a
// choice, so it does report a fitted record's hard problems at their real level.
export function checkDroneBuild(build, droneCatalog) {
  return SLOTS.map((slot) => ({ slot, ...summarize(slotIssues(build, droneCatalog ?? {}, slot, {})) }));
}
