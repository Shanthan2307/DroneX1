// Who may call the agent-only routes: the Dispatch agents (DroneX_agents) send `x-dronex-agent: <token>` with the
// token from DRONEX_AGENT_TOKEN. A valid token also skips the per-IP rate limits and the per-visitor ownership
// checks (the agents act for their own sessions and are bound to a vehicle elsewhere). Without DRONEX_AGENT_TOKEN
// every caller counts as an agent in development (the laptop setup keeps working) and none does in production.
// Server-only.
import { createHash, timingSafeEqual } from "node:crypto";

export const AGENT_HEADER = "x-dronex-agent";

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Pure check: `given` against `expected`, constant-time; no expected token means "development only". */
export function agentTokenValid(given: string | null, expected: string | undefined, development: boolean): boolean {
  if (!expected) return development;
  if (!given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

const isDevelopment = (): boolean => process.env.NODE_ENV !== "production";

/** True when the request carries the agent token (or no token is configured and this is development). */
export function isAgent(request: Request): boolean {
  return agentTokenValid(request.headers.get(AGENT_HEADER), process.env.DRONEX_AGENT_TOKEN?.trim() || undefined, isDevelopment());
}

/** For agent-only routes: null when allowed, else the 403 to return. */
export function requireAgent(request: Request): Response | null {
  return isAgent(request) ? null : Response.json({ error: "this route is for the DroneX agents only" }, { status: 403 });
}
