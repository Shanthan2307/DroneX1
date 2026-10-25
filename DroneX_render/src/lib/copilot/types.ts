// Types shared by the copilot's server feed (feed.ts, the events route) and its browser panel. Plain data only.

export type Priority = "warning" | "status";

/** One thing the copilot says, derived in code from telemetry (callouts.ts). */
export interface Callout {
  id: string;
  vehicleId: string;
  vehicleName: string;
  kind: string;
  priority: Priority;
  /** Phrased for speech: rounded numbers, no coordinates, no abbreviations. */
  text: string;
  timeUs: number;
}

/** A vehicle's state as the copilot sees it: the vehicle record merged with its latest telemetry. */
export interface VehicleSnapshot {
  vehicleId: string;
  name: string;
  presence: "online" | "stale" | "offline";
  armed: boolean;
  mode: string;
  timeUs: number;
  altitudeAboveHomeM: number | null;
  altitudeAmslM: number | null;
  groundSpeedMps: number | null;
  headingDeg: number | null;
  batteryPct: number | null;
  batteryV: number | null;
  gpsFixType: number | null;
  gpsSatellites: number | null;
  ekfStatus: string | null;
  homeLatitudeDeg: number | null;
  homeLongitudeDeg: number | null;
  /** ArduPilot MISSION_CURRENT: the active item, and MISSION_STATE (3 = active). */
  missionCurrent: number | null;
  missionState: number | null;
}

export interface VehicleListed {
  id: string;
  name: string;
  presence: VehicleSnapshot["presence"];
  armed: boolean;
  mode: string;
  vehicleType: string;
}

/** What the events route streams, one JSON object per SSE message. */
export type FeedEvent =
  | { type: "hello"; vehicles: VehicleListed[]; snapshots: VehicleSnapshot[] }
  | { type: "vehicles"; vehicles: VehicleListed[] }
  | { type: "snapshot"; snapshot: VehicleSnapshot }
  | { type: "callout"; callout: Callout };
