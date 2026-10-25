// The sponsor technologies DroneX is built on, and exactly where each one does its work. One registry, read by
// the configurator's "Built with" sidebar (src/components/tracks/TracksPanel.tsx), the simulation UI's badge
// (served as JSON by /api/tracks, since that UI is another origin) and the docs. Keep it honest: a line here means
// the code path exists and runs in the demo.

export type TrackId = "spacetime" | "elastic" | "fetchai" | "cartesia";

export type Surface = "configurator" | "simulator" | "agents" | "live";

export interface TrackUse {
  /** Which screen or process the use lives in. */
  surface: Surface;
  /** What the technology does there, in one sentence. */
  what: string;
  /** The file or folder that implements it, for a judge who wants to look. */
  where: string;
}

export interface Track {
  id: TrackId;
  name: string;
  /** The sponsor's own one-line description of the product. */
  product: string;
  /** Short label for the sidebar chip. */
  chip: string;
  /** Accent colour for the chip (CSS colour). */
  color: string;
  role: string;
  uses: TrackUse[];
  docs: string;
}

export const TRACKS: Track[] = [
  {
    id: "spacetime",
    name: "SpacetimeDB",
    product: "A database with the application logic inside it: tables, transactional reducers, live subscriptions.",
    chip: "Spacetime",
    color: "#7c5cff",
    role: "The shared, persistent airspace: every operator's vehicles, missions, corridors and incidents in one live world, with the rules enforced next to the data.",
    uses: [
      { surface: "live", what: "The mirror publishes every simulated vehicle's position, mode and battery into the airspace tables through reducers.", where: "DroneX_live/src/sinks/spacetime.ts" },
      { surface: "live", what: "Corridor reservations: a mission leg asks for a corridor and altitude band; the reducer grants it or refuses an overlap atomically.", where: "DroneX_live/spacetime/src/lib.rs" },
      { surface: "configurator", what: "The airspace view on the Copilot page subscribes to the tables and draws every drone and reserved corridor live.", where: "DroneX_render/src/components/airspace/AirspaceView.tsx" },
      { surface: "agents", what: "The Dispatch agents coordinate through the same tables: who holds which mission, which corridor is free.", where: "DroneX_agents/dronex_agents/airspace.py" },
    ],
    docs: "https://spacetimedb.com/docs",
  },
  {
    id: "elastic",
    name: "Elastic",
    product: "Elastic Cloud Serverless with semantic_text, Agent Builder and Workflows.",
    chip: "Elastic",
    color: "#f04e98",
    role: "Search and analytics over the flight data the product produces: telemetry, events and verdicts across every simulated flight, plus the ArduPilot manual and the catalog notes in a semantic field.",
    uses: [
      { surface: "live", what: "The mirror bulk-indexes telemetry, mode changes, GPS and EKF health, building-avoidance brakes and mission legs per flight.", where: "DroneX_live/src/sinks/elastic.ts" },
      { surface: "live", what: "ArduPilot's parameter documentation and the catalog's datasheet notes are indexed into semantic_text for grounded answers.", where: "DroneX_live/src/elastic/setup.ts" },
      { surface: "simulator", what: "An Agent Builder agent answers 'why did the courier drift on leg 3' with ES|QL over the flight's EKF and GPS fields.", where: "DroneX_live/elastic/agent.md" },
      { surface: "configurator", what: "The mission card shows fleet statistics from indexed verdicts: how many simulated runs of this design passed and why the rest failed.", where: "DroneX_render/src/app/api/analytics/route.ts" },
    ],
    docs: "https://www.elastic.co/docs",
  },
  {
    id: "fetchai",
    name: "Fetch.ai / ASI:One",
    product: "uAgents on Agentverse, discoverable in ASI:One through the Agent Chat Protocol, with Interactive Cards.",
    chip: "Fetch.ai",
    color: "#2bb7a0",
    role: "DroneX Dispatch: a sentence in ASI:One becomes a verified, flying vehicle. A dispatcher orchestrates fleet agents (one per hangar drone) and a flight agent that owns the simulation engine.",
    uses: [
      { surface: "agents", what: "The Dispatcher parses intent, asks for missing facts with a form card, shows candidates in a carousel, the physics verdict in a review card.", where: "DroneX_agents/dronex_agents/dispatcher.py" },
      { surface: "agents", what: "Fleet agents answer capability queries from the physics verdict and mission matrix served by the configurator.", where: "DroneX_agents/dronex_agents/fleet.py" },
      { surface: "agents", what: "The flight agent starts the design in the simulator, waits for GPS and EKF, takes off, reserves a corridor in the shared airspace and flies to the place, through the engine's tools directly.", where: "DroneX_agents/dronex_agents/flight.py" },
      { surface: "agents", what: "Agent Payment Protocol: the flight agent quotes each simulated flight, the dispatcher pays in testnet FET and the flight agent checks the transaction on chain before it flies.", where: "DroneX_agents/dronex_agents/payment.py" },
      { surface: "configurator", what: "The catalog, verdict, refly and vehicle routes exist for the agents: the same numbers the configurator shows, as JSON.", where: "DroneX_render/src/app/api/sim/vehicles/[id]/route.ts" },
      { surface: "configurator", what: "The Dispatch page shows the agents, their addresses, whether ASI:One can reach the dispatcher, and sentences to try.", where: "DroneX_render/src/app/dispatch/page.tsx" },
    ],
    docs: "https://uagents.fetch.ai/docs",
  },
  {
    id: "cartesia",
    name: "Cartesia",
    product: "Sonic streaming text-to-speech and Ink streaming speech-to-text.",
    chip: "Cartesia",
    color: "#ff8a3d",
    role: "The voice copilot: hands on the controls, eyes on the aircraft. Spoken commands in through Ink, callouts and warnings out through Sonic.",
    uses: [
      { surface: "configurator", what: "The Copilot page streams the microphone to Ink and speaks replies and callouts with Sonic, with barge-in.", where: "DroneX_render/src/components/copilot/VoiceCopilot.tsx" },
      { surface: "configurator", what: "Deterministic callouts from live telemetry: battery and altitude thresholds, mode changes, GPS and EKF health, building ahead, mission leg.", where: "DroneX_render/src/app/api/copilot/events/route.ts" },
      { surface: "simulator", what: "Spoken commands become the same Core RPC tool calls the typed assistant makes: arm, take off, go to a place, change mode, return.", where: "DroneX_render/src/lib/sim/tools.ts" },
    ],
    docs: "https://docs.cartesia.ai",
  },
];

export const trackById = (id: TrackId): Track => {
  const t = TRACKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown track ${id}`);
  return t;
};

/** The uses on one surface, for a sidebar that only lists what is on this screen. */
export const usesOn = (surface: Surface): { track: Track; use: TrackUse }[] =>
  TRACKS.flatMap((track) => track.uses.filter((u) => u.surface === surface).map((use) => ({ track, use })));
