// POST /api/sim/fly: the configurator sends the drone on the pad (its design, its simulation profile and the
// packed 3D model); the server keeps them, starts the simulation in the engine and answers with the simulation
// UI's address for that vehicle. The browser then goes there.
import { droneCatalog } from "../../../../../prototype/drone-assembly/src/data/droneCatalog.js";
import { validateDesign } from "../../../../../prototype/drone-assembly/src/designs.js";
import { flyDesign, modelBookmarkUrl, type SimProfile } from "@/lib/sim/fly";
import { newId, saveFlight } from "@/lib/sim/store";
import { configuratorOrigin } from "@/lib/publicUrls";
import { reserveSim, SIM_FULL, type Slot } from "@/lib/sim/sims";
import { ownershipCookie } from "@/lib/ownership";
import { clientIp, limitRequest } from "@/lib/rateLimit";
import { requireSimulator } from "@/lib/mode";

// Exported models measured so far are 0.05 to 6.1 MB (Tarot X6, modified), but the CineLog25 and the VTBIRD VTOL
// have not been measured, so the 40 MB ceiling stays until they are (docs/DEPLOY.md item 32). Caddy caps the body
// at 42 MB in front of this.
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
  const off = requireSimulator();
  if (off) return off;
  const limited = limitRequest(request, "fly");
  if (limited) return limited;
  if (Number(request.headers.get("content-length") ?? 0) > MODEL_MAX_BYTES + 1024 * 1024) return fail(413, "the model is too large");
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

  let slot: Slot | null;
  try {
    // A browser's Fly is never an agent's, even on a laptop: one sim per visitor address, inside the cap.
    slot = await reserveSim({ ip: clientIp(request.headers), agent: false });
  } catch (e) {
    console.error("[dronex sim]", e instanceof Error ? e.message : String(e));
    return fail(502, "the simulation engine is not running");
  }
  if (!slot) return fail(503, SIM_FULL);

  const id = newId();
  const design = { ...checked.design, id };
  const origin = configuratorOrigin(request);
  try {
    await saveFlight(id, { design, profile, model: bytes });
    const flown = await flyDesign(id, profile, { modelUrl: modelBookmarkUrl(origin, id, profile), openUrl: `${origin}/?sim=${id}` });
    slot.commit(flown);
    return Response.json({ id, ...flown }, { headers: { "Set-Cookie": ownershipCookie(request, flown.vehicleId) } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dronex sim]", message);
    return fail(502, message);
  } finally {
    slot.release();
  }
}
