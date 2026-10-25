// What the mirror hands to each sink. One normalised shape for every consumer (the SpacetimeDB airspace, the
// Elastic flight index, the copilot's callouts), derived from the daemon's `vehicle/list`, `telemetry/update` and
// their differences over time. SI units, degrees, metres, seconds.

export interface VehicleInfo {
  id: string;
  name: string;
  linkId: string;
  vehicleType: string;
  autopilot: string;
  firmware: string | null;
  presence: "online" | "stale" | "offline";
  armed: boolean;
  mode: string;
  /** The DroneX design behind it, from the "DroneX model" bookmark, when there is one. */
  designId: string | null;
  sizeCm: number | null;
  /** True when this is a simulated vehicle (a link the simulator started). */
  simulated: boolean;
}

export interface Fix {
  vehicleId: string;
  timeUs: number;
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeAmslM: number | null;
  altitudeAboveHomeM: number | null;
  altitudeAboveGroundM: number | null;
  headingDeg: number | null;
  groundSpeedMps: number | null;
  climbMps: number | null;
  /** A few named values picked out of the telemetry items, when present. */
  batteryPct: number | null;
  batteryV: number | null;
  gpsSatellites: number | null;
  gpsFixType: number | null;
  gpsHdop: number | null;
  ekfVariance: number | null;
  ekfStatus: string | null;
}

export type FlightEvent =
  | { type: "vehicle-online"; vehicleId: string; timeUs: number; vehicle: VehicleInfo }
  | { type: "vehicle-offline"; vehicleId: string; timeUs: number }
  | { type: "armed"; vehicleId: string; timeUs: number; armed: boolean }
  | { type: "mode"; vehicleId: string; timeUs: number; from: string; to: string }
  | { type: "home-set"; vehicleId: string; timeUs: number; latitudeDeg: number; longitudeDeg: number }
  | { type: "battery-threshold"; vehicleId: string; timeUs: number; pct: number; threshold: number }
  | { type: "gps-quality"; vehicleId: string; timeUs: number; satellites: number | null; fixType: number | null; degraded: boolean }
  | { type: "ekf"; vehicleId: string; timeUs: number; status: string; variance: number | null };

export interface Sink {
  name: string;
  start?(): Promise<void>;
  onVehicle?(v: VehicleInfo): Promise<void> | void;
  onFix?(f: Fix, v: VehicleInfo): Promise<void> | void;
  onEvent?(e: FlightEvent, v: VehicleInfo | null): Promise<void> | void;
  /** Called every second; sinks that batch (Elastic) write here. */
  flush?(): Promise<void> | void;
  stop?(): Promise<void> | void;
}
