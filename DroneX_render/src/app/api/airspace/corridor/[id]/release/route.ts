// POST /api/airspace/corridor/<id>/release: give a granted corridor back. A visitor may release only a corridor
// held by a vehicle in their ownership cookie; the agents (x-dronex-agent) any.
import { connection } from "next/server";
import { mayActOn } from "@/lib/ownership";
import { limitRequest } from "@/lib/rateLimit";
import { toCorridor, waitFor } from "@/lib/airspace/client";
import { withAirspace } from "@/lib/airspace/server";

class NotYours extends Error {}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const limited = limitRequest(request, "airspaceWrite");
  if (limited) return limited;
  const { id } = await params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "corridor ids are integers" }, { status: 400 });
  try {
    const corridor = await withAirspace(async (air) => {
      const held = [...air.conn.db.corridor.iter()].find((c) => c.id === BigInt(id));
      if (!held) throw new Error("no such corridor");
      if (!mayActOn(request, held.vehicleId)) throw new NotYours("not your vehicle's corridor");
      await air.conn.reducers.releaseCorridor({ id: BigInt(id) });
      const row = await waitFor(
        () => [...air.conn.db.corridor.iter()].find((c) => c.id === BigInt(id)),
        (c) => c.status !== "granted",
      );
      return toCorridor(row);
    });
    return Response.json({ corridor });
  } catch (e) {
    if (e instanceof NotYours) return Response.json({ error: e.message }, { status: 403 });
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 503 });
  }
}
