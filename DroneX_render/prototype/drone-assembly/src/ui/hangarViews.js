// The Hangar panel's views as HTML strings (pure: data in, markup out; ui/hangar.js owns the DOM and events).
//   listHtml(model)    Real drones + My drones, each with type, key verdict numbers and mission status
//   aboutHtml(model)   what a drone is and is for, its parts in plain words, sources, mission verdict
//   testHtml(model)    the current build against every mission: pass / fail / not judged, with reasons
//   newHtml(model)     New drone (template or from scratch) and Save as new drone
//   nowHtml(model)     the current-drone chip: name, type, About, Save / Save as new drone
// Every number is a verdict field (dronePhysics) or a record field, labelled est. as the HUD does.
import * as f from "./format.js";
import { partRole } from "./partRoles.js";
import { DRONE_OPTION_META } from "./droneCard.js";

const EST = '<span class="hg-est">est.</span>';
const NB = " ";

/**
 * @typedef {{ ref: string, name: string, note: string, engineering?: string, source: string, basedOnName: string|null, build: object,
 *   summary: import("../droneLibrary.js").EntrySummary, current: boolean, kind: "preset"|"design"|"draft" }} Entry
 */

const missionLabel = (mission, labels) => (mission ? labels[mission.id] ?? mission.name : "");

// "504 g · lift 6.02× · 6.2 min" with est.
function numbersHtml(s) {
  const bits = [];
  if (s.weight_g !== null) bits.push(`<b>${f.num(s.weight_g, 0)}${NB}g</b>`);
  if (s.twr !== null) bits.push(s.hovers ? `lift <b>${f.twr(s.twr)}×</b>` : `static T/W <b>${f.twr(s.twr)}</b>`);
  if (s.flight_min !== null) bits.push(`<b>${f.num(s.flight_min, 1)}${NB}min</b> flight`);
  return bits.length ? `${bits.map((b) => `<span class="nw">${b}</span>`).join(" · ")} ${EST}` : `<span class="hg-dim">no verdict: a part is missing</span>`;
}

function statusHtml(s, labels) {
  if (s.status === "no-mission") return `<span class="hg-status hg-none">No mission picked</span>`;
  const name = f.esc(missionLabel(s.mission, labels));
  return s.status === "cleared"
    ? `<span class="hg-status hg-go">Cleared · ${name}</span>`
    : `<span class="hg-status hg-nogo">Not ready · ${name}${s.toFix ? ` · ${s.toFix} to fix` : ""}</span>`;
}

const badgeHtml = (badge) => `<span class="hg-badge hg-b-${f.esc(badge.key)}">${f.esc(badge.label)}</span>`;

function entryHtml(e, labels, extra = "") {
  return `<li class="hg-entry${e.current ? " is-current" : ""}">
    <button type="button" class="hg-open" data-act="open" data-ref="${f.esc(e.ref)}"${e.current ? ' aria-current="true"' : ""}>
      <span class="hg-row1"><span class="hg-name">${f.esc(e.name)}</span>${badgeHtml(e.summary.badge)}</span>
      <span class="hg-nums">${numbersHtml(e.summary)}</span>
      ${statusHtml(e.summary, labels)}
    </button>
    <button type="button" class="hg-about" data-act="about" data-ref="${f.esc(e.ref)}" aria-label="About ${f.esc(e.name)}">About</button>
    ${extra ? `<span class="hg-tools">${extra}</span>` : ""}
  </li>`;
}

function myToolsHtml(e, ui) {
  const id = f.esc(e.ref.slice("design:".length));
  if (ui.confirmDelete === e.ref) {
    return `<span class="hg-confirm">Delete “${f.esc(e.name)}”?<button type="button" class="hg-tool hg-danger" data-act="delete-yes" data-id="${id}">Delete</button><button type="button" class="hg-tool" data-act="delete-no">Keep</button></span>`;
  }
  return `<button type="button" class="hg-tool" data-act="rename" data-id="${id}">Rename</button><button type="button" class="hg-tool" data-act="duplicate" data-id="${id}">Duplicate</button><button type="button" class="hg-tool" data-act="delete" data-id="${id}">Delete</button>`;
}

function renameHtml(e) {
  const id = f.esc(e.ref.slice("design:".length));
  return `<li class="hg-entry is-editing"><form class="hg-rename" data-id="${id}">
    <label class="hg-label" for="hg-rename-input">Rename</label>
    <input id="hg-rename-input" name="name" maxlength="60" required value="${f.esc(e.name)}" autocomplete="off" />
    <span class="hg-form-btns"><button type="submit" class="hg-primary">Save</button><button type="button" class="hg-tool" data-act="rename-cancel">Cancel</button></span>
  </form></li>`;
}

function brokenHtml(b, ui) {
  const id = f.esc(b.id);
  const tools =
    ui.confirmDelete === `broken:${b.id}`
      ? `<span class="hg-confirm">Delete “${f.esc(b.name)}”?<button type="button" class="hg-tool hg-danger" data-act="delete-yes" data-id="${id}">Delete</button><button type="button" class="hg-tool" data-act="delete-no">Keep</button></span>`
      : `${b.repairable ? `<button type="button" class="hg-tool" data-act="repair" data-id="${id}">Repair and open</button>` : ""}<button type="button" class="hg-tool" data-act="delete-broken" data-id="${id}">Delete</button>`;
  return `<li class="hg-entry is-broken"><div class="hg-open" aria-disabled="true">
      <span class="hg-row1"><span class="hg-name">${f.esc(b.name)}</span><span class="hg-badge hg-b-broken">needs repair</span></span>
      <span class="hg-why">${f.esc(b.reason)}${b.repairable ? ". Repair swaps the missing part for the first compatible one." : ""}</span>
    </div><span class="hg-tools">${tools}</span></li>`;
}

/** The Hangar list. */
export function listHtml({ presets, designs, broken, labels, ui }) {
  const mine = designs.map((e) => (ui.renaming === e.ref ? renameHtml(e) : entryHtml(e, labels, myToolsHtml(e, ui))));
  const empty = !designs.length && !broken.length ? `<p class="hg-empty">No drones of your own yet. Change a part on any drone and save it, or start one with New drone.</p>` : "";
  return `
    <div class="hg-actions"><button type="button" class="hg-primary" data-act="new">New drone</button></div>
    <h3 class="hg-section">Real drones <span>${presets.length}</span></h3>
    <ul class="hg-list">${presets.map((e) => entryHtml(e, labels)).join("")}</ul>
    <h3 class="hg-section">My drones <span>${designs.length}</span></h3>
    ${empty}<ul class="hg-list">${mine.join("")}${broken.map((b) => brokenHtml(b, ui)).join("")}</ul>
    <p class="hg-foot">Numbers are estimates worked out from each part's published data.</p>`;
}

// --- About ---------------------------------------------------------------------------------------------------

// One row per kind of part on the drone (the manifest, so a part kind added later still shows, by its kind name).
function partsHtml(manifest) {
  const seen = new Map();
  for (const p of manifest ?? []) {
    const k = String(p?.kind ?? "");
    if (seen.has(k)) seen.get(k).count++;
    else seen.set(k, { part: p, count: 1 });
  }
  const rows = [...seen.values()].map(({ part, count }) => {
    const role = partRole(part.kind);
    const key = part.record ? DRONE_OPTION_META(part.kind, part.record) : "";
    const name = part.record?.name ?? part.name ?? role.label;
    return `<li><span class="hg-part-kind">${f.esc(role.label)}${count > 1 ? ` <span class="hg-dim">×${count}</span>` : ""}</span>
      <span class="hg-part-name">${f.esc(name)}${key ? ` <span class="hg-key">${f.esc(key)}</span>` : part.record ? "" : ' <span class="hg-key">derived</span>'}</span>
      <span class="hg-part-does">${f.esc(role.does)}</span></li>`;
  });
  return `<ul class="hg-parts">${rows.join("")}</ul>`;
}

function sourcesHtml(sources) {
  const seen = new Set();
  const links = [];
  for (const { label, str } of sources) {
    const s = f.source(str);
    if (!s?.url || seen.has(s.url)) continue;
    seen.add(s.url);
    links.push(`<li><span class="hg-dim">${f.esc(label)}</span> <a href="${f.esc(s.url)}" target="_blank" rel="noopener noreferrer">${f.esc(s.host ?? "source")}</a></li>`);
  }
  return links.length ? `<ul class="hg-sources">${links.join("")}</ul>` : `<p class="hg-dim">No source links.</p>`;
}

function readinessHtml(readiness) {
  if (!readiness) return "";
  return `<ul class="hg-checks">${readiness.lines
    .map((l) => `<li class="${l.ok ? "is-pass" : "is-fail"}"><span class="hg-ico" aria-hidden="true">${l.ok ? "✓" : "✗"}</span><span>${f.esc(l.text)}</span></li>`)
    .join("")}</ul>`;
}

/** About this drone. */
export function aboutHtml({ entry, manifest, readiness, sources, labels, isLoaded }) {
  const s = entry.summary;
  const kindLine = entry.kind === "preset" ? "Real drone" : entry.kind === "design" ? "My drone" : "Unsaved build";
  const what = entry.note ? `<p class="hg-note">${f.esc(entry.note)}</p>` : `<p class="hg-note hg-dim">No description yet.</p>`;
  const eng = entry.engineering
    ? `<details class="hg-eng"><summary>Engineering notes</summary><p class="hg-note hg-small">${f.esc(entry.engineering)}</p></details>`
    : "";
  const based = entry.basedOnName ? `<p class="hg-dim hg-small">Based on ${f.esc(entry.basedOnName)}</p>` : "";
  const buttons = [
    isLoaded ? "" : `<button type="button" class="hg-primary" data-act="open" data-ref="${f.esc(entry.ref)}">Put it on the pad</button>`,
    isLoaded ? `<button type="button" class="hg-primary" data-act="test">Test against every mission</button>` : "",
    entry.kind !== "draft" ? `<button type="button" class="hg-tool" data-act="new" data-template="${f.esc(entry.ref)}">Use as template</button>` : "",
  ].join("");
  return `
    <p class="hg-eyebrow">${kindLine} ${badgeHtml(s.badge)}</p>
    <h3 class="hg-title">${f.esc(entry.name)}</h3>
    ${based}
    <h4 class="hg-h">What it is</h4>${what}${eng}
    <h4 class="hg-h">Verdict ${s.mission ? `· ${f.esc(missionLabel(s.mission, labels))}` : ""}</h4>
    <p class="hg-nums">${numbersHtml(s)}</p>
    ${statusHtml(s, labels)}
    ${readinessHtml(readiness)}
    <h4 class="hg-h">Parts</h4>${partsHtml(manifest)}
    <h4 class="hg-h">Sources</h4>${sourcesHtml(sources)}
    <div class="hg-actions">${buttons}</div>`;
}

// --- Test ----------------------------------------------------------------------------------------------------

const ICON = { pass: "✓", fail: "✗", "not-judged": "?", "n/a": "–" };
const WORD = { pass: "pass", fail: "fail", "not-judged": "not judged", "n/a": "not asked" };
const COLS = [
  ["parts", "Flies at all (no blocking problems)", "Flies"],
  ["weight", "Weight limit", "Weight"],
  ["endurance", "Endurance", "Time"],
  ["lift", "Hover lift (thrust-to-weight)", "Lift"],
  ["speed", "Cruise speed", "Speed"],
  ["payload", "Required payload", "Payload"],
];

/** Test: the matrix and the selected mission's reasons. */
export function testHtml({ name, rows, selectedId, labels }) {
  const head = COLS.map(([, long, short]) => `<th scope="col" title="${long}">${short}</th>`).join("");
  const body = rows
    .map((r) => {
      const sel = r.mission.id === selectedId;
      const passed = r.ready && r.failing === 0;
      const cells = COLS.map(([key]) => {
        const c = r.checks.find((x) => x.key === key);
        const st = c?.status ?? "n/a";
        return `<td class="is-${st}" title="${f.esc(`${c?.label ?? key}: ${WORD[st]}${c?.reason ? ` · ${c.reason}` : ""}`)}"><span aria-label="${WORD[st]}">${ICON[st]}</span></td>`;
      }).join("");
      return `<tr class="${sel ? "is-selected" : ""}" data-act="mission" data-mission="${f.esc(r.mission.id)}" tabindex="0" aria-selected="${sel}">
        <th scope="row"><span class="hg-dot ${passed ? "is-pass" : "is-fail"}"></span>${f.esc(missionLabel(r.mission, labels))}</th>${cells}</tr>`;
    })
    .join("");
  const sel = rows.find((r) => r.mission.id === selectedId) ?? null;
  const detail = sel
    ? `<div class="hg-detail">
        <p class="hg-eyebrow">${sel.ready && sel.failing === 0 ? '<span class="hg-status hg-go">Cleared</span>' : `<span class="hg-status hg-nogo">Not ready · ${sel.failing} failing</span>`}${sel.notJudged ? ` <span class="hg-status hg-nj">${sel.notJudged} not judged</span>` : ""}</p>
        <h4 class="hg-title-sm">${f.esc(sel.mission.name)}</h4>
        <p class="hg-dim hg-small">${f.esc(sel.mission.description ?? "")}</p>
        <ul class="hg-checks">${sel.checks
          .map(
            (c) =>
              `<li class="is-${c.status}"><span class="hg-ico" aria-hidden="true">${ICON[c.status]}</span><span><b>${f.esc(c.label)}</b>${c.want ? ` <span class="hg-dim">wants ${f.esc(c.want)}</span>` : ""}<br>${c.status === "not-judged" ? "not judged: " : ""}${f.esc(c.reason)}</span></li>`,
          )
          .join("")}</ul>
      </div>`
    : `<p class="hg-dim">Pick a mission to see why.</p>`;
  return `
    <p class="hg-dim hg-small">${f.esc(name)} against every mission in the dataset. Each cell is the verdict's own check (est.); click a mission to fly it.</p>
    <div class="hg-matrix-wrap"><table class="hg-matrix"><thead><tr><th scope="col">Mission</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="hg-legend"><span class="is-pass">✓ pass</span><span class="is-fail">✗ fail</span><span class="is-not-judged">? not judged</span><span class="is-n/a">– not asked</span></p>
    ${detail}`;
}

// --- New drone / Save as new drone -----------------------------------------------------------------------------

/** @param {{ mode: "new"|"save-as", name: string, description: string, template: string, airframeId: string, presets: {ref: string, name: string}[], designs: {ref: string, name: string}[], airframes: {id: string, name: string, badge: {label: string}}[], fill: {build: object|null, missing: string[]}|null, partNames: {slot: string, name: string}[], error: string, currentName: string }} m */
export function newHtml(m) {
  const opt = (value, label) => `<option value="${f.esc(value)}"${m.template === value ? " selected" : ""}>${f.esc(label)}</option>`;
  const templatePick =
    m.mode === "save-as"
      ? `<p class="hg-dim hg-small">Saves the parts on the pad now (${f.esc(m.currentName)}) as a drone of your own.</p>`
      : `<label class="hg-label" for="hg-template">Start from</label>
        <select id="hg-template" name="template">
          <option value="scratch"${m.template === "scratch" ? " selected" : ""}>From scratch: pick an airframe</option>
          <optgroup label="Real drones">${m.presets.map((p) => opt(p.ref, p.name)).join("")}</optgroup>
          ${m.designs.length ? `<optgroup label="My drones">${m.designs.map((d) => opt(d.ref, d.name)).join("")}</optgroup>` : ""}
        </select>`;
  const scratch =
    m.mode === "new" && m.template === "scratch"
      ? `<label class="hg-label" for="hg-airframe">Airframe</label>
        <select id="hg-airframe" name="airframe">${m.airframes.map((a) => `<option value="${f.esc(a.id)}"${a.id === m.airframeId ? " selected" : ""}>${f.esc(a.name)} · ${f.esc(a.badge.label)}</option>`).join("")}</select>
        <p class="hg-dim hg-small">The other parts start as the first compatible option on each shelf; swap them on the pad.</p>
        <ul class="hg-fill">${m.partNames.map((p) => `<li><span class="hg-dim">${f.esc(p.slot)}</span> ${p.name ? f.esc(p.name) : '<span class="bad">no compatible option</span>'}</li>`).join("")}</ul>`
      : "";
  return `<form class="hg-form" novalidate>
      <label class="hg-label" for="hg-name">Name</label>
      <input id="hg-name" name="name" maxlength="60" required value="${f.esc(m.name)}" autocomplete="off" placeholder="My drone" />
      <label class="hg-label" for="hg-desc">Description <span class="hg-dim">(optional)</span></label>
      <textarea id="hg-desc" name="description" maxlength="500" rows="3" placeholder="What is it for?">${f.esc(m.description)}</textarea>
      ${templatePick}
      ${scratch}
      ${m.error ? `<p class="hg-error" role="alert">${f.esc(m.error)}</p>` : ""}
      <div class="hg-actions"><button type="submit" class="hg-primary">${m.mode === "save-as" ? "Save drone" : "Create drone"}</button><button type="button" class="hg-tool" data-act="back">Cancel</button></div>
    </form>`;
}

// --- the current-drone chip -------------------------------------------------------------------------------

/** @param {{ name: string, badge: {key: string, label: string}, modified: boolean, kind: "preset"|"design"|"draft", saved: string }} m */
export function nowHtml(m) {
  const save = [];
  if (m.kind === "design" && m.modified) save.push(`<button type="button" class="hg-chip-btn hg-chip-main" data-act="save">Save</button>`);
  if (m.modified || m.kind === "draft") save.push(`<button type="button" class="hg-chip-btn${m.kind === "design" ? "" : " hg-chip-main"}" data-act="save-as">Save as new drone</button>`);
  return `<span class="hg-chip-name">${f.esc(m.name)}${m.modified ? ' <span class="hg-dim">(modified)</span>' : ""}</span>${badgeHtml(m.badge)}
    <button type="button" class="hg-chip-btn" data-act="about-current">About</button>${save.join("")}${m.saved ? `<span class="hg-saved" role="status">${f.esc(m.saved)}</span>` : ""}`;
}
