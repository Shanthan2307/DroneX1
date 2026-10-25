// GET /api/analytics?design=<stored design id or preset id> or ?airframeId=&motorId=&propellerId=&batteryId=&payloadId=
// [&missionId=]: fleet statistics for a design from the flight indices in Elastic (written by DroneX_live): how
// many simulated runs, how many clean, the anomalies seen, the last flight. 503 with a plain message when
// Elastic is not configured, so the mission card simply does not show the line.
import { elasticEnv, fleetStats, type Build } from "@/lib/analytics/elastic";
import { limitRequest } from "@/lib/rateLimit";

export async function GET(request: Request) {
  const limited = limitRequest(request, "analytics");
  if (limited) return limited;
  const env = elasticEnv();
  if (!env) return Response.json({ available: false, error: "Elastic is not configured (ELASTIC_URL, ELASTIC_API_KEY)" }, { status: 503 });
  const q = new URL(request.url).searchParams;
  const design = q.get("design");
  const part = (k: keyof Build) => q.get(k);
  const build: Build | null = q.get("airframeId") ? { airframeId: part("airframeId"), motorId: part("motorId"), propellerId: part("propellerId"), batteryId: part("batteryId"), payloadId: part("payloadId") } : null;
  if (!design && !build) return Response.json({ available: false, error: "design or the five part ids are required" }, { status: 400 });
  try {
    const stats = await fleetStats(env, { designId: design, build, missionId: q.get("missionId") });
    return Response.json({ available: true, source: "Elastic", ...stats }, { headers: { "Cache-Control": "no-cache" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ available: false, error: message }, { status: 503 });
  }
}
