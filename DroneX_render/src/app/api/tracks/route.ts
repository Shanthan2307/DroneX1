// GET /api/tracks: the sponsor-technology registry (src/lib/tracks.ts) as JSON, with CORS for the simulation UI's
// origin (src/lib/cors.ts), so the simulation UI's "Built with" badge (another origin, a prebuilt bundle) shows the same list as the configurator's sidebar.
import { simCors, simPreflight } from "@/lib/cors";
import { TRACKS } from "@/lib/tracks";

export async function GET() {
  return Response.json({ tracks: TRACKS }, { headers: { ...simCors(), "Cache-Control": "no-cache" } });
}

export const OPTIONS = simPreflight;
