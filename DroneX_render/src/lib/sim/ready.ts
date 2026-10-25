// When ArduPilot will accept "arm": position known, GPS 3D fix with enough satellites, EKF good. One rule for the
// vehicles route (the Dispatch flight agent waits on it) and the track scenarios.
import type { Telemetry } from "@/lib/sim/tools";

export const isReady = (t: Telemetry): boolean => {
  if (t.latitudeDeg === null || t.longitudeDeg === null) return false;
  if (t.gpsSatellites !== null && t.gpsSatellites < 6) return false;
  if (t.gpsFix && /no|none|2d/i.test(t.gpsFix)) return false;
  return t.ekfStatus === null || /good/i.test(t.ekfStatus);
};
