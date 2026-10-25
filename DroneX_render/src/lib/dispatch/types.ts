// The /api/dispatch payload: DroneX Dispatch (DroneX_agents) as the /dispatch page shows it.

/** DroneX_agents/logs/agents.json, written by the dispatcher on start. */
export interface DispatchAgentsFile {
  startedAt: string;
  dispatcher: { name: string; handle: string; address: string; port: number; mailbox: boolean };
  flight: { address: string; port: number; payments: boolean; ledger: boolean; priceFet: string };
  fleet: { port: number; agents: Record<string, string> };
  model: string | null;
}

export interface DispatchStatus {
  /** Served on the public site (DRONEX_PUBLIC_URL set): the page hides operator hints (scripts, ports). */
  public: boolean;
  agents: DispatchAgentsFile | null;
  /** The agent processes answering on their local ports. */
  live: { dispatcher: boolean; flight: boolean; fleet: boolean };
  /** The simulation engine's daemon is up. */
  simulator: boolean;
  /** The dispatcher's Almanac entry: type "mailbox" with the Agentverse endpoint is what ASI:One can reach. */
  almanac: { status: string; type: string; endpoint: string | null } | null;
  /** The dispatcher in Agentverse's search index (what ASI:One discovers from); empty name: not connected yet. */
  listing: { name: string; hasReadme: boolean; handle: string | null; interactions: number } | null;
}
