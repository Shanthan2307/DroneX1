// Server-only: runs a track scenario (src/lib/scenarios/catalog.ts) against the real engines and narrates it as a
// stream of events. Every step is a real call: drones start from their stored designs at the scenario's place,
// their missions are plans in the simulator's library flown in Auto, corridors go through the SpacetimeDB reducer,
// questions go to Elastic, voice goes through Cartesia, requests go to the Fetch.ai agents. Nothing is simulated
// for the narration's sake; a step that fails says so and the run goes on where it can.
import { spawn } from "node:child_process";
import path from "node:path";
import { AGENT_HEADER } from "@/lib/agentAuth";
import { runTool } from "@/lib/ai/intent";
import { assignMission, releaseCorridor, requestCorridor } from "@/lib/airspace/actions";
import { elasticEnv, esql, esqlString, semanticSearch } from "@/lib/analytics/elastic";
import { catalogEntries, judge } from "@/lib/catalog/server";
import { CoreClient, readDaemon, sleep } from "@/lib/sim/core";
import { isReady } from "@/lib/sim/ready";
import { reflyDesign } from "@/lib/sim/refly";
import { reserveSim, SIM_FULL } from "@/lib/sim/sims";
import { listFlights } from "@/lib/sim/store";
import { listVehicles, telemetry, withCore, type Telemetry } from "@/lib/sim/tools";
import { SCENARIOS, scenarioById, type LatLon, type Scenario, type ScenarioDrone } from "./catalog";

export type EventKind = "step" | "ok" | "warn" | "fail" | "say" | "heard" | "chat" | "report" | "link" | "vehicle" | "done";
export interface ScenarioEvent {
  kind: EventKind;
  text: string;
  data?: Record<string, unknown>;
}
export type Emit = (e: ScenarioEvent) => void;

// The scenarios call this server's own routes (voice, intent, Dispatch status) as the agents do: on loopback with
// the agent token, so a deployed run neither leaves through the public proxy nor trips the visitor checks.
// DRONEX_INTERNAL_URL overrides where this server listens.
function selfFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  const base = (process.env.DRONEX_INTERNAL_URL?.trim() || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/+$/, "");
  const headers = new Headers(init.headers);
  const token = process.env.DRONEX_AGENT_TOKEN?.trim();
  if (token) headers.set(AGENT_HEADER, token);
  return fetch(`${base}${pathname}`, { ...init, headers });
}

// ---------- the simulator's plan library ----------

interface Plan {
  id: string;
  name: string;
  version: number;
  deleted?: boolean;
}

const MAV_CMD = { waypoint: 16, rtl: 20, takeoff: 22 } as const;
const ABOVE_HOME = 3; // MAV_FRAME_GLOBAL_RELATIVE_ALT

const item = (command: number, at: LatLon | null, altitudeM: number) => ({
  command,
  frame: ABOVE_HOME,
  params: [0, 0, 0, null],
  latitudeDeg: at?.lat ?? 0,
  longitudeDeg: at?.lon ?? 0,
  altitudeM,
  autocontinue: true,
});

function planBody(s: Scenario, d: ScenarioDrone) {
  return {
    name: d.planName,
    vehicleType: "multicopter",
    autopilot: "ardupilot",
    frame: "above-home",
    items: [item(MAV_CMD.takeoff, null, d.altitudeM), ...d.route.map((p) => item(MAV_CMD.waypoint, p, d.altitudeM)), item(MAV_CMD.rtl, null, 0)],
    fence: { polygons: [], circles: [], settings: {} },
    rally: [],
    plannedHome: { latitudeDeg: d.start.lat, longitudeDeg: d.start.lon },
    nextAltitudeM: d.altitudeM,
    minClearanceM: 10,
    labels: ["DroneX scenario", s.trackName],
    notes: `${s.title}. ${s.summary}\n\nWhy it matters: ${s.whyItMatters}\n\nRun it from DroneX: http://localhost:3000/scenarios`,
  };
}

async function withClient<T>(fn: (c: CoreClient) => Promise<T>): Promise<T> {
  const c = await CoreClient.connect((await readDaemon()).socket);
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

/** The scenario's plans in the simulator's library, created or brought up to date by name. Idempotent. */
export async function installPlans(only?: Scenario): Promise<{ name: string; id: string; action: "created" | "updated" }[]> {
  return withClient(async (c) => {
    const { plans } = await c.call<{ plans: Plan[] }>("plan/list", {});
    const out: { name: string; id: string; action: "created" | "updated" }[] = [];
    for (const s of only ? [only] : SCENARIOS)
      for (const d of s.drones) {
        const existing = plans.find((p) => p.name === d.planName && !p.deleted);
        const plan = existing ?? (await c.call<Plan>("plan/create", { vehicleType: "multicopter", autopilot: "ardupilot", name: d.planName }));
        const updated = await c.call<Plan>("plan/update", { id: plan.id, expectedVersion: plan.version, body: planBody(s, d) });
        out.push({ name: d.planName, id: updated.id, action: existing ? "updated" : "created" });
      }
    return out;
  });
}

// ---------- vehicles ----------

/** Vehicles the scenarios started, so "Stop scenario drones" stops only those. */
const started = new Map<string, { linkId: string; scenario: string }>();

async function designFor(presetId: string): Promise<string | null> {
  // The hangar drone as built, newest first: "(modified)" or "(server test)" copies are someone's experiments.
  const all = (await listFlights()).filter((f) => f.basedOn === presetId);
  return all.find((f) => !/\(.*\)/.test(f.name))?.id ?? all[0]?.id ?? null;
}

async function vehicleState(vid: string): Promise<{ ready: boolean; t: Telemetry; mode: string; armed: boolean } | null> {
  try {
    return await withCore(async (c) => {
      const v = (await listVehicles(c)).find((x) => x.id === vid);
      if (!v) return null;
      const t = await telemetry(c, v);
      return { ready: v.presence === "online" && isReady(t), t, mode: v.mode, armed: v.armed };
    });
  } catch {
    return null;
  }
}

async function until<T>(read: () => Promise<T | null>, ok: (v: T) => boolean, timeoutMs: number, everyMs = 2000): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < end) {
    last = await read();
    if (last && ok(last)) return last;
    await sleep(everyMs);
  }
  return last;
}

async function startDrone(s: Scenario, d: ScenarioDrone, origin: string, emit: Emit): Promise<string | null> {
  const designId = await designFor(d.presetId);
  if (!designId) {
    emit({ kind: "fail", text: `${d.role}: the hangar drone ${d.presetId} has not been sent to the simulator yet. Open /?build=${d.presetId}, Build all, Fly in simulation once, then run this again.` });
    return null;
  }
  // Scenario drones count against the simulator cap like any other, within the agents' share (src/lib/sim/sims.ts).
  const slot = await reserveSim({ ip: "scenario", agent: true });
  if (!slot) {
    emit({ kind: "fail", text: `${d.role}: ${SIM_FULL}` });
    return null;
  }
  let flown;
  try {
    flown = await reflyDesign(designId, origin, { latitudeDeg: d.start.lat, longitudeDeg: d.start.lon, headingDeg: d.start.headingDeg });
    if (flown) slot.commit(flown);
  } finally {
    slot.release();
  }
  if (!flown) return null;
  started.set(flown.vehicleId, { linkId: flown.linkId, scenario: s.id });
  emit({ kind: "vehicle", text: `${d.role}: ${flown.name} is on the ground at its start (${d.operator}).`, data: { vehicleId: flown.vehicleId, url: flown.url } });
  return flown.vehicleId;
}

async function readyUp(vid: string, label: string, emit: Emit): Promise<boolean> {
  emit({ kind: "step", text: `${label}: waiting for a GPS fix and the EKF before arming…` });
  const st = await until(() => vehicleState(vid), (v) => v.ready, 150_000);
  if (!st?.ready) {
    emit({ kind: "fail", text: `${label}: no GPS fix / EKF in time, so it cannot arm.` });
    return false;
  }
  emit({ kind: "ok", text: `${label}: GPS fix with ${st.t.gpsSatellites ?? "?"} satellites, EKF ${st.t.ekfStatus ?? "?"}.` });
  return true;
}

/**
 * The plan checked against the buildings this drone would fly past (the simulator knows them from OpenStreetMap);
 * legs that would hit one are given a way around or over it by the simulator's DroneX router (plan/route).
 */
async function routeAroundBuildings(planId: string, vid: string, d: ScenarioDrone, emit: Emit): Promise<void> {
  try {
    await withClient(async (c) => {
      let checks: { code: string; message: string; severity: string }[] = [];
      for (let i = 0; i < 6; i++) {
        checks = (await c.call<{ checks: { code: string; message: string; severity: string }[] }>("plan/check", { id: planId, vehicleId: vid })).checks;
        if (!checks.some((k) => k.code === "buildings-missing")) break;
        await sleep(2500); // the simulator is still fetching the buildings along the route
      }
      const hits = checks.filter((k) => /building/.test(k.code) && k.code !== "buildings-missing");
      if (!hits.length) {
        emit({ kind: "ok", text: `${d.role}: the route clears every building at ${d.altitudeM} m.` });
        return;
      }
      emit({ kind: "warn", text: `${d.role}: ${hits.length} leg(s) would fly into buildings (${hits[0].message}); asking the simulator to route around them…` });
      const plan = await c.call<Plan>("plan/get", { id: planId });
      const r = await c.call<{ routed: number; added: number; notes?: string[] }>("plan/route", { id: planId, expectedVersion: plan.version, vehicleId: vid });
      emit({ kind: "ok", text: `${d.role}: ${r.routed} leg(s) re-routed, ${r.added} waypoint(s) added${r.notes?.length ? ` (${r.notes.join("; ")})` : ""}.` });
    });
  } catch (e) {
    emit({ kind: "warn", text: `${d.role}: building check skipped (${e instanceof Error ? e.message : String(e)}).` });
  }
}

/** Upload the plan, take off in guided, then hand over to Auto so the plan flies. */
/** The plan onto the drone as its mission, retried while the autopilot is still settling. True when it took. */
async function uploadPlan(planId: string, vid: string, d: ScenarioDrone, emit: Emit): Promise<boolean> {
  let up: { status?: string; notes?: string[] } = {};
  for (let i = 0; i < 4; i++) {
    up = await withClient((c) => c.call<{ status?: string; notes?: string[] }>("plan/upload", { planId, vehicleId: vid })).catch((e: Error) => ({ status: "failed", notes: [e.message] }));
    if (up.status === "verified" || up.status === "different") break;
    await sleep(4000);
  }
  // "different" is the engine saying the autopilot rounded something on read-back (its notes say what): flyable.
  if (up.status === "verified" || up.status === "different") {
    emit({ kind: "ok", text: `${d.role}: mission "${d.planName}" uploaded and read back${up.status === "different" ? ` (autopilot rounding: ${(up.notes ?? []).join("; ") || "values"})` : ""}.` });
    return true;
  }
  emit({ kind: "fail", text: `${d.role}: mission upload ${up.status ?? "?"}${up.notes?.length ? `: ${up.notes.join("; ")}` : ""}` });
  return false;
}

async function flyPlan(planId: string, vid: string, d: ScenarioDrone, emit: Emit): Promise<boolean> {
  await routeAroundBuildings(planId, vid, d, emit);
  if (!(await uploadPlan(planId, vid, d, emit))) return false;
  // Straight up to cruise height first: moving sideways while low is how a drone meets a building.
  const climb = Math.min(d.altitudeM, 120);
  const t = await runTool("takeoff", { altitude_m: climb }, vid).catch((e: Error) => ({ result: e.message }));
  emit({ kind: "step", text: `${d.role}: ${t.result}` });
  const air = await until(() => vehicleState(vid), (v) => (v.t.altitudeAboveHomeM ?? 0) >= climb * 0.9, 90_000);
  if (!air || (air.t.altitudeAboveHomeM ?? 0) < climb * 0.6) {
    emit({ kind: "fail", text: `${d.role}: did not climb (${air?.mode ?? "?"}, ${air?.armed ? "armed" : "disarmed"}).` });
    return false;
  }
  const m = await runTool("set_mode", { mode: "AUTO" }, vid).catch((e: Error) => ({ result: e.message }));
  emit({ kind: "ok", text: `${d.role}: airborne at ${Math.round(air.t.altitudeAboveHomeM ?? 0)} m; ${m.result}, flying the mission.` });
  return true;
}

const metres = (a: LatLon, b: LatLon): number => {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
};

/** Follows a mission until the drone is back on the ground (or the time is up), narrating every 20 s. */
async function follow(vid: string, d: ScenarioDrone, emit: Emit, timeoutMs: number, opts: { untilLanded?: boolean } = {}): Promise<void> {
  const end = Date.now() + timeoutMs;
  let lastSaid = 0;
  let wasHome = false;
  let braked = false;
  while (Date.now() < end) {
    const st = await vehicleState(vid);
    if (!st) break;
    const here = st.t.latitudeDeg !== null && st.t.longitudeDeg !== null ? { lat: st.t.latitudeDeg, lon: st.t.longitudeDeg } : null;
    if (Date.now() - lastSaid > 20_000 && here) {
      lastSaid = Date.now();
      const target = d.route[d.route.length - 1];
      emit({ kind: "step", text: `${d.role}: ${st.mode}, ${Math.round(st.t.altitudeAboveHomeM ?? 0)} m, ${Math.round(metres(here, target))} m from ${d.route.length > 1 ? "the far end" : "the destination"}, battery ${st.t.batteryPct !== null ? `${Math.round(st.t.batteryPct)} %` : "?"}.` });
    }
    if (/BRAKE/.test(st.mode) && here && !braked) {
      // The simulator's building protection stops a copter about to fly into a wall; bring it home from there.
      braked = true;
      emit({ kind: "warn", text: `${d.role}: BRAKE: the simulator's building protection stopped it ${Math.round(metres(here, d.route[d.route.length - 1]))} m short; sending it home.` });
      await runTool("return_to_launch", {}, vid).catch(() => undefined);
    }
    // The plan ends with a return-to-launch flown inside Auto, so arrival is judged by distance, not by mode.
    const target = d.route[d.route.length - 1];
    const arrived = here !== null && metres(here, target) < 40;
    if ((arrived || /RTL|LAND/.test(st.mode)) && !wasHome) {
      wasHome = true;
      const battery = st.t.batteryPct !== null ? `${Math.round(st.t.batteryPct)} %` : "?";
      if (braked) emit({ kind: "warn", text: `${d.role}: did not reach the destination (a building was in the way); returning to launch, battery ${battery}.` });
      else if (arrived) emit({ kind: "ok", text: `${d.role}: reached the destination; mission flown, returning to launch, battery ${battery}.` });
      else emit({ kind: "ok", text: `${d.role}: returning to launch (${st.mode}), battery ${battery}.` });
      if (!opts.untilLanded) return;
    }
    if (wasHome && !st.armed) {
      emit({ kind: "ok", text: `${d.role}: landed back at its start.` });
      return;
    }
    await sleep(2000);
  }
  emit({ kind: "warn", text: `${d.role}: still flying when the scenario's time was up; it carries on in the simulator.` });
}

// ---------- the scenarios ----------

async function spacetime(s: Scenario, origin: string, emit: Emit): Promise<void> {
  const [a, b] = s.drones;
  emit({ kind: "step", text: "Putting the mission plans in the simulator's plan library…" });
  const plans = await installPlans(s);
  const planOf = (d: ScenarioDrone) => plans.find((p) => p.name === d.planName)?.id ?? "";
  emit({ kind: "step", text: "Starting both drones at their operators' bases…" });
  const [va, vb] = await Promise.all([startDrone(s, a, origin, emit), startDrone(s, b, origin, emit)]);
  if (!va || !vb) return;
  for (const [vid, d] of [
    [va, a],
    [vb, b],
  ] as const)
    await assignMission({ vehicleId: vid, missionId: s.id, agent: d.operator, status: "proposed" })
      .then(() => emit({ kind: "ok", text: `${d.operator}: mission recorded in the shared airspace (proposed).` }))
      .catch((e: Error) => emit({ kind: "warn", text: `mission record: ${e.message}` }));

  const ask = async (vid: string, d: ScenarioDrone, from: LatLon, to: LatLon, band: [number, number]) => {
    const c = await requestCorridor({ vehicleId: vid, from, to, minAltM: band[0], maxAltM: band[1], widthM: 60, ttlS: 900 });
    emit({ kind: c.status === "granted" ? "ok" : "warn", text: `${d.operator} asks for ${band[0]}–${band[1]} m → ${c.status.toUpperCase()}${c.reason ? `: ${c.reason}` : ""} (corridor #${c.id})`, data: { corridor: c } });
    return c;
  };
  const corridors: number[] = [];
  try {
    const ca = await ask(va, a, a.start, a.route[a.route.length - 1], [a.altitudeM - 10, a.altitudeM + 10]);
    if (ca.status === "granted") corridors.push(ca.id);
    emit({ kind: "step", text: `${b.operator} wants to cross the courier's path in the same band…` });
    const cb1 = await ask(vb, b, b.start, b.route[b.route.length - 1], [a.altitudeM - 10, a.altitudeM + 10]);
    if (cb1.status === "granted") {
      corridors.push(cb1.id);
      emit({ kind: "warn", text: "The airspace granted an overlapping corridor; the reducer's separation rule did not trigger here." });
    } else {
      emit({ kind: "step", text: `${b.operator} re-plans ${b.altitudeM - a.altitudeM} m higher and asks again…` });
      const cb2 = await ask(vb, b, b.start, b.route[b.route.length - 1], [b.altitudeM - 10, b.altitudeM + 10]);
      if (cb2.status === "granted") corridors.push(cb2.id);
    }
  } catch (e) {
    emit({ kind: "fail", text: `The shared airspace is not reachable (${e instanceof Error ? e.message : String(e)}). Start SpacetimeDB (./dev.sh does when the CLI is installed).` });
  }
  emit({ kind: "link", text: "Watch the corridors live on the airspace map", data: { href: "/copilot" } });

  const ok = await Promise.all([readyUp(va, a.role, emit), readyUp(vb, b.role, emit)]);
  if (!ok.every(Boolean)) return;
  const flying = await Promise.all([flyPlan(planOf(a), va, a, emit), flyPlan(planOf(b), vb, b, emit)]);
  for (const [vid, d] of [
    [va, a],
    [vb, b],
  ] as const)
    await assignMission({ vehicleId: vid, missionId: s.id, agent: d.operator, status: "flying" }).catch(() => undefined);
  if (flying.some(Boolean)) await Promise.all([follow(va, a, emit, 360_000), follow(vb, b, emit, 360_000)]);
  for (const id of corridors) await releaseCorridor(id).catch(() => undefined);
  for (const [vid, d] of [
    [va, a],
    [vb, b],
  ] as const)
    await assignMission({ vehicleId: vid, missionId: s.id, agent: d.operator, status: "done" }).catch(() => undefined);
  emit({ kind: "ok", text: `Corridors released; both missions marked done in the shared airspace.` });
}

async function elastic(s: Scenario, origin: string, emit: Emit): Promise<void> {
  const env = elasticEnv();
  if (!env) {
    emit({ kind: "fail", text: "Elastic is not configured (ELASTIC_URL / ELASTIC_API_KEY in DroneX_render/.env.local)." });
    return;
  }
  const [d] = s.drones;
  const plans = await installPlans(s);
  const vid = await startDrone(s, d, origin, emit);
  if (!vid || !(await readyUp(vid, d.role, emit))) return;
  if (await flyPlan(plans[0]?.id ?? "", vid, d, emit)) await follow(vid, d, emit, 300_000);
  emit({ kind: "step", text: "Giving the mirror a few seconds to index the last fixes…" });
  await sleep(8000);

  const v = esqlString(vid);
  emit({ kind: "step", text: "Question 1, ES|QL over the flight's telemetry: what did the battery and the drone actually do?" });
  let drainPerMin: number | null = null;
  let minutes: number | null = null;
  try {
    const [row] = await esql(env, `FROM ${env.prefix}-telemetry | WHERE vehicle_id == ${v} AND armed == true | STATS t0 = MIN(@timestamp), t1 = MAX(@timestamp), batt0 = MAX(battery_pct), batt1 = MIN(battery_pct), max_alt = MAX(altitude_above_home_m), max_speed = MAX(ground_speed_mps), min_sats = MIN(gps_satellites), fixes = COUNT(*)`);
    if (row && row.fixes) {
      minutes = (Date.parse(String(row.t1)) - Date.parse(String(row.t0))) / 60_000;
      const used = Number(row.batt0) - Number(row.batt1);
      drainPerMin = minutes > 0 ? used / minutes : null;
      emit({ kind: "report", text: `${row.fixes} armed fixes over ${minutes.toFixed(1)} min: battery ${row.batt0} % → ${row.batt1} % (${drainPerMin?.toFixed(1) ?? "?"} %/min), up to ${Math.round(Number(row.max_alt))} m and ${Number(row.max_speed).toFixed(1)} m/s, never fewer than ${row.min_sats} satellites.`, data: { row } });
    } else emit({ kind: "warn", text: "No armed telemetry indexed for this vehicle yet: is the mirror running (DroneX_live)?" });
  } catch (e) {
    emit({ kind: "fail", text: `telemetry query: ${e instanceof Error ? e.message : String(e)}` });
  }
  try {
    const events = await esql(env, `FROM ${env.prefix}-events | WHERE vehicle_id == ${v} AND type IN ("armed", "mode", "home-set", "battery-threshold", "gps-quality", "ekf") | SORT @timestamp | KEEP @timestamp, type, detail | LIMIT 12`);
    if (events.length) emit({ kind: "report", text: `Timeline: ${events.map((e) => String(e.detail)).join(" → ")}`, data: { events } });
  } catch (e) {
    emit({ kind: "warn", text: `event timeline: ${e instanceof Error ? e.message : String(e)}` });
  }

  emit({ kind: "step", text: "Question 2, ES|QL over the configurator's verdicts: what did the physics predict for this design?" });
  try {
    const [ver] = await esql(env, `FROM ${env.prefix}-verdicts | WHERE design_id == ${esqlString(d.presetId)} AND mission_id == "medical-delivery-15km" | KEEP summary.hoverTime_min, summary.maxCurrent_A, failing_checks | LIMIT 1`);
    if (ver) {
      const hover = Number(ver["summary.hoverTime_min"]);
      const entry = catalogEntries().find((e) => e.id === d.presetId);
      const mixed = entry ? (judge(entry.build).verdict.mixedTime_min ?? null) : null;
      const flown = drainPerMin ? 100 / drainPerMin : null;
      const vsMixed = flown && mixed ? ` The configurator's mixed-flying estimate is ${mixed.toFixed(1)} min: the flight came within ${Math.abs(flown - mixed).toFixed(1)} min of it.` : "";
      emit({ kind: "report", text: `The configurator predicted about ${hover.toFixed(1)} min of pure hover for this design and failed it on ${String(ver.failing_checks).replace(/,/g, ", ")}. ${flown ? `This flight's battery drain projects about ${flown.toFixed(1)} min from full to empty.${vsMixed}` : ""}`, data: { verdict: ver, mixed, flown } });
    }
  } catch (e) {
    emit({ kind: "warn", text: `verdict lookup: ${e instanceof Error ? e.message : String(e)}` });
  }

  emit({ kind: "step", text: "Question 3, semantic search (Jina embeddings) over ArduPilot's parameter manual: what should the operator set?" });
  const questions = ["low battery failsafe action", "battery capacity in mAh", "¿qué altura usa el dron para volver a casa?"];
  for (const q of questions) {
    try {
      const hits = await semanticSearch(env, "ardupilot-params", q, 3, ["name", "human_name"]);
      emit({ kind: "report", text: `“${q}” → ${hits.map((h) => `${String(h.source.name)} (${String(h.source.human_name ?? "")})`).join(", ")}`, data: { hits } });
    } catch (e) {
      emit({ kind: "warn", text: `manual search: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
}

async function speakAndHear(origin: string, line: string): Promise<{ heard: string | null; error?: string }> {
  try {
    const wav = await selfFetch(`/api/copilot/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: line }) });
    if (!wav.ok) return { heard: null, error: `Sonic: HTTP ${wav.status}` };
    const form = new FormData();
    form.append("audio", new Blob([await wav.arrayBuffer()], { type: "audio/wav" }), "command.wav");
    const r = await selfFetch(`/api/copilot/transcribe`, { method: "POST", body: form });
    const j = (await r.json()) as { text?: string; error?: string };
    return r.ok && j.text ? { heard: j.text } : { heard: null, error: j.error ?? `Ink: HTTP ${r.status}` };
  } catch (e) {
    return { heard: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function cartesia(s: Scenario, origin: string, emit: Emit): Promise<void> {
  const [d] = s.drones;
  const plans = await installPlans(s);
  const vid = await startDrone(s, d, origin, emit);
  if (!vid) return;
  emit({ kind: "link", text: "Callouts for this drone are spoken as they fire", data: { callouts: vid } });
  if (!(await readyUp(vid, d.role, emit))) return;
  await routeAroundBuildings(plans[0]?.id ?? "", vid, d, emit);
  if (!(await uploadPlan(plans[0]?.id ?? "", vid, d, emit))) return;

  const command = async (line: string) => {
    emit({ kind: "say", text: line, data: { who: "pilot" } });
    const { heard, error } = await speakAndHear(origin, line);
    if (!heard) {
      emit({ kind: "fail", text: `voice round trip failed: ${error}` });
      return;
    }
    emit({ kind: "heard", text: heard });
    const r = await selfFetch(`/api/copilot/intent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: heard, vehicleId: vid }) });
    const j = (await r.json()) as { reply?: string; actions?: { tool: string; result: string }[]; error?: string };
    if (!r.ok) {
      emit({ kind: "fail", text: `copilot: ${j.error ?? r.status}` });
      return;
    }
    for (const a of j.actions ?? []) emit({ kind: "ok", text: `${a.tool}: ${a.result}` });
    if (j.reply) emit({ kind: "say", text: j.reply, data: { who: "copilot" } });
  };

  await command("Take off to thirty metres.");
  await until(() => vehicleState(vid), (v) => (v.t.altitudeAboveHomeM ?? 0) >= 18, 40_000);
  await command("Switch to auto and fly the patrol.");
  await sleep(45_000);
  await command("What's the battery?");
  await sleep(10_000);
  await command("Return to launch.");
  await follow(vid, d, emit, 150_000);
}

function agentsDir(): string {
  return process.env.DRONEX_AGENTS_DIR ?? path.resolve(process.cwd(), "../DroneX_agents");
}

async function fetchai(s: Scenario, origin: string, emit: Emit): Promise<void> {
  const status = (await selfFetch(`/api/dispatch`).then((r) => r.json()).catch(() => null)) as { live?: { dispatcher: boolean; flight: boolean; fleet: boolean } } | null;
  if (!status?.live?.dispatcher || !status.live.flight || !status.live.fleet) {
    emit({ kind: "fail", text: "The Dispatch agents are not all running. Start them with DroneX_agents/dev.sh (./dev.sh starts them too)." });
    return;
  }
  emit({ kind: "ok", text: "Dispatcher, eight fleet agents and the flight agent are up." });
  emit({ kind: "step", text: "Sending the clinic's request through the dispatcher's Agentverse mailbox (the path ASI:One uses)…" });
  const dir = agentsDir();
  const lines = ["A clinic needs a fast courier: a 160 km/h sprint over 2 km to Coit Tower, back in 5 minutes", "apex-5-freestyle-quad", "approve"];
  await new Promise<void>((resolve) => {
    const child = spawn(path.join(dir, ".venv/bin/python"), ["scripts/live_chat.py", "--via-agentverse", "--full-cards", ...lines], { cwd: dir });
    let buf = "";
    const onLine = (ln: string) => {
      const t = ln.trim();
      if (t.startsWith("▶")) emit({ kind: "say", text: t.slice(1).trim(), data: { who: "clinic" } });
      else if (t.startsWith("◀")) emit({ kind: "chat", text: t.slice(1).trim() });
      else if (t.startsWith("[card")) {
        const m = /^\[card (\w+)\] (.*)$/.exec(t);
        try {
          const card = JSON.parse(m?.[2] ?? "{}") as { title?: string; items?: { title: string; badges?: { label: string }[] }[]; summary_rows?: { label: string; value: string }[] };
          const what = card.items?.map((i) => `${i.title} (${i.badges?.[0]?.label ?? ""})`).join(", ") ?? card.summary_rows?.map((r) => `${r.label}: ${r.value}`).join(" · ") ?? "";
          emit({ kind: "report", text: `Card · ${m?.[1]}${card.title ? ` · ${card.title}` : ""}: ${what}`.slice(0, 600) });
        } catch {
          emit({ kind: "report", text: `Card · ${m?.[1] ?? "?"}` });
        }
      }
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    };
    child.stdout.on("data", onData);
    child.on("error", (e) => {
      emit({ kind: "fail", text: `could not start the chat client: ${e.message}` });
      resolve();
    });
    child.on("close", () => resolve());
    setTimeout(() => child.kill(), 360_000);
  });
}

const RUNNERS: Record<Scenario["track"], (s: Scenario, origin: string, emit: Emit) => Promise<void>> = { spacetime, elastic, cartesia, fetchai };

let running: string | null = null;

/** Runs one scenario; one at a time, since they share the simulator and the voice. */
export async function runScenario(id: string, origin: string, emit: Emit): Promise<void> {
  const s = scenarioById(id);
  if (!s) {
    emit({ kind: "fail", text: `no scenario ${id}` });
    return;
  }
  if (running) {
    emit({ kind: "fail", text: `"${running}" is still running; stop it or wait for it to finish.` });
    return;
  }
  running = s.title;
  const t0 = Date.now();
  emit({ kind: "step", text: `${s.trackName} · ${s.title}` });
  try {
    await RUNNERS[s.track](s, origin, emit);
  } catch (e) {
    emit({ kind: "fail", text: e instanceof Error ? e.message : String(e) });
  } finally {
    running = null;
    emit({ kind: "done", text: `Finished in ${Math.round((Date.now() - t0) / 1000)} s.` });
  }
}

/** Stops the simulated vehicles the scenarios started (not anyone else's). */
export async function stopScenarioDrones(): Promise<number> {
  let n = 0;
  await withClient(async (c) => {
    for (const [vid, { linkId }] of started) {
      await c.call("sim/stop", { id: linkId }).catch(() => undefined);
      started.delete(vid);
      n++;
    }
  });
  return n;
}
