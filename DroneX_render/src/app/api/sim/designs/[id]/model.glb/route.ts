// GET /api/sim/designs/<id>/model.glb: the packed 3D model of a design sent to the simulator. The simulation UI's
// map (another origin) fetches it, so it carries CORS for the simulation UI's origin (src/lib/cors.ts).
import { connection } from "next/server";
import { simCors, simPreflight } from "@/lib/cors";
import { readModel } from "@/lib/sim/store";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const model = await readModel(id);
  if (!model) return Response.json({ error: "no such model" }, { status: 404, headers: simCors() });
  return new Response(new Uint8Array(model), {
    headers: { ...simCors(), "Content-Type": "model/gltf-binary", "Content-Length": String(model.length), "Cache-Control": "no-cache" },
  });
}

export const OPTIONS = simPreflight;
