// POST /api/airspace/corridor/<id>/release: give a granted corridor back.
import { connection } from "next/server";
import { releaseCorridor } from "@/lib/airspace/actions";
import { CORS } from "../../../route";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "corridor ids are integers" }, { status: 400, headers: CORS });
  try {
    const corridor = await releaseCorridor(Number(id));
    return Response.json({ corridor }, { headers: CORS });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 503, headers: CORS });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
