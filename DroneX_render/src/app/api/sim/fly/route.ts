// POST /api/sim/fly: the configurator sends the drone on the pad (its design, its simulation profile and the
// packed 3D model); the server keeps them, starts the simulation in the engine and answers with the simulation
// UI's address for that vehicle. The browser then goes there.
import { droneCatalog } from "../../../../../prototype/drone-assembly/src/data/droneCatalog.js";
import { validateDesign } from "../../../../../prototype/drone-assembly/src/designs.js";
import { flyDesign, modelBookmarkUrl, type SimProfile } from "@/lib/sim/fly";
import { newId, saveFlight } from "@/lib/sim/store";
import { configuratorOrigin } from "@/lib/publicUrls";

const MODEL_MAX_BYTES = 40 * 1024 * 1024;
const PARAM_NAME = /^[A-Z0-9_]{1,16}$/;
const FRAME = /^[A-Za-z0-9_+-]{1,100}$/;
const BASES = new Set(["multicopter", "plane", "vtol"]);

const fail = (status: number, error: string) => Response.json({ error }, { status });

type Design = { id: string; name: string };

// The profile is the client's claim about the design; every field is checked for shape and range before it reaches
// the engine or a URL.
function readProfile(raw: unknown): SimProfile | string {
  if (typeof raw !== "object" || raw === null) return "profile is not an object";
  const p = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const name = str(p.name)?.trim().slice(0, 64);
  if (!name) return "profile.name missing";
  const vehicle = str(p.vehicle);
  const base = str(p.base);
  const frame = str(p.frame);
  if (!vehicle || !BASES.has(vehicle) || !base || !BASES.has(base)) return "profile.vehicle / base unknown";
  if (!frame || !FRAME.test(frame)) return "profile.frame unusable";
  const span_m = typeof p.span_m === "number" && p.span_m > 0 && p.span_m < 100 ? p.span_m : null;
  if (!span_m) return "profile.span_m out of range";
  const spinner = p.spinner === null || p.spinner === undefined ? null : str(p.spinner);
  if (spinner !== null && !/^[A-Za-z0-9_]{1,32}$/.test(spinner)) return "profile.spinner unusable";
  const rotorsRaw = Array.isArray(p.rotors) ? p.rotors : [];
  if (rotorsRaw.length > 8) return "too many rotors";
  const rotors = rotorsRaw.map((r) => ({ ccw: Boolean((r as { ccw?: unknown })?.ccw) }));
  const paramsRaw = Array.isArray(p.params) ? p.params : [];
  const params: SimProfile["params"] = [];
  for (const q of paramsRaw) {
    const { name: n, value } = (q ?? {}) as { name?: unknown; value?: unknown };
    if (typeof n !== "string" || !PARAM_NAME.test(n) || typeof value !== "number" || !Number.isFinite(value)) return `parameter ${String(n)} unusable`;
    params.push({ name: n, value });
  }
  return { name, vehicle: vehicle as SimProfile["vehicle"], frame, base: base as SimProfile["base"], spinner, span_m, rotors, params };
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "expected a multipart form");
  }
  const designText = form.get("design");
  const profileText = form.get("profile");
  const model = form.get("model");
  if (typeof designText !== "string" || typeof profileText !== "string" || !(model instanceof Blob)) return fail(400, "design, profile and model are required");
  if (model.size > MODEL_MAX_BYTES) return fail(413, "the model is too large");

  let designRaw: unknown;
  let profileRaw: unknown;
  try {
    designRaw = JSON.parse(designText);
    profileRaw = JSON.parse(profileText);
  } catch {
    return fail(400, "design or profile is not JSON");
  }
  const checked = validateDesign(designRaw, droneCatalog) as { ok: true; design: Design } | { ok: false; reason: string };
  if (!checked.ok) return fail(400, `design: ${checked.reason}`);
  const profile = readProfile(profileRaw);
  if (typeof profile === "string") return fail(400, profile);

  const bytes = new Uint8Array(await model.arrayBuffer());
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== "glTF") return fail(400, "the model is not a glTF binary");

  const id = newId();
  const design = { ...checked.design, id };
  await saveFlight(id, { design, profile, model: bytes });

  const origin = configuratorOrigin(request);
  try {
    const flown = await flyDesign(id, profile, { modelUrl: modelBookmarkUrl(origin, id, profile), openUrl: `${origin}/?sim=${id}` });
    return Response.json({ id, ...flown });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dronex sim]", message);
    return fail(502, message);
  }
}
