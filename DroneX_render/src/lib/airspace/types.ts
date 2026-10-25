// The shared airspace as plain JSON, for the /api/airspace routes (the Dispatch agents) and the browser view.
// Mirrors the SpacetimeDB module's tables (DroneX_live/spacetime/src/lib.rs); bigint columns become numbers.

export interface AirVehicle {
  id: string;
  name: string;
  designId: string | null;
  vehicleType: string;
  operator: string;
  presence: "online" | "stale" | "offline" | string;
  armed: boolean;
  mode: string;
  sizeCm: number | null;
  updatedAtUs: number;
}

export interface AirPosition {
  vehicleId: string;
  lat: number;
  lon: number;
  altAmslM: number | null;
  altHomeM: number | null;
  headingDeg: number | null;
  speedMps: number | null;
  batteryPct: number | null;
  gpsSats: number | null;
  ekfStatus: string | null;
  timeUs: number;
  seenAtUs: number;
}

export type CorridorStatus = "granted" | "refused" | "released" | "expired";

export interface AirCorridor {
  id: number;
  requestId: string;
  vehicleId: string;
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  minAltM: number;
  maxAltM: number;
  widthM: number;
  status: CorridorStatus | string;
  requestedAtUs: number;
  expiresAtUs: number;
  reason: string;
}

export interface AirIncident {
  id: number;
  vehicleId: string;
  kind: string;
  detail: string;
  lat: number;
  lon: number;
  timeUs: number;
}

export interface AirMission {
  vehicleId: string;
  missionId: string;
  agent: string;
  status: string;
  updatedAtUs: number;
}

export interface AirspaceSnapshot {
  vehicles: AirVehicle[];
  positions: AirPosition[];
  corridors: AirCorridor[];
  incidents: AirIncident[];
  missions: AirMission[];
  /** Where the snapshot came from. */
  database: string;
}

export interface CorridorRequest {
  vehicleId: string;
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  minAltM: number;
  maxAltM: number;
  widthM?: number;
  ttlS?: number;
  /** Optional caller id; one is made when absent. */
  requestId?: string;
}

export interface MissionRequest {
  vehicleId: string;
  missionId: string;
  agent: string;
  status?: string;
}
