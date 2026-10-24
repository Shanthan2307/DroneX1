// Saved drone designs: the user's own drones, as plain, versioned, self-contained data.
//   createDesign({ name, description?, basedOn?, build }, { id?, now? })  -> Design
//   validateDesign(value, catalog)        -> { ok: true, design } | { ok: false, reason }   never throws
//   serializeDesign(design)               -> string (JSON)
//   parseDesign(text, catalog)            -> validateDesign of the parsed JSON, never throws
//   designToBuild(design)                 -> the drone BuildState every other module takes (contract §1)
//   renameDesign / touchDesign / duplicateDesign / upsertDesign / removeDesign   pure list and record helpers
//   loadDesigns(storage, catalog)         -> Design[]  (corrupt or foreign storage reads as no designs)
//   saveDesigns(storage, designs)         -> { ok: true } | { ok: false, reason }
//
// A design is a build plus a name; nothing in it is a real-world number, only record ids into the datasets, so
// the verdict is always recomputed from the sourced data and can never go stale. The format and version fields
// make the record self-describing, so a later exporter (or a v2 migration) can read it on its own.
//
// Pure: no DOM, no globals. Storage is passed in (window.localStorage in the browser, a stub in tests); ids and
// clocks can be passed in too, so every function is deterministic under test.
import { checkDroneBuild } from "./droneCompat.js";

export const DESIGN_FORMAT = "dronex.design";
export const DESIGN_VERSION = 1;
// One key for the whole list, versioned, so a future format can live beside this one instead of over it.
export const DESIGNS_STORAGE_KEY = "dronex.designs.v1";
const STORE_FORMAT = "dronex.designs";

export const NAME_MAX = 60;
export const DESCRIPTION_MAX = 500;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * @typedef {object} DesignBuild
 * @property {string} airframeId
 * @property {string} motorId
 * @property {string} propellerId
 * @property {string} batteryId
 * @property {string} payloadId          "" when no payload is fitted
 * @property {string|null} missionId
 * @property {string} [cruiseMotorId]     quadplanes only: the forward cruise motor
 * @property {string} [cruisePropellerId] quadplanes only: the forward cruise propeller
 */

/**
 * @typedef {object} Design
 * @property {"dronex.design"} format
 * @property {1} version
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string|null} basedOn       the preset or design id it started from, or null (from scratch)
 * @property {DesignBuild} build
 * @property {string} createdAt          ISO 8601
 * @property {string} updatedAt          ISO 8601
 */

/** @typedef {{ ok: true, design: Design } | { ok: false, reason: string }} DesignResult */

/** @typedef {{ getItem(key: string): string|null, setItem(key: string, value: string): void }} DesignStorage */

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStr = (x) => typeof x === "string";
const isoNow = () => new Date().toISOString();
const isIso = (x) => isStr(x) && Number.isFinite(Date.parse(x));
const cleanText = (x, max) => (isStr(x) ? x.trim().replace(/\s+/g, " ").slice(0, max) : "");
// Descriptions keep their line breaks; only the ends are trimmed.
const cleanDescription = (x) => (isStr(x) ? x.trim().slice(0, DESCRIPTION_MAX) : "");

/** A fresh id: time plus randomness, no dependency. @returns {string} */
export function newDesignId() {
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// The build fields a design keeps, from any build-shaped object (a livery and anything else are dropped).
/** @param {Record<string, unknown>} build @returns {DesignBuild} */
export function pickDesignBuild(build) {
  const b = isObj(build) ? build : {};
  const str = (x) => (isStr(x) ? x : "");
  /** @type {DesignBuild} */
  const out = {
    airframeId: str(b.airframeId),
    motorId: str(b.motorId),
    propellerId: str(b.propellerId),
    batteryId: str(b.batteryId),
    payloadId: str(b.payloadId),
    missionId: isStr(b.missionId) && b.missionId ? b.missionId : null,
  };
  if (isStr(b.cruiseMotorId) && b.cruiseMotorId) out.cruiseMotorId = b.cruiseMotorId;
  if (isStr(b.cruisePropellerId) && b.cruisePropellerId) out.cruisePropellerId = b.cruisePropellerId;
  return out;
}

/**
 * A new design (not validated: call validateDesign before trusting it).
 * @param {{ name: string, description?: string, basedOn?: string|null, build: Record<string, unknown> }} fields
 * @param {{ id?: string, now?: string }} [opts]
 * @returns {Design}
 */
export function createDesign(fields, opts = {}) {
  const now = opts.now ?? isoNow();
  return {
    format: DESIGN_FORMAT,
    version: DESIGN_VERSION,
    id: opts.id ?? newDesignId(),
    name: cleanText(fields?.name, NAME_MAX),
    description: cleanDescription(fields?.description),
    basedOn: isStr(fields?.basedOn) && fields.basedOn ? fields.basedOn : null,
    build: pickDesignBuild(fields?.build),
    createdAt: now,
    updatedAt: now,
  };
}

const known = (list, id) => Array.isArray(list) && list.some((r) => r?.id === id);

// Every part id must name a record; payload may be empty, mission may be null. One reason, the first found.
/** @returns {string|null} */
function buildProblem(build, catalog) {
  const need = [
    ["airframe", "airframeId", "airframes"],
    ["motor", "motorId", "motors"],
    ["propeller", "propellerId", "propellers"],
    ["battery", "batteryId", "batteries"],
  ];
  for (const [label, key, list] of need) {
    if (!build[key]) return `no ${label} chosen`;
    if (!known(catalog?.[list], build[key])) return `unknown ${label} id: ${build[key]}`;
  }
  if (build.payloadId && !known(catalog?.payloads, build.payloadId)) return `unknown payload id: ${build.payloadId}`;
  if (build.missionId && !known(catalog?.missions, build.missionId)) return `unknown mission id: ${build.missionId}`;
  if (build.cruiseMotorId && !known(catalog?.motors, build.cruiseMotorId)) return `unknown cruise motor id: ${build.cruiseMotorId}`;
  if (build.cruisePropellerId && !known(catalog?.propellers, build.cruisePropellerId)) return `unknown cruise propeller id: ${build.cruisePropellerId}`;
  // Physical fits nothing else can fix (droneCompat's "incompatible" level): a propeller too wide for the frame,
  // a bore smaller than the shaft. Problems another slot could fix (lift, current) are the verdict's to report.
  const hard = checkDroneBuild(build, catalog).find((s) => s.level === "incompatible");
  if (hard) return `incompatible ${hard.slot}: ${hard.reasons[0] ?? "does not fit"}`;
  return null;
}

/**
 * Checks anything (parsed JSON, storage contents) and returns a clean copy of a valid design.
 * @param {unknown} value
 * @param {object} catalog droneCatalog
 * @returns {DesignResult}
 */
export function validateDesign(value, catalog) {
  try {
    if (!isObj(value)) return { ok: false, reason: "not a design object" };
    if (value.format !== DESIGN_FORMAT) return { ok: false, reason: `not a DroneX design (format ${JSON.stringify(value.format ?? null)})` };
    if (value.version !== DESIGN_VERSION) return { ok: false, reason: `unsupported design version ${JSON.stringify(value.version ?? null)}` };
    if (!isStr(value.id) || !ID_RE.test(value.id)) return { ok: false, reason: "missing or malformed id" };
    const name = cleanText(value.name, NAME_MAX);
    if (!name) return { ok: false, reason: "a design needs a name" };
    if (value.description != null && !isStr(value.description)) return { ok: false, reason: "description must be text" };
    if (value.basedOn != null && !isStr(value.basedOn)) return { ok: false, reason: "basedOn must be an id or null" };
    if (!isIso(value.createdAt) || !isIso(value.updatedAt)) return { ok: false, reason: "createdAt and updatedAt must be dates" };
    if (!isObj(value.build)) return { ok: false, reason: "missing build" };
    const raw = value.build;
    for (const key of ["airframeId", "motorId", "propellerId", "batteryId", "payloadId", "missionId", "cruiseMotorId", "cruisePropellerId"]) {
      if (raw[key] != null && !isStr(raw[key])) return { ok: false, reason: `build.${key} must be text` };
    }
    const build = pickDesignBuild(raw);
    const problem = buildProblem(build, catalog);
    if (problem) return { ok: false, reason: problem };
    return {
      ok: true,
      design: {
        format: DESIGN_FORMAT,
        version: DESIGN_VERSION,
        id: value.id,
        name,
        description: cleanDescription(value.description),
        basedOn: isStr(value.basedOn) && value.basedOn ? value.basedOn : null,
        build,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      },
    };
  } catch (e) {
    // Getters that throw, cyclic oddities: still an answer, never an exception.
    return { ok: false, reason: `unreadable design (${e instanceof Error ? e.message : "error"})` };
  }
}

/** @param {Design} design @returns {string} */
export const serializeDesign = (design) => JSON.stringify(design);

/** @param {unknown} text @param {object} catalog @returns {DesignResult} */
export function parseDesign(text, catalog) {
  if (!isStr(text)) return { ok: false, reason: "not text" };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  return validateDesign(value, catalog);
}

/** The BuildState the configurator loads (same shape a preset gives, contract §1). */
export function designToBuild(design) {
  return { ...pickDesignBuild(design?.build), livery: { primary: "#ffffff", accent: "#111111", stripe: false, patch: null } };
}

// --- pure record and list helpers --------------------------------------------------------------------------

/** @param {Design} d @param {string} name @param {string} [now] @returns {Design} */
export const renameDesign = (d, name, now = isoNow()) => ({ ...d, name: cleanText(name, NAME_MAX) || d.name, updatedAt: now });

/** A design with a new build (Save). @returns {Design} */
export const touchDesign = (d, build, now = isoNow()) => ({ ...d, build: pickDesignBuild(build), updatedAt: now });

/** A copy under a new id, "… copy", based on the original. @returns {Design} */
export function duplicateDesign(d, opts = {}) {
  const base = `${d.name} copy`;
  return createDesign({ name: base, description: d.description, basedOn: d.id, build: d.build }, opts);
}

/** Replaces the design with the same id, or appends it. @returns {Design[]} */
export function upsertDesign(list, design) {
  const i = list.findIndex((d) => d.id === design.id);
  return i < 0 ? [...list, design] : list.map((d, j) => (j === i ? design : d));
}

/** @returns {Design[]} */
export const removeDesign = (list, id) => list.filter((d) => d.id !== id);

// --- storage -----------------------------------------------------------------------------------------------

/**
 * @typedef {{ id: string, name: string, reason: string, raw: unknown }} BrokenDesign
 * A stored design that no longer validates (say a part record was removed from the datasets). It is kept, shown
 * with its reason, and can be repaired or deleted; it is never silently dropped from storage.
 */

/**
 * Everything in storage: the valid designs and the broken ones. Corrupt JSON, a foreign shape or a storage that
 * throws (private mode) read as an empty store, never an exception.
 * @param {DesignStorage|null|undefined} storage
 * @param {object} catalog
 * @returns {{ designs: Design[], broken: BrokenDesign[] }}
 */
export function readDesignStore(storage, catalog) {
  const empty = { designs: [], broken: [] };
  let text = null;
  try {
    text = storage?.getItem(DESIGNS_STORAGE_KEY) ?? null;
  } catch {
    return empty;
  }
  if (!isStr(text)) return empty;
  let store;
  try {
    store = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!isObj(store) || store.format !== STORE_FORMAT || store.version !== DESIGN_VERSION || !Array.isArray(store.designs)) return empty;
  const seen = new Set();
  /** @type {Design[]} */
  const designs = [];
  /** @type {BrokenDesign[]} */
  const broken = [];
  for (const raw of store.designs) {
    const r = validateDesign(raw, catalog);
    if (r.ok) {
      if (seen.has(r.design.id)) continue;
      seen.add(r.design.id);
      designs.push(r.design);
      continue;
    }
    // Only something that is recognisably one of our designs is worth keeping as broken; junk is dropped.
    if (isObj(raw) && raw.format === DESIGN_FORMAT && isStr(raw.id) && ID_RE.test(raw.id) && !seen.has(raw.id)) {
      seen.add(raw.id);
      broken.push({ id: raw.id, name: cleanText(raw.name, NAME_MAX) || "Unnamed design", reason: r.reason, raw });
    }
  }
  return { designs, broken };
}

/** Every valid design in storage (see readDesignStore). @returns {Design[]} */
export const loadDesigns = (storage, catalog) => readDesignStore(storage, catalog).designs;

/**
 * Writes the list, keeping any broken designs as they were so a part coming back to the datasets revives them.
 * @param {DesignStorage|null|undefined} storage
 * @param {Design[]} designs
 * @param {BrokenDesign[]} [broken]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function saveDesigns(storage, designs, broken = []) {
  if (!storage) return { ok: false, reason: "no storage available" };
  try {
    const all = [...designs, ...broken.filter((b) => !designs.some((d) => d.id === b.id)).map((b) => b.raw)];
    storage.setItem(DESIGNS_STORAGE_KEY, JSON.stringify({ format: STORE_FORMAT, version: DESIGN_VERSION, designs: all }));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "storage refused the write" };
  }
}
