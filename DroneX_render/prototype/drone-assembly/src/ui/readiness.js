// Flight readiness panel.
//   mountReadiness({ host?, hud?, destinations?, onDestination? }) -> { update(state), setPhase(phase), dispose() }
//     state: { build, verdict, mission, readiness, complete?, summary? }
//       readiness: droneCatalog.droneReadiness(verdict, mission) → { ready, title, to, lines: [{ key, ok, text "Lift: …" }],
//         toFix }; summary: { headline, ok?, sentences } for the flight result.
//     phase: "pad" (shown once the drone is complete) | "flight" (hidden) | "result" (end line + sentences)
//     destinations: droneCatalog.droneDestinations() → [{ id, label, missionId }]; onDestination(missionId, d) on a click.
//   panelText(state, phase, destinations) -> what the panel shows, as plain data (pure)
// Layout: fixed right 32 px, top 60 px, 280 px wide; at ≤ 760 px full width just under the HUD's real bottom.
// Header: dot + "CLEARED TO FLY" / "NOT READY YET" + "hit Take off" / "n to fix", then the mission line; row 0 a
// segmented mission picker; then the readiness rows. CSS injected once (<style data-readiness>), classes rdy-,
// style.css tokens. DOM work only inside mountReadiness.

const missionOf = (d) => d.missionId ?? d.id;
const PHASES = new Set(["pad", "flight", "result"]);
function normalise(r, v) {
  const src = Array.isArray(r) ? r : (r?.lines ?? r?.rows ?? null);
  // readiness() lines are "Lift: 2.4× weight": the label before the first colon, the detail after it.
  const row = (x) => {
    const t = x.text ?? x.detail ?? x.line ?? "";
    const m = /^([^:]+):\s*(.*)$/.exec(t);
    return x.label ? { label: x.label, ok: Boolean(x.ok), text: t } : { label: m ? m[1] : (x.key ?? ""), ok: Boolean(x.ok), text: m ? m[2] : t };
  };
  const rows = (src ?? []).map(row);
  const toFix = Number.isFinite(r?.toFix) ? r.toFix : rows.filter((x) => !x.ok).length;
  const ready = typeof r?.ready === "boolean" ? r.ready : Boolean(v?.feasible) && toFix === 0;
  return { rows, toFix, ready };
}

export function panelText(state = {}, phase = "pad", destinations = []) {
  const { build, verdict, mission, readiness, complete = Boolean(verdict), summary } = state;
  if (phase === "flight") return { visible: false };
  if (phase === "result") {
    if (!summary?.headline) return { visible: false };
    return { visible: true, result: true, ok: summary.ok !== false, title: "FLIGHT RESULT", headline: summary.headline, sentences: (summary.sentences ?? []).slice(0, 3) };
  }
  if (!complete || !verdict) return { visible: false };
  const { rows, toFix, ready } = normalise(readiness, verdict);
  const current = build?.missionId ?? mission?.id ?? null;
  const to = typeof readiness?.to === "string" ? readiness.to : readiness && "to" in readiness ? "" : mission?.name ? `to ${mission.name}` : "";
  return {
    visible: true,
    result: false,
    ready,
    title: typeof readiness?.title === "string" ? readiness.title : ready ? "CLEARED TO FLY" : "NOT READY YET",
    fix: ready ? "hit Take off" : `${toFix} to fix`,
    to,
    dest: destinations.map((d) => ({ id: d.id, missionId: missionOf(d), label: d.label, current: missionOf(d) === current })),
    rows,
    firstBad: rows.findIndex((x) => !x.ok),
  };
}

// ---------- DOM ----------
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "hidden") e.hidden = true;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid != null && kid !== false) e.append(kid);
  return e;
}

const CSS = `
.rdy { position: fixed; right: 32px; top: 60px; width: 280px; z-index: 10; padding: 8px; border: 1px solid var(--hairline);
  border-radius: 12px; background: var(--surface); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  color: var(--text); font-family: var(--font); font-size: 12px; text-align: left; transition: opacity 400ms ease, border-color 400ms ease; }
.rdy[hidden], .rdy [hidden] { display: none !important; } /* the grid/flex rules below would beat the attribute */
.rdy.rdy-ready { border-color: rgba(46, 230, 182, 0.45); box-shadow: 0 0 18px rgba(46, 230, 182, 0.12); }
.rdy-head { display: flex; align-items: center; gap: 8px; padding: 4px 8px 0; }
.rdy-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--nogo); }
.rdy-title { margin: 0; font-size: 11px; font-weight: 600; letter-spacing: 0.14em; color: var(--nogo); }
.rdy-ready .rdy-dot, .rdy-good .rdy-dot { background: var(--go); }
.rdy-ready .rdy-title, .rdy-good .rdy-title { color: var(--go); }
.rdy-fix { margin-left: auto; font-size: 11px; color: var(--text-2); white-space: nowrap; }
.rdy-to { margin: 2px 0 6px; padding-left: 22px; font-size: 11px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rdy-dest { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; margin: 0 4px 6px; padding: 2px; border: 1px solid var(--hairline);
  border-radius: 8px; background: rgba(255, 255, 255, 0.03); }
.rdy-dest button { font: inherit; font-size: 11.5px; color: var(--text-2); background: none; border: 0; border-radius: 6px; padding: 5px 0; cursor: pointer; }
.rdy-dest button[aria-checked="true"] { color: var(--bg); background: var(--select); font-weight: 600; }
.rdy-dest button:not([aria-checked="true"]):hover, .rdy-dest button:focus-visible { color: var(--text); background: rgba(255, 255, 255, 0.07); outline: none; }
.rdy-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; }
.rdy-row { display: flex; align-items: baseline; gap: 8px; padding: 5px 8px; border-radius: 8px; }
.rdy-row.rdy-first { background: rgba(255, 106, 61, 0.08); }
.rdy-mark { width: 12px; flex: none; font-size: 11px; font-weight: 700; }
.rdy-ok .rdy-mark { color: var(--go); }
.rdy-bad .rdy-mark, .rdy-bad .rdy-detail { color: var(--nogo); }
.rdy-label { font-size: 12.5px; color: var(--text); white-space: nowrap; }
.rdy-detail { margin-left: auto; font-family: var(--mono); font-size: 11.5px; color: var(--text-2); text-align: right; font-variant-numeric: tabular-nums; }
.rdy-result { padding: 4px 8px 2px; }
.rdy-headline { margin: 4px 0 0; font-size: 12.5px; font-weight: 600; color: var(--text); }
.rdy-result p.rdy-s { margin: 4px 0 0; font-size: 11.5px; line-height: 1.45; color: var(--text-2); }
body.landing .rdy { opacity: 0; pointer-events: none; }
@media (max-width: 760px) { .rdy { left: 16px; right: 16px; width: auto; top: 80px; } }
@media (pointer: coarse) { .rdy-dest button { min-height: 28px; } }
`;
let styleRefs = 0;
let styleEl = null;

export function mountReadiness({ host = null, hud = null, destinations = null, onDestination = null } = {}) {
  if (!styleRefs++) {
    styleEl = el("style", { "data-readiness": true, text: CSS });
    document.head.append(styleEl);
  }
  const dests = Array.isArray(destinations) ? destinations : [];
  let state = {};
  let phase = "pad";
  const hudEl = hud ?? document.getElementById("hud");
  const panel = el("section", { class: "rdy", "aria-live": "polite", "aria-label": "Flight readiness", hidden: true });
  const head = el("div", { class: "rdy-head" });
  const title = el("h2", { class: "rdy-title" });
  const fix = el("span", { class: "rdy-fix" });
  head.append(el("span", { class: "rdy-dot", "aria-hidden": "true" }), title, fix);
  const to = el("p", { class: "rdy-to" });
  const dest = el("div", { class: "rdy-dest", role: "radiogroup", "aria-label": "Mission" });
  const rowsEl = el("ul", { class: "rdy-rows" });
  const result = el("div", { class: "rdy-result", hidden: true });
  panel.append(head, to, dest, rowsEl, result);
  (host ?? document.body).append(panel);
  document.body.dataset.readinessPanel = "1";

  // The mission picker: one segment per mission.
  dest.replaceChildren();
  dest.style.gridTemplateColumns = `repeat(${Math.max(1, Math.min(dests.length, 5))}, 1fr)`; // a drone's missions are not always four
  for (const d of dests) {
    dest.append(
      el("button", {
        type: "button",
        role: "radio",
        "aria-checked": "false",
        "data-id": d.id,
        text: d.label,
        onclick: (e) => {
          onDestination?.(missionOf(d), d);
          if (e.detail > 0) e.currentTarget.blur?.(); // a mouse click: hand the keys back to the demo (L takes off)
        },
        // Only the keys that press this button stay here (Space would also explode the stack); every other key,
        // L included, reaches the demo's shortcuts.
        onkeydown: (e) => {
          if (e.key === " " || e.key === "Enter") e.stopPropagation();
        },
      }),
    );
  }

  // Phones: full width just under the HUD's real bottom edge.
  const mq = globalThis.matchMedia?.("(max-width: 760px)") ?? null;
  function place() {
    if (!mq?.matches) {
      panel.style.top = "";
      return;
    }
    const r = hudEl?.getBoundingClientRect?.();
    panel.style.top = r && r.height > 0 ? `${Math.round(r.bottom + 6)}px` : "";
  }
  const ro = hudEl && typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
  ro?.observe(hudEl);
  mq?.addEventListener?.("change", place);
  addEventListener("resize", place);

  function render() {
    const t = panelText(state, phase, dests);
    panel.hidden = !t.visible;
    if (!t.visible) return;
    panel.classList.toggle("rdy-ready", Boolean(t.ready));
    panel.classList.toggle("rdy-good", Boolean(t.result && t.ok));
    title.textContent = t.title;
    fix.textContent = t.result ? "" : t.fix;
    to.hidden = t.result || !t.to;
    to.textContent = t.to ?? "";
    dest.hidden = t.result;
    rowsEl.hidden = t.result;
    result.hidden = !t.result;
    if (t.result) {
      result.replaceChildren(el("p", { class: "rdy-headline", text: t.headline }), ...t.sentences.map((s) => el("p", { class: "rdy-s", text: s })));
    } else {
      for (const b of dest.children) b.setAttribute("aria-checked", String(t.dest.find((d) => d.id === b.getAttribute("data-id"))?.current ?? false));
      rowsEl.replaceChildren(
        ...t.rows.map((r, i) =>
          el("li", { class: `rdy-row ${r.ok ? "rdy-ok" : "rdy-bad"}${i === t.firstBad ? " rdy-first" : ""}` }, el("span", { class: "rdy-mark", "aria-hidden": "true", text: r.ok ? "✓" : "✕" }), el("span", { class: "rdy-label", text: r.label }), el("span", { class: "rdy-detail", text: r.text })),
        ),
      );
    }
    place();
  }

  return {
    update(next = {}) {
      state = { ...next };
      render();
    },
    setPhase(next) {
      if (!PHASES.has(next)) return;
      phase = next;
      render();
    },
    dispose() {
      ro?.disconnect();
      mq?.removeEventListener?.("change", place);
      removeEventListener("resize", place);
      panel.remove();
      delete document.body.dataset.readinessPanel;
      if (!--styleRefs) {
        styleEl?.remove();
        styleEl = null;
      }
    },
  };
}
