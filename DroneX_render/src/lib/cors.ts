// CORS for the two routes the simulation UI (another origin) fetches: a design's model.glb and /api/tracks. Every
// other route is same-origin only and sends no CORS headers. The allowed origin is DRONEX_SIM_UI_URL's origin; on
// a laptop without it, any origin (the simulator runs on a loopback port of its own). Server-only.

/** The simulation UI's origin, or "*" in development when DRONEX_SIM_UI_URL is unset, or null (no CORS). */
export function simOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const url = env.DRONEX_SIM_UI_URL?.trim();
  if (url) {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }
  return env.NODE_ENV === "production" ? null : "*";
}

/** Headers that let the simulation UI read a GET response. */
export function simCors(): Record<string, string> {
  const origin = simOrigin();
  if (!origin) return {};
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, OPTIONS", Vary: "Origin" };
}

export const simPreflight = (): Response => new Response(null, { status: 204, headers: simCors() });
