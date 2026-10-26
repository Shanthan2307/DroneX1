// GET /api/airspace: a snapshot of the shared airspace (SpacetimeDB): every vehicle, its latest position, the
// corridors (granted, refused, released, expired), incidents and mission assignments. For the Dispatch agents and
// anything else that reads JSON rather than subscribing. Same-origin only; rate-limited per visitor.
import { connection } from "next/server";
import { withAirspace } from "@/lib/airspace/server";
import { limitRequest } from "@/lib/rateLimit";
import { requireSimulator } from "@/lib/mode";

export async function GET(request: Request) {
  await connection();
  const off = requireSimulator();
  if (off) return off;
  const limited = limitRequest(request, "airspaceRead");
  if (limited) return limited;
  try {
    const snapshot = await withAirspace(async (air) => air.snapshot());
    return Response.json(snapshot, { headers: { "Cache-Control": "no-cache" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 503 });
  }
}
