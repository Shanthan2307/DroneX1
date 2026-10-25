// GET /api/dispatch: where DroneX Dispatch (the Fetch.ai agents, DroneX_agents) stands, for the /dispatch page.
// Reads the status file the dispatcher writes on start (addresses, ports, mailbox, payments), probes each agent's
// local port, asks the simulation engine whether it is up, and asks Agentverse what it has listed for the
// dispatcher (the Almanac entry and the search index ASI:One discovers agents from). Nothing here is a secret.
// The answer is cached for 30 s (every open /dispatch page shares it) and the route is rate-limited per visitor.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { connection } from "next/server";
import { readDaemon } from "@/lib/sim/core";
import type { DispatchStatus, DispatchAgentsFile } from "@/lib/dispatch/types";
import { limitRequest } from "@/lib/rateLimit";

const CACHE_MS = 30_000;
const g = globalThis as unknown as { __dronexDispatch?: { at: number; value: Promise<DispatchStatus> } };

const agentsDir = (): string => process.env.DRONEX_AGENTS_DIR ?? path.resolve(process.cwd(), "../DroneX_agents");

async function readAgents(): Promise<DispatchAgentsFile | null> {
  try {
    return JSON.parse(await readFile(path.join(agentsDir(), "logs", "agents.json"), "utf8")) as DispatchAgentsFile;
  } catch {
    return null;
  }
}

/** Any HTTP answer on the port means the agent process is up (the fleet Bureau and the flight agent 404 on /agent_info). */
async function up(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/agent_info`, { signal: AbortSignal.timeout(1500), cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(5000), cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

type AlmanacEntry = { status?: string; type?: string; endpoints?: { url: string }[] };
type SearchHit = { address: string; name?: string; description?: string; readme?: string; handle?: string | null; total_interactions?: number };

export async function GET(request: Request) {
  await connection();
  const limited = limitRequest(request, "dispatch");
  if (limited) return limited;
  const cached = g.__dronexDispatch;
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const value = status();
    g.__dronexDispatch = { at: Date.now(), value };
    value.catch(() => (g.__dronexDispatch = undefined));
  }
  return Response.json(await g.__dronexDispatch!.value, { headers: { "Cache-Control": "public, max-age=30" } });
}

async function status(): Promise<DispatchStatus> {
  const agents = await readAgents();
  const simulator = await readDaemon().then(
    () => true,
    () => false,
  );
  const out: DispatchStatus = { public: Boolean(process.env.DRONEX_PUBLIC_URL?.trim()), agents, live: { dispatcher: false, flight: false, fleet: false }, simulator, almanac: null, listing: null };
  if (!agents) return out;
  const address = agents.dispatcher.address;
  const [dispatcher, flight, fleet, almanac, search] = await Promise.all([
    up(agents.dispatcher.port),
    up(agents.flight.port),
    up(agents.fleet.port),
    json<AlmanacEntry>(`https://agentverse.ai/v1/almanac/agents/${address}`),
    json<{ agents?: SearchHit[] }>("https://agentverse.ai/v1/search/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ search_text: address, limit: 1 }),
    }),
  ]);
  out.live = { dispatcher, flight, fleet };
  if (almanac) out.almanac = { status: almanac.status ?? "unknown", type: almanac.type ?? "unknown", endpoint: almanac.endpoints?.[0]?.url ?? null };
  const hit = search?.agents?.find((a) => a.address === address);
  if (hit) out.listing = { name: hit.name ?? "", hasReadme: Boolean(hit.readme), handle: hit.handle ?? null, interactions: hit.total_interactions ?? 0 };
  return out;
}
