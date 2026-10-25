// POST /api/verdict {build} or {presetId, swaps?}: the physics verdict of one build, its readiness against its
// mission and the whole mission matrix. The Dispatch agents use it to re-check a part swap before proposing it;
// the in-ASI:One review card is built from this answer. Code decides, never a model.
import { checkBuild, judge, type Build } from "@/lib/catalog/server";
import { dronePresetToBuild, getDronePreset } from "../../../../prototype/drone-assembly/src/data/droneCatalog.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const fail = (status: number, error: string) => Response.json({ error }, { status, headers: CORS });

export async function POST(request: Request) {
  let body: { build?: unknown; presetId?: string; swaps?: Partial<Build>; missionId?: string | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(400, "expected JSON");
  }
  let raw: unknown = body.build;
  if (!raw && body.presetId) {
    const preset = getDronePreset(body.presetId) as Record<string, unknown> | null;
    if (!preset) return fail(404, `no such preset: ${body.presetId}`);
    raw = { ...(dronePresetToBuild(preset) as Build), ...(body.swaps ?? {}), ...(body.missionId !== undefined ? { missionId: body.missionId } : {}) };
  }
  if (!raw) return fail(400, "build or presetId is required");
  const checked = checkBuild(raw);
  if (!checked.ok) return fail(400, `build: ${checked.reason}`);
  const { summary, readiness, missions, warnings } = judge(checked.build);
  return Response.json({ build: checked.build, summary, readiness, missions, warnings, label: "estimates from dronePhysics.js over dataset fields" }, { headers: CORS });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
