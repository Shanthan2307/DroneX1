// GET /api/sim/designs/<id>/model.glb: the packed 3D model of a design sent to the simulator. The simulation UI's
// map (another origin on this machine) fetches it, so it is served with open CORS.
import { connection } from "next/server";
import { readModel } from "@/lib/sim/store";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const model = await readModel(id);
  if (!model) return Response.json({ error: "no such model" }, { status: 404, headers: CORS });
  return new Response(new Uint8Array(model), {
    headers: { ...CORS, "Content-Type": "model/gltf-binary", "Content-Length": String(model.length), "Cache-Control": "no-cache" },
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
