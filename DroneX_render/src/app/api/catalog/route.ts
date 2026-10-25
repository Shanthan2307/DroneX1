// GET /api/catalog: every hangar drone with its physics verdict, readiness and mission matrix, plus the mission
// list. The Fetch.ai fleet agents answer capability questions from this; the Dispatch review card shows these
// numbers. Same code path as the configurator's cards: dronePhysics.js over the dataset, nothing else.
import { catalogEntries, missions } from "@/lib/catalog/server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET() {
  return Response.json({ presets: catalogEntries(), missions: missions(), label: "every number is a dataset field or a named formula over dataset fields (dronePhysics.js); computed values are estimates" }, { headers: { ...CORS, "Cache-Control": "no-cache" } });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
