// GET /api/sim/designs: every design in the store (sent to the simulator at least once), newest first, with its
// profile. The Dispatch flight agent picks the stored design that matches the hangar drone it was asked to fly.
import { connection } from "next/server";
import { listFlights } from "@/lib/sim/store";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET() {
  await connection();
  return Response.json({ designs: await listFlights() }, { headers: { ...CORS, "Cache-Control": "no-cache" } });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
