// The track scenarios: one short story per sponsor technology, each a real mission in the simulator (its plans
// go into the simulator's plan library, named "DroneX · <track> · …") plus the steps that make the technology do
// its work in front of you. Data only; src/lib/scenarios/run.ts runs them.
//
// Places are real San Francisco coordinates; heights are metres above home. The drones are hangar designs that
// have been sent to the simulator once (Fly in simulation), so they can be started again from the store.

export type TrackId = "spacetime" | "elastic" | "cartesia" | "fetchai";

export interface LatLon {
  lat: number;
  lon: number;
}

export interface ScenarioDrone {
  /** Which role it plays in the story. */
  role: string;
  /** The hangar preset whose stored design flies. */
  presetId: string;
  /** Who flies it, as the shared airspace records it. */
  operator: string;
  start: LatLon & { headingDeg: number };
  /** The mission: waypoints flown in Auto after a guided take-off, then a return to launch. */
  route: LatLon[];
  altitudeM: number;
  /** The simulator plan's name. */
  planName: string;
}

export interface Scenario {
  id: string;
  track: TrackId;
  trackName: string;
  title: string;
  /** One line: what happens. */
  summary: string;
  /** Why someone who builds this technology should care; what it shows that nothing else would. */
  whyItMatters: string;
  /** What to watch, and where. */
  watch: string[];
  drones: ScenarioDrone[];
  /** Roughly how long it runs. */
  minutes: number;
}

export const PLACES = {
  ucsfMissionBay: { lat: 37.7679, lon: -122.3895 },
  oraclePark: { lat: 37.7776, lon: -122.3893 },
  pier40: { lat: 37.7792, lon: -122.3862 },
  ferryBuilding: { lat: 37.7956, lon: -122.3925 },
  pier7: { lat: 37.7997, lon: -122.3973 },
  pier27: { lat: 37.8057, lon: -122.4022 },
} as const;

export const SCENARIOS: Scenario[] = [
  {
    id: "spacetime-two-operators",
    track: "spacetime",
    trackName: "SpacetimeDB",
    title: "Two operators, one sky",
    summary:
      "A hospital courier and a survey hexacopter from two different operators ask for corridors that cross over Mission Bay at the same height. The airspace refuses the second, it asks again higher, is granted, and both fly.",
    whyItMatters:
      "When two operators share a sky, \"check if the corridor is free, then take it\" is a race. In DroneX the rule lives in a SpacetimeDB reducer next to the corridor table: the grant or the refusal happens atomically inside the database, and every client (the airspace map, the agents, the mirror) sees the answer in the same frame through its subscription. No API server in between, no lock service, no stale cache.",
    watch: [
      "The airspace map on /copilot: corridor #A appears granted, #B flashes refused with the reducer's reason, then #B reappears granted in the higher band.",
      "The simulator's 3D map: the courier passes under the hexacopter where the corridors cross.",
    ],
    drones: [
      {
        role: "Courier (UCSF Mission Bay to Oracle Park)",
        presetId: "apex-5-medical-courier",
        operator: "UCSF courier ops",
        start: { ...PLACES.ucsfMissionBay, headingDeg: 0 },
        route: [PLACES.oraclePark],
        // Above the 59 m building on the way and the ballpark's light towers (the building guard stops anything lower).
        altitudeM: 85,
        planName: "DroneX · SpacetimeDB · Courier corridor, Mission Bay → Oracle Park",
      },
      {
        role: "Survey hexacopter crossing east to west",
        presetId: "tarot-x6-mapping",
        operator: "Bay Survey Co",
        // Bayfront Park: open ground, so the take-off and the landing are clear of buildings.
        start: { lat: 37.7705, lon: -122.3863, headingDeg: 270 },
        route: [{ lat: 37.7705, lon: -122.3958 }],
        altitudeM: 120,
        planName: "DroneX · SpacetimeDB · Survey crossing at 120 m",
      },
    ],
    minutes: 4,
  },
  {
    id: "elastic-find-the-signal",
    track: "elastic",
    trackName: "Elastic",
    title: "After the flight, find the signal",
    summary:
      "The medical courier flies Mission Bay → Pier 40 and back. Then Elastic answers three questions about that flight from three kinds of data in one cluster: what the telemetry did, what the configurator predicted, and what ArduPilot's manual says to change.",
    whyItMatters:
      "A drone program produces three silos: design verdicts, flight telemetry and the autopilot's 5,800-parameter manual. DroneX puts all three in Elastic: ES|QL aggregates the flight's time series and joins it to the verdict the configurator computed, and semantic_text with Jina embeddings (jina-embeddings-v5-text-small, measured best of six setups on this data) finds the right ArduPilot parameter from a plain-language question, in any language.",
    watch: [
      "The report at the end of the run: battery used per minute against the configurator's endurance estimate, the mode timeline, and the parameters the manual search returned.",
      "Kibana: the dronex-telemetry and dronex-events indices for this flight's vehicle.",
    ],
    drones: [
      {
        role: "Courier run",
        presetId: "apex-5-medical-courier",
        operator: "UCSF courier ops",
        start: { ...PLACES.ucsfMissionBay, headingDeg: 0 },
        route: [PLACES.pier40],
        altitudeM: 70,
        planName: "DroneX · Elastic · Courier run, Mission Bay → Pier 40 and back",
      },
    ],
    minutes: 4,
  },
  {
    id: "cartesia-hands-on-the-sticks",
    track: "cartesia",
    trackName: "Cartesia",
    title: "Hands on the sticks, eyes on the aircraft",
    summary:
      "A waterfront patrol along the Embarcadero flown entirely by voice: each command is spoken by Sonic, heard by Ink, acted on by the copilot, and the copilot's callouts (arming, altitude, battery) are spoken back as they happen.",
    whyItMatters:
      "A pilot's hands are on the sticks and their eyes are on the aircraft; a screen is the wrong interface at that moment. Voice is only usable there if it is fast and interruptible: Ink streams the words as they are said, Sonic starts speaking in a fraction of a second, and a warning cuts in over a status line (barge-in). Every command here is real audio through both models, not text pretending to be speech.",
    watch: [
      "This page: each command plays as audio, then what Ink heard, then what the copilot did, then the callouts as they fire.",
      "The simulator's 3D map: the patrol from the Ferry Building past Pier 7 to Pier 27.",
    ],
    drones: [
      {
        role: "Waterfront patrol",
        // The hangar's long-endurance quad (about 19 min of mixed flying, est.): a patrol needs the time.
        presetId: "chimera7-longrange",
        operator: "Port of SF patrol",
        start: { ...PLACES.ferryBuilding, headingDeg: 320 },
        route: [PLACES.pier7, PLACES.pier27],
        altitudeM: 40,
        planName: "DroneX · Cartesia · Voice patrol, Ferry Building → Pier 27",
      },
    ],
    minutes: 4,
  },
  {
    id: "fetchai-clinic-asks",
    track: "fetchai",
    trackName: "Fetch.ai",
    title: "A clinic asks, the fleet answers",
    summary:
      "A request in plain words goes to DroneX Dispatch through its Agentverse mailbox, exactly the path ASI:One uses. The dispatcher asks the eight fleet agents, the physics picks the drone that passes, and on approval the flight agent starts it, waits for GPS, reserves a corridor and flies.",
    whyItMatters:
      "Agents are only interesting when they do real work. Here a sentence becomes a physics-checked, airspace-cleared flight: the fleet agents answer from their own verdicts, the flight agent owns the simulator, they talk over uAgents protocols, and the whole thing is discoverable on Agentverse and ASI:One with Interactive Cards. With payments on, the flight is paid in testnet FET and checked on chain before take-off.",
    watch: [
      "This page: the conversation as the agents send it, cards included.",
      "/dispatch: the agents and their Agentverse listing. The simulator: the dispatched drone taking off.",
    ],
    drones: [],
    minutes: 3,
  },
];

export const scenarioById = (id: string): Scenario | undefined => SCENARIOS.find((s) => s.id === id);
