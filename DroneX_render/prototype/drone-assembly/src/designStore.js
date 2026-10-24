// The user's saved drones in this browser: designs.js's pure functions over one storage (localStorage).
//   createDesignStore(storage, catalog) -> { list(), broken(), get(id), put(design), remove(id), lastError }
// Every write re-reads nothing and writes the whole list (it is small), keeping broken designs as they were.
import { readDesignStore, saveDesigns, upsertDesign, removeDesign, validateDesign } from "./designs.js";

/** @typedef {import("./designs.js").Design} Design */
/** @typedef {import("./designs.js").BrokenDesign} BrokenDesign */

/**
 * @param {import("./designs.js").DesignStorage|null} storage
 * @param {object} catalog
 */
export function createDesignStore(storage, catalog) {
  const start = readDesignStore(storage, catalog);
  /** @type {Design[]} */
  let designs = start.designs;
  /** @type {BrokenDesign[]} */
  let broken = start.broken;
  let lastError = "";

  const persist = () => {
    const r = saveDesigns(storage, designs, broken);
    lastError = r.ok ? "" : `Not saved in this browser: ${r.reason}`;
    return r.ok;
  };

  return {
    list: () => designs,
    broken: () => broken,
    /** @param {string} id */
    get: (id) => designs.find((d) => d.id === id) ?? null,
    /** Validates, then adds or replaces. @param {Design} design @returns {{ ok: boolean, reason?: string }} */
    put(design) {
      const r = validateDesign(design, catalog);
      if (!r.ok) return { ok: false, reason: r.reason };
      designs = upsertDesign(designs, r.design);
      broken = broken.filter((b) => b.id !== r.design.id);
      persist();
      return lastError ? { ok: true, reason: lastError } : { ok: true };
    },
    /** @param {string} id */
    remove(id) {
      designs = removeDesign(designs, id);
      broken = broken.filter((b) => b.id !== id);
      persist();
    },
    get lastError() {
      return lastError;
    },
  };
}
