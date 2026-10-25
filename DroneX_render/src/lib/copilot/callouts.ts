// The copilot's callouts: pure functions from one vehicle state to the next, the way a ground station or a
// second pilot would speak them. No model is involved; every line is a template over telemetry, so the same
// state always produces the same words, and the words are shaped for speech (numbers as words, no coordinates).
import type { Callout, Priority, VehicleSnapshot } from "./types";

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** An integer in words, for 0 to 9999; anything else falls back to digits. */
export function spokenNumber(n: number): string {
  const v = Math.round(n);
  if (!Number.isFinite(v) || v < 0 || v > 9999) return String(v);
  if (v < 20) return ONES[v];
  if (v < 100) return v % 10 === 0 ? TENS[Math.floor(v / 10)] : `${TENS[Math.floor(v / 10)]}-${ONES[v % 10]}`;
  if (v < 1000) {
    const rest = v % 100;
    return `${ONES[Math.floor(v / 100)]} hundred${rest ? ` ${spokenNumber(rest)}` : ""}`;
  }
  const rest = v % 1000;
  return `${spokenNumber(Math.floor(v / 1000))} thousand${rest ? ` ${spokenNumber(rest)}` : ""}`;
}

export const spokenPercent = (pct: number): string => `${spokenNumber(pct)} percent`;

export const spokenMetres = (m: number): string => {
  const v = Math.round(m);
  return `${spokenNumber(v)} ${v === 1 ? "metre" : "metres"}`;
};

const MODE_WORDS: Record<string, string> = {
  STABILIZE: "stabilize",
  ALT_HOLD: "altitude hold",
  LOITER: "loiter",
  POSHOLD: "position hold",
  GUIDED: "guided",
  AUTO: "auto mission",
  RTL: "return to launch",
  LAND: "landing",
  BRAKE: "brake",
  SMART_RTL: "smart return",
  CIRCLE: "circle",
  ACRO: "acro",
  QLOITER: "quad loiter",
  QHOVER: "quad hover",
  QLAND: "quad land",
  QRTL: "quad return",
  FBWA: "fly by wire A",
  CRUISE: "cruise",
  MANUAL: "manual",
};

/** A flight mode as a pilot would say it. */
export const spokenMode = (mode: string): string => MODE_WORDS[mode.toUpperCase()] ?? mode.toLowerCase().replace(/_/g, " ");

/** Battery levels that get a callout when crossed on the way down; 30 and below are warnings. */
export const BATTERY_THRESHOLDS = [50, 30, 20, 10] as const;
/** Heights above home that get a callout when passed on the way up. */
export const ALTITUDE_BANDS_M = [10, 20, 40, 60, 80, 100, 120] as const;
const GPS_MIN_SATELLITES = 6;
const GPS_MIN_FIX_TYPE = 3;
const MISSION_ACTIVE = 3;

let seq = 0;
const make = (v: VehicleSnapshot, kind: string, priority: Priority, text: string): Callout => ({
  id: `${v.vehicleId.slice(0, 8)}-${v.timeUs}-${kind}-${++seq}`,
  vehicleId: v.vehicleId,
  vehicleName: v.name,
  kind,
  priority,
  text,
  timeUs: v.timeUs,
});

const gpsDegraded = (v: VehicleSnapshot): boolean =>
  (v.gpsFixType !== null && v.gpsFixType < GPS_MIN_FIX_TYPE) || (v.gpsSatellites !== null && v.gpsSatellites < GPS_MIN_SATELLITES);

/** Whether a state carried telemetry at all; a vehicle record alone (before its first update) has none. */
const hadTelemetry = (v: VehicleSnapshot): boolean => v.batteryPct !== null || v.gpsSatellites !== null || v.ekfStatus !== null || v.altitudeAmslM !== null;

const movedM = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const k = 111_320;
  const dLat = (bLat - aLat) * k;
  const dLon = (bLon - aLon) * k * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
};

/**
 * What changed between two states of one vehicle, as callouts. The first state (no previous) says only that the
 * vehicle is online. Warnings: brake, low battery, GPS degraded, EKF not good. Everything else is status.
 */
export function deriveCallouts(prev: VehicleSnapshot | null, next: VehicleSnapshot): Callout[] {
  const out: Callout[] = [];
  if (!prev) {
    if (next.presence === "online") out.push(make(next, "online", "status", `${next.name} online, ${spokenMode(next.mode)}, ${next.armed ? "armed" : "disarmed"}`));
    return out;
  }
  if (prev.presence === "online" && next.presence !== "online") out.push(make(next, "offline", "warning", `${next.name} lost, no heartbeat`));
  if (prev.presence !== "online" && next.presence === "online") out.push(make(next, "online", "status", `${next.name} back online`));

  if (prev.armed !== next.armed) out.push(make(next, next.armed ? "armed" : "disarmed", "status", next.armed ? "motors armed" : "motors disarmed"));

  if (prev.mode !== next.mode) {
    const to = next.mode.toUpperCase();
    if (to === "BRAKE") out.push(make(next, "brake", "warning", "braking, stopping now"));
    else out.push(make(next, "mode", "status", `mode ${spokenMode(next.mode)}`));
  }

  if (prev.batteryPct !== null && next.batteryPct !== null) {
    for (const th of BATTERY_THRESHOLDS) {
      if (prev.batteryPct > th && next.batteryPct <= th) {
        const text = th <= 10 ? `battery ${spokenPercent(next.batteryPct)}, land now` : th <= 30 ? `battery ${spokenPercent(next.batteryPct)}, head home` : `battery ${spokenPercent(next.batteryPct)}`;
        out.push(make(next, `battery-${th}`, th <= 30 ? "warning" : "status", text));
      }
    }
  }

  const pa = prev.altitudeAboveHomeM;
  const na = next.altitudeAboveHomeM;
  if (pa !== null && na !== null) {
    if (pa < 1.5 && na >= 1.5 && next.armed) out.push(make(next, "airborne", "status", "airborne"));
    for (const band of ALTITUDE_BANDS_M) {
      if (pa < band && na >= band) out.push(make(next, `altitude-${band}`, "status", `passing ${spokenMetres(band)}`));
    }
    if (pa >= 10 && na < 10 && next.armed && (next.groundSpeedMps ?? 0) < 8) out.push(make(next, "descending-10", "status", "ten metres, descending"));
  }

  // Health and home: only once telemetry was already flowing, so the first update after the vehicle appears does
  // not announce "GPS good", "navigation good" and "home set" for a state that was simply unknown until then.
  const flowing = hadTelemetry(prev);

  if (flowing && gpsDegraded(prev) !== gpsDegraded(next)) {
    if (gpsDegraded(next)) {
      const sats = next.gpsSatellites !== null ? `, ${spokenNumber(next.gpsSatellites)} satellites` : "";
      out.push(make(next, "gps-degraded", "warning", `GPS degraded${sats}, hold position`));
    } else out.push(make(next, "gps-good", "status", "GPS good"));
  }

  if (flowing && prev.ekfStatus !== null && prev.ekfStatus !== next.ekfStatus && next.ekfStatus) {
    const good = /good/i.test(next.ekfStatus);
    out.push(make(next, good ? "ekf-good" : "ekf-bad", good ? "status" : "warning", good ? "navigation good" : `navigation ${next.ekfStatus.toLowerCase()}`));
  }

  const homeNow = next.homeLatitudeDeg !== null && next.homeLongitudeDeg !== null;
  const homeBefore = prev.homeLatitudeDeg !== null && prev.homeLongitudeDeg !== null;
  if (flowing && homeNow && (!homeBefore || movedM(prev.homeLatitudeDeg as number, prev.homeLongitudeDeg as number, next.homeLatitudeDeg as number, next.homeLongitudeDeg as number) > 1)) {
    out.push(make(next, "home-set", "status", "home set"));
  }

  if (next.missionCurrent !== null && prev.missionCurrent !== next.missionCurrent && next.missionState === MISSION_ACTIVE && next.missionCurrent > 0) {
    out.push(make(next, "mission-leg", "status", `mission leg ${spokenNumber(next.missionCurrent)}`));
  }
  return out;
}

/**
 * A warning the engine itself raised about a vehicle. The building guard's ("<name> stopped before hitting a
 * building", "...about 30 m tall...") becomes a building callout with the height in words; anything else is
 * spoken as written.
 */
export function calloutForNotification(v: VehicleSnapshot, title: string, body: string | null): Callout | null {
  const text = `${title}${body ? `. ${body}` : ""}`.trim();
  if (!text) return null;
  if (/building/i.test(text)) {
    const height = body?.match(/about\s+(\d+(?:\.\d+)?)\s*m\s+tall/i);
    const tall = height ? `, it is about ${spokenMetres(Number(height[1]))} tall` : "";
    return make(v, "building", "warning", `building ahead, braking${tall}. Fly away from it or climb above it`);
  }
  return make(v, "notice", "warning", text);
}
