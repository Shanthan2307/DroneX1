// Pure shaping: what the mirror sees (sinks/types.ts) becomes Elasticsearch documents; flights are cut out of the
// stream; a flight is scored. No client, no IO, so every rule here is unit-tested (shape.test.ts) and the same
// score the Workflow computes in the cluster can be checked against this one.
import type { FlightEvent, Fix, VehicleInfo } from "../sinks/types.js";

export const usToIso = (timeUs: number): string => new Date(Math.round(timeUs / 1000)).toISOString();

export interface TelemetryDoc {
  "@timestamp": string;
  vehicle_id: string;
  vehicle_name: string;
  design_id: string | null;
  flight_id: string;
  simulated: boolean;
  location: { lat: number; lon: number };
  altitude_amsl_m: number | null;
  altitude_above_home_m: number | null;
  altitude_above_ground_m: number | null;
  heading_deg: number | null;
  ground_speed_mps: number | null;
  climb_mps: number | null;
  battery_pct: number | null;
  battery_v: number | null;
  gps_satellites: number | null;
  gps_fix_type: number | null;
  gps_hdop: number | null;
  ekf_variance: number | null;
  ekf_status: string | null;
  mode: string;
  armed: boolean;
}

export interface EventDoc {
  "@timestamp": string;
  vehicle_id: string;
  vehicle_name: string | null;
  design_id: string | null;
  flight_id: string | null;
  type: FlightEvent["type"];
  detail: string;
  /** The event's own fields, flattened under one object for ES|QL. */
  data: Record<string, string | number | boolean | null>;
}

export interface VehicleDoc {
  "@timestamp": string;
  vehicle_id: string;
  vehicle_name: string;
  link_id: string;
  vehicle_type: string;
  autopilot: string;
  firmware: string | null;
  presence: VehicleInfo["presence"];
  armed: boolean;
  mode: string;
  design_id: string | null;
  size_cm: number | null;
  simulated: boolean;
  flight_id: string | null;
}

export interface FlightDoc {
  "@timestamp": string;
  flight_id: string;
  vehicle_id: string;
  vehicle_name: string;
  design_id: string | null;
  started_at: string;
  ended_at: string | null;
  status: "in-flight" | "ended";
}

/**
 * A flight is one vehicle-online … vehicle-offline span: the simulated vehicle appears when the simulator starts it
 * and goes when it is stopped, so the span holds the whole session, including the arm and disarm events inside it.
 * The id is `<vehicle id>:<online time in µs>`, stable across mirror restarts for the same session.
 */
export class FlightTracker {
  private current = new Map<string, { id: string; startedUs: number }>();

  flightOf(vehicleId: string): string | null {
    return this.current.get(vehicleId)?.id ?? null;
  }

  /** Starts a flight for a vehicle seen online without an event (the mirror started mid-session). */
  ensure(v: VehicleInfo, nowUs: number): string {
    const cur = this.current.get(v.id);
    if (cur) return cur.id;
    const id = `${v.id}:${nowUs}`;
    this.current.set(v.id, { id, startedUs: nowUs });
    return id;
  }

  /** Applies an event; returns the flight document to write, if the event opens or closes a flight. */
  apply(e: FlightEvent, v: VehicleInfo | null): FlightDoc | null {
    if (e.type === "vehicle-online") {
      const id = `${e.vehicleId}:${e.timeUs}`;
      this.current.set(e.vehicleId, { id, startedUs: e.timeUs });
      return { "@timestamp": usToIso(e.timeUs), flight_id: id, vehicle_id: e.vehicleId, vehicle_name: e.vehicle.name, design_id: e.vehicle.designId, started_at: usToIso(e.timeUs), ended_at: null, status: "in-flight" };
    }
    if (e.type === "vehicle-offline") {
      const cur = this.current.get(e.vehicleId);
      if (!cur) return null;
      this.current.delete(e.vehicleId);
      return { "@timestamp": usToIso(e.timeUs), flight_id: cur.id, vehicle_id: e.vehicleId, vehicle_name: v?.name ?? "", design_id: v?.designId ?? null, started_at: usToIso(cur.startedUs), ended_at: usToIso(e.timeUs), status: "ended" };
    }
    return null;
  }
}

export function telemetryDoc(f: Fix, v: VehicleInfo, flightId: string): TelemetryDoc {
  return {
    "@timestamp": usToIso(f.timeUs),
    vehicle_id: f.vehicleId,
    vehicle_name: v.name,
    design_id: v.designId,
    flight_id: flightId,
    simulated: v.simulated,
    location: { lat: f.latitudeDeg, lon: f.longitudeDeg },
    altitude_amsl_m: f.altitudeAmslM,
    altitude_above_home_m: f.altitudeAboveHomeM,
    altitude_above_ground_m: f.altitudeAboveGroundM,
    heading_deg: f.headingDeg,
    ground_speed_mps: f.groundSpeedMps,
    climb_mps: f.climbMps,
    battery_pct: f.batteryPct,
    battery_v: f.batteryV,
    gps_satellites: f.gpsSatellites,
    gps_fix_type: f.gpsFixType,
    gps_hdop: f.gpsHdop,
    ekf_variance: f.ekfVariance,
    ekf_status: f.ekfStatus,
    mode: v.mode,
    armed: v.armed,
  };
}

const describeEvent = (e: FlightEvent): string => {
  switch (e.type) {
    case "vehicle-online":
      return `${e.vehicle.name} came online (${e.vehicle.vehicleType}, ${e.vehicle.mode})`;
    case "vehicle-offline":
      return "vehicle went offline";
    case "armed":
      return e.armed ? "armed" : "disarmed";
    case "mode":
      return `mode ${e.from} → ${e.to}`;
    case "home-set":
      return `home set at ${e.latitudeDeg.toFixed(5)}, ${e.longitudeDeg.toFixed(5)}`;
    case "battery-threshold":
      return `battery ${e.pct.toFixed(0)} % (crossed ${e.threshold} %)`;
    case "gps-quality":
      return e.degraded ? `GPS degraded: ${e.satellites ?? "?"} satellites, fix type ${e.fixType ?? "?"}` : `GPS recovered: ${e.satellites ?? "?"} satellites`;
    case "ekf":
      return `EKF ${e.status}${e.variance !== null ? ` (variance ${e.variance.toFixed(3)})` : ""}`;
  }
};

export function eventDoc(e: FlightEvent, v: VehicleInfo | null, flightId: string | null): EventDoc {
  const data: Record<string, string | number | boolean | null> = {};
  for (const [k, val] of Object.entries(e)) {
    if (k === "type" || k === "vehicleId" || k === "timeUs" || k === "vehicle") continue;
    if (val === null || typeof val === "string" || typeof val === "number" || typeof val === "boolean") data[k] = val;
  }
  return { "@timestamp": usToIso(e.timeUs), vehicle_id: e.vehicleId, vehicle_name: v?.name ?? (e.type === "vehicle-online" ? e.vehicle.name : null), design_id: v?.designId ?? (e.type === "vehicle-online" ? e.vehicle.designId : null), flight_id: flightId, type: e.type, detail: describeEvent(e), data };
}

export function vehicleDoc(v: VehicleInfo, nowUs: number, flightId: string | null): VehicleDoc {
  return { "@timestamp": usToIso(nowUs), vehicle_id: v.id, vehicle_name: v.name, link_id: v.linkId, vehicle_type: v.vehicleType, autopilot: v.autopilot, firmware: v.firmware, presence: v.presence, armed: v.armed, mode: v.mode, design_id: v.designId, size_cm: v.sizeCm, simulated: v.simulated, flight_id: flightId };
}

// ---------- scoring a flight ----------

export interface FlightScore {
  flight_id: string;
  vehicle_id: string;
  design_id: string | null;
  "@timestamp": string;
  fixes: number;
  duration_min: number;
  /** Battery used per minute of flight, measured, against the estimate from the verdict (100 / hover minutes). */
  battery_drain_pct_per_min: number | null;
  battery_drain_estimate_pct_per_min: number | null;
  battery_sag_ratio: number | null;
  ekf_variance_peak: number | null;
  gps_dropouts: number;
  gps_satellites_min: number | null;
  brake_events: number;
  mode_changes: number;
  max_altitude_above_home_m: number | null;
  max_ground_speed_mps: number | null;
  anomalies: string[];
  anomalous: boolean;
}

export interface ScoreInput {
  flightId: string;
  vehicleId: string;
  designId: string | null;
  fixes: Pick<TelemetryDoc, "@timestamp" | "battery_pct" | "ekf_variance" | "gps_satellites" | "altitude_above_home_m" | "ground_speed_mps">[];
  events: Pick<EventDoc, "type" | "data">[];
  /** From the design's verdict, when known. */
  hoverTimeMin: number | null;
}

export const SCORE_RULES = {
  batterySagRatio: 1.3, // measured drain more than 30 % above the estimate
  ekfVariancePeak: 0.5, // ArduPilot's EKF variance scale: 1 is the failsafe line
  gpsDropouts: 1,
  gpsSatellitesMin: 6,
  brakeEvents: 1,
} as const;

/** The score, computed the same way the Workflow computes it in the cluster (elastic/workflow.yaml). */
export function scoreFlight(input: ScoreInput): FlightScore {
  const fixes = [...input.fixes].sort((a, b) => a["@timestamp"].localeCompare(b["@timestamp"]));
  const first = fixes[0];
  const last = fixes[fixes.length - 1];
  const durationMin = first && last ? (Date.parse(last["@timestamp"]) - Date.parse(first["@timestamp"])) / 60_000 : 0;
  const batt = fixes.map((f) => f.battery_pct).filter((x): x is number => x !== null);
  const drain = batt.length >= 2 && durationMin > 0.5 ? (batt[0] - batt[batt.length - 1]) / durationMin : null;
  const estimate = input.hoverTimeMin && input.hoverTimeMin > 0 ? 100 / input.hoverTimeMin : null;
  const sag = drain !== null && estimate !== null && estimate > 0 ? drain / estimate : null;
  const ekf = fixes.map((f) => f.ekf_variance).filter((x): x is number => x !== null);
  const sats = fixes.map((f) => f.gps_satellites).filter((x): x is number => x !== null);
  const alts = fixes.map((f) => f.altitude_above_home_m).filter((x): x is number => x !== null);
  const speeds = fixes.map((f) => f.ground_speed_mps).filter((x): x is number => x !== null);
  const gpsDropouts = input.events.filter((e) => e.type === "gps-quality" && e.data.degraded === true).length;
  const brakeEvents = input.events.filter((e) => e.type === "mode" && e.data.to === "BRAKE").length;
  const modeChanges = input.events.filter((e) => e.type === "mode").length;
  const anomalies: string[] = [];
  if (sag !== null && sag > SCORE_RULES.batterySagRatio) anomalies.push(`battery drains ${((sag - 1) * 100).toFixed(0)} % faster than the estimate`);
  const ekfPeak = ekf.length ? Math.max(...ekf) : null;
  if (ekfPeak !== null && ekfPeak > SCORE_RULES.ekfVariancePeak) anomalies.push(`EKF variance peaked at ${ekfPeak.toFixed(2)}`);
  if (gpsDropouts >= SCORE_RULES.gpsDropouts) anomalies.push(`${gpsDropouts} GPS dropout${gpsDropouts === 1 ? "" : "s"}`);
  const satsMin = sats.length ? Math.min(...sats) : null;
  if (satsMin !== null && satsMin < SCORE_RULES.gpsSatellitesMin) anomalies.push(`as few as ${satsMin} satellites`);
  if (brakeEvents >= SCORE_RULES.brakeEvents) anomalies.push(`braked for a building ${brakeEvents} time${brakeEvents === 1 ? "" : "s"}`);
  return {
    flight_id: input.flightId,
    vehicle_id: input.vehicleId,
    design_id: input.designId,
    "@timestamp": last?.["@timestamp"] ?? new Date().toISOString(),
    fixes: fixes.length,
    duration_min: Math.round(durationMin * 100) / 100,
    battery_drain_pct_per_min: drain === null ? null : Math.round(drain * 100) / 100,
    battery_drain_estimate_pct_per_min: estimate === null ? null : Math.round(estimate * 100) / 100,
    battery_sag_ratio: sag === null ? null : Math.round(sag * 100) / 100,
    ekf_variance_peak: ekfPeak,
    gps_dropouts: gpsDropouts,
    gps_satellites_min: satsMin,
    brake_events: brakeEvents,
    mode_changes: modeChanges,
    max_altitude_above_home_m: alts.length ? Math.max(...alts) : null,
    max_ground_speed_mps: speeds.length ? Math.max(...speeds) : null,
    anomalies,
    anomalous: anomalies.length > 0,
  };
}

// ---------- knowledge: ArduPilot parameters ----------

export interface ParamDoc {
  name: string;
  human_name: string;
  documentation: string;
  group: string;
  vehicle: string;
  range: string | null;
  units: string | null;
  values: string | null;
  user: string | null;
  /** The text the semantic field embeds: name, human name and documentation in one sentence. */
  text: string;
}

const unescapeXml = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
};

/**
 * apm.pdef.xml (ArduPilot's parameter definitions): <parameters name="GROUP"> blocks holding <param name=.. humanName=..
 * documentation=..> with <field name="Range">, <field name="Units">, <values><value code="0">Off</value>…</values>.
 * A regex walk is enough: the file is regular and we want five attributes and two fields per parameter.
 */
export function parseParamDefs(xml: string, vehicle = "ArduCopter"): ParamDoc[] {
  const out: ParamDoc[] = [];
  const groupRe = /<parameters\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/parameters>/g;
  let g: RegExpExecArray | null;
  while ((g = groupRe.exec(xml))) {
    const group = unescapeXml(g[1]);
    const body = g[2];
    const paramRe = /<param\b([^>]*)(?:\/>|>([\s\S]*?)<\/param>)/g;
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(body))) {
      const head = p[1];
      const inner = p[2] ?? "";
      const name = attr(head, "name");
      if (!name) continue;
      const field = (n: string): string | null => {
        const m = inner.match(new RegExp(`<field\\s+name="${n}">([\\s\\S]*?)<\\/field>`));
        return m ? unescapeXml(m[1]).trim() : null;
      };
      const values = [...inner.matchAll(/<value\s+code="([^"]*)">([\s\S]*?)<\/value>/g)].map((m) => `${unescapeXml(m[1])}: ${unescapeXml(m[2]).trim()}`);
      const human = attr(head, "humanName") ?? name;
      const documentation = (attr(head, "documentation") ?? "").trim();
      const shortName = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
      out.push({
        name: shortName,
        human_name: human,
        documentation,
        group,
        vehicle,
        range: field("Range"),
        units: field("Units"),
        values: values.length ? values.join("; ") : null,
        user: attr(head, "user"),
        text: `${shortName} (${human}): ${documentation}${field("Units") ? ` Units: ${field("Units")}.` : ""}${field("Range") ? ` Range: ${field("Range")}.` : ""}`,
      });
    }
  }
  return out;
}

// ---------- knowledge: catalog notes ----------

export interface NoteDoc {
  record_id: string;
  record_kind: string;
  name: string;
  manufacturer: string | null;
  source: string | null;
  notes: string | null;
  /** Every numeric field of the record, as it is in the dataset. */
  numbers: Record<string, number>;
  /** What the semantic field embeds: the name, the notes and the numbers in words. */
  text: string;
}

export function catalogNoteDocs(kind: string, records: Record<string, unknown>[]): NoteDoc[] {
  return records
    .filter((r) => typeof r.id === "string")
    .map((r) => {
      const numbers: Record<string, number> = {};
      for (const [k, v] of Object.entries(r)) if (typeof v === "number" && Number.isFinite(v)) numbers[k] = v;
      const name = typeof r.name === "string" ? r.name : String(r.id);
      const notes = typeof r.notes === "string" ? r.notes : typeof r.note === "string" ? r.note : typeof r.description === "string" ? r.description : null;
      const nums = Object.entries(numbers)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");
      return {
        record_id: String(r.id),
        record_kind: kind,
        name,
        manufacturer: typeof r.manufacturer === "string" ? r.manufacturer : null,
        source: typeof r.source === "string" ? r.source : null,
        notes,
        numbers,
        text: `${kind} ${name}${notes ? `: ${notes}` : ""}${nums ? ` (${nums})` : ""}`,
      };
    });
}

// ---------- knowledge: physics formulas ----------

export interface FormulaDoc {
  function_name: string;
  /** The comment block right above the export, which the physics file keeps as the formula's explanation. */
  comment: string;
  signature: string;
  text: string;
}

/**
 * dronePhysics.js explains each formula in the comment lines directly above its `export const name = (` or
 * `export function name(`; the block ends at the previous blank line or code line. Section banners
 * ("// --- model 1: the propeller ---") are kept as part of the comment, since they name the model.
 */
export function parseFormulaComments(source: string): FormulaDoc[] {
  const lines = source.split("\n");
  const out: FormulaDoc[] = [];
  const exportRe = /^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)\s*(=|\()/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(exportRe);
    if (!m) continue;
    const comment: string[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const t = lines[j].trim();
      if (t.startsWith("//")) comment.unshift(t.replace(/^\/\/\s?/, ""));
      else break;
    }
    if (comment.length === 0) continue;
    const text = comment.join("\n").trim();
    out.push({ function_name: m[1], comment: text, signature: lines[i].trim().slice(0, 160), text: `${m[1]}: ${text}` });
  }
  return out;
}
