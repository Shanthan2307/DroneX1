// Intent to action: a sentence from the pilot (spoken through Cartesia, typed, or relayed by the Dispatch agent)
// becomes one of the copilot's tools (src/lib/sim/tools.ts), chosen by an OpenAI-compatible chat model with
// function calling. The model only picks the tool and its arguments; the action and its receipt are code. The
// endpoint is configurable (INTENT_API_BASE / INTENT_API_KEY / INTENT_MODEL); ASI:One by default. Server-only.
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { arm, describe, disarm, goToPlace, land, listVehicles, pickVehicle, rtl, setMode, takeoff, telemetry, withCore, type AllowedIds } from "@/lib/sim/tools";
import { touchSim } from "@/lib/sim/sims";

export interface IntentResult {
  /** What to say back, in one or two short sentences. */
  reply: string;
  /** The tools that ran, in order, with their receipts. */
  actions: { tool: string; args: Record<string, unknown>; result: string }[];
  /** The vehicle acted on, when one was. */
  vehicleId: string | null;
  model: string;
}

const TOOLS: ChatCompletionTool[] = [
  { type: "function", function: { name: "status", description: "Where the vehicle is and how it is doing: altitude, speed, battery, GPS, EKF, mode.", parameters: { type: "object", properties: { vehicle: { type: "string", description: "vehicle name, if the pilot named one" } } } } },
  { type: "function", function: { name: "list_vehicles", description: "Which vehicles exist and which are online.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "takeoff", description: "Guided mode, arm, and take off to a height above home in metres.", parameters: { type: "object", properties: { altitude_m: { type: "number" }, vehicle: { type: "string" } }, required: ["altitude_m"] } } },
  { type: "function", function: { name: "goto_place", description: "Fly to a named place (landmark, address, pier) at a height above home in metres, in guided mode.", parameters: { type: "object", properties: { place: { type: "string" }, altitude_m: { type: "number" }, vehicle: { type: "string" } }, required: ["place", "altitude_m"] } } },
  { type: "function", function: { name: "set_mode", description: "Change the flight mode: LOITER, BRAKE, ALT_HOLD, POSHOLD, AUTO, GUIDED, STABILIZE, RTL, LAND.", parameters: { type: "object", properties: { mode: { type: "string" }, vehicle: { type: "string" } }, required: ["mode"] } } },
  { type: "function", function: { name: "return_to_launch", description: "Fly back to the launch point and land.", parameters: { type: "object", properties: { vehicle: { type: "string" } } } } },
  { type: "function", function: { name: "land", description: "Land where it is.", parameters: { type: "object", properties: { vehicle: { type: "string" } } } } },
  { type: "function", function: { name: "arm", description: "Arm the motors without taking off. Only when the pilot says arm.", parameters: { type: "object", properties: { vehicle: { type: "string" } } } } },
  { type: "function", function: { name: "disarm", description: "Disarm the motors. Only on the ground.", parameters: { type: "object", properties: { vehicle: { type: "string" } } } } },
];

const SYSTEM = `You are the DroneX copilot, speaking to a pilot who is flying a simulated drone over San Francisco. Decide which tool the pilot's words ask for and call it. If no tool fits (a question about the design, small talk), answer in one short sentence without a tool. Never arm, take off, change mode, return or land unless the pilot clearly asked for that action. Heights default to 20 metres if the pilot gives none for a takeoff and 40 metres for a go-to. Reply in one or two short spoken sentences, numbers rounded, no markdown.`;

/** A cap on every model reply: the copilot speaks one or two sentences. */
const MAX_TOKENS = 400;

function client(): { api: OpenAI; model: string } {
  const apiKey = process.env.INTENT_API_KEY;
  if (!apiKey) throw new Error("INTENT_API_KEY is not set (ASI:One or any OpenAI-compatible endpoint)");
  return { api: new OpenAI({ apiKey, baseURL: process.env.INTENT_API_BASE ?? "https://api.asi1.ai/v1" }), model: process.env.INTENT_MODEL ?? "asi1-mini" };
}

type Args = Record<string, unknown>;
const str = (a: Args, k: string): string | null => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string) : null);
const num = (a: Args, k: string, d: number): number => (typeof a[k] === "number" && Number.isFinite(a[k] as number) ? (a[k] as number) : d);

/**
 * Which vehicles a command may touch: `lock` pins every command to one vehicle and ignores the model's `vehicle`
 * argument (the Dispatch agent's session); `allowed` limits the choice (a visitor's own drones; null: all).
 */
export type VehicleScope = { lock: string } | { allowed: AllowedIds };

const ALL: VehicleScope = { allowed: null };

/** Runs one tool against the engine and says what happened. */
export async function runTool(name: string, args: Args, defaultVehicle?: string | null, scope: VehicleScope = ALL): Promise<{ result: string; vehicleId: string | null }> {
  return withCore(async (c) => {
    const allowed: AllowedIds = "lock" in scope ? [scope.lock] : scope.allowed;
    if (name === "list_vehicles") {
      const all = await listVehicles(c, allowed);
      return { result: all.length ? all.map((v) => `${v.name} (${v.presence}, ${v.mode}${v.armed ? ", armed" : ""})`).join("; ") : "no vehicles", vehicleId: null };
    }
    const wanted = "lock" in scope ? scope.lock : (str(args, "vehicle") ?? defaultVehicle ?? null);
    const v = await pickVehicle(c, wanted, allowed);
    touchSim(v.id);
    switch (name) {
      case "status":
        return { result: describe(await telemetry(c, v), v), vehicleId: v.id };
      case "takeoff":
        return { result: await takeoff(c, v, num(args, "altitude_m", 20)), vehicleId: v.id };
      case "goto_place": {
        const place = str(args, "place");
        if (!place) return { result: "which place?", vehicleId: v.id };
        return { result: await goToPlace(c, v, place, num(args, "altitude_m", 40)), vehicleId: v.id };
      }
      case "set_mode": {
        const mode = str(args, "mode");
        if (!mode) return { result: "which mode?", vehicleId: v.id };
        return { result: await setMode(c, v, mode), vehicleId: v.id };
      }
      case "return_to_launch":
        return { result: await rtl(c, v), vehicleId: v.id };
      case "land":
        return { result: await land(c, v), vehicleId: v.id };
      case "arm":
        return { result: await arm(c, v), vehicleId: v.id };
      case "disarm":
        return { result: await disarm(c, v), vehicleId: v.id };
      default:
        return { result: `unknown tool ${name}`, vehicleId: v.id };
    }
  });
}

/** The pilot's sentence, acted on. One round of tool calls, then a spoken reply grounded in the receipts. */
export async function act(text: string, opts: { vehicleId?: string | null; scope?: VehicleScope } = {}): Promise<IntentResult> {
  const scope = opts.scope ?? ALL;
  const { api, model } = client();
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: text },
  ];
  const first = await api.chat.completions.create({ model, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.1, max_tokens: MAX_TOKENS });
  const choice = first.choices[0]?.message;
  const actions: IntentResult["actions"] = [];
  let vehicleId: string | null = "lock" in scope ? scope.lock : (opts.vehicleId ?? null);
  if (!choice) return { reply: "I did not catch that.", actions, vehicleId, model };
  const calls = choice.tool_calls ?? [];
  if (calls.length === 0) return { reply: (choice.content ?? "").trim() || "Say what you want the drone to do.", actions, vehicleId, model };
  messages.push(choice);
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
      const r = await runTool(call.function.name, args, vehicleId, scope);
      result = r.result;
      vehicleId = r.vehicleId ?? vehicleId;
    } catch (e) {
      result = e instanceof Error ? e.message : String(e);
    }
    actions.push({ tool: call.function.name, args, result });
    messages.push({ role: "tool", tool_call_id: call.id, content: result });
  }
  const second = await api.chat.completions.create({ model, messages, temperature: 0.2, max_tokens: MAX_TOKENS });
  const reply = (second.choices[0]?.message.content ?? "").trim() || actions.map((a) => a.result).join(". ");
  return { reply, actions, vehicleId, model };
}
