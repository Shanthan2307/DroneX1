// The copilot's callouts are code, not a model: the same change in telemetry always produces the same words,
// phrased for speech.
import { describe, expect, it } from "vitest";
import { BATTERY_THRESHOLDS, calloutForNotification, deriveCallouts, spokenMetres, spokenMode, spokenNumber, spokenPercent } from "./callouts";
import type { VehicleSnapshot } from "./types";

const base: VehicleSnapshot = {
  vehicleId: "4c3a6a47-d200-5d83-8470-f50b2f6076fb",
  name: "Apex 5 freestyle quad",
  presence: "online",
  armed: false,
  mode: "STABILIZE",
  timeUs: 1_000_000,
  altitudeAboveHomeM: 0,
  altitudeAmslM: 0.1,
  groundSpeedMps: 0,
  headingDeg: 20,
  batteryPct: 100,
  batteryV: 12.6,
  gpsFixType: 6,
  gpsSatellites: 10,
  ekfStatus: "Good",
  homeLatitudeDeg: 37.7609749,
  homeLongitudeDeg: -122.386761,
  missionCurrent: 0,
  missionState: 1,
};
const at = (patch: Partial<VehicleSnapshot>): VehicleSnapshot => ({ ...base, ...patch, timeUs: base.timeUs + 1 });
const texts = (prev: VehicleSnapshot | null, next: VehicleSnapshot) => deriveCallouts(prev, next).map((c) => `${c.priority}: ${c.text}`);

describe("numbers for speech", () => {
  it("says integers in words", () => {
    expect(spokenNumber(0)).toBe("zero");
    expect(spokenNumber(7)).toBe("seven");
    expect(spokenNumber(15)).toBe("fifteen");
    expect(spokenNumber(20)).toBe("twenty");
    expect(spokenNumber(37.6)).toBe("thirty-eight");
    expect(spokenNumber(120)).toBe("one hundred twenty");
    expect(spokenNumber(1200)).toBe("one thousand two hundred");
    expect(spokenNumber(12345)).toBe("12345");
  });
  it("rounds percentages and metres", () => {
    expect(spokenPercent(29.6)).toBe("thirty percent");
    expect(spokenMetres(1)).toBe("one metre");
    expect(spokenMetres(39.5)).toBe("forty metres");
  });
  it("speaks modes as a pilot would", () => {
    expect(spokenMode("ALT_HOLD")).toBe("altitude hold");
    expect(spokenMode("RTL")).toBe("return to launch");
    expect(spokenMode("SOME_NEW_MODE")).toBe("some new mode");
  });
});

describe("callouts", () => {
  it("announces a vehicle the first time it is seen, and nothing else", () => {
    expect(texts(null, base)).toEqual(["status: Apex 5 freestyle quad online, stabilize, disarmed"]);
  });

  it("says nothing when nothing changed", () => {
    expect(texts(base, at({}))).toEqual([]);
  });

  it("calls arming, mode changes, and brake as a warning", () => {
    expect(texts(base, at({ armed: true }))).toEqual(["status: motors armed"]);
    expect(texts(base, at({ mode: "GUIDED" }))).toEqual(["status: mode guided"]);
    expect(texts(at({ mode: "GUIDED" }), at({ mode: "BRAKE" }))).toEqual(["warning: braking, stopping now"]);
  });

  it("calls each battery threshold once, on the way down, with the right urgency", () => {
    expect(BATTERY_THRESHOLDS).toEqual([50, 30, 20, 10]);
    expect(texts(at({ batteryPct: 51 }), at({ batteryPct: 49.6 }))).toEqual(["status: battery fifty percent"]);
    expect(texts(at({ batteryPct: 31 }), at({ batteryPct: 29 }))).toEqual(["warning: battery twenty-nine percent, head home"]);
    expect(texts(at({ batteryPct: 11 }), at({ batteryPct: 9 }))).toEqual(["warning: battery nine percent, land now"]);
    expect(texts(at({ batteryPct: 29 }), at({ batteryPct: 28 }))).toEqual([]);
    expect(texts(at({ batteryPct: 28 }), at({ batteryPct: 31 }))).toEqual([]);
    // a big drop crosses several thresholds at once, each said
    expect(texts(at({ batteryPct: 55 }), at({ batteryPct: 25 }))).toEqual(["status: battery twenty-five percent", "warning: battery twenty-five percent, head home"]);
  });

  it("calls altitude bands on the way up and airborne after takeoff", () => {
    expect(texts(at({ armed: true, altitudeAboveHomeM: 0.4 }), at({ armed: true, altitudeAboveHomeM: 2.2 }))).toEqual(["status: airborne"]);
    expect(texts(at({ armed: true, altitudeAboveHomeM: 9 }), at({ armed: true, altitudeAboveHomeM: 21 }))).toEqual(["status: passing ten metres", "status: passing twenty metres"]);
    expect(texts(at({ armed: true, altitudeAboveHomeM: 21 }), at({ armed: true, altitudeAboveHomeM: 25 }))).toEqual([]);
    expect(texts(at({ armed: true, altitudeAboveHomeM: 12, groundSpeedMps: 1 }), at({ armed: true, altitudeAboveHomeM: 8, groundSpeedMps: 1 }))).toEqual(["status: ten metres, descending"]);
  });

  it("warns when GPS degrades and says when it is back", () => {
    expect(texts(base, at({ gpsSatellites: 4 }))).toEqual(["warning: GPS degraded, four satellites, hold position"]);
    expect(texts(at({ gpsSatellites: 4 }), at({ gpsSatellites: 9 }))).toEqual(["status: GPS good"]);
    expect(texts(base, at({ gpsFixType: 1 }))).toEqual(["warning: GPS degraded, ten satellites, hold position"]);
  });

  it("warns on EKF changes and reports home and mission legs", () => {
    expect(texts(base, at({ ekfStatus: "Bad" }))).toEqual(["warning: navigation bad"]);
    expect(texts(at({ ekfStatus: "Bad" }), at({ ekfStatus: "Good" }))).toEqual(["status: navigation good"]);
    expect(texts(at({ homeLatitudeDeg: null, homeLongitudeDeg: null }), base)).toEqual(["status: home set"]);
    expect(texts(base, at({ homeLatitudeDeg: 37.7609749 + 0.000005 }))).toEqual([]);
    expect(texts(base, at({ homeLatitudeDeg: 37.7609749 + 0.0001 }))).toEqual(["status: home set"]);
    expect(texts(base, at({ missionCurrent: 3, missionState: 3 }))).toEqual(["status: mission leg three"]);
    expect(texts(base, at({ missionCurrent: 3, missionState: 1 }))).toEqual([]);
  });

  it("never speaks a digit (a vehicle's own name aside)", () => {
    const all = [
      ...deriveCallouts(null, base),
      ...deriveCallouts(base, at({ armed: true, mode: "GUIDED", altitudeAboveHomeM: 45, batteryPct: 19, gpsSatellites: 3, ekfStatus: "Bad", missionCurrent: 2, missionState: 3 })),
    ];
    expect(all.length).toBeGreaterThan(6);
    for (const c of all) expect(c.text.replace(base.name, "")).not.toMatch(/\d/);
  });

  it("stays quiet about health and home until telemetry has flowed once", () => {
    const recordOnly = at({ altitudeAboveHomeM: null, altitudeAmslM: null, groundSpeedMps: null, headingDeg: null, batteryPct: null, batteryV: null, gpsFixType: null, gpsSatellites: null, ekfStatus: null, homeLatitudeDeg: null, homeLongitudeDeg: null, missionCurrent: null, missionState: null });
    expect(texts(recordOnly, base)).toEqual([]);
  });

  it("turns an engine warning about a building into a building callout", () => {
    const c = calloutForNotification(base, "Apex 5 freestyle quad stopped before hitting a building", "Buildings are solid. It is braking in front of one about 34 m tall. Fly away from it, or climb above it.");
    expect(c?.priority).toBe("warning");
    expect(c?.kind).toBe("building");
    expect(c?.text).toBe("building ahead, braking, it is about thirty-four metres tall. Fly away from it or climb above it");
    expect(c?.text).not.toMatch(/\d/);
    expect(calloutForNotification(base, "Battery failsafe", null)?.text).toBe("Battery failsafe");
    expect(calloutForNotification(base, "", null)).toBeNull();
  });
});
