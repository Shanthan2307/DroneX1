// The parts assistant: answers a builder's questions about the drone on the pad (what a part does, why a mission
// fails, which part to pick instead, what a mission requires) by function calling over tools that read the
// dataset and run dronePhysics.js. The model chooses tools and words the answer; every number in the answer
// comes from a tool result, and a swap is only proposed after the physics has judged it. Server-only.
//
// The same OpenAI-compatible endpoint as the flight copilot (INTENT_API_BASE / INTENT_API_KEY / INTENT_MODEL;
// ASI:One by default). The voice around it is Cartesia (Ink in, Sonic out) on the configurator page.
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { checkBuild, judge, type Build, type MissionRow } from "@/lib/catalog/server";
import { droneCatalog } from "../../../prototype/drone-assembly/src/data/droneCatalog.js";
import { droneOptionsWithCompat } from "../../../prototype/drone-assembly/src/droneCompat.js";
import { DRONE_RULES } from "../../../prototype/drone-assembly/src/dronePhysics.js";
import { PART_SLOT_ROLE } from "../../../prototype/drone-assembly/src/ui/partRoles.js";

export type Slot = "airframe" | "motor" | "propeller" | "battery" | "payload";
export const SLOTS: Slot[] = ["airframe", "motor", "propeller", "battery", "payload"];

const SLOT_FIELD: Record<Slot, keyof Build> = { airframe: "airframeId", motor: "motorId", propeller: "propellerId", battery: "batteryId", payload: "payloadId" };
const SLOT_LIST: Record<Slot, string> = { airframe: "airframes", motor: "motors", propeller: "propellers", battery: "batteries", payload: "payloads" };

/** A change the page can make: a part swap or a mission choice. */
export type Change = { kind: "swap"; slot: Slot; partId: string; partName: string; why: string } | { kind: "mission"; missionId: string; missionName: string; why: string };

export interface AssistantTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantRequest {
  messages: AssistantTurn[];
  build: Build;
  /** The drone's name on the pad, for the answer's wording. */
  name?: string | null;
  /** The part the builder has clicked, if any. */
  selected?: { slot: Slot; partId: string | null } | null;
}

export interface AssistantResult {
  reply: string;
  /** Changes offered as buttons (the builder decides). */
  suggestions: Change[];
  /** Changes the builder explicitly asked for; the page applies them. */
  apply: Change[];
  actions: { tool: string; args: Record<string, unknown>; result: string }[];
  model: string;
}

type Rec = Record<string, unknown> & { id: string; name: string };
type Catalog = Record<string, Rec[]> & { missions: Rec[] };
const catalog = droneCatalog as unknown as Catalog;

const records = (slot: Slot): Rec[] => catalog[SLOT_LIST[slot]] ?? [];
const recordOf = (slot: Slot, id: string | null | undefined): Rec | null => (id ? (records(slot).find((r) => r.id === id) ?? null) : null);
const missionOf = (id: string | null | undefined): Rec | null => (id ? (catalog.missions.find((m) => m.id === id) ?? null) : null);
const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** A part by id, or by name as the model tends to say it ("T-Motor F60 Pro IV V2.0"); the first slot that has it. */
function findPart(slot: Slot | null, idOrName: string): { slot: Slot; rec: Rec } | null {
  const q = norm(idOrName);
  for (const s of slot ? [slot] : SLOTS) {
    const list = records(s);
    const rec = list.find((r) => r.id === idOrName) ?? list.find((r) => norm(r.name) === q) ?? list.find((r) => norm(r.name).startsWith(q) || q.startsWith(norm(r.name))) ?? null;
    if (rec) return { slot: s, rec };
  }
  return null;
}
const slotOfPart = (id: string): Slot | null => findPart(null, id)?.slot ?? null;
const isSlot = (v: unknown): v is Slot => typeof v === "string" && (SLOTS as string[]).includes(v);

/** A record without its long free-text notes (trimmed), so tool results stay small. */
const compact = (r: Rec): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined) continue;
    out[k] = k === "notes" && typeof v === "string" && v.length > 400 ? `${v.slice(0, 400)}…` : v;
  }
  return out;
};

const round = (v: unknown, d = 1): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** The numbers that describe a build, from the verdict (all est.). */
function figures(build: Build) {
  const { verdict, readiness, missions, warnings } = judge(build);
  return {
    allUpWeight_g: round(verdict.allUpWeight_g, 0),
    hoverThrustToWeight: round(verdict.hoverTWR, 2),
    hoverPower_W: round(verdict.hoverPower_W, 0),
    hoverTime_min: round(verdict.hoverTime_min),
    mixedFlyingTime_min: round(verdict.mixedTime_min),
    range_km: round(verdict.range_km),
    cruiseSpeed_ms: round(verdict.cruiseSpeed_ms),
    maxCurrent_A: round(verdict.maxCurrent_A, 0),
    batteryDischarge_C: round(verdict.discharge_C),
    under250g: verdict.sub250 ?? null,
    readiness,
    missions,
    warnings,
  };
}

const rowFor = (missions: MissionRow[], missionId: string | null | undefined): MissionRow | null => (missionId ? (missions.find((m) => m.mission.id === missionId) ?? null) : null);

const checksOf = (row: MissionRow | null) =>
  row
    ? {
        mission: row.mission.name,
        ready: row.ready,
        checks: row.checks.map((c) => ({ check: c.label ?? c.key, status: c.status, detail: (c as { reason?: string }).reason ?? c.text ?? null })),
      }
    : null;

const nameOf = (slot: Slot, id: string | null | undefined): string => recordOf(slot, id)?.name ?? (id ? id : "nothing fitted");

function overview(build: Build, name: string | null | undefined): Record<string, unknown> {
  const f = figures(build);
  const mission = missionOf(build.missionId);
  return {
    drone: name ?? null,
    parts: Object.fromEntries(SLOTS.map((s) => [s, { id: build[SLOT_FIELD[s]] ?? null, name: nameOf(s, build[SLOT_FIELD[s]] as string | null), weight_g: recordOf(s, build[SLOT_FIELD[s]] as string | null)?.weight_g ?? recordOf(s, build[SLOT_FIELD[s]] as string | null)?.emptyWeight_g ?? null }])),
    estimates: { allUpWeight_g: f.allUpWeight_g, hoverThrustToWeight: f.hoverThrustToWeight, hoverPower_W: f.hoverPower_W, hoverTime_min: f.hoverTime_min, mixedFlyingTime_min: f.mixedFlyingTime_min, range_km: f.range_km, cruiseSpeed_ms: f.cruiseSpeed_ms, maxCurrent_A: f.maxCurrent_A, under250g: f.under250g },
    selectedMission: mission ? mission.name : "none chosen",
    missionResult: checksOf(rowFor(f.missions, build.missionId)),
    otherMissions: f.missions.filter((m) => m.mission.id !== build.missionId).map((m) => ({ id: m.mission.id, name: m.mission.name, ready: m.ready, failing: m.failing })),
    warnings: f.warnings,
    note: "every figure is an estimate from dronePhysics.js over the dataset's own part records",
  };
}

function partInfo(slot: Slot | null, partId: string | null, build: Build): Record<string, unknown> {
  const s = slot ?? (partId ? slotOfPart(partId) : null);
  if (!s) return { error: "name a slot (airframe, motor, propeller, battery, payload) or a part id" };
  const id = partId ?? (build[SLOT_FIELD[s]] as string | null);
  const rec = id ? (findPart(s, id)?.rec ?? null) : null;
  if (!rec) return { slot: s, fitted: null, role: PART_SLOT_ROLE[s], note: s === "payload" ? "no payload is fitted" : `no ${s} record ${id ?? ""}` };
  return { slot: s, role: PART_SLOT_ROLE[s], fittedOnThisDrone: build[SLOT_FIELD[s]] === rec.id, record: compact(rec) };
}

function tryChange(build: Build, change: Partial<Build>): Record<string, unknown> {
  const checked = checkBuild({ ...build, ...change });
  if (!checked.ok) return { possible: false, reason: checked.reason };
  const before = figures(build);
  const after = figures(checked.build);
  const keys = ["allUpWeight_g", "hoverThrustToWeight", "hoverTime_min", "mixedFlyingTime_min", "range_km", "cruiseSpeed_ms", "maxCurrent_A"] as const;
  return {
    possible: true,
    change: Object.fromEntries(keys.map((k) => [k, { before: before[k], after: after[k] }])),
    missionBefore: checksOf(rowFor(before.missions, build.missionId)),
    missionAfter: checksOf(rowFor(after.missions, checked.build.missionId)),
    newWarnings: after.warnings.filter((w) => !before.warnings.includes(w)),
  };
}

function slotOptions(build: Build, slot: Slot): Record<string, unknown> {
  const rows = droneOptionsWithCompat(build, droneCatalog, slot) as { record: Rec; level: string; reasons: string[] }[];
  return {
    slot,
    fitted: nameOf(slot, build[SLOT_FIELD[slot]] as string | null),
    options: rows.map(({ record, level, reasons }) => {
      const out: Record<string, unknown> = { id: record.id, name: record.name, compatibility: level, reasons, weight_g: record.weight_g ?? record.emptyWeight_g ?? null };
      if (level !== "incompatible" && build.missionId) {
        const checked = checkBuild({ ...build, [SLOT_FIELD[slot]]: record.id });
        if (checked.ok) {
          const row = rowFor(judge(checked.build).missions, build.missionId);
          out.missionReadyWithIt = row?.ready ?? null;
          out.hoverTime_min = round(row?.summary.hoverTime_min);
        }
      }
      return out;
    }),
  };
}

function missionInfo(build: Build, missionId: string | null): Record<string, unknown> {
  const m = missionOf(missionId ?? build.missionId);
  if (!m) return { missions: catalog.missions.map((x) => ({ id: x.id, name: x.name })) };
  const row = rowFor(judge(build).missions, m.id);
  const payload = typeof m.requiredPayloadId === "string" ? recordOf("payload", m.requiredPayloadId) : null;
  return { requirements: compact(m), requiredPayload: payload?.name ?? null, thisDrone: checksOf(row) };
}

/** One-part swaps that make the mission pass; if none, the mission's required payload plus one more part. */
function findFixes(build: Build, missionId: string | null): Record<string, unknown> {
  const mid = missionId ?? build.missionId;
  const m = missionOf(mid);
  if (!m) return { error: "no mission chosen; name one" };
  const passing = (b: Build): MissionRow | null => {
    const checked = checkBuild(b);
    if (!checked.ok) return null;
    const row = rowFor(judge(checked.build).missions, m.id);
    return row?.ready ? row : null;
  };
  const base: Build = { ...build, missionId: m.id };
  if (passing(base)) return { mission: m.name, alreadyPasses: true };
  const fixes: Record<string, unknown>[] = [];
  for (const s of SLOTS)
    for (const r of records(s)) {
      if (r.id === base[SLOT_FIELD[s]]) continue;
      const row = passing({ ...base, [SLOT_FIELD[s]]: r.id });
      if (row) fixes.push({ swaps: [{ slot: s, id: r.id, name: r.name }], hoverTime_min: round(row.summary.hoverTime_min), allUpWeight_g: round(row.summary.auw_g, 0) });
    }
  const req = typeof m.requiredPayloadId === "string" ? m.requiredPayloadId : null;
  if (!fixes.length && req && base.payloadId !== req) {
    const withPayload: Build = { ...base, payloadId: req };
    for (const s of SLOTS.filter((x) => x !== "payload"))
      for (const r of records(s)) {
        if (r.id === withPayload[SLOT_FIELD[s]]) continue;
        const row = passing({ ...withPayload, [SLOT_FIELD[s]]: r.id });
        if (row) fixes.push({ swaps: [{ slot: "payload", id: req, name: nameOf("payload", req) }, { slot: s, id: r.id, name: r.name }], hoverTime_min: round(row.summary.hoverTime_min), allUpWeight_g: round(row.summary.auw_g, 0) });
      }
  }
  const failing = checksOf(rowFor(judge(base).missions, m.id))?.checks.filter((c) => c.status === "fail");
  return fixes.length ? { mission: m.name, fixes: fixes.slice(0, 6) } : { mission: m.name, fixes: [], failingNow: failing, note: "no single swap, nor the required payload plus one swap, makes this mission pass with the parts in the dataset" };
}

const TOOLS: ChatCompletionTool[] = [
  { type: "function", function: { name: "build_overview", description: "The drone on the pad: every part, the physics estimates (weight, lift, flight time, range, current), how it does on its mission check by check, and which other missions it passes.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "part_info", description: "What a part is and does, and its full dataset record (specs, source, notes). Give the slot for the fitted part, or a part id for any part.", parameters: { type: "object", properties: { slot: { type: "string", enum: SLOTS }, part_id: { type: "string" } } } } },
  { type: "function", function: { name: "slot_options", description: "Every part that can go in a slot, with compatibility (ok, unusual, incompatible and why), weight, and whether the current mission would pass with it.", parameters: { type: "object", properties: { slot: { type: "string", enum: SLOTS } }, required: ["slot"] } } },
  { type: "function", function: { name: "try_change", description: "Judge a change with the physics before proposing it: before/after numbers and the mission checks. Use for 'what if I used X'.", parameters: { type: "object", properties: { slot: { type: "string", enum: SLOTS }, part_id: { type: "string" }, mission_id: { type: "string" } } } } },
  { type: "function", function: { name: "mission_info", description: "A mission's requirements (distance, endurance, weight limit, lift, speed, required payload) and how this drone does against each; without an id, the current mission; with 'list', every mission.", parameters: { type: "object", properties: { mission_id: { type: "string" } } } } },
  { type: "function", function: { name: "find_fixes", description: "Search every one-part swap (and the required payload plus one swap) for builds that pass a mission, judged by the physics.", parameters: { type: "object", properties: { mission_id: { type: "string" } } } } },
  { type: "function", function: { name: "physics_rules", description: "The thresholds and modelling constants the verdict uses (lift ratios, usable pack share, 250 g line, tip speed, allowances), for explaining why a check passes or fails.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "suggest_change", description: "Offer the builder a button to make a change (a part swap or a mission). Only after try_change or find_fixes showed what it does.", parameters: { type: "object", properties: { slot: { type: "string", enum: SLOTS }, part_id: { type: "string" }, mission_id: { type: "string" }, why: { type: "string", description: "one short clause, from the tool results" } }, required: ["why"] } } },
  { type: "function", function: { name: "apply_change", description: "Make the change on the pad now. Only when the builder clearly asked to do it (\"swap it\", \"use that battery\", \"switch to the medical mission\").", parameters: { type: "object", properties: { slot: { type: "string", enum: SLOTS }, part_id: { type: "string" }, mission_id: { type: "string" }, why: { type: "string" } }, required: ["why"] } } },
];

const SYSTEM = `You are DroneX's build assistant, speaking (through a voice) to someone building a drone in a configurator. You explain the parts, what each mission requires, why the drone passes or fails, and which part to choose instead.

Rules:
- Every number you say must come from a tool result in this conversation. Never estimate or invent one. If a tool has no number for it, say the dataset does not have it.
- The physics decides pass or fail, not you. Before recommending a part, judge it with try_change or find_fixes. If nothing passes, say so and name the failing check.
- Use build_overview first when the question is about this drone. Use part_info for "what is this part / what does it do". Use slot_options for "what else could go here". Use mission_info for requirements.
- When a better part exists, call suggest_change so the builder gets a button. Call apply_change only when the builder clearly asked you to make the change.
- Speak plainly for a beginner: say what a part does and why its number matters, then the number. Two to four short sentences, no markdown, no lists, numbers rounded and with units (grams, minutes, kilometres). Say "about" for estimates.`;

function client(): { api: OpenAI; model: string } {
  const apiKey = process.env.INTENT_API_KEY;
  if (!apiKey) throw new Error("INTENT_API_KEY is not set (ASI:One or any OpenAI-compatible endpoint)");
  return { api: new OpenAI({ apiKey, baseURL: process.env.INTENT_API_BASE ?? "https://api.asi1.ai/v1" }), model: process.env.INTENT_MODEL ?? "asi1-mini" };
}

type Args = Record<string, unknown>;
const str = (a: Args, k: string): string | null => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : null);

/** A change from tool arguments, validated against the dataset; a string says why it is not one. */
function changeFrom(args: Args, build: Build): Change | string {
  const why = str(args, "why") ?? "";
  const missionId = str(args, "part_id") ? null : str(args, "mission_id");
  if (missionId) {
    const m = missionOf(missionId);
    return m ? { kind: "mission", missionId: m.id, missionName: m.name, why } : `no mission ${missionId}`;
  }
  const partId = str(args, "part_id");
  if (!partId) return "a change needs a part_id (and its slot) or a mission_id";
  const hit = findPart(isSlot(args.slot) ? args.slot : null, partId) ?? findPart(null, partId);
  if (!hit) return `no part ${partId}; use slot_options to see the ids`;
  const checked = checkBuild({ ...build, [SLOT_FIELD[hit.slot]]: hit.rec.id });
  if (!checked.ok) return `not possible: ${checked.reason}`;
  return { kind: "swap", slot: hit.slot, partId: hit.rec.id, partName: hit.rec.name, why };
}

const sameChange = (a: Change, b: Change): boolean => (a.kind === "swap" && b.kind === "swap" ? a.slot === b.slot && a.partId === b.partId : a.kind === "mission" && b.kind === "mission" && a.missionId === b.missionId);
const offer = (list: Change[], c: Change): void => {
  if (!list.some((x) => sameChange(x, c))) list.push(c);
};

/** Runs one tool. `out` collects the suggestions and applied changes for the page. */
export function runAssistantTool(name: string, args: Args, req: AssistantRequest, out: { suggestions: Change[]; apply: Change[] }): string {
  const build = req.build;
  const slotArg = isSlot(args.slot) ? args.slot : null;
  let result: unknown;
  switch (name) {
    case "build_overview":
      result = overview(build, req.name);
      break;
    case "part_info":
      result = partInfo(slotArg ?? (str(args, "part_id") ? null : (req.selected?.slot ?? null)), str(args, "part_id"), build);
      break;
    case "slot_options":
      result = slotArg ? slotOptions(build, slotArg) : { error: "slot is required" };
      break;
    case "try_change": {
      const change: Partial<Build> = {};
      const hit = str(args, "part_id") ? findPart(slotArg, str(args, "part_id") as string) : null;
      const slot = hit?.slot ?? null;
      const partId = hit?.rec.id ?? null;
      if (slot && partId) (change as Record<string, unknown>)[SLOT_FIELD[slot]] = partId;
      const mid = str(args, "mission_id");
      if (mid) change.missionId = mid;
      result = Object.keys(change).length ? tryChange(build, change) : { error: "give a part (slot + part_id) or a mission_id" };
      const t = result as { missionBefore?: { ready: boolean } | null; missionAfter?: { ready: boolean; mission: string } | null };
      if (slot && partId && t.missionAfter?.ready && !t.missionBefore?.ready) offer(out.suggestions, { kind: "swap", slot, partId, partName: nameOf(slot, partId), why: `passes ${t.missionAfter.mission}` });
      break;
    }
    case "mission_info": {
      const mid = str(args, "mission_id");
      result = missionInfo(build, mid === "list" ? "__list__" : mid);
      break;
    }
    case "find_fixes": {
      const r = findFixes(build, str(args, "mission_id"));
      // A fix the physics found is offered as a button whether or not the model remembers to suggest it.
      for (const fix of ((r.fixes as { swaps: { slot: Slot; id: string; name: string }[]; hoverTime_min: number | null }[] | undefined) ?? []).filter((f) => f.swaps.length === 1).slice(0, 2)) {
        const sw = fix.swaps[0];
        offer(out.suggestions, { kind: "swap", slot: sw.slot, partId: sw.id, partName: sw.name, why: `passes ${String(r.mission)}${fix.hoverTime_min !== null ? `, about ${fix.hoverTime_min} min hover` : ""}` });
      }
      result = r;
      break;
    }
    case "physics_rules":
      result = DRONE_RULES;
      break;
    case "suggest_change":
    case "apply_change": {
      const c = changeFrom(args, build);
      if (typeof c === "string") result = { error: c };
      else {
        offer(name === "apply_change" ? out.apply : out.suggestions, c);
        // Once applied, the rest of this turn talks about the changed drone.
        if (name === "apply_change") req.build = c.kind === "swap" ? { ...build, [SLOT_FIELD[c.slot]]: c.partId } : { ...build, missionId: c.missionId };
        result = { ok: true, [name === "apply_change" ? "applied" : "offered"]: c };
      }
      break;
    }
    default:
      result = { error: `unknown tool ${name}` };
  }
  return JSON.stringify(result);
}

const MAX_ROUNDS = 5;
/** A cap on every model reply (cost): the answer is a few spoken sentences. */
const MAX_TOKENS = 400;

/** The reply as speech: models add markdown even when told not to; Sonic would read the asterisks. */
export function forSpeech(text: string): string {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The builder's question, answered: up to five rounds of tool calls, then a spoken reply. */
export async function answer(req: AssistantRequest): Promise<AssistantResult> {
  const { api, model } = client();
  const context = `The drone on the pad: ${req.name ?? "unnamed"}. Selected part: ${req.selected ? `${req.selected.slot} ${req.selected.partId ?? ""}` : "none"}. Mission: ${missionOf(req.build.missionId)?.name ?? "none chosen"}.`;
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: `${SYSTEM}\n\n${context}` }, ...req.messages.slice(-10).map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam)];
  const out = { suggestions: [] as Change[], apply: [] as Change[] };
  const actions: AssistantResult["actions"] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await api.chat.completions.create({ model, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.2, max_tokens: MAX_TOKENS });
    const msg = res.choices[0]?.message;
    if (!msg) break;
    const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (!calls.length) {
      const reply = (msg.content ?? "").trim();
      return { reply: forSpeech(reply) || "I could not work that out; ask me about a part, a mission or what to change.", ...out, actions, model };
    }
    messages.push(msg);
    for (const call of calls) {
      if (call.type !== "function") continue;
      let args: Args = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Args;
      } catch {
        args = {};
      }
      let result: string;
      try {
        result = runAssistantTool(call.function.name, args, req, out);
      } catch (e) {
        result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      actions.push({ tool: call.function.name, args, result: result.length > 300 ? `${result.slice(0, 300)}…` : result });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  const last = await api.chat.completions.create({ model, messages: [...messages, { role: "user", content: "Answer now in two to four short spoken sentences, from the tool results only." }], temperature: 0.2, max_tokens: MAX_TOKENS });
  return { reply: forSpeech(last.choices[0]?.message.content ?? "") || "I could not finish that answer.", ...out, actions, model };
}
