// GET /api/tracks: the sponsor-technology registry (src/lib/tracks.ts) as JSON, with open CORS, so the simulation
// UI's "Built with" badge (another origin, a prebuilt bundle) shows the same list as the configurator's sidebar.
import { TRACKS } from "@/lib/tracks";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET() {
  return Response.json({ tracks: TRACKS }, { headers: { ...CORS, "Cache-Control": "no-cache" } });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
