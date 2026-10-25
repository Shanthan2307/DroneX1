// The pure shaping rules, verified without a cluster: parameter definitions parse, documents take the right
// shape, flights are cut out of the stream, scores and anomaly flags follow SCORE_RULES.
import { describe, expect, it } from "vitest";
import type { FlightEvent, Fix, VehicleInfo } from "../sinks/types.js";
import { catalogNoteDocs, eventDoc, FlightTracker, parseFormulaComments, parseParamDefs, SCORE_RULES, scoreFlight, telemetryDoc, usToIso } from "./shape.js";
import { verdictDocs } from "./verdicts.js";

const vehicle: VehicleInfo = { id: "v1", name: "Apex courier", linkId: "li1", vehicleType: "Quadrotor", autopilot: "Ardupilotmega", firmware: "4.8.0", presence: "online", armed: false, mode: "STABILIZE", designId: "s-abcdefabcdef", sizeCm: 35, simulated: true };
const fix = (timeUs: number, extra: Partial<Fix> = {}): Fix => ({ vehicleId: "v1", timeUs, latitudeDeg: 37.76, longitudeDeg: -122.38, altitudeAmslM: 10, altitudeAboveHomeM: 10, altitudeAboveGroundM: 9, headingDeg: 22, groundSpeedMps: 3, climbMps: 0, batteryPct: 90, batteryV: 24.5, gpsSatellites: 10, gpsFixType: 6, gpsHdop: 1.2, ekfVariance: 0.01, ekfStatus: "Good", ...extra });

describe("documents", () => {
  it("telemetry carries the vehicle, the flight and a geo_point", () => {
    const d = telemetryDoc(fix(1_792_000_000_000_000), vehicle, "v1:1");
    expect(d.location).toEqual({ lat: 37.76, lon: -122.38 });
    expect(d.flight_id).toBe("v1:1");
    expect(d.design_id).toBe("s-abcdefabcdef");
    expect(d["@timestamp"]).toBe(usToIso(1_792_000_000_000_000));
    expect(d.mode).toBe("STABILIZE");
  });
  it("events flatten their fields and describe themselves", () => {
    const e: FlightEvent = { type: "mode", vehicleId: "v1", timeUs: 1, from: "GUIDED", to: "BRAKE" };
    const d = eventDoc(e, vehicle, "v1:1");
    expect(d.detail).toBe("mode GUIDED → BRAKE");
    expect(d.data).toEqual({ from: "GUIDED", to: "BRAKE" });
    expect(d.flight_id).toBe("v1:1");
  });
});

describe("flights", () => {
  it("open on vehicle-online, close on vehicle-offline, and are stable ids", () => {
    const t = new FlightTracker();
    const open = t.apply({ type: "vehicle-online", vehicleId: "v1", timeUs: 1000, vehicle }, vehicle);
    expect(open?.status).toBe("in-flight");
    expect(open?.flight_id).toBe("v1:1000");
    expect(t.flightOf("v1")).toBe("v1:1000");
    expect(t.apply({ type: "armed", vehicleId: "v1", timeUs: 2000, armed: true }, vehicle)).toBeNull();
    const close = t.apply({ type: "vehicle-offline", vehicleId: "v1", timeUs: 9000 }, vehicle);
    expect(close?.status).toBe("ended");
    expect(close?.flight_id).toBe("v1:1000");
    expect(close?.ended_at).toBe(usToIso(9000));
    expect(t.flightOf("v1")).toBeNull();
  });
  it("ensure() starts a flight for a vehicle seen mid-session and keeps it", () => {
    const t = new FlightTracker();
    expect(t.ensure(vehicle, 5)).toBe("v1:5");
    expect(t.ensure(vehicle, 6)).toBe("v1:5");
  });
});

describe("scores", () => {
  const minute = 60_000;
  const fixes = (n: number, battery: (i: number) => number, ekf = 0.01, sats = 10) =>
    Array.from({ length: n }, (_, i) => ({ "@timestamp": new Date(Date.UTC(2026, 9, 25, 0, i)).toISOString(), battery_pct: battery(i), ekf_variance: ekf, gps_satellites: sats, altitude_above_home_m: 30, ground_speed_mps: 5 }));
  it("a quiet flight has no anomalies and a sag ratio near one", () => {
    // 10 minutes, 2 % per minute measured; estimate from a 50-minute hover is 2 % per minute
    const s = scoreFlight({ flightId: "f", vehicleId: "v1", designId: "d", fixes: fixes(11, (i) => 100 - 2 * i), events: [], hoverTimeMin: 50 });
    expect(s.duration_min).toBe(10);
    expect(s.battery_drain_pct_per_min).toBe(2);
    expect(s.battery_sag_ratio).toBe(1);
    expect(s.anomalous).toBe(false);
    expect(minute).toBeGreaterThan(0);
  });
  it("flags battery sag, EKF peaks, GPS dropouts, few satellites and brakes", () => {
    const s = scoreFlight({
      flightId: "f",
      vehicleId: "v1",
      designId: "d",
      fixes: fixes(11, (i) => 100 - 4 * i, 0.8, 4),
      events: [
        { type: "gps-quality", data: { degraded: true, satellites: 4, fixType: 2 } },
        { type: "mode", data: { from: "GUIDED", to: "BRAKE" } },
        { type: "mode", data: { from: "BRAKE", to: "GUIDED" } },
      ],
      hoverTimeMin: 50,
    });
    expect(s.battery_sag_ratio).toBe(2);
    expect(s.gps_dropouts).toBe(1);
    expect(s.brake_events).toBe(1);
    expect(s.mode_changes).toBe(2);
    expect(s.gps_satellites_min).toBe(4);
    expect(s.anomalies.length).toBe(5);
    expect(s.anomalous).toBe(true);
    expect(SCORE_RULES.gpsSatellitesMin).toBe(6);
  });
  it("has no sag ratio without an estimate or with a flight too short to measure", () => {
    expect(scoreFlight({ flightId: "f", vehicleId: "v1", designId: null, fixes: fixes(11, (i) => 100 - i), events: [], hoverTimeMin: null }).battery_sag_ratio).toBeNull();
    expect(scoreFlight({ flightId: "f", vehicleId: "v1", designId: null, fixes: fixes(1, () => 100), events: [], hoverTimeMin: 20 }).battery_drain_pct_per_min).toBeNull();
  });
});

describe("knowledge", () => {
  it("parses ArduPilot parameter definitions with range, units and values", () => {
    const xml = `<paramfile><parameters name="MOT_"><param humanName="Thrust Hover Value" name="MOT_THST_HOVER" documentation="Motor thrust needed to hover expressed as a number from 0 to 1" user="Advanced">
        <field name="Range">0.125 0.6875</field>
      </param>
      <param humanName="Hover Value Learning" name="ArduCopter:MOT_HOVER_LEARN" documentation="Enable/Disable automatic learning of hover throttle" user="Advanced">
        <values><value code="0">Disabled</value><value code="1">Learn</value><value code="2">Learn and Save</value></values>
      </param></parameters>
      <parameters name="WPNAV_"><param humanName="Waypoint Horizontal Speed" name="WPNAV_SPEED" documentation="Defines the speed in cm/s which the aircraft will attempt to maintain horizontally during a WP mission"><field name="Units">cm/s</field><field name="Range">20 2000</field></param></parameters></paramfile>`;
    const p = parseParamDefs(xml);
    expect(p.map((x) => x.name)).toEqual(["MOT_THST_HOVER", "MOT_HOVER_LEARN", "WPNAV_SPEED"]);
    expect(p[0].range).toBe("0.125 0.6875");
    expect(p[0].group).toBe("MOT_");
    expect(p[1].values).toBe("0: Disabled; 1: Learn; 2: Learn and Save");
    expect(p[2].units).toBe("cm/s");
    expect(p[2].text).toContain("Units: cm/s");
  });
  it("turns dataset records into notes with their numbers", () => {
    const docs = catalogNoteDocs("motor", [{ id: "m1", name: "F60", manufacturer: "T-Motor", kv: 1950, weight_g: 33.4, idleCurrent_A: null, source: "https://x", notes: "V2.0 record" }]);
    expect(docs[0].numbers).toEqual({ kv: 1950, weight_g: 33.4 });
    expect(docs[0].text).toContain("V2.0 record");
    expect(docs[0].text).toContain("kv 1950");
  });
  it("takes the comment block above each exported physics function", () => {
    const src = `// --- model 1: the propeller ---\n// Standard propeller coefficient form\n//     thrust T = Ct · ρ · n² · D⁴\nconst helper = 1;\nexport const propellerThrust_N = (prop, rev_s) => {\n};\n\n// pack voltage\nexport function packVoltage_V(b) {}\nexport const noComment = 1;\n`;
    const f = parseFormulaComments(src);
    expect(f.map((x) => x.function_name)).toEqual(["packVoltage_V"]);
    expect(f[0].comment).toBe("pack voltage");
  });
  it("attaches the model banner only when it sits directly above the export", () => {
    const src = `// Standard propeller coefficient form\n//     thrust T = Ct · ρ · n² · D⁴\nexport const propellerThrust_N = (prop, rev_s) => 1;\n`;
    expect(parseFormulaComments(src)[0].comment).toContain("Ct · ρ");
  });
});

describe("verdicts", () => {
  it("one document per mission with the failing checks named", () => {
    const docs = verdictDocs("apex", "preset", "Apex", null, {
      build: { airframeId: "a", motorId: "m", propellerId: "p", batteryId: "b", payloadId: null, missionId: "x" },
      summary: { hoverTime_min: 15.8, feasible: true },
      readiness: { ready: false, lines: [] },
      warnings: [],
      missions: [
        { mission: { id: "x", name: "X" }, ready: false, failing: 1, notJudged: 0, checks: [{ key: "endurance", label: "Endurance", status: "fail", text: "15.8 min < 20 min" }], summary: { hoverTime_min: 15.8 } },
        { mission: { id: "y", name: "Y" }, ready: true, failing: 0, notJudged: 1, checks: [], summary: { hoverTime_min: 15.8 } },
      ],
    });
    expect(docs).toHaveLength(2);
    expect(docs[0].failing_checks).toEqual(["Endurance"]);
    expect(docs[1].ready).toBe(true);
    expect(docs[0].build.payloadId).toBeNull();
  });
});
