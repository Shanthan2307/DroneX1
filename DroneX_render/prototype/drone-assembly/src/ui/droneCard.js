// Detail card for one selected DRONE part, the drone half of ui/card.js.
//   droneCardBody(part, ctx, P)      -> { eyebrow, title, sub | subHtml, body, sources }  same shape as engineCard
//   DRONE_OPTION_META(kind, record)  -> the one key number per alternative in the options list
// card.js owns the frame, the drawer and the options list; this file only writes the body, and it uses the same
// provenance helper P, so every number here is clickable too: P.rec() for a dataset field (the drawer shows the
// record's own source), P.calc() for a derived number (the drawer shows the formula with its inputs).
//
// Two rules this file must never break:
//   1. TRUE millimetres and grams only (contract §2). spec.geom carries true metres and spec.slotY / height /
//      radius are multiplied by geom.viewK for the display scale — a viewK number must never reach the screen.
//      Everything below reads part.record fields or part.geom lengths in metres, nothing scaled.
//   2. No invented numbers. A record field is shown as the record states it. A derived number shows its
//      formula and carries the "derived" tag; anything that leans on a DRONE_RULES modelling constant carries
//      the "est." tag instead, because a modelling allowance is an estimate, not a measurement.
import { droneCatalog } from "../data/droneCatalog.js";
import { DRONE_RULES } from "../dronePhysics.js";
import * as f from "./format.js";
import { partRole } from "./partRoles.js";

const NB = " ";
const DERIVED = '<span class="tag">derived</span>';
const EST = '<span class="tag">est.</span>';
const DASH = "–";

const row = (label, value, tag = "") => `<div><dt>${f.esc(label)}</dt><dd>${value}${tag ? " " + tag : ""}</dd></div>`;
const nw = f.nw;
const each = (v, total) => `${nw(`${v} each`)} · ${nw(`${total} total`)}`;

// --- units ------------------------------------------------------------------------------------------------
// format.js covers metres, tonnes and kilonewtons; a drone is grams, millimetres, volts and amps. Record
// values keep the record's own precision (f.rec); derived values are rounded to something readable.
const gr = (x) => `${f.rec(x, 1)}${NB}g`;
const grR = (x) => `${f.num(x, 0)}${NB}g`;
const mmv = (x) => `${f.rec(x, 2)}${NB}mm`;
const inch = (x) => `${f.rec(x, 2)}″`;
const volts = (x) => `${f.rec(x, 2)}${NB}V`;
const ampsv = (x) => `${f.num(x, 1)}${NB}A`;
const watts = (x) => `${f.num(x, 1)}${NB}W`;
const wh = (x) => `${f.rec(x, 2)}${NB}Wh`;
const mins = (x) => `${f.num(x, 1)}${NB}min`;
const rpmv = (x) => `${f.num(x, 0)}${NB}rpm`;
const mahv = (x) => `${f.num(x, 0)}${NB}mAh`;
const kmv = (x) => `${f.num(x, 2)}${NB}km`;
const msv = (x) => `${f.num(x, 1)}${NB}m/s`;
const twrv = (x) => f.num(x, 2);
const mach = (x) => `Mach${NB}${f.num(x, 2)}`;
const pctv = (x) => `${f.num(x * 100, 0)}${NB}%`;
const dm2 = (x) => `${f.rec(x, 2)}${NB}dm²`;
const gdm2 = (x) => `${f.num(x, 1)}${NB}g/dm²`;
// Millimetres from the true metres a geom carries. geom lengths are metres (contract §5), never display scale.
const mmOf = (metres) => (Number.isFinite(metres) ? mmv(metres * 1000) : DASH);

const ok = (x) => typeof x === "number" && Number.isFinite(x);
// The airframe record's type, in words (the record keeps its enum; only the label changes).
const TYPE_LABEL = { multirotor: "multirotor", fixed_wing_3dprint: "fixed wing, 3D printed" };

function sourceLink(str, label) {
  const src = f.source(str);
  if (!src?.url) return src?.derived ? `<span>${f.esc(label ? label + ": " : "")}derived</span>` : "";
  const text = `${src.derived ? "derived · " : ""}${src.host ?? "source"}`;
  return `<span>${label ? f.esc(label) + ": " : ""}<a href="${f.esc(src.url)}" target="_blank" rel="noopener noreferrer" title="${f.esc(str)}">${f.esc(text)}</a></span>`;
}

// --- the kinds (contract §5) -----------------------------------------------------------------------------
// Which dataset collection a kind's record comes from, and the eyebrow it gets. The two "derived structure"
// kinds have no record: the electronics stack and the tail are drawn from layout proportions.
const KIND = {
  "drone-frame": { list: "airframes", label: "frame" },
  "drone-arm": { list: "motors", label: "arm + motor" },
  "drone-electronics": { list: null, label: "electronics" },
  "drone-battery": { list: "batteries", label: "battery" },
  "drone-camera": { list: "payloads", label: "payload" },
  "drone-propeller": { list: "propellers", label: "propeller" },
  "drone-fuselage": { list: "airframes", label: "fuselage" },
  "drone-wing": { list: "airframes", label: "wing" },
  "drone-tail": { list: null, label: "tail" },
  "drone-nose-motor": { list: "motors", label: "motor" },
  "drone-nose-propeller": { list: "propellers", label: "propeller" },
};

export const DRONE_KIND_LABEL = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [k, v.label]));

// --- the shared verdict footer ---------------------------------------------------------------------------
// The whole-vehicle numbers, on every drone card, the way stageFooter puts the stage's physics on every rocket
// card. Only shown once the vehicle is built (ctx.complete): a drone's weight and thrust are facts about the
// whole build, so quoting them while it is still being assembled would be a number about a drone that is not
// there yet.
function verdictFooter(P, v, airframeType, highlight = null) {
  if (!v || !ok(v.allUpWeight_g) || v.allUpWeight_g <= 0) return "";
  const hovers = airframeType === "multirotor" || String(airframeType ?? "").startsWith("vtol");
  const bits = [
    `AUW ${P.calc(grR(v.allUpWeight_g), massFormula(v), `includes a ${DRONE_RULES.ELECTRONICS_ALLOWANCE_G} g modelling allowance for the flight controller, ESC, VTX and wiring`)} ${EST}`,
    `${hovers ? "hover" : "static"} T/W ${P.calc(twrv(v.hoverTWR), `T/W = total thrust / all-up weight = ${grR(v.totalThrust_g)} / ${grR(v.allUpWeight_g)}`, `full-throttle thrust; the app wants ≥ ${DRONE_RULES.HOVER_TWR_OK} to hover with margin, ${DRONE_RULES.HOVER_TWR_MIN} to hold altitude at all`)} ${EST}`,
  ];
  if (ok(v.hoverTime_min)) {
    bits.push(
      `${hovers ? "hover" : "cruise"} ${P.calc(mins(v.hoverTime_min), `t = usable pack energy / power × 60 = ${wh((v.hoverTime_min * v.hoverPower_W) / 60)} / ${watts(v.hoverPower_W)} × 60`, `usable energy is ${pctv(DRONE_RULES.USABLE_PACK_SHARE)} of the pack, the share a LiPo is flown to`)} ${EST}`,
    );
  }
  if (ok(v.mixedTime_min)) {
    bits.push(`mixed ${P.calc(mins(v.mixedTime_min), `t_mixed = t_steady / ${DRONE_RULES.MIXED_POWER_FACTOR}`, "mixed flying — climbs, translation and manoeuvre — draws more than a steady hover; the factor is a modelling assumption")} ${EST}`);
  }
  const warn = (v.warnings ?? []).map((w) => `<li>${f.esc(w)}</li>`).join("");
  const checks = missionChecks(v, v.mission);
  const judged = checks.filter((c) => c.ok !== null);
  const passed = judged.filter((c) => c.ok).length;
  const missionLine = v.mission && judged.length
    ? `<p style="margin-top:4px">${f.esc(v.mission.name)}: ${passed === judged.length ? GOOD(`all ${judged.length} checks pass`) : `<span class="bad">${judged.length - passed} of ${judged.length} checks short</span>`}</p>`
    : "";
  return `<div class="stage">${massBar(v, highlight)}<p>${bits.map(nw).join(" · ")}</p>${missionLine}${warn ? `<ul class="warn">${warn}</ul>` : ""}</div>`;
}

// Pass and fail in the card's own colours (style.css: --go / --nogo).
const GOOD = (html) => `<span style="color:var(--go)">${html}</span>`;
const PASS = GOOD("\u2713\u00a0pass");
const FAIL = '<span class="bad">\u2717\u00a0short</span>';
const NOT_JUDGED = '<span class="tag">not judged</span>';
const passMark = (okFlag) => (okFlag === null || okFlag === undefined ? NOT_JUDGED : okFlag ? PASS : FAIL);

// The all-up weight as one stacked bar: a segment per contributor, sized by its grams (the verdict's own
// massBreakdown), the part on the open card drawn bright. A legend under it on the frame card only.
const BAR_SHADES = ["#8a9099", "#c9ced6", "#5f656e", "#e8a25a", "#9fb6d6", "#b7a3d9"];
function massBar(v, highlight = null, { legend = false } = {}) {
  const rows = (v?.massBreakdown ?? []).filter((r) => ok(r.grams) && r.grams > 0);
  const total = ok(v?.allUpWeight_g) && v.allUpWeight_g > 0 ? v.allUpWeight_g : 0;
  if (!rows.length || !total) return "";
  const lit = (r) => Boolean(highlight) && String(r.label).includes(highlight);
  const anyLit = rows.some(lit);
  const segs = rows
    .map((r, i) => {
      const share = r.grams / total;
      const on = !anyLit || lit(r);
      const title = `${r.label}: ${f.num(r.grams, 0)} g · ${f.num(share * 100, 0)} %`;
      return `<span title="${f.esc(title)}" style="flex:${share.toFixed(4)} 0 0;background:${BAR_SHADES[i % BAR_SHADES.length]};opacity:${on ? 1 : 0.35};min-width:2px"></span>`;
    })
    .join("");
  const bar = `<div role="img" aria-label="mass breakdown" style="display:flex;gap:1px;height:8px;border-radius:4px;overflow:hidden;margin:2px 0 6px">${segs}</div>`;
  if (!legend) return bar;
  // One line per contributor: swatch, name (ellipsised, full name on hover), grams and share right-aligned.
  const key = rows
    .map(
      (r, i) =>
        `<div style="display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:1.5"><span style="flex:none;width:8px;height:8px;border-radius:2px;background:${BAR_SHADES[i % BAR_SHADES.length]}"></span><span title="${f.esc(r.label)}" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-2)">${f.esc(r.label)}</span><span style="flex:none;font-variant-numeric:tabular-nums">${nw(grR(r.grams))} · ${nw(pctv(r.grams / total))}</span></div>`,
    )
    .join("");
  return `${bar}<div style="margin-top:6px">${key}</div>`;
}

// The mission's requirements against this build's verdict: what was asked, what the build has, pass or fail.
// The same comparisons dronePhysics makes for missionOk, read from missionOk so the two can never disagree.
function missionChecks(v, mission) {
  if (!mission || !v) return [];
  const o = v.missionOk ?? {};
  const out = [];
  if (ok(mission.maxAllowableWeight_g)) out.push({ key: "weight", label: "Weight", want: `≤ ${grR(mission.maxAllowableWeight_g)}`, have: ok(v.allUpWeight_g) ? grR(v.allUpWeight_g) : DASH, ok: o.weight ?? null });
  if (ok(mission.targetEndurance_min)) out.push({ key: "endurance", label: "Endurance", want: `≥ ${mins(mission.targetEndurance_min)}`, have: ok(v.mixedTime_min) ? `${mins(v.mixedTime_min)} mixed` : DASH, ok: o.endurance ?? null });
  if (ok(mission.requiredHoverTWR)) out.push({ key: "twr", label: "Thrust/weight", want: `≥ ${twrv(mission.requiredHoverTWR)}`, have: ok(v.hoverTWR) ? twrv(v.hoverTWR) : DASH, ok: o.twr ?? null });
  if (ok(mission.minCruiseSpeed_ms)) {
    const speed = ok(v.cruiseSpeed_ms) ? `${msv(v.cruiseSpeed_ms)} cruise` : ok(v.maxSpeed_ms) ? `${msv(v.maxSpeed_ms)} top` : DASH;
    out.push({ key: "speed", label: "Speed", want: `≥ ${msv(mission.minCruiseSpeed_ms)}`, have: speed, ok: o.speed ?? null });
  }
  if (mission.requiredPayloadId) {
    const name = (id) => droneCatalog.payloads?.find((p) => p.id === id)?.name ?? id;
    out.push({ key: "payload", label: "Payload", want: name(mission.requiredPayloadId), have: v.massBreakdown?.some((r) => r.label === name(mission.requiredPayloadId)) ? "fitted" : "not fitted", ok: o.payload ?? null });
  }
  return out;
}

// The all-up weight as a sum, for the drawer: "138 g + 4 × 32.4 g + … + 30 g".
const massFormula = (v) => `AUW = ${(v.massBreakdown ?? []).map((r) => grR(r.grams)).join(" + ")} = ${grR(v.allUpWeight_g)}`;

// The mass breakdown as its own list, on the frame and fuselage cards: one row per contributor, with its share.
function massTable(P, v) {
  if (!v?.massBreakdown?.length || !ok(v.allUpWeight_g) || v.allUpWeight_g <= 0) return "";
  const head = `<p class="eyebrow" style="margin-top:14px">Mass breakdown</p>`;
  const total = `<dl style="margin-top:6px"><div><dt>All-up weight</dt><dd>${P.calc(grR(v.allUpWeight_g), massFormula(v), "every chosen part plus the electronics allowance")} ${EST}</dd></div></dl>`;
  return `${head}<div style="margin-top:6px">${massBar(v, null, { legend: true })}</div>${total}`;
}

// The mission rows, on the payload card: what the mission asked for and whether this build gets there.
// Each requirement as "has · wants · pass/fail"; the wanted figure is the mission record's own field (clickable).
const MISSION_FIELD = { weight: "maxAllowableWeight_g", endurance: "targetEndurance_min", twr: "requiredHoverTWR", speed: "minCruiseSpeed_ms", payload: "requiredPayloadId" };
function missionRows(P, v, mission, { complete = true } = {}) {
  if (!mission) return [];
  const S = (field, html) => P.rec(html, ["drone", "missions", mission.id, field], mission.source);
  const out = [row("Mission", f.esc(mission.name))];
  for (const c of missionChecks(v, mission)) {
    const want = S(MISSION_FIELD[c.key], f.esc(c.want));
    const note = c.key === "speed" && c.ok !== null && !ok(v?.cruiseSpeed_ms) ? ' <span class="tag">top speed: no cruise figure for a multirotor</span>' : "";
    out.push(row(c.label, complete ? `${nw(f.esc(c.have))} · ${nw(`wants ${want}`)} ${passMark(c.ok)}${note}` : `wants ${want}`, c.key === "payload" ? "" : complete ? EST : ""));
  }
  return out;
}

// --- per-kind cards --------------------------------------------------------------------------------------

// The multirotor frame: the airframe record, read as a frame. Every length is the record's own millimetres.
function frameCard(part, ctx, P) {
  const a = part.record;
  const v = ctx.verdict;
  const g = part.geom ?? {};
  const R = (field, html) => P.rec(html, ["drone", "airframes", a.id, field], a.source);
  const rows = [
    row("Type", f.esc(TYPE_LABEL[a.type] ?? String(a.type ?? DASH).replace(/_/g, " "))),
    row("Wheelbase", R("wheelbase_mm", mmv(a.wheelbase_mm)), ok(g.wheelbase_m) ? "" : ""),
    row("Motors", `${R("motorCount", String(a.motorCount))}${ok(v?.hoverRotorCount) && v.hoverRotorCount !== a.motorCount ? ` (${v.hoverRotorCount} of them lift)` : ""}`),
    row("Largest propeller", ok(a.maxPropDiameter_in) ? R("maxPropDiameter_in", inch(a.maxPropDiameter_in)) : ok(a.liftPropDiameter_in) ? R("liftPropDiameter_in", inch(a.liftPropDiameter_in)) : DASH),
    row("Motor mount", ok(a.motorMount_mm) ? R("motorMount_mm", mmv(a.motorMount_mm)) : DASH),
    row("Empty weight", R("emptyWeight_g", gr(a.emptyWeight_g))),
  ];
  if (ok(a.armThickness_mm)) rows.push(row("Arm thickness", R("armThickness_mm", mmv(a.armThickness_mm))));
  if (ok(a.topPlateThickness_mm) || ok(a.bottomPlateThickness_mm)) {
    rows.push(row("Plates", `${nw(`${ok(a.topPlateThickness_mm) ? R("topPlateThickness_mm", mmv(a.topPlateThickness_mm)) : DASH} top`)} · ${nw(`${ok(a.bottomPlateThickness_mm) ? R("bottomPlateThickness_mm", mmv(a.bottomPlateThickness_mm)) : DASH} bottom`)}`));
  }
  if (ok(a.standoffHeight_mm)) rows.push(row("Standoffs", R("standoffHeight_mm", mmv(a.standoffHeight_mm))));
  if (Array.isArray(a.stackMount_mm)) rows.push(row("Stack mount", R("stackMount_mm", f.esc(a.stackMount_mm.map((x) => `${x} mm`).join(" / ")))));
  if (ok(a.frontalArea_m2)) rows.push(row("Frontal area", R("frontalArea_m2", `${f.rec(a.frontalArea_m2, 4)}${NB}m²`)));
  if (ok(a.dragCoefficient_cd)) rows.push(row("Drag coefficient", R("dragCoefficient_cd", f.rec(a.dragCoefficient_cd, 3))));
  // The top speed a multirotor's own two aerodynamic fields support. Nothing else about forward flight is in
  // the records, so there is no cruise figure to put beside it.
  if (ctx.complete && ok(v?.maxSpeed_ms)) {
    rows.push(
      row(
        "Top speed",
        P.calc(
          msv(v.maxSpeed_ms),
          `tilt the disc until thrust holds weight and drag at once: D = √(T² − W²), V = √(2D / (ρ·Cd·A)) with T = ${grR(v.totalThrust_g)}, W = ${grR(v.allUpWeight_g)}, Cd = ${f.rec(a.dragCoefficient_cd, 3)}, A = ${f.rec(a.frontalArea_m2, 4)} m², ρ = ${DRONE_RULES.AIR_DENSITY_KGM3} kg/m³`,
          "the aerodynamic ceiling at full thrust: optimistic, because a tilted rotor makes less thrust than a level one",
        ),
        EST,
      ),
    );
  }
  return {
    eyebrow: `Drone · ${KIND["drone-frame"].label}`,
    title: a.name,
    sub: part.sub ?? `${a.type} · ${a.motorCount} motors`,
    body: `<dl>${rows.join("")}</dl>${ctx.complete ? massTable(P, v) : ""}${missionBlock(P, v, ctx)}${ctx.complete ? verdictFooter(P, v, a.type, a.name) : ""}${note(part)}`,
    sources: [sourceLink(a.source), v?.mission ? sourceLink(v.mission.source, "mission") : ""],
  };
}

// The mission's checks as their own section (frame, fuselage and payload cards).
function missionBlock(P, v, ctx) {
  const mission = ctx.mission ?? v?.mission ?? null;
  if (!mission) return "";
  return `<p class="eyebrow" style="margin-top:14px">Mission requirements</p><dl style="margin-top:6px">${missionRows(P, v, mission, { complete: Boolean(ctx.complete) }).join("")}</dl>`;
}

// A motor, on an arm or in a nose. The electrical fields are what make the thrust model honest, so they are
// all here: kv, winding resistance, idle current, and the two ratings that cap it.
function motorCard(part, ctx, P) {
  const m = part.record;
  const v = ctx.verdict;
  const n = ctx.complete && ok(v?.motorCount) && v.motorCount > 0 ? v.motorCount : part.count ?? 1;
  const R = (field, html) => P.rec(html, ["drone", "motors", m.id, field], m.source);
  const d = slotDetail(ctx, "motor");
  const rows = [
    row("KV", `${R("kv", `${f.num(m.kv, 0)}${NB}rpm/V`)}`),
    row("Stator", `${R("stator", f.esc(String(m.stator)))} · ${nw(`${R("statorDiameter_mm", mmv(m.statorDiameter_mm))}${NB}×${NB}${R("statorHeight_mm", mmv(m.statorHeight_mm))}`)}`),
    row("Bell", `${nw(`${R("outerDiameter_mm", mmv(m.outerDiameter_mm))} across`)} · ${nw(`${R("height_mm", mmv(m.height_mm))} tall`)}`),
    row("Prop shaft", `${R("propShaftDiameter_mm", mmv(m.propShaftDiameter_mm))} · ${nw(`${R("mountCircle_mm", mmv(m.mountCircle_mm))} bolt circle`)}`),
    row("Weight", n > 1 ? each(R("weight_g", gr(m.weight_g)), P.calc(grR(n * m.weight_g), `total = n × m = ${n} × ${gr(m.weight_g)} = ${grR(n * m.weight_g)}`)) : R("weight_g", gr(m.weight_g))),
    row("Ratings", `${nw(`${R("maxCurrent_A", ampsv(m.maxCurrent_A))} max`)} · ${nw(`${R("maxPower_W", watts(m.maxPower_W))} max`)}`),
    row("Winding", `${nw(`${R("internalResistance_mohm", `${f.rec(m.internalResistance_mohm, 1)}${NB}mΩ`)} resistance`)} · ${nw(`${R("idleCurrent_A", ampsv(m.idleCurrent_A))} idle`)}`),
  ];
  if (Array.isArray(m.recommendedProps) && m.recommendedProps.length) {
    const propName = (id) => droneCatalog.propellers?.find((x) => x.id === id)?.name ?? id; // the record names, not ids
    rows.push(row("Rated propellers", R("recommendedProps", f.esc(m.recommendedProps.map(propName).join(", ")))));
  }
  // The full-throttle working point: where the motor's torque curve meets the propeller's. This is the number
  // the whole verdict stands on, so its formula is spelled out in the drawer.
  if (ctx.complete && d && ok(d.rpm) && ok(v?.packVoltage_V)) {
    const whyLimited = d.limitedBy === "current" ? `held to its ${ampsv(m.maxCurrent_A)} rating` : d.limitedBy === "power" ? `held to its ${watts(m.maxPower_W)} rating` : "not limited by its ratings";
    rows.push(row("Full-throttle speed", P.calc(rpmv(d.rpm), `motor torque = propeller torque: Kt·((V − I·Rm)/Rm − I0) = Cp·ρ·n²·D⁵/2π, with V = ${volts(v.packVoltage_V)}, Rm = ${f.rec(m.internalResistance_mohm, 1)} mΩ, I0 = ${ampsv(m.idleCurrent_A)}, Kt = 60/(2π·${f.num(m.kv, 0)})`, `${whyLimited}; no-load would be ${rpmv(d.freeRpm)}`), DERIVED));
    rows.push(row("Thrust", each(P.calc(grR(d.thrust_g), `T = Ct·ρ·n²·D⁴ at ${rpmv(d.rpm)}`, "propeller coefficient form, with the propeller's own measured ct_static"), P.calc(grR(v.totalThrust_g), `total = lifting rotors × T = ${v.hoverRotorCount} × ${grR(d.thrust_g)} = ${grR(v.totalThrust_g)}`, v.hoverRotorCount === v.motorCount ? "" : "only the rotors that lift are counted: a quadplane's cruise motor points forward")), EST));
    rows.push(row("Draw", each(P.calc(ampsv(d.current_A), `I = (V − N/kv)/Rm = (${volts(v.packVoltage_V)} − ${rpmv(d.rpm)}/${f.num(m.kv, 0)})/${f.rec(m.internalResistance_mohm, 1)} mΩ`, "at full throttle"), P.calc(ampsv(v.maxCurrent_A), `pack = n × I + payload and avionics / V = ${v.motorCount} × ${ampsv(d.current_A)} + …`, "every motor at full throttle at once: the worst case the pack has to survive")), EST));
  }
  const noseKind = part.kind === "drone-nose-motor";
  return {
    eyebrow: `Drone · ${KIND[part.kind]?.label ?? "motor"}`,
    title: m.name,
    sub: part.sub ?? (noseKind ? "nose motor" : `arm ${(part.geom?.index ?? 0) + 1} of ${n}`),
    body: `<dl>${rows.join("")}</dl>${ctx.complete ? verdictFooter(P, v, airframeType(ctx), m.name) : ""}${note(part)}`,
    sources: [sourceLink(m.source)],
  };
}

// A propeller. ct_static and cp_static are the measured coefficients the thrust and power models run on, so
// they are shown as record fields, not hidden inside a formula.
function propellerCard(part, ctx, P) {
  const p = part.record;
  const v = ctx.verdict;
  const n = ctx.complete && ok(v?.motorCount) && v.motorCount > 0 ? v.motorCount : part.count ?? 1;
  const R = (field, html) => P.rec(html, ["drone", "propellers", p.id, field], p.source);
  const d = slotDetail(ctx, "propeller");
  const disc_m2 = ok(p.diameter_mm) ? (Math.PI * (p.diameter_mm / 1000) ** 2) / 4 : null;
  const rows = [
    row("Size", `${nw(`${R("diameter_in", inch(p.diameter_in))}${NB}×${NB}${R("pitch_in", inch(p.pitch_in))}`)} · ${nw(`${R("bladeCount", String(p.bladeCount))} blades`)}`),
    row("Diameter", R("diameter_mm", mmv(p.diameter_mm))),
    row("Hub", `${nw(`${R("hubDiameter_mm", mmv(p.hubDiameter_mm))} across`)} · ${nw(`${R("hubThickness_mm", mmv(p.hubThickness_mm))} thick`)} · ${nw(`${R("shaftHole_mm", mmv(p.shaftHole_mm))} bore`)}`),
    row("Material", f.esc(p.material ?? "")),
    row("Weight", n > 1 ? each(R("weight_g", gr(p.weight_g)), P.calc(grR(n * p.weight_g), `total = n × m = ${n} × ${gr(p.weight_g)} = ${grR(n * p.weight_g)}`)) : R("weight_g", gr(p.weight_g))),
    row("Static coefficients", `${nw(`Ct ${R("ct_static", f.rec(p.ct_static, 4))}`)} · ${nw(`Cp ${R("cp_static", f.rec(p.cp_static, 4))}`)}`),
  ];
  if (disc_m2 !== null) {
    rows.push(row("Disc area", P.calc(`${f.rec(disc_m2, 4)}${NB}m²`, `A = π·D²/4 = π·(${mmv(p.diameter_mm)})²/4`, "the area the rotor pushes air through, the disc in the hover power formula"), DERIVED));
  }
  if (ctx.complete && d && ok(d.rpm)) {
    rows.push(row("At full throttle", `${nw(P.calc(rpmv(d.rpm), "where the motor's torque curve meets this propeller's", "see the motor card for the solution"))} · ${nw(P.calc(grR(d.thrust_g), `T = Ct·ρ·n²·D⁴ = ${f.rec(p.ct_static, 4)} · ${DRONE_RULES.AIR_DENSITY_KGM3} · (${f.num(d.rpm / 60, 1)} rev/s)² · (${mmv(p.diameter_mm)})⁴`, "static thrust in the propeller coefficient form, the convention UIUC and APC publish Ct in"))} · ${nw(P.calc(watts(d.shaftPower_W), `P = Cp·ρ·n³·D⁵ = ${f.rec(p.cp_static, 4)} · ${DRONE_RULES.AIR_DENSITY_KGM3} · (${f.num(d.rpm / 60, 1)} rev/s)³ · (${mmv(p.diameter_mm)})⁵`, "shaft power the motor has to put in"))}`, EST));
    if (ok(d.tipMach)) {
      const hot = d.tipMach > DRONE_RULES.TIP_MACH_LIMIT;
      const tip = P.calc(mach(d.tipMach), `M = π·D·n / a = π·${mmv(p.diameter_mm)}·${f.num(d.rpm / 60, 1)} rev/s / ${DRONE_RULES.SPEED_OF_SOUND_MS} m/s`, `the app's safe line is Mach ${DRONE_RULES.TIP_MACH_LIMIT}, a design threshold: no record states a maximum RPM`);
      rows.push(row("Tip speed", hot ? `<span class="bad">${tip}</span>` : tip, EST));
    }
  }
  return {
    eyebrow: `Drone · ${KIND[part.kind]?.label ?? "propeller"}`,
    title: p.name,
    sub: part.sub ?? `${p.bladeCount}-blade · ${p.manufacturer ?? ""}`.trim(),
    body: `<dl>${rows.join("")}</dl>${ctx.complete ? verdictFooter(P, v, airframeType(ctx), p.name) : ""}${note(part)}`,
    sources: [sourceLink(p.source)],
  };
}

// The pack. Everything about endurance and the discharge check lives here, because they are all questions
// about this one record.
function batteryCard(part, ctx, P) {
  const b = part.record;
  const v = ctx.verdict;
  const R = (field, html) => P.rec(html, ["drone", "batteries", b.id, field], b.source);
  const perCell = DRONE_RULES.VOLTS_PER_CELL[b.chemistry] ?? DRONE_RULES.VOLTS_PER_CELL_FALLBACK;
  const rows = [
    row("Chemistry", `${f.esc(b.chemistry)} · ${nw(`${R("cells_s", `${b.cells_s}S`)} in series`)}`),
    row("Nominal voltage", `${R("nominalVoltage_V", volts(b.nominalVoltage_V))} · ${nw(`${R("maxVoltage_V", volts(b.maxVoltage_V))} charged`)}`),
    row("Capacity", `${R("capacity_mAh", mahv(b.capacity_mAh))} · ${R("energy_Wh", wh(b.energy_Wh))}`),
    row("Discharge rating", `${nw(`${R("continuousC", `${f.rec(b.continuousC, 1)}C`)} continuous`)} · ${nw(`${R("burstC", `${f.rec(b.burstC, 1)}C`)} burst`)} · ${nw(`${R("maxDischargeCurrent_A", ampsv(b.maxDischargeCurrent_A))} rated`)}`),
    row("Internal resistance", R("internalResistance_mohm", `${f.rec(b.internalResistance_mohm, 1)}${NB}mΩ`)),
    row("Weight", R("weight_g", gr(b.weight_g))),
    row("Size", `${nw(`${R("length_mm", mmv(b.length_mm))}${NB}×${NB}${R("width_mm", mmv(b.width_mm))}${NB}×${NB}${R("height_mm", mmv(b.height_mm))}`)}`),
    row("Connector", f.esc(b.connector ?? "")),
  ];
  if (ok(v?.packVoltage_V)) {
    rows.push(row("Pack voltage used", P.calc(volts(v.packVoltage_V), `V = cells × volts per cell = ${b.cells_s} × ${perCell}${NB}V`, `${perCell} V is the nominal ${b.chemistry} cell voltage; it reproduces this record's own ${volts(b.nominalVoltage_V)}`), DERIVED));
  }
  if (ok(b.energy_Wh)) {
    rows.push(row("Usable energy", P.calc(wh(b.energy_Wh * DRONE_RULES.USABLE_PACK_SHARE), `usable = ${wh(b.energy_Wh)} × ${DRONE_RULES.USABLE_PACK_SHARE}`, `a pack is flown to about ${pctv(DRONE_RULES.USABLE_PACK_SHARE)} of its capacity to keep the cells safe`), EST));
  }
  if (ctx.complete && v) {
    if (ok(v.hoverCurrent_A) && ok(v.hoverPower_W)) {
      const powerFormula = `P = T^1.5 / √(2ρA) per rotor, ÷ figure of merit ${DRONE_RULES.ROTOR_FIGURE_OF_MERIT}, then through the motor and ESC, plus the payload and ${watts(DRONE_RULES.AVIONICS_POWER_W)} of avionics`;
      const powerHtml = nw(P.calc(watts(v.hoverPower_W), powerFormula, "momentum theory for the rotor; the motor current comes from its own kv, resistance and idle current"));
      const currentHtml = nw(P.calc(ampsv(v.hoverCurrent_A), `I = P / V = ${watts(v.hoverPower_W)} / ${volts(v.packVoltage_V)}`));
      rows.push(row("Hover draw", `${powerHtml} · ${currentHtml}`, EST));
    }
    if (ok(v.discharge_C)) {
      rows.push(row("Hover discharge", P.calc(`${f.num(v.discharge_C, 1)}C`, `C = I_hover / capacity = ${ampsv(v.hoverCurrent_A)} / ${f.rec(b.capacity_mAh / 1000, 3)}${NB}Ah`, `the pack is rated ${f.rec(b.continuousC, 1)}C continuous`), EST));
    }
    if (ok(v.maxCurrent_A)) {
      const bad = v.dischargeOk === false;
      const html = P.calc(ampsv(v.maxCurrent_A), `every motor at full throttle: ${v.motorCount} × ${ampsv(v.maxCurrent_A / Math.max(1, v.motorCount))} plus the payload and avionics`, `the pack is rated ${ampsv(b.maxDischargeCurrent_A)}`);
      rows.push(row("Worst-case draw", bad ? `<span class="bad">${html}</span> (over the ${ampsv(b.maxDischargeCurrent_A)} rating)` : `${html} (inside the ${ampsv(b.maxDischargeCurrent_A)} rating)`, EST));
    }
    if (ok(v.hoverTime_min)) {
      const steadyFormula = `t = usable energy / power × 60 = ${wh(b.energy_Wh * DRONE_RULES.USABLE_PACK_SHARE)} / ${watts(v.hoverPower_W)} × 60`;
      const steadyHtml = nw(`${P.calc(mins(v.hoverTime_min), steadyFormula, "steady flight: a hover for a rotorcraft, level cruise for a wing")} steady`);
      const mixedHtml = nw(
        `${P.calc(mins(v.mixedTime_min), `t_mixed = t_steady / ${DRONE_RULES.MIXED_POWER_FACTOR}`, "the mixed-throttle factor is a modelling assumption, not a measurement")} mixed`,
      );
      rows.push(row("Flight time", `${steadyHtml} · ${mixedHtml}`, EST));
    }
  }
  return {
    eyebrow: `Drone · ${KIND["drone-battery"].label}`,
    title: b.name,
    sub: part.sub ?? `${b.cells_s}S ${b.chemistry} · ${b.capacity_mAh} mAh`,
    body: `<dl>${rows.join("")}</dl>${ctx.complete ? verdictFooter(P, v, airframeType(ctx), b.name) : ""}${note(part)}`,
    sources: [sourceLink(b.source)],
  };
}

// The payload, and with it the mission: this is the card that says whether the drone is carrying what the
// mission asked for.
function payloadCard(part, ctx, P) {
  const p = part.record;
  const v = ctx.verdict;
  const mission = ctx.mission ?? v?.mission ?? null;
  const R = (field, html) => P.rec(html, ["drone", "payloads", p.id, field], p.source);
  const rows = [
    row("Type", f.esc(p.type)),
    row("Weight", R("weight_g", gr(p.weight_g))),
    row("Power", `${R("power_W", watts(p.power_W))}${ok(p.voltage_min_V) ? ` · ${nw(`${R("voltage_min_V", volts(p.voltage_min_V))}–${R("voltage_max_V", volts(p.voltage_max_V))}`)}` : ""}`),
    row("Size", `${nw(`${R("length_mm", mmv(p.length_mm))}${NB}×${NB}${R("width_mm", mmv(p.width_mm))}${NB}×${NB}${R("height_mm", mmv(p.height_mm))}`)}`),
  ];
  if (ctx.complete && ok(v?.allUpWeight_g) && v.allUpWeight_g > 0) {
    rows.push(row("Share of weight", P.calc(pctv(p.weight_g / v.allUpWeight_g), `${gr(p.weight_g)} / ${grR(v.allUpWeight_g)}`), DERIVED));
  }
  return {
    eyebrow: `Drone · ${KIND["drone-camera"].label}`,
    title: p.name,
    sub: part.sub ?? f.esc(p.type),
    body: `<dl>${rows.join("")}</dl>${missionBlock(P, v, ctx)}${ctx.complete ? verdictFooter(P, v, airframeType(ctx), p.name) : ""}${note(part)}`,
    sources: [sourceLink(p.source), mission ? sourceLink(mission.source, "mission") : ""],
  };
}

// The electronics stack has no record: the configurator does not let you choose a flight controller, so its
// mass and draw are the DRONE_RULES modelling allowance and the card says so plainly.
function electronicsCard(part, ctx, P) {
  const v = ctx.verdict;
  const g = part.geom ?? {};
  const rows = [
    row("Weight", P.calc(grR(DRONE_RULES.ELECTRONICS_ALLOWANCE_G), `allowance = flight controller + 4-in-1 ESC + VTX and antenna + wiring ≈ ${DRONE_RULES.ELECTRONICS_ALLOWANCE_G} g`, "a modelling allowance for the parts the configurator does not let you choose, not a measurement of a product"), EST),
    row("Standing draw", P.calc(watts(DRONE_RULES.AVIONICS_POWER_W), `allowance = flight controller + receiver + video transmitter ≈ ${DRONE_RULES.AVIONICS_POWER_W} W`, "a modelling allowance, added to the hover power alongside the payload's own draw"), EST),
  ];
  if (ok(g.boardSize_m)) rows.push(row("Board", P.calc(`${mmOf(g.boardSize_m)}${NB}square`, "the frame's own stack-mount pattern", "layout proportions, not a dataset record"), DERIVED));
  if (ok(g.stackH_m)) rows.push(row("Stack height", P.calc(mmOf(g.stackH_m), "layout proportions for an FC and ESC sandwich", "not a dataset record"), DERIVED));
  if (ok(g.vtxW_m) || ok(g.antennaLen_m)) {
    rows.push(row("VTX", `${nw(`${mmOf(g.vtxW_m)} board`)} · ${nw(`${mmOf(g.antennaLen_m)} antenna`)}`, DERIVED));
  }
  return {
    eyebrow: "Drone · derived structure · electronics",
    title: part.name || "Flight controller and ESC stack",
    sub: part.sub ?? "not a dataset record",
    body: `<dl>${rows.join("")}</dl><p class="note">${f.esc(part.note || "No record behind this part: the configurator does not offer a flight controller, so its weight and power are a documented modelling allowance in DRONE_RULES.")}</p>${ctx.complete ? verdictFooter(P, v, airframeType(ctx), "Electronics") : ""}`,
    sources: [],
  };
}

// The fuselage of a printed or composite airframe: the same airframe record, read lengthwise.
function fuselageCard(part, ctx, P) {
  const a = part.record;
  const v = ctx.verdict;
  const R = (field, html) => P.rec(html, ["drone", "airframes", a.id, field], a.source);
  const rows = [
    row("Type", f.esc(TYPE_LABEL[a.type] ?? String(a.type ?? DASH).replace(/_/g, " "))),
    row("Fuselage length", R("fuselageLength_mm", mmv(a.fuselageLength_mm))),
    row("Wingspan", R("wingspan_mm", mmv(a.wingspan_mm))),
    row("Empty weight", R("emptyWeight_g", gr(a.emptyWeight_g))),
  ];
  if (ok(a.targetAUW_g)) rows.push(row("Designed all-up weight", R("targetAUW_g", gr(a.targetAUW_g))));
  if (a.printMaterial) rows.push(row("Printed in", R("printMaterial", f.esc(a.printMaterial))));
  if (ok(a.internalRibCount)) rows.push(row("Internal ribs", R("internalRibCount", String(a.internalRibCount))));
  if (ok(a.sparDiameter_mm)) rows.push(row("Spar", R("sparDiameter_mm", mmv(a.sparDiameter_mm))));
  if (ok(a.boomLength_mm)) rows.push(row("Booms", `${nw(`${R("boomLength_mm", mmv(a.boomLength_mm))} long`)} · ${nw(`${R("boomDiameter_mm", mmv(a.boomDiameter_mm))} across`)}`));
  if (ok(a.transitionSpeed_ms)) rows.push(row("Transition speed", R("transitionSpeed_ms", msv(a.transitionSpeed_ms))));
  return {
    eyebrow: `Drone · ${KIND["drone-fuselage"].label}`,
    title: a.name,
    sub: part.sub ?? `${a.type} · ${a.printMaterial ?? "composite"}`,
    body: `<dl>${rows.join("")}</dl>${ctx.complete ? massTable(P, v) : ""}${missionBlock(P, v, ctx)}${ctx.complete ? verdictFooter(P, v, a.type, a.name) : ""}${note(part)}`,
    sources: [sourceLink(a.source)],
  };
}

// The wing: the record's geometry and its two aerodynamic coefficients, then the three numbers they support —
// wing loading, stall speed and the cruise the endurance and range are worked out at.
function wingCard(part, ctx, P) {
  const a = part.record;
  const v = ctx.verdict;
  const R = (field, html) => P.rec(html, ["drone", "airframes", a.id, field], a.source);
  const ar = ok(a.aspectRatio) ? R("aspectRatio", f.rec(a.aspectRatio, 2)) : P.calc(f.rec(((a.wingspan_mm / 1000) ** 2 / (a.wingArea_dm2 / 100)) || NaN, 2), `AR = span² / area = (${mmv(a.wingspan_mm)})² / ${dm2(a.wingArea_dm2)}`, "the definition of aspect ratio, used because this record does not state one");
  const rows = [
    row("Span", R("wingspan_mm", mmv(a.wingspan_mm))),
    row("Area", R("wingArea_dm2", dm2(a.wingArea_dm2))),
    row("Aspect ratio", ar, ok(a.aspectRatio) ? "" : DERIVED),
    row("Airfoil", f.esc(a.airfoil ?? "")),
  ];
  if (ok(a.wingChord_mm)) rows.push(row("Chord", R("wingChord_mm", mmv(a.wingChord_mm))));
  rows.push(row("Coefficients", `${nw(`CL max ${R("cl_max", f.rec(a.cl_max, 3))}`)} · ${nw(`Cd0 ${R("cd0", f.rec(a.cd0, 3))}`)}`));
  if (ok(a.wingLoading_target_g_dm2)) rows.push(row("Designed wing loading", R("wingLoading_target_g_dm2", gdm2(a.wingLoading_target_g_dm2))));
  if (ctx.complete && v) {
    if (ok(v.wingLoading_g_dm2)) {
      rows.push(row("This build's wing loading", P.calc(gdm2(v.wingLoading_g_dm2), `all-up weight / area = ${grR(v.allUpWeight_g)} / ${dm2(a.wingArea_dm2)}`), EST));
    }
    if (ok(v.stallSpeed_ms)) {
      // The record quotes its own stall speed at a reference weight. Both are shown: the formula is honest at
      // this build's weight, and the record's figure says what the designer measured, so a reader can see the
      // two do not quite agree rather than being told only one of them.
      const quoted = Object.keys(a).find((k) => k.startsWith("stallSpeed_at_"));
      const note = quoted ? `the record quotes ${msv(a[quoted])} at ${quoted.replace("stallSpeed_at_", "").replace("g_ms", " g")}` : "";
      rows.push(row("Stall speed", P.calc(msv(v.stallSpeed_ms), `V = √(2W / (ρ·S·CL max)) = √(2·${grR(v.allUpWeight_g)}·g0 / (${DRONE_RULES.AIR_DENSITY_KGM3}·${dm2(a.wingArea_dm2)}·${f.rec(a.cl_max, 3)}))`, note), EST));
    }
    if (ok(v.cruiseSpeed_ms)) {
      rows.push(row("Cruise speed", P.calc(msv(v.cruiseSpeed_ms), `V_cruise = ${DRONE_RULES.CRUISE_STALL_FACTOR} × stall = ${DRONE_RULES.CRUISE_STALL_FACTOR} × ${msv(v.stallSpeed_ms)}`, "the multiple of stall speed is a sizing convention for this app, not a measurement"), EST));
    }
    if (ok(v.range_km)) {
      rows.push(row("Range", P.calc(kmv(v.range_km), `range = cruise speed × cruise endurance, with drag from CD = Cd0 + CL²/(π·e·AR), e = ${DRONE_RULES.OSWALD_EFFICIENCY}, propeller efficiency ${DRONE_RULES.CRUISE_PROP_EFFICIENCY}`, "the drag polar is the record's own Cd0 and aspect ratio; span efficiency and cruise propeller efficiency are modelling constants"), EST));
    }
  }
  return {
    eyebrow: `Drone · ${KIND["drone-wing"].label}`,
    title: `${a.name} wing`,
    sub: part.sub ?? `${a.airfoil ?? "wing"} · ${a.wingArea_dm2} dm²`,
    body: `<dl>${rows.join("")}</dl>${ctx.complete ? verdictFooter(P, v, a.type, a.name) : ""}${note(part)}`,
    sources: [sourceLink(a.source)],
  };
}

// The tail has no record either: a tail surface is sized off the wing, and no airframe record states one.
function tailCard(part, ctx, P) {
  const g = part.geom ?? {};
  const rows = [
    row("Horizontal", `${nw(`${mmOf(g.hSpan_m)} span`)} · ${nw(`${mmOf(g.hChord_m)} chord`)}`, DERIVED),
    row("Vertical", `${nw(`${mmOf(g.vHeight_m)} tall`)} · ${nw(`${mmOf(g.vChord_m)} chord`)}`, DERIVED),
  ];
  if (ok(g.boomL_m)) rows.push(row("Tail boom", mmOf(g.boomL_m), DERIVED));
  return {
    eyebrow: "Drone · derived structure · tail",
    title: part.name || "Tail surfaces",
    sub: part.sub ?? "not a dataset record",
    body: `<dl>${rows.join("")}</dl><p class="note">${f.esc(part.note || "No record behind this part: the airframe datasets do not state tail dimensions, so these are layout proportions off the wing. Its mass is inside the airframe's empty weight.")}</p>`,
    sources: [],
  };
}

// --- helpers the cards share ------------------------------------------------------------------------------
// droneDetails rows reach the card as ctx.details when card.js forwards them. It does not today (it only
// forwards the rocket's per-stage row), so everything above degrades to the verdict's own numbers and nothing
// breaks the day it starts to.
const slotDetail = (ctx, slot) => (Array.isArray(ctx?.details) ? ctx.details.find((d) => d?.slot === slot) ?? null : null) ?? detailFromVerdict(ctx, slot);
// What the verdict alone can say about a slot, in the shape a droneDetails row has.
function detailFromVerdict(ctx, slot) {
  const v = ctx?.verdict;
  if (!v || v.vehicle !== "drone") return null;
  if (slot === "motor" || slot === "propeller") {
    // The verdict carries the one full-throttle solution every number came from (workingPoint), so the card
    // quotes the same figures by construction.
    const w = v.workingPoint ?? {};
    return {
      slot,
      rpm: ok(w.rpm) ? w.rpm : null,
      freeRpm: ok(w.freeRpm) ? w.freeRpm : null,
      thrust_g: ok(w.thrust_g) ? w.thrust_g : ok(v.thrustPerMotor_g) ? v.thrustPerMotor_g : null,
      current_A: ok(w.current_A) ? w.current_A : null,
      shaftPower_W: ok(w.shaftPower_W) ? w.shaftPower_W : null,
      tipMach: ok(w.tipMach) ? w.tipMach : null,
      limitedBy: w.limitedBy ?? null,
    };
  }
  return null;
}
// The build's own airframe type, from the verdict (not the mission, and not the first airframe in the catalog).
const airframeType = (ctx) => ctx?.verdict?.airframeType ?? droneCatalog.airframes?.find((a) => a.id === ctx?.build?.airframeId)?.type ?? null;
const note = (part) => (part?.note ? `<p class="note">${f.esc(part.note)}</p>` : "");

// --- the entry point -------------------------------------------------------------------------------------
// card.js calls this for every part whose kind starts with "drone-". A kind with no record, or an unknown
// kind, still gets a card: it says what it is and that nothing in the datasets describes it.
export function droneCardBody(part, ctx = {}, P) {
  const c = cardFor(part, ctx, P);
  return { ...c, body: roleHtml(part?.kind) + c.body };
}

// "What this part does / why this number matters", first on every card (ui/partRoles.js: words only, no numbers).
function roleHtml(kind) {
  const r = partRole(String(kind ?? ""));
  return `<p class="role"><span class="role-does">${f.esc(r.does)}</span> <span class="role-why">${f.esc(r.why)}</span></p>`;
}

function cardFor(part, ctx, P) {
  const kind = String(part?.kind ?? "");
  const has = Boolean(part?.record);
  if (kind === "drone-frame" && has) return frameCard(part, ctx, P);
  if (kind === "drone-fuselage" && has) return fuselageCard(part, ctx, P);
  if (kind === "drone-wing" && has) return wingCard(part, ctx, P);
  if ((kind === "drone-arm" || kind === "drone-nose-motor") && has) return motorCard(part, ctx, P);
  if ((kind === "drone-propeller" || kind === "drone-nose-propeller") && has) return propellerCard(part, ctx, P);
  if (kind === "drone-battery" && has) return batteryCard(part, ctx, P);
  if (kind === "drone-camera" && has) return payloadCard(part, ctx, P);
  if (kind === "drone-electronics") return electronicsCard(part, ctx, P);
  if (kind === "drone-tail") return tailCard(part, ctx, P);
  return derivedCard(part, ctx, P);
}

// A drone part the datasets say nothing about: show the true millimetres the layout gave it and say so.
function derivedCard(part, ctx, P) {
  const rows = [];
  if (ok(part?.height_m) || ok(part?.diameter_m)) {
    rows.push(row("Size", `${nw(`${mmOf(part.diameter_m)} across`)} · ${nw(`${mmOf(part.height_m)} tall`)}`, DERIVED));
  }
  return {
    eyebrow: `Drone · derived structure · ${KIND[part?.kind]?.label ?? String(part?.kind ?? "part").replace(/^drone-/, "")}`,
    title: part?.name || "Drone part",
    sub: part?.sub ?? "not a dataset record",
    body: `<dl>${rows.join("")}</dl><p class="note">${f.esc(part?.note || "No dataset record behind this part: its size comes from the layout's proportions and its mass is inside the airframe's empty weight.")}</p>`,
    sources: [],
  };
}

// --- the options list ------------------------------------------------------------------------------------
// The one key number per alternative, the drone answer to card.js's optionMeta: thrust is what matters about a
// rocket engine, and for a drone it is KV, propeller size, pack capacity, payload weight and frame size.
// Straight from the record, no physics. Accepts a part kind ("drone-arm") or a slot name ("motor").
export function DRONE_OPTION_META(kind, r) {
  if (!r) return "";
  const k = String(kind ?? "");
  const is = (...names) => names.some((n) => k === n || k === `drone-${n}`);
  if (is("arm", "nose-motor", "motor", "motors")) return ok(r.kv) ? `${f.num(r.kv, 0)} KV` : "";
  if (is("propeller", "nose-propeller", "propellers")) return ok(r.diameter_in) ? `${f.rec(r.diameter_in, 2)}″ × ${f.rec(r.pitch_in, 2)}″` : "";
  if (is("battery", "batteries")) return ok(r.capacity_mAh) ? `${r.cells_s}S · ${mahv(r.capacity_mAh)}` : "";
  if (is("camera", "payload", "payloads")) return ok(r.weight_g) ? gr(r.weight_g) : "";
  if (is("frame", "fuselage", "wing", "airframe", "airframes")) {
    if (ok(r.wheelbase_mm)) return `${mmv(r.wheelbase_mm)} wheelbase`;
    if (ok(r.wingspan_mm)) return `${mmv(r.wingspan_mm)} span`;
    return "";
  }
  return "";
}
