// The Hangar's brain: what a drone is, how it does on its mission, how it does on every mission, and how a new
// drone is filled in from an airframe. Pure: data in, plain objects out; the panels in ui/hangar*.js render them.
//   droneTypeBadge(airframe)                     -> { key, label }   "quad", "cinewhoop", "hex", "fixed wing", …
//   droneEntrySummary(build, catalog)            -> the Hangar row: type, key verdict numbers, mission status
//   missionMatrix(build, catalog)                -> one row per mission, each requirement pass / fail / not judged
//   fillFromAirframe(airframeId, catalog, base?) -> a whole build from one airframe (first compatible per slot)
//
// Nothing here computes physics: every number is a field of dronePhysics.evaluateDrone's verdict, and the
// cleared/not-ready call is droneCatalog.droneReadiness's, the same function the HUD and the readiness panel use.
import { evaluateDrone } from "./dronePhysics.js";
import { droneOptionsWithCompat } from "./droneCompat.js";
import { appLiftRule, droneOptionsFor, droneReadiness } from "./data/droneCatalog.js";

/** @typedef {{ key: string, label: string }} TypeBadge */

const byId = (list, id) => (id ? (list ?? []).find((x) => x?.id === id) : undefined);
const fin = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

// Multirotor names by arm count; anything else is "N-rotor".
const ROTOR_NAME = { 3: "tricopter", 4: "quad", 6: "hex", 8: "octo" };

/**
 * The type badge, read off the airframe record (type, motorCount, ducted). Unknown types still get a label.
 * @param {Record<string, unknown>|null|undefined} airframe
 * @returns {TypeBadge}
 */
export function droneTypeBadge(airframe) {
  const type = String(airframe?.type ?? "");
  if (type === "multirotor") {
    if (airframe?.ducted === true) return { key: "cinewhoop", label: "cinewhoop" };
    const n = fin(airframe?.motorCount);
    return { key: "multirotor", label: (n && ROTOR_NAME[n]) || (n ? `${n}-rotor` : "multirotor") };
  }
  if (type.startsWith("fixed_wing")) return { key: "wing", label: "fixed wing" };
  if (type === "vtol_quadplane") return { key: "vtol", label: "VTOL quadplane" };
  if (type === "vtol_tiltrotor") return { key: "vtol", label: "VTOL tiltrotor" };
  if (type.startsWith("vtol")) return { key: "vtol", label: "VTOL" };
  return { key: "other", label: type ? type.replace(/_/g, " ") : "drone" };
}

// The endurance a mission is judged on (dronePhysics: mixedTime_min), the steady figure where there is no mixed one.
const flightMinutes = (v) => fin(v?.mixedTime_min) ?? fin(v?.hoverTime_min);

/**
 * @typedef {object} EntrySummary
 * @property {TypeBadge} badge
 * @property {number|null} weight_g      verdict.allUpWeight_g (est.)
 * @property {number|null} twr           verdict.hoverTWR (est.; static T/W for a wing)
 * @property {boolean} hovers            false for a pure fixed wing (its T/W is static, not hover)
 * @property {number|null} flight_min    verdict.mixedTime_min, else hoverTime_min (est.)
 * @property {object|null} mission       the mission record
 * @property {"cleared"|"not-ready"|"no-mission"} status
 * @property {number} toFix
 * @property {object} verdict
 */

/**
 * @param {Record<string, unknown>} build
 * @param {object} catalog droneCatalog
 * @returns {EntrySummary}
 */
export function droneEntrySummary(build, catalog) {
  const airframe = byId(catalog?.airframes, build?.airframeId);
  const verdict = evaluateDrone(build, catalog);
  const mission = byId(catalog?.missions, build?.missionId) ?? null;
  const ready = droneReadiness(verdict, mission);
  const weight = fin(verdict.allUpWeight_g);
  return {
    badge: droneTypeBadge(airframe),
    weight_g: weight && weight > 0 ? weight : null,
    twr: fin(verdict.hoverTWR) && verdict.hoverTWR > 0 ? verdict.hoverTWR : null,
    hovers: !String(airframe?.type ?? "").startsWith("fixed_wing"),
    flight_min: flightMinutes(verdict),
    mission,
    status: !mission ? "no-mission" : ready.ready ? "cleared" : "not-ready",
    toFix: ready.toFix,
    verdict,
  };
}

// ---------- the mission matrix ----------

/**
 * @typedef {"pass"|"fail"|"not-judged"|"n/a"} CheckStatus
 * @typedef {{ key: string, label: string, status: CheckStatus, have: string, want: string, reason: string }} MissionCheck
 * @typedef {{ mission: { id: string, name: string, description?: string }, verdict: object, ready: boolean, checks: MissionCheck[], failing: number, notJudged: number }} MissionRow
 */

const g0 = (x) => `${Math.round(x)} g`;
const min1 = (x) => `${x.toFixed(1)} min`;
const x2 = (x) => `${x.toFixed(2)}×`;
const ms1 = (x) => `${x.toFixed(1)} m/s`;
const status = (okFlag) => (okFlag === true ? "pass" : okFlag === false ? "fail" : "not-judged");

function weightCheck(v, m) {
  const limit = fin(m.maxAllowableWeight_g);
  if (limit === null) return { key: "weight", label: "Weight", status: "n/a", have: "", want: "", reason: "this mission sets no weight limit" };
  const have = fin(v.allUpWeight_g) && v.allUpWeight_g > 0 ? g0(v.allUpWeight_g) : "–";
  const s = status(v.missionOk?.weight);
  const reason =
    s === "pass" ? `${have} all-up, under the ${g0(limit)} limit` : s === "fail" ? `${have} all-up, ${g0(v.allUpWeight_g - limit)} over the ${g0(limit)} limit` : "no all-up weight: the build is missing a part";
  return { key: "weight", label: "Weight", status: s, have, want: `≤ ${g0(limit)}`, reason };
}

function enduranceCheck(v, m) {
  const need = fin(m.targetEndurance_min);
  if (need === null) return { key: "endurance", label: "Endurance", status: "n/a", have: "", want: "", reason: "this mission sets no endurance target" };
  const t = fin(v.mixedTime_min);
  const s = status(v.missionOk?.endurance);
  const have = t === null ? "–" : `${min1(t)} mixed`;
  const reason =
    s === "pass"
      ? `${min1(t)} of mixed flying, needs ${min1(need)}`
      : s === "fail"
        ? `${min1(t)} of mixed flying, ${min1(need - t)} short of ${min1(need)}`
        : "no flight time: the verdict has no steady-flight power for this build";
  return { key: "endurance", label: "Endurance", status: s, have, want: `≥ ${min1(need)}`, reason };
}

// Lift is judged twice, and both lines bind: the mission's own requiredHoverTWR (verdict.missionOk.twr) and the
// app's clearing rule, the readiness panel's "lift" line (max of appLiftRule and the mission's).
function liftCheck(v, m, readiness) {
  const twr = fin(v.hoverTWR);
  const missionNeed = fin(m.requiredHoverTWR);
  const appLine = readiness.lines.find((l) => l.key === "lift");
  const need = Math.max(appLiftRule(v), missionNeed ?? 0);
  const missionOk = v.missionOk?.twr;
  const have = twr && twr > 0 ? x2(twr) : "–";
  if (!(twr > 0)) return { key: "lift", label: "Lift", status: "not-judged", have, want: `≥ ${x2(need)}`, reason: "no thrust figure: the build is missing a part" };
  const s = missionOk === false || appLine?.ok === false ? "fail" : "pass";
  let reason;
  if (missionOk === false) reason = `${have} its weight, this mission wants ${x2(missionNeed)}`;
  else if (appLine?.ok === false) reason = `${have} its weight; the mission asks ${missionNeed === null ? "nothing" : x2(missionNeed)}, but the app clears it at ${x2(appLiftRule(v))} or more`;
  else reason = `${have} its weight, needs ${x2(need)}`;
  return { key: "lift", label: "Lift", status: s, have, want: `≥ ${x2(need)}`, reason };
}

// Speed: a winged airframe is judged on its cruise speed; a multirotor has no cruise figure, so dronePhysics
// judges it on its aerodynamic top speed, which needs the frame's drag data. Without either: not judged.
function speedCheck(v, m, airframe) {
  const need = fin(m.minCruiseSpeed_ms);
  if (need === null) return { key: "speed", label: "Speed", status: "n/a", have: "", want: "", reason: "this mission sets no speed" };
  const cruise = fin(v.cruiseSpeed_ms);
  const top = fin(v.maxSpeed_ms);
  const s = status(v.missionOk?.speed);
  const want = `≥ ${ms1(need)}`;
  if (s === "not-judged") {
    const winged = airframe && !String(airframe.type ?? "").startsWith("multirotor");
    const why = winged
      ? "no cruise speed: the airframe record lacks the wing data (stall speed or lift figures) to work one out"
      : "no top-speed estimate: the frame record has no drag data (frontal area and drag coefficient)";
    return { key: "speed", label: "Speed", status: s, have: "–", want, reason: why };
  }
  const ref = cruise ?? top;
  const what = cruise !== null ? "cruise" : "top speed (a multirotor has no cruise figure)";
  const reason = s === "pass" ? `${ms1(ref)} ${what}, needs ${ms1(need)}` : `${ms1(ref)} ${what}, ${ms1(need - ref)} short of ${ms1(need)}`;
  return { key: "speed", label: "Speed", status: s, have: `${ms1(ref)}${cruise !== null ? " cruise" : " top"}`, want, reason };
}

function payloadCheck(v, m, catalog, build) {
  if (!m.requiredPayloadId) return { key: "payload", label: "Payload", status: "n/a", have: "", want: "", reason: "this mission needs no particular payload" };
  const wanted = byId(catalog?.payloads, m.requiredPayloadId);
  const fitted = byId(catalog?.payloads, build?.payloadId);
  const s = status(v.missionOk?.payload);
  const name = wanted?.name ?? m.requiredPayloadId;
  const reason = s === "pass" ? `${name} fitted` : s === "fail" ? `needs ${name}; ${fitted ? `${fitted.name} is fitted` : "nothing is fitted"}` : "the build could not be evaluated";
  return { key: "payload", label: "Payload", status: s, have: fitted?.name ?? "none", want: name, reason };
}

// Whether it flies at all: the verdict's feasible flag and its blocking warnings, plus the other part problems the
// readiness panel counts (mission shortfalls are left out: they have their own rows above).
function partsCheck(v) {
  const blocking = v.blockingWarnings ?? [];
  if (!v.feasible || blocking.length) {
    return { key: "parts", label: "Flies", status: "fail", have: "", want: "", reason: blocking.length ? blocking.join("; ") : "the verdict says it cannot fly" };
  }
  return { key: "parts", label: "Flies", status: "pass", have: "", want: "", reason: "no blocking problems" };
}

/**
 * The build against every mission in the dataset: evaluateDrone once per mission, nothing recomputed here.
 * @param {Record<string, unknown>} build
 * @param {object} catalog droneCatalog
 * @returns {MissionRow[]}
 */
export function missionMatrix(build, catalog) {
  const airframe = byId(catalog?.airframes, build?.airframeId);
  return (catalog?.missions ?? []).map((mission) => {
    const verdict = evaluateDrone({ ...build, missionId: mission.id }, catalog);
    const readiness = droneReadiness(verdict, mission);
    const checks = [
      partsCheck(verdict),
      weightCheck(verdict, mission),
      enduranceCheck(verdict, mission),
      liftCheck(verdict, mission, readiness),
      speedCheck(verdict, mission, airframe),
      payloadCheck(verdict, mission, catalog, build),
    ];
    return {
      mission,
      verdict,
      ready: readiness.ready,
      checks,
      failing: checks.filter((c) => c.status === "fail").length,
      notJudged: checks.filter((c) => c.status === "not-judged").length,
    };
  });
}

// ---------- a new drone from an airframe ----------

const FILL_SLOTS = [
  ["motor", "motorId"],
  ["propeller", "propellerId"],
  ["battery", "batteryId"],
  ["payload", "payloadId"],
];

// The first record on the slot's shelf (droneOptionsFor order) that droneCompat rates "ok" for this build, else
// the first that is merely "unusual"; null when every option is incompatible.
/** @returns {string|null} */
function firstCompatible(build, catalog, slot) {
  const rated = new Map(droneOptionsWithCompat(build, catalog, slot).map((o) => [o.record.id, o.level]));
  const order = droneOptionsFor(slot, build).map((r) => r.id);
  return order.find((id) => rated.get(id) === "ok") ?? order.find((id) => rated.has(id) && rated.get(id) !== "incompatible") ?? null;
}

/**
 * A whole build from one airframe: each remaining slot takes the first option on the shelf (droneOptionsFor's
 * order) that droneCompat rates "ok", else the first that is not incompatible. Slots are filled in build order,
 * so each choice is judged against the parts already picked. A slot with nothing usable is reported, not guessed.
 * @param {string} airframeId
 * @param {object} catalog droneCatalog
 * @param {{ missionId?: string|null }} [base]
 * @returns {{ build: Record<string, unknown>|null, missing: string[] }}
 */
export function fillFromAirframe(airframeId, catalog, base = {}) {
  if (!byId(catalog?.airframes, airframeId)) return { build: null, missing: ["airframe"] };
  /** @type {Record<string, unknown>} */
  let build = { airframeId, missionId: base.missionId ?? null };
  const missing = [];
  for (const [slot, key] of FILL_SLOTS) {
    const pick = firstCompatible(build, catalog, slot);
    if (pick) build = { ...build, [key]: pick };
    else {
      missing.push(slot);
      build = { ...build, [key]: "" };
    }
  }
  return { build, missing };
}

/**
 * A stored build whose part ids no longer all exist (a record removed from the datasets): every unknown slot
 * takes the first compatible option, judged against the parts that survived. An unknown airframe cannot be
 * repaired this way (every other part depends on it), so it reports build: null. An unknown mission is cleared.
 * @param {Record<string, unknown>} build
 * @param {object} catalog droneCatalog
 * @returns {{ build: Record<string, unknown>|null, replaced: string[], missing: string[] }}
 */
export function repairBuild(build, catalog) {
  if (!byId(catalog?.airframes, build?.airframeId)) return { build: null, replaced: ["airframe"], missing: ["airframe"] };
  const LIST = { motor: "motors", propeller: "propellers", battery: "batteries", payload: "payloads" };
  let next = { ...build };
  if (next.missionId && !byId(catalog?.missions, next.missionId)) next.missionId = null;
  for (const key of ["cruiseMotorId", "cruisePropellerId"]) {
    if (next[key] && !byId(catalog?.[key === "cruiseMotorId" ? "motors" : "propellers"], next[key])) delete next[key];
  }
  const replaced = [];
  const missing = [];
  for (const [slot, key] of FILL_SLOTS) {
    const id = next[key];
    if (!id ? slot === "payload" : byId(catalog?.[LIST[slot]], id)) continue;
    const pick = firstCompatible(next, catalog, slot);
    if (pick) replaced.push(slot);
    else missing.push(slot);
    next = { ...next, [key]: pick ?? "" };
  }
  return { build: next, replaced, missing };
}
