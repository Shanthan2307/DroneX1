// How a build on the pad becomes a vehicle in the simulation engine (dronex/DroneX_1: UXDuck Core + ArduPilot
// SITL). Pure: no three, no DOM. Everything here is either a dataset field, a verdict field (dronePhysics.js) or
// an ArduPilot convention with its source in a comment. The 3D model itself is built by simExport.js.
//
//   simKind(airframe)                      -> { vehicle, frame, base, bearings, spinner }
//   simProfile({ build, verdict, catalog, name }) -> what the server needs to start the simulation (§ below)
//   bearingOf(x, z)                        -> degrees clockwise from the nose, nose at +Z, +X to the left
//   assignMotors(props, bearings)          -> props in ArduPilot motor order
//   simParams(verdict, battery, kind)      -> [{ name, value }] ArduPilot parameters derived from the design
import { footprint_m } from "./droneLayout.js";

// ArduPilot motor layouts: where each motor sits, in degrees clockwise from the nose, in output order (motor 1
// first). Source: ArduPilot Copter docs, "Connect ESCs and Motors", motor order diagrams
// (https://ardupilot.org/copter/docs/connect-escs-and-motors.html). The drawn propellers are matched to these
// so the simulator's motor outputs spin the propellers in the right places.
export const MOTOR_BEARINGS = {
  X: [45, 225, 315, 135],
  hexax: [90, 270, 30, 210, 330, 150],
  octa: [22.5, 202.5, 337.5, 157.5, 67.5, 247.5, 112.5, 292.5],
  tri: [60, 300, 180],
};

// ArduPilot conventions used when deriving parameters. Each with its source.
export const SIM_RULES = {
  // MOT_THST_HOVER / Q_M_THST_HOVER accept 0.125 to 0.6875 (ArduPilot parameter documentation).
  THST_HOVER_MIN: 0.125,
  THST_HOVER_MAX: 0.6875,
  // AIRSPEED_MIN is set above the stall speed; 1.2× stall is the usual margin (ArduPilot Plane tuning docs,
  // "Airspeed settings"). est.
  STALL_MARGIN: 1.2,
  // A LiPo cell is full at 4.2 V, used only when the battery record has no maxVoltage_V (generic LiPo spec).
  LIPO_FULL_V: 4.2,
  // Core's vehicle names are at most 64 characters (vehicle/save).
  NAME_MAX: 64,
};

/**
 * Which ArduPilot vehicle and frame fly this airframe, and how the simulation engine's map draws it: `base` is
 * the stock model type its motion code understands (multicopter / plane / vtol), `bearings` the motor layout
 * the drawn propellers are matched to, `spinner` the node name of a nose or cruise propeller (spun from the
 * throttle output) or null.
 */
export function simKind(airframe) {
  const t = airframe?.type;
  if (t === "multirotor") {
    const n = airframe.motorCount ?? 4;
    const frame = n === 6 ? "hexax" : n === 8 ? "octa" : n === 3 ? "tri" : "X";
    return { vehicle: "multicopter", frame, base: "multicopter", bearings: MOTOR_BEARINGS[frame], spinner: null };
  }
  if (t === "vtol_quadplane") return { vehicle: "vtol", frame: "quadplane", base: "vtol", bearings: MOTOR_BEARINGS.X, spinner: "Propeller" };
  if (t === "vtol_tiltrotor") return { vehicle: "vtol", frame: "quadplane-tilttri", base: "vtol", bearings: MOTOR_BEARINGS.tri, spinner: "Propeller" };
  return { vehicle: "plane", frame: "plane", base: "plane", bearings: [], spinner: "Propeller" };
}

/** Degrees clockwise from the nose for a point on the drone: the nose is +Z and +X is the left side. */
export const bearingOf = (x, z) => ((Math.atan2(-x, z) * 180) / Math.PI + 360) % 360;

const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * Puts the drawn propellers in ArduPilot motor order: motor 1 gets the propeller nearest its bearing, and so on.
 * With a count the layout does not expect, they are ordered clockwise from the nose instead.
 * @template {{ bearing_deg: number }} P
 * @param {P[]} props
 * @param {number[]} bearings
 * @returns {P[]}
 */
export function assignMotors(props, bearings) {
  if (props.length !== bearings.length) return [...props].sort((a, b) => a.bearing_deg - b.bearing_deg);
  const left = new Set(props);
  const out = [];
  for (const b of bearings) {
    let best = null;
    for (const p of left) if (!best || angleDiff(p.bearing_deg, b) < angleDiff(best.bearing_deg, b)) best = p;
    left.delete(best);
    out.push(best);
  }
  return out;
}

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * ArduPilot parameters that carry the design into the simulator: the pack's capacity and full voltage, the hover
 * throttle a multirotor's lift implies, and a wing's cruise and minimum airspeeds. SITL's airframe dynamics
 * stay ArduPilot's standard frame; these tune its battery model, hover point and speeds to the design. est.
 */
export function simParams(verdict, battery, kind) {
  const out = [];
  if (fin(battery?.capacity_mAh) && battery.capacity_mAh > 0) out.push({ name: "BATT_CAPACITY", value: Math.round(battery.capacity_mAh) });
  const full_V = fin(battery?.maxVoltage_V) ? battery.maxVoltage_V : fin(battery?.cells_s) ? battery.cells_s * SIM_RULES.LIPO_FULL_V : null;
  if (full_V) out.push({ name: "SIM_BATT_VOLTAGE", value: round(full_V, 1) });
  if (kind.base === "multicopter" || kind.base === "vtol") {
    const share = verdict?.hoverThrottleShare;
    if (fin(share) && share > 0) {
      const prefix = kind.base === "vtol" ? "Q_M_" : "MOT_";
      out.push({ name: `${prefix}THST_HOVER`, value: round(clamp(share, SIM_RULES.THST_HOVER_MIN, SIM_RULES.THST_HOVER_MAX), 3) });
      out.push({ name: `${prefix}HOVER_LEARN`, value: 0 }); // keep the design's figure rather than learning one
    }
  }
  if (kind.base === "plane" || kind.base === "vtol") {
    const cruise = verdict?.cruiseSpeed_ms;
    const stall = verdict?.stallSpeed_ms;
    // AIRSPEED_MIN is a whole number of m/s in ArduPilot (Int16); AIRSPEED_CRUISE is not.
    const min_ms = fin(stall) && stall > 0 ? Math.max(1, Math.round(stall * SIM_RULES.STALL_MARGIN)) : null;
    if (min_ms !== null) out.push({ name: "AIRSPEED_MIN", value: min_ms });
    if (fin(cruise) && cruise > 0 && (min_ms === null || cruise > min_ms)) out.push({ name: "AIRSPEED_CRUISE", value: round(cruise, 1) });
  }
  return out;
}

const byId = (list, id) => list?.find((r) => r.id === id) ?? null;

/**
 * Everything the server needs to start this build as a simulated vehicle, besides the 3D model:
 * `{ name, vehicle, frame, base, spinner, bearings, span_m, params, airframeType }`. `span_m` is the drone's
 * widest horizontal extent in true metres (the same footprint the display scale is set from), which is how big
 * the map draws the model.
 */
export function simProfile({ build, verdict, catalog, name }) {
  const airframe = byId(catalog?.airframes, build?.airframeId);
  const propeller = byId(catalog?.propellers, build?.propellerId);
  const battery = byId(catalog?.batteries, build?.batteryId);
  const kind = simKind(airframe);
  return {
    name: String(name ?? airframe?.name ?? "DroneX drone").trim().slice(0, SIM_RULES.NAME_MAX),
    vehicle: kind.vehicle,
    frame: kind.frame,
    base: kind.base,
    spinner: kind.spinner,
    bearings: kind.bearings,
    span_m: round(footprint_m(airframe, propeller), 3),
    params: simParams(verdict, battery, kind),
    airframeType: airframe?.type ?? null,
  };
}
