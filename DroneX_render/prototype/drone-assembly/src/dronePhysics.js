// Drone physics, the mirror of physics.js for the drone path (contract: docs/drone-integration.md §7).
//   DRONE_RULES                          the thresholds and modelling constants, each with its source
//   evaluateDrone(build, droneCatalog)   one verdict object, shape-compatible with physics.evaluateBuild
//   droneDetails(build, droneCatalog)    one row per configurator slot, the role stageDetails plays
//
// Plain JS, no imports, so node can run it (scripts/check-drone-physics.mjs builds known vehicles and checks
// the answers). Like physics.js it never throws: an empty or unknown build comes back as an infeasible verdict
// with plain-words warnings, exactly the way evaluateBuild handles an empty stage list.
//
// WHERE THE NUMBERS COME FROM. Every real-world quantity is a field of a record in src/data/drone/*.json
// (sourced in that folder's SOURCES.md) or a documented modelling constant in DRONE_RULES below. Nothing is
// invented here. The three models are standard and are explained at the function that uses them:
//   1. propeller coefficients  T = Ct ρ n² D⁴ and P = Cp ρ n³ D⁵   (propellerThrust_N / propellerShaftPower_W)
//   2. first-order brushless motor model from kv, winding resistance and idle current  (motorAtFullThrottle)
//   3. momentum theory for hover induced power, with a figure of merit  (hoverRotorPoint)
// Label every one of them "est." on screen: they are formulas over records, not measurements of a built drone.

// --- constants shared with physics.js ---------------------------------------------------------------------
export const G0 = 9.80665; // standard gravity, the same constant physics.js uses

// --- DRONE_RULES ------------------------------------------------------------------------------------------
// Thresholds and modelling constants. A "threshold" is a line this app draws; a "modelling constant" stands in
// for something the datasets do not carry. Neither is a measurement of a specific product.
export const DRONE_RULES = {
  // Physical constants of the air the propeller data was measured in.
  AIR_DENSITY_KGM3: 1.225, // ISA sea level, 15 °C: the condition propeller Ct/Cp coefficients are quoted at
  SPEED_OF_SOUND_MS: 340.3, // ISA sea level, used only for the propeller tip-speed limit below

  // Readiness thresholds (contract §7 names the first three).
  HOVER_TWR_OK: 2.0, // hover at about half throttle: standard multirotor sizing practice
  HOVER_TWR_MIN: 1.3, // below this a rotorcraft cannot hold altitude with any control margin left
  USABLE_PACK_SHARE: 0.8, // a LiPo pack is flown to about 80 % of its capacity to keep cell voltage safe
  SUB_250_G: 250, // the FAA / EASA registration threshold, the reason sub-250 g builds exist at all
  // A pure fixed wing does not hover, so HOVER_TWR_MIN cannot judge it. This is the static thrust-to-weight a
  // hand- or bungee-launched model needs to climb away. A design threshold for this app, not a regulation.
  WING_STATIC_TWR_MIN: 0.5,
  // Propeller tip speed. Above about Mach 0.75 a plastic or composite propeller loses thrust fast and the
  // blades can delaminate. The 0.75 line is a design threshold for this check, not a per-propeller rating:
  // no record in propellers.json carries a maximum RPM.
  TIP_MACH_LIMIT: 0.75,

  // Modelling constants: masses and powers the datasets do not carry.
  // A modelling allowance for the flight controller, ESC, VTX, receiver and wiring — the parts the
  // configurator does not let you choose. It is NOT a measurement of a specific product: it is the rough sum
  // of a 20 × 20 stack (FC ~8 g, 4-in-1 ESC ~10 g), a VTX and antenna (~7 g) and wiring (~5 g). Always shown
  // with an "est." tag. TODO(source): drop this the day airframes.json carries an electronics mass per frame.
  ELECTRONICS_ALLOWANCE_G: 30,
  // The same parts' standing power draw, for the hover-current sum. Also a modelling allowance, same reason.
  // TODO(source): a flight controller plus a 25-600 mW video transmitter is a few watts; no record says how many.
  AVIONICS_POWER_W: 4,
  // Rotor figure of merit: ideal induced power / rotor shaft power in hover. 0.55 is the usual value quoted for
  // small propellers and it is cross-checked against this dataset: feeding each propeller's own measured
  // ct_static and cp_static through the coefficient model gives an equivalent figure of merit of 0.52 to 0.60
  // at hover loading (scripts/check-drone-physics.mjs asserts that), so the constant agrees with the records.
  ROTOR_FIGURE_OF_MERIT: 0.55,
  // ESC conversion efficiency, pack watts to motor watts. A design assumption: no record carries an ESC.
  ESC_EFFICIENCY: 0.95,
  // Mixed flight — climbs, translation and manoeuvre — draws more than a steady hover. A modelling assumption
  // for the "mixed" endurance figure. TODO(source): the real factor depends on the pilot, not the parts.
  MIXED_POWER_FACTOR: 1.8,
  // Cruise speed of a winged airframe as a multiple of its stall speed. A sizing convention for this app
  // (1.3 × stall is the classic approach-speed margin; a model cruises a little above that), not a measurement.
  CRUISE_STALL_FACTOR: 1.4,
  // Oswald span efficiency in the drag polar CD = cd0 + CL² / (π e AR). 0.8 is the standard value for a
  // straight, untwisted model wing. A modelling constant: no airframe record carries one.
  OSWALD_EFFICIENCY: 0.8,
  // Propeller efficiency in forward flight (thrust power out / shaft power in). The records only carry STATIC
  // coefficients, which say nothing about cruise, so this stands in for them. A modelling constant.
  CRUISE_PROP_EFFICIENCY: 0.7,
  // Coaxial pairs (an X8: two propellers on one arm, one above the other). The lower rotor works in the upper
  // one's wake, so a coaxial pair makes less thrust than two isolated rotors at the same speed. Only applied to an
  // airframe with coaxial: true. TODO(source): set from a cited measurement before any coaxial airframe is added;
  // until then a coaxial record is evaluated without a loss and evaluateDrone says so in a warning.
  COAXIAL_THRUST_FACTOR: null,
  // Ducts. A duct can add static thrust, but no source in this dataset measures it for the ducts we carry, so
  // a ducted airframe is evaluated as open propellers (no gain, no penalty) and the card says so. Kept here as a
  // named null rather than an unspoken omission. TODO(source).
  DUCT_THRUST_FACTOR: null,

  // Nominal volts per cell by chemistry, for pack voltage = cells_s × volts per cell. These are the standard
  // nominal cell voltages and they reproduce every nominalVoltage_V field in batteries.json exactly
  // (4S LiPo 14.8 V, 6S LiPo 22.2 V, 6S Li-ion 21.6 V), so the rule and the records agree. LiHV (high-voltage
  // LiPo, 4.35 V full) is 3.8 V nominal, which reproduces the GEPRC 4S HV pack's published 15.2 V. One exception
  // is called out in its record: iFlight labels its 6S Li-ion pack 22.2 V; the rule's 21.6 V is used for it.
  VOLTS_PER_CELL: { LiPo: 3.7, "Li-ion": 3.6, LiHV: 3.8 },
  VOLTS_PER_CELL_FALLBACK: 3.7, // an unknown chemistry is treated as LiPo, and a warning says so
};

const {
  AIR_DENSITY_KGM3: RHO,
  SPEED_OF_SOUND_MS,
  HOVER_TWR_OK,
  HOVER_TWR_MIN,
  USABLE_PACK_SHARE,
  SUB_250_G,
  WING_STATIC_TWR_MIN,
  TIP_MACH_LIMIT,
  ELECTRONICS_ALLOWANCE_G,
  AVIONICS_POWER_W,
  ROTOR_FIGURE_OF_MERIT,
  ESC_EFFICIENCY,
  MIXED_POWER_FACTOR,
  CRUISE_STALL_FACTOR,
  OSWALD_EFFICIENCY,
  CRUISE_PROP_EFFICIENCY,
  COAXIAL_THRUST_FACTOR,
  VOLTS_PER_CELL,
  VOLTS_PER_CELL_FALLBACK,
} = DRONE_RULES;

// --- small, total helpers ---------------------------------------------------------------------------------
const byId = (list, id) => (id ? (list ?? []).find((x) => x?.id === id) : undefined);
// A record field is only usable if it is a finite number. Anything else reads as "the dataset does not say".
const fin = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const pos = (x) => (fin(x) !== null && x > 0 ? x : null);
const mm = (x) => (pos(x) === null ? null : x / 1000); // millimetres to metres
const round = (x, d) => (fin(x) === null ? null : Math.round(x * 10 ** d) / 10 ** d);
// Amps for a warning line: whole amps read better than three decimals ("62 A needed, 50 A rated").
const amps = (a) => String(Math.round(a));
const grams = (g) => String(Math.round(g));

// --- pack voltage -----------------------------------------------------------------------------------------
// Nominal pack voltage = cells in series × nominal volts per cell, with the chemistry taken from the record.
// Computed from cells_s rather than read from nominalVoltage_V so that the one rule covers a record that only
// states its cell count; the two agree for every pack in batteries.json.
export const packVoltage_V = (battery) => {
  const cells = pos(battery?.cells_s);
  if (cells === null) return null;
  const perCell = VOLTS_PER_CELL[battery?.chemistry] ?? VOLTS_PER_CELL_FALLBACK;
  return cells * perCell;
};

// --- model 1: the propeller ------------------------------------------------------------------------------
// Standard propeller coefficient form, the convention the UIUC propeller database and APC's own performance
// tables publish Ct and Cp in (n is REVOLUTIONS per second, not radians):
//     thrust  T = Ct · ρ · n² · D⁴      shaft power  P = Cp · ρ · n³ · D⁵
// ct_static and cp_static are measured fields of every record in propellers.json (see SOURCES.md), so no
// empirical "grams per inch of propeller" coefficient is needed anywhere in this file. Diameter is the record's
// diameter_mm; pitch_in is not an input to these formulas because the measured coefficients already contain
// the effect of the pitch — pitch is carried through to the card and the compatibility check instead.
const propDiameter_m = (prop) => mm(prop?.diameter_mm) ?? (pos(prop?.diameter_in) === null ? null : prop.diameter_in * 0.0254);
export const propellerThrust_N = (prop, rev_s) => {
  const D = propDiameter_m(prop);
  const ct = pos(prop?.ct_static);
  if (D === null || ct === null || fin(rev_s) === null) return null;
  return ct * RHO * rev_s * rev_s * D ** 4;
};
export const propellerShaftPower_W = (prop, rev_s) => {
  const D = propDiameter_m(prop);
  const cp = pos(prop?.cp_static);
  if (D === null || cp === null || fin(rev_s) === null) return null;
  return cp * RHO * rev_s ** 3 * D ** 5;
};
// Revolutions per second that make a wanted thrust, the thrust formula turned round. Used for hover, where the
// thrust is set by the weight rather than by the throttle.
const revForThrust = (prop, thrust_N) => {
  const D = propDiameter_m(prop);
  const ct = pos(prop?.ct_static);
  if (D === null || ct === null || !(thrust_N > 0)) return null;
  return Math.sqrt(thrust_N / (ct * RHO * D ** 4));
};
// Propeller torque coefficient written as Q = A · n², so the motor and the propeller can be solved together.
// Q = P / (2π n) and P = Cp ρ n³ D⁵, hence A = Cp ρ D⁵ / 2π.
const propTorqueFactor = (prop) => {
  const D = propDiameter_m(prop);
  const cp = pos(prop?.cp_static);
  if (D === null || cp === null) return null;
  return (cp * RHO * D ** 5) / (2 * Math.PI);
};
export const tipMach = (prop, rev_s) => {
  const D = propDiameter_m(prop);
  if (D === null || fin(rev_s) === null) return null;
  return (Math.PI * D * rev_s) / SPEED_OF_SOUND_MS;
};

// --- model 2: the motor ----------------------------------------------------------------------------------
// First-order brushless motor model, the one every motor sizing tool uses, over three fields the records carry
// (kv, internalResistance_mohm, idleCurrent_A):
//     speed    N_rpm = kv · (V − I · Rm)        (the kv relation, with the winding drop taken off)
//     torque   Q = Kt · (I − I0),  Kt = 60 / (2π · kv)  N·m/A
// So torque falls as speed rises, which is what stops a motor from reaching kv × V under load.
const motorKt_Nm_A = (motor) => {
  const kv = pos(motor?.kv);
  return kv === null ? null : 60 / (2 * Math.PI * kv);
};
const motorResistance_ohm = (motor) => {
  const r = fin(motor?.internalResistance_mohm);
  return r === null || r < 0 ? null : r / 1000;
};

// Full-throttle working point of one motor with one propeller on one pack, found by making the motor's torque
// equal the propeller's torque. Substituting the kv relation into Q = A n² gives a quadratic in n:
//     A n² + (60 Kt / (kv Rm)) n − Kt (V / Rm − I0) = 0
// The positive root is the speed the pair settles at. The pair is then held to the motor's own electrical
// limits (maxCurrent_A and maxPower_W): if the free solution asks for more than the motor is rated for, the ESC
// throttles back, and the speed an allowed current can hold a propeller at is n = sqrt(Kt (I_limit − I0) / A).
// This is what stops an over-propped motor from reporting thrust it could never make.
export const motorAtFullThrottle = (motor, prop, packV) => {
  const Kt = motorKt_Nm_A(motor);
  const Rm = motorResistance_ohm(motor);
  const A = propTorqueFactor(prop);
  const V = pos(packV);
  const I0 = fin(motor?.idleCurrent_A) ?? 0;
  if (Kt === null || Rm === null || A === null || V === null || !(A > 0) || !(Rm > 0)) return null;

  const b = (60 * Kt) / (pos(motor.kv) * Rm);
  const c = -Kt * (V / Rm - I0);
  const disc = b * b - 4 * A * c;
  if (!(disc >= 0)) return null;
  const freeRev_s = (-b + Math.sqrt(disc)) / (2 * A);
  if (!(freeRev_s > 0)) return null;

  // What the motor would draw at that speed, and the limits it must stay inside.
  const freeCurrent_A = (V - (60 * freeRev_s) / pos(motor.kv)) / Rm;
  const currentCap_A = pos(motor?.maxCurrent_A) ?? Infinity;
  const powerCap_A = pos(motor?.maxPower_W) === null ? Infinity : motor.maxPower_W / V;
  const limit_A = Math.min(currentCap_A, powerCap_A);

  let rev_s = freeRev_s;
  let current_A = freeCurrent_A;
  let limitedBy = null;
  if (freeCurrent_A > limit_A) {
    limitedBy = currentCap_A <= powerCap_A ? "current" : "power";
    current_A = limit_A;
    const torque_Nm = Kt * (limit_A - I0);
    rev_s = torque_Nm > 0 ? Math.sqrt(torque_Nm / A) : 0;
  }
  const thrust_N = propellerThrust_N(prop, rev_s) ?? 0;
  const shaftPower_W = propellerShaftPower_W(prop, rev_s) ?? 0;
  return {
    rev_s,
    rpm: rev_s * 60,
    freeRev_s,
    thrust_N,
    shaftPower_W,
    current_A,
    power_W: V * current_A, // electrical watts into the motor at full throttle
    limitedBy, // null, "current" or "power": which rating cut the throttle back
    tipMach: tipMach(prop, rev_s),
    freeTipMach: tipMach(prop, freeRev_s),
  };
};

// --- model 3: hover --------------------------------------------------------------------------------------
// Induced power from momentum theory, the ideal power a disc of area A needs to hold a thrust T:
//     P_ideal = T^1.5 / sqrt(2 ρ A)
// divided by DRONE_RULES.ROTOR_FIGURE_OF_MERIT to get real rotor shaft power. The electrical side is not a
// constant: the speed the propeller must turn at to make that thrust is known from the thrust formula, so the
// motor model gives the current honestly — torque I = Q / Kt + I0, back-EMF V_b = N / kv, and the watts into
// the motor are V_b · I + I² · Rm (back-EMF power plus copper loss). ESC loss is the one assumed number.
const hoverRotorPoint = (motor, prop, thrustPerRotor_N) => {
  const D = propDiameter_m(prop);
  const Kt = motorKt_Nm_A(motor);
  const Rm = motorResistance_ohm(motor);
  const kv = pos(motor?.kv);
  const I0 = fin(motor?.idleCurrent_A) ?? 0;
  if (D === null || !(thrustPerRotor_N > 0)) return null;
  const disc_m2 = (Math.PI * D * D) / 4;
  const ideal_W = thrustPerRotor_N ** 1.5 / Math.sqrt(2 * RHO * disc_m2);
  const shaft_W = ideal_W / ROTOR_FIGURE_OF_MERIT;
  const rev_s = revForThrust(prop, thrustPerRotor_N);
  if (rev_s === null || Kt === null || Rm === null || kv === null) return null;
  const torque_Nm = shaft_W / (2 * Math.PI * rev_s);
  const current_A = torque_Nm / Kt + I0;
  const backEmf_V = (rev_s * 60) / kv;
  const motor_W = backEmf_V * current_A + current_A * current_A * Rm;
  return { disc_m2, ideal_W, shaft_W, rev_s, current_A, motor_W, pack_W: motor_W / ESC_EFFICIENCY };
};

// --- airframe reading ------------------------------------------------------------------------------------
// How many motors a build carries, and how many of them lift it in a hover. They differ on a quadplane, whose
// cruise motor points forward and does nothing for the hover; on a tilt-rotor every motor tilts or lifts.
const motorCountOf = (airframe) => Math.max(0, Math.round(pos(airframe?.motorCount) ?? 0));
const hoverRotorCountOf = (airframe) => {
  if (airframe?.type === "vtol_quadplane") return Math.max(0, Math.round(pos(airframe?.liftMotorCount) ?? motorCountOf(airframe)));
  return motorCountOf(airframe);
};
// A quadplane's forward motors: the record's cruiseMotorCount, else whatever motorCount leaves after the lift
// rotors. Zero for every other type, whose motors are all counted as hover rotors.
const cruiseMotorCountOf = (airframe) => {
  if (airframe?.type !== "vtol_quadplane") return 0;
  const stated = pos(airframe?.cruiseMotorCount);
  return Math.max(0, Math.round(stated ?? motorCountOf(airframe) - hoverRotorCountOf(airframe)));
};
// The motors that pull a winged VTOL along in cruise, and so share its cruise shaft power: the quadplane's
// cruise motor(s), or a tilt-rotor's tilting motors (its tail motor only steadies the hover).
const cruisingMotorCountOf = (airframe) => {
  if (airframe?.type === "vtol_quadplane") return Math.max(1, cruiseMotorCountOf(airframe));
  if (airframe?.type === "vtol_tiltrotor") return Math.max(1, Math.round(pos(airframe?.tiltMotorCount) ?? motorCountOf(airframe)));
  return Math.max(1, motorCountOf(airframe));
};
const wingArea_m2 = (airframe) => (pos(airframe?.wingArea_dm2) === null ? null : airframe.wingArea_dm2 / 100); // 1 dm² = 0.01 m²
const span_m = (airframe) => mm(airframe?.wingspan_mm);
// Aspect ratio for the drag polar: the record's own figure, else span² / area, which is its definition.
const aspectRatioOf = (airframe) => {
  const ar = pos(airframe?.aspectRatio);
  if (ar !== null) return ar;
  const b = span_m(airframe);
  const S = wingArea_m2(airframe);
  return b === null || S === null ? null : (b * b) / S;
};
// A wing the model can fly: an area, and a way to its stall speed (a cl_max, or a stall speed its maker quotes).
const hasWing = (airframe) => wingArea_m2(airframe) !== null && (pos(airframe?.cl_max) !== null || quotedStall(airframe) !== null);
const mustHover = (airframe) => airframe?.type === "multirotor" || String(airframe?.type ?? "").startsWith("vtol");

// --- the wing in level flight ----------------------------------------------------------------------------
// Stall speed. A record that quotes its maker's stall speed at a stated weight (stallSpeed_at_490g_ms on the
// Eclipson: "STALL SPEED 24km/h" at its 490 g take-off weight) has that figure scaled to this build's weight —
// exactly, because stall speed goes as the square root of weight at a fixed CL_max. A quoted measurement beats
// a formula, so the cl_max formula V = sqrt(2 W / (ρ S CL_max)) is only the fallback for a record that quotes
// nothing and states a cl_max.
const quotedStall = (airframe) => {
  for (const key of Object.keys(airframe ?? {})) {
    const m = /^stallSpeed_at_(\d+(?:\.\d+)?)g_ms$/.exec(key);
    if (m && pos(airframe[key]) !== null) return { key, speed_ms: airframe[key], weight_g: Number(m[1]) };
  }
  return null;
};
const stallSpeed_ms = (airframe, weight_N) => {
  if (!(weight_N > 0)) return null;
  const quoted = quotedStall(airframe);
  if (quoted && quoted.weight_g > 0) {
    const weight_g = (weight_N / G0) * 1000;
    return quoted.speed_ms * Math.sqrt(weight_g / quoted.weight_g);
  }
  const S = wingArea_m2(airframe);
  const cl = pos(airframe?.cl_max);
  if (S === null || cl === null) return null;
  return Math.sqrt((2 * weight_N) / (RHO * S * cl));
};
// Pack watts to hold level flight at V. The aerodynamics are the wing's own drag polar: CL from the weight,
// CD = cd0 + CL² / (π e AR) from the record's cd0 and aspect ratio, drag power D·V, then the propeller.
// The electrical side goes through the SAME first-order motor model the hover path uses, not a bare efficiency
// constant: at cruise a motor is lightly loaded and its idle (iron) loss is a large share of what it draws, so
// charging only an ESC efficiency understated the draw badly (it was the reason a 612 g wing reported over an
// hour and a half on a 23 Wh pack). The speed the propeller must turn at to absorb that shaft power comes from
// the propeller's own power coefficient, P = Cp ρ n³ D⁵ — the right way round for power absorption, and it
// cross-checks: the Eclipson's 9x6 propeller comes out at a pitch speed within a few per cent of the airspeed,
// which is what a propeller at cruise does.
// motorCount is how many motors share that shaft power (one on a plain wing or a quadplane's single pusher,
// the two tilting nacelles on a tilt-rotor); each is run through the motor model at its share.
const cruisePower_W = (airframe, motor, prop, weight_N, V_ms, extra_W, motorCount = 1) => {
  const S = wingArea_m2(airframe);
  const cd0 = pos(airframe?.cd0);
  const AR = aspectRatioOf(airframe);
  const k = Math.max(1, Math.round(motorCount));
  if (S === null || cd0 === null || AR === null || !(V_ms > 0) || !(weight_N > 0)) return null;
  const q = 0.5 * RHO * V_ms * V_ms;
  const CL = weight_N / (q * S);
  const CD = cd0 + (CL * CL) / (Math.PI * OSWALD_EFFICIENCY * AR);
  const drag_N = q * S * CD;
  const shaft_W = (drag_N * V_ms) / CRUISE_PROP_EFFICIENCY;
  const motor_W = motorElectrical_W(motor, prop, shaft_W / k);
  if (motor_W === null) return null;
  return (k * motor_W) / ESC_EFFICIENCY + extra_W;
};
// Electrical watts into one motor for a given shaft power, through the motor model: find the speed the
// propeller absorbs that power at, then the torque, then the current, then back-EMF power plus copper loss.
const motorElectrical_W = (motor, prop, shaft_W) => {
  const D = propDiameter_m(prop);
  const cp = pos(prop?.cp_static);
  const Kt = motorKt_Nm_A(motor);
  const Rm = motorResistance_ohm(motor);
  const kv = pos(motor?.kv);
  const I0 = fin(motor?.idleCurrent_A) ?? 0;
  if (D === null || cp === null || Kt === null || Rm === null || kv === null || !(shaft_W > 0)) return null;
  const rev_s = (shaft_W / (cp * RHO * D ** 5)) ** (1 / 3);
  if (!(rev_s > 0)) return null;
  const torque_Nm = shaft_W / (2 * Math.PI * rev_s);
  const current_A = torque_Nm / Kt + I0;
  const backEmf_V = (rev_s * 60) / kv;
  return backEmf_V * current_A + current_A * current_A * Rm;
};
// Top speed of a multirotor, from the only two aerodynamic fields a multirotor record carries
// (frontalArea_m2, dragCoefficient_cd). In fast forward flight the disc tilts, so the rotors hold the weight
// and the drag at once: T cos θ = W and T sin θ = D. At full thrust D = sqrt(T² − W²), and setting that equal
// to ½ ρ V² Cd A gives the speed. This is the aerodynamic ceiling and it is optimistic: a tilted rotor makes
// less thrust than a level one, which this does not model.
const multirotorMaxSpeed_ms = (airframe, thrust_N, weight_N) => {
  const A = pos(airframe?.frontalArea_m2);
  const cd = pos(airframe?.dragCoefficient_cd);
  if (A === null || cd === null || !(thrust_N > weight_N) || !(weight_N > 0)) return null;
  const drag_N = Math.sqrt(thrust_N * thrust_N - weight_N * weight_N);
  return Math.sqrt((2 * drag_N) / (RHO * cd * A));
};

// --- the empty verdict -----------------------------------------------------------------------------------
// The shape every caller gets, with nothing resolved. evaluateDrone returns this (plus warnings) whenever a
// record is missing or unknown, the way evaluateBuild returns its zeroed object for an empty build.
const emptyVerdict = (warnings) => ({
  // shared shape, so the rocket UI keeps working unchanged
  stages: [],
  totalDeltaV_ms: 0,
  requiredDeltaV_ms: 0,
  marginDeltaV_ms: 0,
  liftoffTWR: 0,
  liftoffThrust_kN: 0,
  totalMass_kg: 0,
  deltaVOk: false,
  twrOk: false,
  feasible: false,
  closestRocketId: null,
  warnings,
  // drone
  vehicle: "drone",
  allUpWeight_g: 0,
  thrustPerMotor_g: 0,
  totalThrust_g: 0,
  hoverTWR: 0,
  punchOutTWR: 0,
  hoverThrottleShare: null,
  hoverPower_W: null,
  hoverCurrent_A: null,
  maxCurrent_A: null,
  hoverTime_min: null,
  mixedTime_min: null,
  range_km: null,
  cruiseSpeed_ms: null,
  maxSpeed_ms: null,
  stallSpeed_ms: null,
  discharge_C: null,
  dischargeOk: null,
  wingLoading_g_dm2: null,
  sub250: false,
  massBreakdown: [],
  mission: null,
  missionOk: { weight: null, endurance: null, twr: null, speed: null, payload: null },
  // extras the card needs to show a formula with its inputs
  packVoltage_V: null,
  motorCount: 0,
  hoverRotorCount: 0,
  cruiseMotorCount: 0,
  liftHoverPower_W: null,
  liftHoverTime_min: null,
  modelNotes: [],
  blockingWarnings: warnings.slice(),
});

// --- evaluateDrone ---------------------------------------------------------------------------------------
// Field meanings, so nothing on a card is ambiguous:
//   thrustPerMotor_g / totalThrust_g  grams-force at FULL throttle, from models 1 and 2
//   hoverTWR                          totalThrust_g / allUpWeight_g — how many times its own weight it can lift
//   punchOutTWR                       the SAME number: our thrust is already a full-throttle figure, so there
//                                     is no second, higher number to report. hoverThrottleShare = 1 / hoverTWR
//                                     is the useful companion: the share of throttle a steady hover needs.
//   hoverPower_W / hoverCurrent_A     electrical, out of the pack, holding a steady hover (model 3), including
//                                     the payload's own power_W and the avionics allowance
//   maxCurrent_A                      electrical, out of the pack, at full throttle: what the pack must supply
//   hoverTime_min                     steady-flight endurance: hover for a rotorcraft, level cruise for a wing
//   mixedTime_min                     hoverTime_min / DRONE_RULES.MIXED_POWER_FACTOR
export const evaluateDrone = (build, droneCatalog) => {
  const warnings = [];
  const blocking = new Set();
  const addBlocking = (message) => {
    warnings.push(message);
    blocking.add(message);
  };
  const add = (message) => warnings.push(message);
  // Model notes are not problems with the build: they say where the model is simpler than the vehicle (a duct
  // left out, a coaxial loss not sourced yet). Kept out of warnings because the readiness panel counts every
  // warning as a parts problem.
  const modelNotes = [];
  const note = (message) => modelNotes.push(message);

  if (!build || typeof build !== "object") {
    return emptyVerdict(["empty build"]);
  }
  const cat = droneCatalog && typeof droneCatalog === "object" ? droneCatalog : {};

  const airframe = byId(cat.airframes, build.airframeId);
  const motor = byId(cat.motors, build.motorId);
  const propeller = byId(cat.propellers, build.propellerId);
  const battery = byId(cat.batteries, build.batteryId);
  const payload = build.payloadId ? byId(cat.payloads, build.payloadId) : undefined;
  const mission = build.missionId ? byId(cat.missions, build.missionId) : undefined;

  // The four parts a drone cannot fly without. A missing id and an unknown id read differently on purpose.
  const need = [
    ["airframe", build.airframeId, airframe],
    ["motor", build.motorId, motor],
    ["propeller", build.propellerId, propeller],
    ["battery", build.batteryId, battery],
  ];
  for (const [slot, id, record] of need) {
    if (!id) addBlocking(`no ${slot} chosen yet`);
    else if (!record) addBlocking(`unknown ${slot} id: ${id}`);
  }
  if (build.payloadId && !payload) addBlocking(`unknown payload id: ${build.payloadId}`);
  if (build.missionId && !mission) addBlocking(`unknown mission id: ${build.missionId}`);
  if (blocking.size > 0) return emptyVerdict(warnings);
  // A quadplane carries two power trains: the lift motors and propellers in the build's motor and propeller
  // slots, and a forward cruise motor and propeller named by build.cruiseMotorId / build.cruisePropellerId (a
  // preset sets them; the shelf has no slot for them). Missing or unknown, the cruise train falls back to the
  // lift records, which is how a quadplane was evaluated before the build could name its own cruise motor.
  const cruiseMotorCount = cruiseMotorCountOf(airframe);
  const cruiseMotor = (cruiseMotorCount > 0 && byId(cat.motors, build.cruiseMotorId)) || motor;
  const cruiseProp = (cruiseMotorCount > 0 && byId(cat.propellers, build.cruisePropellerId)) || propeller;
  if (cruiseMotorCount > 0 && (cruiseMotor === motor || cruiseProp === propeller)) {
    note(`${airframe.name} has no cruise motor or propeller of its own in this build: cruise is worked out on the lift ones`);
  }

  // The numbers the thrust model cannot do without. Checked together and up front so that nothing below has to
  // divide by a missing value: a build that gets this far has a pack voltage, a motor count and a working
  // motor-and-propeller pair, and every formula after this point is safe.
  const motorCount = motorCountOf(airframe);
  const packV = packVoltage_V(battery);
  const point = packV === null ? null : motorAtFullThrottle(motor, propeller, packV);
  if (motorCount < 1) addBlocking(`${airframe.name} does not say how many motors it carries`);
  if (packV === null) addBlocking(`${battery.name} does not say how many cells it has, so there is no pack voltage`);
  else if (!point) addBlocking(`cannot work out what ${motor.name} does with ${propeller.name}: a record is missing a number the thrust model needs`);
  if (blocking.size > 0) return emptyVerdict(warnings);
  if (!VOLTS_PER_CELL[battery.chemistry]) add(`unknown battery chemistry "${battery.chemistry}": treated as LiPo at ${VOLTS_PER_CELL_FALLBACK} V a cell`);

  // --- weight -----------------------------------------------------------------------------------------
  const hoverRotorCount = hoverRotorCountOf(airframe);
  // Motors in the build's motor slot: all of them, except on a quadplane, whose cruise motor(s) are separate.
  const slotMotorCount = motorCount - cruiseMotorCount;
  const empty_g = pos(airframe.emptyWeight_g) ?? 0;
  const motors_g = slotMotorCount * (pos(motor.weight_g) ?? 0);
  const props_g = slotMotorCount * (pos(propeller.weight_g) ?? 0);
  const cruiseMotors_g = cruiseMotorCount * (pos(cruiseMotor.weight_g) ?? 0);
  const cruiseProps_g = cruiseMotorCount * (pos(cruiseProp.weight_g) ?? 0);
  const battery_g = pos(battery.weight_g) ?? 0;
  const payload_g = pos(payload?.weight_g) ?? 0;
  // The electronics a record states (electronicsWeight_g: a sourced figure for that frame's ESCs, flight
  // controller and wiring, explained in its notes) beat the generic 5-inch allowance, which is far too light for
  // a hexacopter's six ESCs.
  const electronics_g = fin(airframe.electronicsWeight_g) !== null && airframe.electronicsWeight_g >= 0 ? airframe.electronicsWeight_g : ELECTRONICS_ALLOWANCE_G;
  const massBreakdown = [
    { label: `${airframe.name} (empty)`, grams: empty_g },
    { label: `${slotMotorCount} × ${motor.name}`, grams: motors_g },
    { label: `${slotMotorCount} × ${propeller.name}`, grams: props_g },
    ...(cruiseMotorCount > 0
      ? [
          { label: `${cruiseMotorCount} × ${cruiseMotor.name} (cruise)`, grams: cruiseMotors_g },
          { label: `${cruiseMotorCount} × ${cruiseProp.name} (cruise)`, grams: cruiseProps_g },
        ]
      : []),
    { label: battery.name, grams: battery_g },
    ...(payload ? [{ label: payload.name, grams: payload_g }] : []),
    { label: "Electronics (FC, ESC, VTX, wiring)", grams: electronics_g },
  ];
  // An airframe that does not publish its empty weight (a 3D-printed kit whose weight depends on the print)
  // cannot be weighed, and every number below would quietly leave the airframe out. Blocking, so the verdict
  // can never call such a build ready; the other numbers are still worked out and shown, labelled by this.
  if (pos(airframe.emptyWeight_g) === null) {
    addBlocking(`${airframe.name} publishes no empty weight, so the all-up weight leaves the airframe out and every figure here is optimistic`);
  }
  const allUpWeight_g = massBreakdown.reduce((sum, r) => sum + r.grams, 0);
  const totalMass_kg = allUpWeight_g / 1000;
  const weight_N = totalMass_kg * G0;

  // --- thrust -----------------------------------------------------------------------------------------
  // A coaxial pair loses thrust to the lower rotor working in the upper one's wake. Applied only when the
  // record says coaxial and DRONE_RULES carries a sourced factor; otherwise the loss is left out, out loud.
  const coaxial = airframe.coaxial === true;
  const coaxFactor = coaxial && pos(COAXIAL_THRUST_FACTOR) !== null ? COAXIAL_THRUST_FACTOR : 1;
  if (coaxial && coaxFactor === 1) note(`${airframe.name} is coaxial, and no sourced coaxial thrust loss is in the rules yet: its lift is an upper bound`);
  if (airframe.ducted === true) note(`${airframe.name} is ducted; no source in the dataset measures its duct's effect, so its propellers are modelled as open`);
  const thrustPerMotor_N = point.thrust_N * coaxFactor;
  const thrustPerMotor_g = (thrustPerMotor_N / G0) * 1000;
  const liftingThrust_N = hoverRotorCount * thrustPerMotor_N;
  const totalThrust_g = (liftingThrust_N / G0) * 1000;
  const hoverTWR = allUpWeight_g > 0 ? totalThrust_g / allUpWeight_g : 0;
  // Our thrust is a full-throttle figure, so there is no higher punch-out number to report: see the header.
  const punchOutTWR = hoverTWR;
  const hoverThrottleShare = hoverTWR > 0 ? 1 / hoverTWR : null;

  // Physical fits that stop the build dead. The same three rules droneCompat.js marks incompatible, repeated
  // here so the verdict can block a build the shelf let through (physics.evaluateBuild does the same with the
  // propellant and engine-fit rules).
  const maxProp_in = pos(airframe.maxPropDiameter_in);
  const prop_in = pos(propeller.diameter_in);
  if (maxProp_in !== null && prop_in !== null && prop_in > maxProp_in) {
    addBlocking(`a ${prop_in}" propeller does not fit a frame built for ${maxProp_in}": the blades would hit the arms`);
  }
  const mount_mm = pos(airframe.motorMount_mm);
  const circle_mm = pos(motor.mountCircle_mm);
  if (mount_mm !== null && circle_mm !== null && Math.abs(mount_mm - circle_mm) > 0.01) {
    addBlocking(`${motor.name} bolts on a ${circle_mm} mm pattern, the frame has ${mount_mm} mm: the screws miss the holes`);
  }
  const bore_mm = pos(propeller.shaftHole_mm);
  const shaft_mm = pos(motor.propShaftDiameter_mm);
  if (bore_mm !== null && shaft_mm !== null && bore_mm < shaft_mm - 0.01) {
    addBlocking(`${propeller.name}'s ${bore_mm} mm bore will not go over a ${shaft_mm} mm shaft`);
  }
  // Thrust-to-weight. A rotorcraft that cannot lift itself is blocked; a wing is judged on a looser rule
  // because it is carried by its wing, not its propeller.
  if (mustHover(airframe)) {
    if (hoverTWR < 1) addBlocking(`it cannot lift itself: ${grams(totalThrust_g)} g of thrust under ${grams(allUpWeight_g)} g of drone`);
    else if (hoverTWR < HOVER_TWR_MIN) addBlocking(`hover thrust-to-weight ${hoverTWR.toFixed(2)} is below ${HOVER_TWR_MIN}: nothing left to hold altitude with`);
    else if (hoverTWR < HOVER_TWR_OK) add(`hover thrust-to-weight ${hoverTWR.toFixed(2)} is below ${HOVER_TWR_OK}: it will feel sluggish`);
  } else if (hoverTWR < WING_STATIC_TWR_MIN) {
    addBlocking(`static thrust-to-weight ${hoverTWR.toFixed(2)} is below ${WING_STATIC_TWR_MIN}: it cannot climb away from a launch`);
  }
  // Propeller tip speed, a real limit on the blades.
  if (fin(point.tipMach) !== null && point.tipMach > TIP_MACH_LIMIT) {
    add(`${propeller.name} tips reach Mach ${point.tipMach.toFixed(2)} on a ${battery.cells_s}S pack, past the Mach ${TIP_MACH_LIMIT} the blades are safe at`);
  }
  if (point.limitedBy) {
    const rated = point.limitedBy === "current" ? `${motor.maxCurrent_A} A` : `${motor.maxPower_W} W`;
    add(`${motor.name} is over-propped on ${propeller.name}: the ESC has to hold it to its ${rated} rating, so this is all the thrust there is`);
  }

  // --- hover power and endurance ------------------------------------------------------------------------
  const extraPower_W = (pos(payload?.power_W) ?? 0) + AVIONICS_POWER_W;
  // Each rotor of a coaxial pair has to make 1 / coaxFactor more thrust to hold its share of the weight.
  const rotorHover = hoverRotorCount > 0 ? hoverRotorPoint(motor, propeller, weight_N / hoverRotorCount / coaxFactor) : null;
  const hoverPack_W = rotorHover ? hoverRotorCount * rotorHover.pack_W + extraPower_W : null;
  // A rotorcraft's steady-flight power is its hover power. A pure fixed wing never hovers, so its steady
  // figure is level cruise through the drag polar — the same question, answered with the wing it actually has.
  // A winged VTOL hovers only to take off and land and flies the job as a wing, so its steady figure is the
  // wing's cruise too (on its cruise motor and propeller), and the hover-only figure is reported beside it as
  // liftHoverTime_min. A VTOL record with no wing data keeps the hover figure.
  const isPureWing = airframe.type === "fixed_wing_3dprint";
  const isVtol = String(airframe.type ?? "").startsWith("vtol");
  const stall_ms = hasWing(airframe) ? stallSpeed_ms(airframe, weight_N) : null;
  // A cruise speed the maker publishes (cruiseSpeed_ms, measured on its own flight test) beats the
  // stall × CRUISE_STALL_FACTOR convention, the same way a quoted stall speed beats the cl_max formula.
  const publishedCruise_ms = wingArea_m2(airframe) !== null ? pos(airframe.cruiseSpeed_ms) : null;
  const cruiseSpeed_ms = publishedCruise_ms ?? (stall_ms === null ? null : stall_ms * CRUISE_STALL_FACTOR);
  const cruisePack_W =
    cruiseSpeed_ms === null ? null : cruisePower_W(airframe, cruiseMotor, cruiseProp, weight_N, cruiseSpeed_ms, extraPower_W, cruisingMotorCountOf(airframe));
  const isWingedVtol = isVtol && cruisePack_W !== null;
  // A VTOL with a wing but no drag data (no cd0 published) flies its job as a wing, and the wing's cruise power
  // cannot be worked out. Its endurance is NOT JUDGED rather than judged on the hover figure: hovering the whole
  // mission is not what it does, so the hover number would fail it for the wrong reason. A pure wing without a
  // cd0 is in the same position. Missing drag data is a gap in the model, not a problem with the build, so it is
  // a model note and does not block (a multirotor without drag data has its speed check skipped the same way).
  // A VTOL's hover-only figure stays as liftHoverTime_min.
  const cruiseNotJudged = (isVtol || isPureWing) && wingArea_m2(airframe) !== null && cruisePack_W === null;
  if (cruiseNotJudged) {
    note(`${airframe.name} publishes no drag figure (cd0), so its cruise power, cruise endurance and range are not judged; hover on the lift rotors is`);
  }
  const hoverPower_W = isPureWing || isWingedVtol ? cruisePack_W : cruiseNotJudged ? null : hoverPack_W;
  const hoverCurrent_A = hoverPower_W !== null ? hoverPower_W / packV : null;
  // Worst case for the pack: every motor at full throttle at once. That is what a quadplane's transition
  // actually does (lift rotors still turning while the cruise motor spools up), so every motor, not just the
  // hover rotors. The avionics and payload draw ride on top of it.
  const cruisePoint = cruiseMotorCount > 0 ? motorAtFullThrottle(cruiseMotor, cruiseProp, packV) : null;
  const maxCurrent_A = slotMotorCount * point.current_A + cruiseMotorCount * (cruisePoint?.current_A ?? point.current_A) + extraPower_W / packV;

  const usable_Wh = (pos(battery.energy_Wh) ?? 0) * USABLE_PACK_SHARE;
  const hoverTime_min = hoverPower_W !== null && hoverPower_W > 0 && usable_Wh > 0 ? (usable_Wh / hoverPower_W) * 60 : null;
  const mixedTime_min = hoverTime_min === null ? null : hoverTime_min / MIXED_POWER_FACTOR;
  // Hover alone on the lift rotors: the number a VTOL's takeoff and landing budget is made of. Equal to
  // hoverTime_min for a multirotor; null for a pure wing.
  const liftHoverTime_min = !isPureWing && hoverPack_W !== null && hoverPack_W > 0 && usable_Wh > 0 ? (usable_Wh / hoverPack_W) * 60 : null;
  if (hoverTime_min === null && !cruiseNotJudged) {
    add(usable_Wh > 0 ? `there is no steady-flight power for a ${airframe.type}, so there is no flight time` : `${battery.name} does not say how much energy it holds, so there is no flight time`);
  }

  // --- discharge ---------------------------------------------------------------------------------------
  // discharge_C is the hover draw in C, the figure a pilot reads off a pack's label. The pass/fail question is
  // the harder one: can the pack supply the current the motors want at full throttle? maxDischargeCurrent_A is
  // in every record; continuousC × capacity is the same number worked out the long way, as a fallback.
  const capacity_Ah = (pos(battery.capacity_mAh) ?? 0) / 1000;
  const discharge_C = hoverCurrent_A !== null && capacity_Ah > 0 ? hoverCurrent_A / capacity_Ah : null;
  const rated_A = pos(battery.maxDischargeCurrent_A) ?? (pos(battery.continuousC) !== null && capacity_Ah > 0 ? battery.continuousC * capacity_Ah : null);
  const dischargeOk = rated_A === null ? null : maxCurrent_A <= rated_A;
  if (dischargeOk === false) {
    addBlocking(`pack can't supply the current the motors want: ${amps(maxCurrent_A)} A needed, ${amps(rated_A)} A rated`);
  }
  if (rated_A === null) add(`${battery.name} does not say how much current it can give, so the discharge check is skipped`);

  // --- speeds, range, wing loading ---------------------------------------------------------------------
  // A multirotor has no honest cruise speed in these records: nothing says what "cruise" means for one, and a
  // static thrust coefficient cannot be read as a forward-flight polar. So cruiseSpeed_ms stays null for a
  // multirotor and range_km with it; the top speed below is the one forward-flight number its record supports.
  const maxSpeed_ms = hasWing(airframe) ? null : multirotorMaxSpeed_ms(airframe, liftingThrust_N, weight_N);
  const cruiseEndurance_min = cruisePack_W !== null && cruisePack_W > 0 && usable_Wh > 0 ? (usable_Wh / cruisePack_W) * 60 : null;
  const range_km = cruiseSpeed_ms !== null && cruiseEndurance_min !== null ? (cruiseSpeed_ms * cruiseEndurance_min * 60) / 1000 : null;
  const wingArea_dm2 = pos(airframe.wingArea_dm2);
  const wingLoading_g_dm2 = wingArea_dm2 === null ? null : allUpWeight_g / wingArea_dm2;

  // --- the 250 g line ----------------------------------------------------------------------------------
  const sub250 = allUpWeight_g < SUB_250_G;

  // --- mission -----------------------------------------------------------------------------------------
  // A requirement this build cannot be measured against is null, never true.
  //
  // ENDURANCE IS JUDGED ON mixedTime_min, NOT hoverTime_min, EVERYWHERE. A mission's targetEndurance_min is
  // how long the aircraft must stay up while doing the job — transiting 15 km, sweeping a grid, flying a race
  // line — and none of that is a motionless hover. hoverTime_min is the best case the pack can ever give, so
  // measuring a mission against it would pass builds that cannot finish the mission. The readiness panel
  // compares against mixedTime_min for the same reason, and the two must never quote different numbers at the
  // user, so this is the one comparator: missionOk.endurance, the shortfall warning, and droneReadiness all
  // read mixedTime_min.
  //
  // The speed row needs a word too: the mission asks for a minimum cruise speed, and a multirotor has no
  // cruise figure, so for one it is judged on the top speed instead — which is generous, and said so on the card.
  const speedRef_ms = cruiseSpeed_ms ?? maxSpeed_ms;
  const missionOk = {
    weight: mission && pos(mission.maxAllowableWeight_g) !== null ? allUpWeight_g <= mission.maxAllowableWeight_g : null,
    endurance: mission && pos(mission.targetEndurance_min) !== null && mixedTime_min !== null ? mixedTime_min >= mission.targetEndurance_min : null,
    twr: mission && pos(mission.requiredHoverTWR) !== null ? hoverTWR >= mission.requiredHoverTWR : null,
    speed: mission && pos(mission.minCruiseSpeed_ms) !== null && speedRef_ms !== null ? speedRef_ms >= mission.minCruiseSpeed_ms : null,
    payload: mission && mission.requiredPayloadId ? build.payloadId === mission.requiredPayloadId : null,
  };
  if (missionOk.payload === false) {
    const wanted = byId(cat.payloads, mission.requiredPayloadId);
    add(`${mission.name} wants ${wanted?.name ?? mission.requiredPayloadId} fitted`);
  }
  if (missionOk.weight === false) add(`${grams(allUpWeight_g)} g all-up, over this mission's ${grams(mission.maxAllowableWeight_g)} g limit`);
  if (missionOk.endurance === false) add(`${mixedTime_min.toFixed(1)} min of mixed flying, ${(mission.targetEndurance_min - mixedTime_min).toFixed(1)} min short of this mission`);
  if (missionOk.twr === false) add(`hover thrust-to-weight ${hoverTWR.toFixed(2)}, this mission wants ${mission.requiredHoverTWR}`);

  const twrOk = mustHover(airframe) ? hoverTWR >= HOVER_TWR_OK : hoverTWR >= WING_STATIC_TWR_MIN;
  const feasible = blocking.size === 0 && (mustHover(airframe) ? hoverTWR >= HOVER_TWR_MIN : twrOk);

  return {
    // shared shape, so the rocket UI keeps working unchanged
    stages: [],
    totalDeltaV_ms: 0,
    requiredDeltaV_ms: 0,
    marginDeltaV_ms: 0,
    liftoffTWR: hoverTWR,
    liftoffThrust_kN: liftingThrust_N / 1000,
    totalMass_kg,
    // A drone has no delta-v requirement, so this cannot fail; true keeps any rocket UI that gates on it quiet.
    deltaVOk: true,
    twrOk,
    feasible,
    closestRocketId: null,
    warnings,
    // drone
    vehicle: "drone",
    allUpWeight_g,
    thrustPerMotor_g,
    totalThrust_g,
    hoverTWR,
    punchOutTWR,
    hoverThrottleShare,
    hoverPower_W,
    hoverCurrent_A,
    maxCurrent_A,
    hoverTime_min,
    mixedTime_min,
    range_km,
    cruiseSpeed_ms,
    maxSpeed_ms,
    stallSpeed_ms: stall_ms,
    discharge_C,
    dischargeOk,
    wingLoading_g_dm2,
    sub250,
    massBreakdown,
    mission: mission ?? null,
    missionOk,
    // Extras the card needs to print a formula with its inputs. workingPoint is the one full-throttle solution
    // every other number here came from, passed on so ui/droneCard.js quotes the same figures by construction
    // rather than solving the motor a second time.
    packVoltage_V: packV,
    motorCount,
    hoverRotorCount,
    cruiseMotorCount,
    liftHoverPower_W: hoverPack_W,
    liftHoverTime_min,
    airframeType: airframe.type ?? null,
    workingPoint: {
      rpm: point.rpm,
      freeRpm: point.freeRev_s * 60,
      thrust_g: thrustPerMotor_g,
      current_A: point.current_A,
      power_W: point.power_W,
      shaftPower_W: point.shaftPower_W,
      tipMach: point.tipMach,
      limitedBy: point.limitedBy,
    },
    modelNotes,
    blockingWarnings: [...blocking],
  };
};

// --- droneDetails ----------------------------------------------------------------------------------------
// One row per configurator slot, bottom-up in build order, the role physics.stageDetails plays for a rocket:
// the per-slot numbers the card footer shows, plus the warnings that slot caused. A row always exists for every
// slot, with record null and null numbers when nothing is chosen, so the card never has to guard.
//   slot      "airframe" | "motor" | "propeller" | "battery" | "payload"
//   record    the dataset record, or null
//   mass_g    what this slot adds to the all-up weight (motors and propellers are already × motorCount)
//   share     mass_g / allUpWeight_g, or null when there is no weight yet
//   warnings  the verdict's warning strings that name this slot's record
export const droneDetails = (build, droneCatalog) => {
  const verdict = evaluateDrone(build, droneCatalog);
  const cat = droneCatalog && typeof droneCatalog === "object" ? droneCatalog : {};
  const b = build && typeof build === "object" ? build : {};
  const airframe = byId(cat.airframes, b.airframeId) ?? null;
  const motor = byId(cat.motors, b.motorId) ?? null;
  const propeller = byId(cat.propellers, b.propellerId) ?? null;
  const battery = byId(cat.batteries, b.batteryId) ?? null;
  const payload = byId(cat.payloads, b.payloadId) ?? null;
  const motorCount = motorCountOf(airframe);
  // A quadplane's cruise motor and propeller have no slot of their own; their grams ride in the motor and
  // propeller rows (count says how many lift units there are), so the rows still add up to the verdict.
  const cruiseCount = cruiseMotorCountOf(airframe);
  const cruiseMotor = byId(cat.motors, b.cruiseMotorId) ?? motor;
  const cruiseProp = byId(cat.propellers, b.cruisePropellerId) ?? propeller;
  const cruiseGrams = (record) => cruiseCount * (pos(record?.weight_g) ?? 0);
  const electronics_g = fin(airframe?.electronicsWeight_g) !== null && airframe.electronicsWeight_g >= 0 ? airframe.electronicsWeight_g : ELECTRONICS_ALLOWANCE_G;
  const packV = battery ? packVoltage_V(battery) : null;
  const point = motor && propeller && packV ? motorAtFullThrottle(motor, propeller, packV) : null;
  const auw = verdict.allUpWeight_g;
  const share = (g) => (auw > 0 ? g / auw : null);
  // A warning belongs to a slot when it names that slot's record. Simple, and it matches how the warning
  // strings are written: every one of them starts from or mentions the part that caused it.
  const mine = (record) => (record?.name ? verdict.warnings.filter((w) => w.includes(record.name)) : []);

  const rows = [
    {
      slot: "airframe",
      record: airframe,
      mass_g: airframe ? pos(airframe.emptyWeight_g) ?? 0 : null,
      count: 1,
      motorCount,
      hoverRotorCount: verdict.hoverRotorCount,
      wingLoading_g_dm2: verdict.wingLoading_g_dm2,
      stallSpeed_ms: verdict.stallSpeed_ms,
      maxSpeed_ms: verdict.maxSpeed_ms,
      warnings: mine(airframe),
    },
    {
      slot: "motor",
      record: motor,
      mass_g: motor ? (motorCount - cruiseCount) * (pos(motor.weight_g) ?? 0) + cruiseGrams(cruiseMotor) : null,
      count: motorCount - cruiseCount,
      cruiseCount,
      rpm: point?.rpm ?? null,
      freeRpm: point ? point.freeRev_s * 60 : null,
      thrust_g: point ? (point.thrust_N / G0) * 1000 : null,
      current_A: point?.current_A ?? null,
      power_W: point?.power_W ?? null,
      limitedBy: point?.limitedBy ?? null,
      warnings: mine(motor),
    },
    {
      slot: "propeller",
      record: propeller,
      mass_g: propeller ? (motorCount - cruiseCount) * (pos(propeller.weight_g) ?? 0) + cruiseGrams(cruiseProp) : null,
      count: motorCount - cruiseCount,
      cruiseCount,
      rpm: point?.rpm ?? null,
      thrust_g: point ? (point.thrust_N / G0) * 1000 : null,
      shaftPower_W: point?.shaftPower_W ?? null,
      tipMach: point?.tipMach ?? null,
      warnings: mine(propeller),
    },
    {
      slot: "battery",
      record: battery,
      mass_g: battery ? pos(battery.weight_g) ?? 0 : null,
      count: 1,
      packVoltage_V: packV,
      usable_Wh: battery ? (pos(battery.energy_Wh) ?? 0) * USABLE_PACK_SHARE : null,
      hoverCurrent_A: verdict.hoverCurrent_A,
      maxCurrent_A: verdict.maxCurrent_A,
      discharge_C: verdict.discharge_C,
      dischargeOk: verdict.dischargeOk,
      hoverTime_min: verdict.hoverTime_min,
      mixedTime_min: verdict.mixedTime_min,
      warnings: mine(battery),
    },
    {
      slot: "payload",
      record: payload,
      mass_g: payload ? pos(payload.weight_g) ?? 0 : null,
      count: 1,
      power_W: payload ? pos(payload.power_W) ?? 0 : null,
      warnings: mine(payload),
    },
    {
      slot: "electronics",
      record: null,
      mass_g: electronics_g,
      count: 1,
      power_W: AVIONICS_POWER_W,
      warnings: [],
    },
  ];
  return rows.map((r) => ({ ...r, share: r.mass_g === null ? null : share(r.mass_g) }));
};

// --- rounded view of a verdict, for a check script or a log line -----------------------------------------
// Not used by the UI (the card formats its own numbers): a tidy one-liner for scripts/check-drone-physics.mjs.
export const droneSummary = (verdict) => ({
  auw_g: round(verdict.allUpWeight_g, 1),
  thrustPerMotor_g: round(verdict.thrustPerMotor_g, 0),
  hoverTWR: round(verdict.hoverTWR, 2),
  hoverPower_W: round(verdict.hoverPower_W, 1),
  hoverTime_min: round(verdict.hoverTime_min, 1),
  maxCurrent_A: round(verdict.maxCurrent_A, 1),
  feasible: verdict.feasible,
});
