// The Hangar: the drone library panel (Real drones + My drones), About this drone, Test, and New drone.
//   createHangar({ el, button, chip, store, host }) -> { show(view, arg?), close(), toggle(), isOpen, view, refresh(), refreshChip(), flash(msg) }
// One panel with a small view stack (list → about → test …); ui/hangarViews.js writes the markup, this file owns
// the DOM, the events and the design actions. host is main.js: the current build and how to load one.
//   host.current()          -> { ref, kind: "preset"|"design"|"draft", id, name, build, modified, manifest, verdict }
//   host.open(ref, build?)  loads "preset:<id>" | "design:<id>" (or the given build under that ref) on the pad
//   host.selectMission(id)  host.saveCurrent(design) after a Save / Save as (the pad now shows that design)
//   host.renamed(design) / host.deleted(id)
import { droneCatalog, dronePresetIds, getDronePreset, dronePresetToBuild, droneDestinations, droneReadiness, droneOptionsFor } from "../data/droneCatalog.js";
import { droneBuildManifest } from "../droneLayout.js";
import { droneEntrySummary, droneTypeBadge, missionMatrix, fillFromAirframe, repairBuild } from "../droneLibrary.js";
import { createDesign, designToBuild, duplicateDesign, renameDesign, touchDesign } from "../designs.js";
import { listHtml, aboutHtml, testHtml, newHtml, nowHtml } from "./hangarViews.js";

const TITLES = { list: "Hangar", about: "About this drone", test: "Test", new: "New drone", "save-as": "Save as new drone" };
const SLOT_FIELDS = [
  ["Motor", "motorId", "motors"],
  ["Propeller", "propellerId", "propellers"],
  ["Battery", "batteryId", "batteries"],
  ["Payload", "payloadId", "payloads"],
];
const byId = (list, id) => (id ? (list ?? []).find((x) => x?.id === id) : undefined);
const buildKey = (b) => JSON.stringify({ ...b, livery: undefined });
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function createHangar({ el, button, chip, store, host }) {
  const labels = Object.fromEntries(droneDestinations().map((d) => [d.missionId, d.label]));
  const summaries = new Map(); // buildKey -> summary (evaluateDrone is cheap, but the list redraws often)
  const summaryOf = (build) => {
    const k = buildKey(build);
    if (!summaries.has(k)) summaries.set(k, droneEntrySummary(build, droneCatalog));
    return summaries.get(k);
  };
  /** @type {{ view: string, arg: string|null }[]} */
  let stack = [];
  const ui = { renaming: null, confirmDelete: null };
  let form = null; // the New drone form's state while it is open
  let savedMsg = "";
  let savedTimer = 0;

  // ---------- entries ----------
  function presetEntry(id) {
    const p = getDronePreset(id);
    if (!p) return null;
    const build = dronePresetToBuild(p);
    const cur = host.current();
    return { ref: `preset:${id}`, kind: "preset", name: p.name, note: p.about ?? p.note ?? "", engineering: p.about ? p.note ?? "" : "", source: p.source ?? "", basedOnName: null, build, summary: summaryOf(build), current: cur.ref === `preset:${id}` && !cur.modified };
  }
  const nameOfRef = (ref) => (ref?.startsWith("preset:") ? getDronePreset(ref.slice(7))?.name : ref ? store.get(ref.replace(/^design:/, ""))?.name : null) ?? null;
  function designEntry(d) {
    const build = designToBuild(d);
    const cur = host.current();
    return { ref: `design:${d.id}`, kind: "design", name: d.name, note: d.description, source: "", basedOnName: nameOfRef(d.basedOn), build, summary: summaryOf(build), current: cur.ref === `design:${d.id}` && !cur.modified };
  }
  function currentEntry() {
    const c = host.current();
    const base = c.kind === "preset" ? presetEntry(c.id) : c.kind === "design" && store.get(c.id) ? designEntry(store.get(c.id)) : null;
    return {
      ...(base ?? { note: "", source: "", basedOnName: null }),
      ref: c.ref,
      kind: c.kind,
      name: c.modified ? `${c.name} (modified)` : c.name,
      build: c.build,
      summary: summaryOf(c.build),
      current: true,
    };
  }
  function entryFor(ref) {
    if (!ref || ref === "current" || ref === host.current().ref) return currentEntry();
    if (ref.startsWith("preset:")) return presetEntry(ref.slice(7));
    const d = store.get(ref.replace(/^design:/, ""));
    return d ? designEntry(d) : null;
  }

  // ---------- render ----------
  const top = () => stack[stack.length - 1] ?? { view: "list", arg: null };

  function brokenRows() {
    return store.broken().map((b) => ({ ...b, repairable: Boolean(byId(droneCatalog.airframes, b.raw?.build?.airframeId)) }));
  }

  function sourcesOf(entry) {
    const b = entry.build;
    const recs = [
      ["airframe", byId(droneCatalog.airframes, b.airframeId)],
      ["motor", byId(droneCatalog.motors, b.motorId)],
      ["propeller", byId(droneCatalog.propellers, b.propellerId)],
      ["battery", byId(droneCatalog.batteries, b.batteryId)],
      ["payload", byId(droneCatalog.payloads, b.payloadId)],
      ["mission", byId(droneCatalog.missions, b.missionId)],
    ];
    return [{ label: "drone", str: entry.source }, ...recs.filter(([, r]) => r).map(([label, r]) => ({ label, str: r.source }))];
  }

  function bodyHtml() {
    const { view, arg } = top();
    if (view === "about") {
      const entry = entryFor(arg);
      if (!entry) return `<p class="hg-dim">That drone is gone.</p>`;
      const isLoaded = entry.current || entry.ref === host.current().ref;
      const manifest = isLoaded ? host.current().manifest : safeManifest(entry.build);
      return aboutHtml({ entry, manifest, readiness: droneReadiness(entry.summary.verdict, entry.summary.mission), sources: sourcesOf(entry), labels, isLoaded });
    }
    if (view === "test") {
      const c = host.current();
      return testHtml({ name: c.modified ? `${c.name} (modified)` : c.name, rows: missionMatrix(c.build, droneCatalog), selectedId: c.build.missionId, labels });
    }
    if (view === "new" || view === "save-as") return newHtml(formModel(view));
    return listHtml({
      presets: dronePresetIds.map(presetEntry).filter(Boolean),
      designs: store.list().map(designEntry),
      broken: brokenRows(),
      labels,
      ui,
    });
  }

  function safeManifest(build) {
    try {
      return droneBuildManifest(build, droneCatalog);
    } catch {
      return [];
    }
  }

  function render({ keepScroll = false } = {}) {
    const body = el.querySelector(".hg-body");
    const scroll = keepScroll && body ? body.scrollTop : 0;
    const { view } = top();
    el.innerHTML = `<div class="hg-head">
        ${stack.length > 1 ? '<button type="button" class="hg-icon" data-act="back" aria-label="Back">‹</button>' : ""}
        <h2 class="hg-h2">${TITLES[view] ?? "Hangar"}</h2>
        <button type="button" class="hg-icon" data-act="close" aria-label="Close">×</button>
      </div><div class="hg-body hg-v-${view}">${bodyHtml()}</div>`;
    el.querySelector(".hg-body").scrollTop = scroll;
    const focus = el.querySelector("#hg-rename-input") ?? (view === "new" || view === "save-as" ? el.querySelector("#hg-name") : null);
    if (!keepScroll && view === "list") el.querySelector(".hg-entry.is-current")?.scrollIntoView({ block: "nearest" });
    if (focus && !keepScroll) {
      focus.focus({ preventScroll: true });
      focus.select?.();
    }
  }

  // ---------- open / close ----------
  const isOpen = () => !el.hidden;
  function setOpen(open) {
    if (open === isOpen()) return;
    el.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("hangar-open", open);
    if (open && !reduced()) el.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "ease-out" });
    if (!open) {
      stack = [];
      ui.renaming = ui.confirmDelete = null;
      if (el.contains(document.activeElement)) button.focus({ preventScroll: true });
    }
  }
  function show(view = "list", arg = null, { push = false } = {}) {
    if (view === "new" || view === "save-as") form = newForm(view, arg);
    if (!push || !isOpen()) stack = view === "list" ? [] : [{ view: "list", arg: null }];
    stack.push({ view, arg });
    setOpen(true);
    render();
  }
  const back = () => {
    if (stack.length > 1) stack.pop();
    render();
  };

  // ---------- New drone / Save as ----------
  function newForm(mode, template) {
    const c = host.current();
    const firstAirframe = droneOptionsFor("airframe")[0]?.id ?? "";
    return {
      mode,
      name: mode === "save-as" ? `${c.name} custom`.slice(0, 60) : "",
      description: "",
      template: template ?? c.ref ?? "scratch",
      airframeId: c.build.airframeId ?? firstAirframe,
      error: "",
    };
  }
  function scratchFill() {
    return fillFromAirframe(form.airframeId, droneCatalog, { missionId: host.current().build.missionId ?? null });
  }
  function formModel(view) {
    const fill = view === "new" && form.template === "scratch" ? scratchFill() : null;
    const partNames = fill?.build ? SLOT_FIELDS.map(([slot, key, list]) => ({ slot, name: byId(droneCatalog[list], fill.build[key])?.name ?? "" })) : [];
    return {
      ...form,
      mode: view,
      presets: dronePresetIds.map((id) => ({ ref: `preset:${id}`, name: getDronePreset(id)?.name ?? id })),
      designs: store.list().map((d) => ({ ref: `design:${d.id}`, name: d.name })),
      airframes: droneOptionsFor("airframe").map((a) => ({ id: a.id, name: a.name, badge: droneTypeBadge(a) })),
      fill,
      partNames,
      currentName: host.current().name,
    };
  }
  function readForm() {
    const fd = new FormData(el.querySelector(".hg-form"));
    form.name = String(fd.get("name") ?? "");
    form.description = String(fd.get("description") ?? "");
    if (fd.has("template")) form.template = String(fd.get("template"));
    if (fd.has("airframe")) form.airframeId = String(fd.get("airframe"));
  }
  // The build a new drone starts from, and what it is based on.
  function templateBuild() {
    if (form.mode === "save-as") {
      const c = host.current();
      return { build: c.build, basedOn: c.kind === "draft" ? null : c.id };
    }
    if (form.template === "scratch") {
      const fill = scratchFill();
      if (!fill.build || fill.missing.length) return { error: `No compatible ${fill.missing.join(", ")} for this airframe in the dataset` };
      return { build: fill.build, basedOn: null };
    }
    const entry = entryFor(form.template);
    return entry ? { build: entry.build, basedOn: form.template.replace(/^(preset|design):/, "") } : { error: "That template is gone" };
  }
  function submitForm() {
    readForm();
    if (!form.name.trim()) {
      form.error = "Give it a name.";
      return render({ keepScroll: true });
    }
    const t = templateBuild();
    if (t.error) {
      form.error = t.error;
      return render({ keepScroll: true });
    }
    const design = createDesign({ name: form.name, description: form.description, basedOn: t.basedOn, build: t.build });
    const r = store.put(design);
    if (!r.ok) {
      form.error = `Cannot save: ${r.reason}`;
      return render({ keepScroll: true });
    }
    const mode = form.mode;
    form = null;
    if (mode === "save-as") host.saveCurrent(design);
    else host.open(`design:${design.id}`);
    flash(r.reason ? r.reason : mode === "save-as" ? "Saved to My drones" : "Created in My drones");
    show("list");
  }

  // ---------- design actions ----------
  function saveCurrent() {
    const c = host.current();
    const d = c.kind === "design" ? store.get(c.id) : null;
    if (!d) return show("save-as");
    const next = touchDesign(d, c.build);
    const r = store.put(next);
    if (!r.ok) return flash(`Cannot save: ${r.reason}`);
    host.saveCurrent(next);
    flash(r.reason ?? "Saved");
  }
  function repair(id) {
    const b = store.broken().find((x) => x.id === id);
    const fixed = b ? repairBuild(b.raw?.build ?? {}, droneCatalog) : null;
    if (!b || !fixed?.build || fixed.missing.length) return flash("Cannot repair this one: delete it instead");
    const d = createDesign(
      { name: b.name, description: typeof b.raw.description === "string" ? b.raw.description : "", basedOn: typeof b.raw.basedOn === "string" ? b.raw.basedOn : null, build: fixed.build },
      { id: b.id, now: typeof b.raw.createdAt === "string" ? b.raw.createdAt : undefined },
    );
    const r = store.put(touchDesign(d, fixed.build));
    if (!r.ok) return flash(`Cannot repair: ${r.reason}`);
    host.open(`design:${id}`);
    flash(`Repaired: new ${fixed.replaced.join(", ")}`);
    render({ keepScroll: true });
  }

  function onAction(act, t) {
    const id = t.dataset.id;
    switch (act) {
      case "close":
        return setOpen(false);
      case "back":
        return back();
      case "open":
        host.open(t.dataset.ref);
        return render({ keepScroll: true });
      case "about":
        return show("about", t.dataset.ref, { push: true });
      case "about-current":
        return show("about", "current");
      case "test":
        return show("test", null, { push: true });
      case "mission":
        host.selectMission(t.dataset.mission);
        return render({ keepScroll: true });
      case "new":
        return show("new", t.dataset.template ?? null, { push: true });
      case "save":
        return saveCurrent();
      case "save-as":
        return show("save-as");
      case "rename":
        ui.renaming = `design:${id}`;
        ui.confirmDelete = null;
        return render({ keepScroll: true });
      case "rename-cancel":
        ui.renaming = null;
        return render({ keepScroll: true });
      case "duplicate": {
        const d = store.get(id);
        if (d) store.put(duplicateDesign(d));
        flash(d ? "Duplicated" : "");
        return render({ keepScroll: true });
      }
      case "delete":
        ui.confirmDelete = `design:${id}`;
        return render({ keepScroll: true });
      case "delete-broken":
        ui.confirmDelete = `broken:${id}`;
        return render({ keepScroll: true });
      case "delete-no":
        ui.confirmDelete = null;
        return render({ keepScroll: true });
      case "delete-yes":
        store.remove(id);
        ui.confirmDelete = null;
        host.deleted(id);
        flash("Deleted");
        return render({ keepScroll: true });
      case "repair":
        return repair(id);
      default:
        return undefined;
    }
  }

  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (t && el.contains(t)) onAction(t.dataset.act, t);
  });
  el.addEventListener("keydown", (e) => {
    const row = e.target.closest?.('tr[data-act="mission"]');
    if (row && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onAction("mission", row);
    }
    if (e.key === "Escape" && ui.renaming) {
      e.stopPropagation();
      onAction("rename-cancel", e.target);
    }
  });
  el.addEventListener("change", (e) => {
    if (!form || !e.target.closest(".hg-form") || !e.target.matches("select")) return;
    readForm();
    form.error = "";
    render({ keepScroll: true });
  });
  el.addEventListener("submit", (e) => {
    e.preventDefault();
    const rename = e.target.closest(".hg-rename");
    if (rename) {
      const d = store.get(rename.dataset.id);
      const name = String(new FormData(rename).get("name") ?? "").trim();
      if (d && name) {
        const next = renameDesign(d, name);
        store.put(next);
        host.renamed(next);
      }
      ui.renaming = null;
      return render({ keepScroll: true });
    }
    submitForm();
  });
  chip.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (t) onAction(t.dataset.act, t);
  });

  // ---------- the chip ----------
  function flash(msg) {
    savedMsg = msg;
    clearTimeout(savedTimer);
    refreshChip();
    savedTimer = setTimeout(() => {
      savedMsg = "";
      refreshChip();
    }, 2600);
  }
  function refreshChip() {
    const c = host.current();
    const badge = droneTypeBadge(byId(droneCatalog.airframes, c.build.airframeId));
    chip.innerHTML = nowHtml({ name: c.name, badge, modified: c.modified, kind: c.kind, saved: savedMsg });
  }

  return {
    show,
    close: () => setOpen(false),
    toggle: () => (isOpen() ? setOpen(false) : show("list")),
    get isOpen() {
      return isOpen();
    },
    get view() {
      return isOpen() ? top().view : null;
    },
    // After the build changed under the panel (a swap, a mission pick, a load): redraw in place.
    refresh() {
      refreshChip();
      if (isOpen() && !(top().view === "new" || top().view === "save-as" || ui.renaming)) render({ keepScroll: true });
    },
    refreshChip,
    flash,
  };
}
