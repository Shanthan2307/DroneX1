// Detail card for one selected part. Fixed left on desktop, bottom sheet on narrow screens (style.css).
//   createCard(rootEl, { onOption }?) -> { show(part, ctx), refresh(ctx), hide(), el, part }
// The card frame: eyebrow, title, sub line, the body from ui/droneCard.js, the "Options" list (the slot's
// alternatives, dataset records with their compatibility) and the source links. Esc / a click on empty space
// close it (select.js).
// Sourced-number drawer: every number is clickable and opens a line under it with its evidence: the record's own
// source (its quoted text, any derivation note, and the link), or for a derived number its formula with the
// inputs.
import { DRONE_OPTION_META, droneCardBody } from "./droneCard.js";
import * as f from "./format.js";

// Provenance registry for one render: rec() marks a record field, calc() a derived value; both return the
// number wrapped in a clickable, and remember what its drawer shows.
function provenance() {
  const entries = [];
  const wrap = (html, entry) => {
    entries.push(entry);
    return `<button type="button" class="num" data-p="${entries.length - 1}" aria-expanded="false">${html}</button>`;
  };
  return {
    entries,
    // path into the dataset, e.g. ["drone", "motors", "<id>", "kv"]; source = the record's source string
    rec: (html, path, source) => wrap(html, { path, source }),
    calc: (html, formula, note = "") => wrap(html, { formula, note }),
  };
}

const URL_RE = /https?:\/\/[^\s;)"]+/g;
function drawerHtml(entry) {
  if (entry.formula) {
    return `<span class="drawer-f">${f.esc(entry.formula)}</span>${entry.note ? `<span class="drawer-n">${f.esc(entry.note)}</span>` : ""}`;
  }
  // The record's source string: its quoted text, any derivation note before the URL, and the link.
  const str = entry.source ?? "";
  const quotes = [...str.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const derivation = /^\s*derived/i.test(str) ? str.split(URL_RE)[0].replace(/[\s;,(]+$/, "") : "";
  const src = f.source(str);
  const parts = [];
  if (quotes.length) parts.push(`<span class="drawer-q">“${f.esc(quotes.join(" … "))}”</span>`);
  if (derivation) parts.push(`<span class="drawer-n">${f.esc(derivation)}</span>`);
  if (!quotes.length && !derivation) parts.push(`<span class="drawer-n">Record source (no verbatim quote for this field yet)</span>`);
  if (src?.url) parts.push(`<a href="${f.esc(src.url)}" target="_blank" rel="noopener noreferrer">${f.esc(src.host ?? "source")}</a>`);
  return parts.join("");
}

// options: records, or compat entries { record, level: ok | unusual | incompatible, reasons } (droneCompat.js),
// already sorted ok → unusual → incompatible. Unusual rows carry a tag and their reasons; incompatible rows
// are greyed out and cannot be picked; a hairline separates the groups.
function optionsHtml(part, options, { expanded, disabled }) {
  if (!part.record || !options || options.length < 2) return "";
  let prevLevel = null;
  const items = options
    .map((o) => {
      const { record: r, level = "ok", reasons = [] } = o.record ? o : { record: o };
      const cur = r.id === part.record.id;
      const blocked = level === "incompatible";
      const why = reasons.length ? `<span class="opt-why">${f.esc(reasons.join(" · "))}</span>` : "";
      const tag = level === "unusual" ? ' <span class="tag">unusual</span>' : "";
      const first = prevLevel !== null && level !== prevLevel ? ' class="opt-group"' : "";
      prevLevel = level;
      return `<li${first}><button type="button" class="opt opt-${level}" data-id="${f.esc(r.id)}"${cur ? ' aria-current="true"' : ""}${disabled || (blocked && !cur) ? " disabled" : ""}${blocked ? ' aria-disabled="true"' : ""}><span class="opt-name">${f.esc(r.name)}${tag}</span><span class="opt-meta">${f.esc(DRONE_OPTION_META(part.kind, r))}</span>${why}</button></li>`;
    })
    .join("");
  return `<div class="opts${expanded ? " open" : ""}"><button type="button" class="opt-toggle" aria-expanded="${expanded}"${disabled ? " disabled" : ""}>Options</button><ul class="opt-list"${expanded ? "" : " hidden"}>${items}</ul></div>`;
}

// show(part, ctx): ctx = { verdict, complete, options?, optionsDisabled? }.
// options: the records this slot can take (vehicle.optionsWithCompat); picking one calls onOption(part, recordId).
export function createCard(rootEl, { onOption } = {}) {
  const el = rootEl;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Part details");
  let current = null;
  let key = "";
  let expanded = false;
  let lastCtx = null;
  let prov = [];

  // A number's drawer opens on a line under its row (or under the sub line / stage footer); one per line.
  function toggleDrawer(btn) {
    const i = Number(btn.dataset.p);
    const host = btn.closest(".detail dl > div, .detail .stage, .detail .sub");
    if (!host || !prov[i]) return;
    const inside = host.matches("dl > div, .stage");
    const scope = inside ? host : host.parentElement;
    const open = scope.querySelector(`:scope > .drawer[data-for="${inside ? "" : "sub"}"]`);
    const wasThis = open?.dataset.p === String(i);
    open?.remove();
    for (const b of (inside ? host : host).querySelectorAll('.num[aria-expanded="true"]')) b.setAttribute("aria-expanded", "false");
    if (wasThis) return;
    const d = document.createElement("div");
    d.className = "drawer";
    d.dataset.p = String(i);
    d.dataset.for = inside ? "" : "sub";
    d.innerHTML = drawerHtml(prov[i]);
    if (inside) host.appendChild(d);
    else host.after(d);
    btn.setAttribute("aria-expanded", "true");
    if (!reduced()) d.animate([{ opacity: 0, transform: "translateY(-3px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "ease-out" });
  }

  el.addEventListener("click", (e) => {
    const num = e.target.closest(".num");
    if (num) {
      toggleDrawer(num);
      return;
    }
    const opt = e.target.closest(".opt");
    if (opt && !opt.disabled && opt.getAttribute("aria-disabled") !== "true" && current) {
      if (opt.getAttribute("aria-current") === "true") return;
      expanded = false;
      onOption?.(current, opt.dataset.id);
      return;
    }
    if (e.target.closest(".opt-toggle") && current) {
      expanded = !expanded;
      const wrap = el.querySelector(".opts");
      wrap.classList.toggle("open", expanded);
      wrap.querySelector(".opt-toggle").setAttribute("aria-expanded", String(expanded));
      const list = wrap.querySelector(".opt-list");
      list.hidden = !expanded;
      if (expanded) {
        list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
        if (!reduced()) list.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "ease-out" });
      }
    }
  });

  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  function show(part, ctx = {}) {
    const { verdict, complete = false, options, optionsDisabled = false } = ctx;
    lastCtx = ctx;
    const P = provenance();
    // The card for a drone part: millimetres, grams, KV and mAh, with the verdict's numbers once it is built.
    const c = droneCardBody(part, { verdict, complete }, P);
    const nextKey = `${part.id}|${part.record?.id ?? ""}|${part.count ?? ""}|${complete}|${optionsDisabled}|${verdict?.totalDeltaV_ms ?? ""}`;
    if (part === current && nextKey === key && el.classList.contains("open")) return;
    const swap = current && current.id !== part.id && el.classList.contains("open");
    if (!current || current.id !== part.id) expanded = false;
    const sources = c.sources.filter(Boolean);
    prov = P.entries;
    el.innerHTML = `
      <div class="detail-body">
        <p class="eyebrow">${f.esc(c.eyebrow)}</p>
        <h2>${f.esc(c.title)}</h2>
        ${c.subHtml ? `<p class="sub">${c.subHtml}</p>` : c.sub ? `<p class="sub">${f.esc(c.sub)}</p>` : ""}
        ${c.body}
        ${optionsHtml(part, options, { expanded, disabled: optionsDisabled })}
        ${sources.length ? `<p class="src">${sources.join("")}</p>` : ""}
      </div>`;
    current = part;
    key = nextKey;
    // Force a style flush so the slide-in transition runs from the closed state.
    void el.offsetWidth;
    el.classList.add("open");
    if (swap && !reduced()) {
      el.querySelector(".detail-body").animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], {
        duration: 200,
        easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      });
    }
  }

  function hide() {
    current = null;
    key = "";
    expanded = false;
    el.classList.remove("open");
  }

  return {
    show,
    hide,
    // Re-render the open card with fresh context (after a swap or when the stack completes).
    refresh(ctx) {
      if (current) show(current, { ...lastCtx, ...ctx });
    },
    el,
    get part() {
      return current;
    },
  };
}
