// GET /api/scenarios: the track scenarios (src/lib/scenarios/catalog.ts), for the Scenarios page.
import { SCENARIOS } from "@/lib/scenarios/catalog";

export function GET() {
  return Response.json({ scenarios: SCENARIOS });
}
