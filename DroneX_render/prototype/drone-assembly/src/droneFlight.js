// Drone flight: what the Take-off button runs. A rocket's launch is an ascent trajectory, staging and an
// orbit; a drone's is none of those. A multirotor spools its motors up where it stands, unsticks from the pad,
// climbs to a hover, flies a loop out and back and sets down again. A fixed wing cannot hover, so it flies like
// a plane: a take-off roll, a climb-out, one circuit, a final approach and a roll-out back to where it started.
// One with no landing gear on a launch stand (bounds.stand) is rail-launched off it instead, and belly-lands
// behind it with the motor cut and the prop parked, then is put back on it (see wingPlan).
//
//   createDroneFlight({ root, camera, controls, sfx, onTelemetry, onEnd }) ->
//     { start({ parts, verdict, mission }), update(dt), stop(), active, phase }
//
// What moves. Not `root`: the pad hangs off it too, and choreo.update() puts root back at the origin every frame
// its shake is over (which is why an earlier version that tweened root never left the ground). The flight makes
// its own group, `craft`, pivoted on the vehicle's centre, hangs every part group off it for the flight and puts
// them back on root afterwards, exactly where they were. Everything is driven from update(dt) on a closed-form
// path of time (no tweens), so a frame written here is the frame that renders: update() runs after choreo's and
// after controls.update() in main's loop.
//
// The propellers: each piece of a propeller part is turned about the propeller's own hub axis (the piece's
// userData.spinAxis through its origin when droneParts.js tags it, else found from the geometry: the thin
// direction of the disc, through the centroid of the blades), so a quad's props and a wing's
// nose prop both spin on their hubs whatever their pieces' origins are. Fast, the blades give way to a
// translucent blur disc added here at runtime (droneParts.js is not touched).
//
// Timings, heights, path shapes and the camera are visual choices (named below), never shown as facts. Every
// NUMBER on the telemetry line and in the summary comes from dronePhysics' verdict and is labelled est.
import * as THREE from "three";

const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- visual choices: shape and pace only, never shown on screen as facts ----
// Multirotor, seconds of flight clock per phase.
const QUAD = { spool: 1.6, lift: 2.8, hover: 1.2, loop: 10, home: 1.0, descend: 3.0, spoolDown: 1.4 };
const HOVER_H_K = 0.9; // hover height above the pad, in vehicle widths
const LOOP_A_K = 1.6; // the loop's half-length (out from the pad), in vehicle widths
const LOOP_B_K = 0.85; // its half-width
const LOOP_RISE_K = 0.25; // how much higher the far end of the loop is flown, in vehicle widths
const QUAD_G_U = 13; // the "gravity" the lean is worked out against (u/s²): sets how far it leans into a turn
const MAX_TILT = 0.42; // radians: no lean past ~24°
// Multirotor flight characters (the vehicle is always drawn the same width, so its size has to come across in
// how it moves): a 5" quad as above; a heavy-lift hex slower, gentler and flatter; a whoop quick and tight.
const QUAD_PROFILE = { T: QUAD, hoverK: HOVER_H_K, loopA: LOOP_A_K, loopB: LOOP_B_K, rise: LOOP_RISE_K, maxTilt: MAX_TILT, bob: 1, yawTau: 0.35 };
const HEAVY_PROFILE = { T: { spool: 2.2, lift: 4.0, hover: 1.6, loop: 14, home: 1.4, descend: 4.4, spoolDown: 1.8 }, hoverK: 0.75, loopA: 1.5, loopB: 0.8, rise: 0.15, maxTilt: 0.2, bob: 0.4, yawTau: 0.9 };
const WHOOP_PROFILE = { T: { spool: 1.0, lift: 1.7, hover: 0.6, loop: 6.5, home: 0.6, descend: 2.1, spoolDown: 1.0 }, hoverK: 0.8, loopA: 1.05, loopB: 0.55, rise: 0.3, maxTilt: 0.5, bob: 1.3, yawTau: 0.2 };
const GEAR_S = 1.6; // seconds for retractable landing gear to swing up or down
// Quadplane: hover on the lift rotors, transition to wing-borne flight on the cruise motor, a circuit, back.
const VTOL = { spool: 1.8, lift: 3.0, hover: 1.0, accel: 4.2, decel: 4.6, home: 1.0, descend: 3.4, spoolDown: 1.4 };
const VTOL_H_K = 0.7; // hover height, in spans
const VTOL_CIRCUIT_K = 0.45; // the circuit flown this much higher than the hover, in spans
const VTOL_TILT = 0.18; // radians: how far it leans on its lift rotors
const LIFT_OFF_AT = 0.8; // share of cruise speed by which the lift rotors have spun down (and back up)
// Fixed wing.
const WING = { spool: 1.8, spoolDown: 1.4 };
const WING_V_K = 1.15; // airspeed in vehicle spans per second (slow motion: the HUD shows the real cruise speed)
const ROLL_K = 1.4; // take-off roll length in spans
const ROLLOUT_K = 1.4; // landing roll-out length in spans
const WING_G_U = 18; // bank is worked out against this (u/s²)
const MAX_BANK = 0.62;
const CLIMB_AOA = 0.07; // nose above the flight path in the climb, radians
const FLARE_AOA = 0.12; // and in the flare
// From a launch stand (droneLayout.js STAND_CLEAR: a fixed wing has no landing gear, so it rests on a stand that
// keeps its nose propeller's disc off the deck). It spools up on the stand, is shot forward along it like a
// rail launch, and on the way home cuts the motor on final, parks the blades where they hang highest, belly-lands
// on the deck behind the stand, slides to a stop and is put back on the stand.
const SLIDE_K = 0.3; // belly slide length, in spans
const PARK_S = 0.7; // seconds for the blades to wind down to their parked angle
const CUT_ALT_K = 0.3; // on final, the motor is cut below this height above the stand, in spans
const RESET_S = 2.2; // seconds to lift it back onto the stand
const DECK_MAT_K = 0.006; // the landing mat's top above the deck, in spans (anchors.js DPAD.matT × radius_u)
// Propellers.
const IDLE_RPS = 3; // turns per second at idle
const FLIGHT_RPS = 28; // at hover throttle (the disc's streaks turn at this)
const BLADE_RPS_MAX = 4.5; // the blades themselves never turn faster on screen than this: no strobing
const BLUR_FROM = 0.22; // throttle where the blur disc starts to show
const BLUR_FULL = 0.62; // and where the blades have given way to it
const DISC_ALPHA = 0.85; // disc material opacity at full blur (the texture carries its own alpha)
// Downwash.
const RING_LIFE = 1.5; // seconds a dust ring lives
const RING_EVERY = 0.16; // seconds between rings at full strength
const RING_POOL = 10;
// Camera.
const CAM_TAU = { az: 0.9, el: 0.8, d: 0.9, target: 0.12 }; // smoothing time constants, seconds

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => clamp(x, 0, 1);
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const smoother = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (dt, tau) => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const fin = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const num = (x, dp = 0) => (fin(x) === null ? "—" : x.toFixed(dp));

const UP = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const PHASE_LABEL = {
  spool: "ARMED",
  strain: "NO LIFT",
  lift: "LIFT-OFF",
  hover: "HOVER",
  loop: "MISSION LEG",
  home: "HOVER",
  descend: "LANDING",
  spoolDown: "LANDED",
  transition: "TRANSITION",
  cruise: "WING-BORNE",
  backTransition: "BACK-TRANSITION",
  roll: "TAKE-OFF ROLL",
  climb: "CLIMB-OUT",
  circuit: "CIRCUIT",
  final: "FINAL",
  rollout: "ROLL-OUT",
  launch: "LAUNCH",
  glide: "MOTOR OFF · FINAL",
  slide: "BELLY LANDING",
  reset: "BACK ON THE STAND",
};

// ---- the blur disc ----
let discTexture = null;
function blurTexture() {
  if (discTexture || typeof document === "undefined") return discTexture;
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  const R = S / 2;
  // Body: a dark translucent disc, densest just inside the tips where the blades are widest and fastest.
  const body = g.createRadialGradient(R, R, 0, R, R, R);
  body.addColorStop(0, "rgba(120,124,132,0)");
  body.addColorStop(0.15, "rgba(120,124,132,0)");
  body.addColorStop(0.21, "rgba(120,124,132,0.42)");
  body.addColorStop(0.65, "rgba(110,114,122,0.30)");
  body.addColorStop(0.9, "rgba(130,134,142,0.46)");
  body.addColorStop(0.97, "rgba(130,134,142,0.18)");
  body.addColorStop(1, "rgba(130,134,142,0)");
  g.fillStyle = body;
  g.fillRect(0, 0, S, S);
  // Two soft blade ghosts, so a turning disc still reads as a propeller.
  if (typeof g.createConicGradient === "function") {
    g.globalCompositeOperation = "source-atop";
    const con = g.createConicGradient(0, R, R);
    for (const [at, a] of [[0, 0.22], [0.12, 0], [0.38, 0], [0.5, 0.22], [0.62, 0], [0.88, 0], [1, 0.22]]) con.addColorStop(at, `rgba(18,19,22,${a * 2})`);
    g.fillStyle = con;
    g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = "source-over";
  }
  // The tip circle catching the light.
  g.strokeStyle = "rgba(225,228,235,0.22)";
  g.lineWidth = S * 0.012;
  g.beginPath();
  g.arc(R, R, R * 0.95, 0, TAU);
  g.stroke();
  discTexture = new THREE.CanvasTexture(c);
  discTexture.colorSpace = THREE.SRGBColorSpace;
  discTexture.anisotropy = 4;
  return discTexture;
}

// ---- propeller analysis: hub axis, hub centre, radius, which pieces are hub and which are blades ----
const tmpV = new THREE.Vector3();
function analyseProp(part) {
  const pieces = (part.pieces ?? []).filter((pc) => pc.mesh?.geometry?.attributes?.position);
  if (!pieces.length) return null;
  part.group.updateMatrixWorld(true);
  // Vertices in part-local space (the piece's REST pose: the propeller may still carry a spin from last time).
  const local = new THREE.Matrix4();
  const box = new THREE.Box3();
  const sum = new THREE.Vector3();
  let n = 0;
  const per = pieces.map((pc) => {
    const rest = pc.rest ?? { position: pc.mesh.position, quaternion: pc.mesh.quaternion };
    local.compose(rest.position, rest.quaternion, pc.mesh.scale);
    const pos = pc.mesh.geometry.attributes.position;
    const pts = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      tmpV.fromBufferAttribute(pos, i).applyMatrix4(local);
      pts[i * 3] = tmpV.x;
      pts[i * 3 + 1] = tmpV.y;
      pts[i * 3 + 2] = tmpV.z;
      box.expandByPoint(tmpV);
      sum.add(tmpV);
      n++;
    }
    return { pc, pts, rest: { position: rest.position.clone(), quaternion: rest.quaternion.clone() } };
  });
  if (!n) return null;
  const centre = sum.multiplyScalar(1 / n);
  // The hub axis. droneParts.js authors every propeller piece centred on its own hub at the mesh's origin and
  // may say which local axis it turns about (userData.spinAxis, "y" by contract when absent): when it says so,
  // that is the axis, through the piece's rest position, and the vertex centroid only places the blur disc
  // along it. Otherwise the disc is thin along its axis: the box's smallest side is the hub axis.
  const tagged = per.find((p) => p.pc.mesh.userData?.spinAxis);
  let axis;
  if (tagged) {
    const k = tagged.pc.mesh.userData.spinAxis;
    axis = new THREE.Vector3(k === "x" ? 1 : 0, k === "y" ? 1 : 0, k === "z" ? 1 : 0).applyQuaternion(tagged.rest.quaternion).normalize();
    const hub = tagged.rest.position;
    centre.copy(hub).addScaledVector(axis, tmpV.copy(centre).sub(hub).dot(axis));
  } else {
    const size = box.getSize(new THREE.Vector3());
    axis = size.y <= size.x && size.y <= size.z ? new THREE.Vector3(0, 1, 0) : size.z <= size.x ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  }
  const radial = (x, y, z) => {
    tmpV.set(x - centre.x, y - centre.y, z - centre.z);
    const along = tmpV.dot(axis);
    return Math.sqrt(Math.max(0, tmpV.lengthSq() - along * along));
  };
  let R = 0;
  for (const p of per) {
    let r = 0;
    for (let i = 0; i < p.pts.length; i += 3) r = Math.max(r, radial(p.pts[i], p.pts[i + 1], p.pts[i + 2]));
    p.reach = r;
    R = Math.max(R, r);
    p.pts = null;
  }
  // Along the axis, the disc sits where the blades are.
  const blades = per.filter((p) => p.reach >= R * 0.4);
  const hubs = per.filter((p) => p.reach < R * 0.4);
  return { part, axis, centre: centre.clone(), R, blades, hubs, all: per, dir: part.geom?.spinDir === -1 ? -1 : 1 };
}

function makeDisc(prop) {
  const mat = new THREE.MeshBasicMaterial({
    map: blurTexture(),
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(prop.R * 1.02, 64), mat);
  disc.name = `${prop.part.id ?? "prop"}:blur`;
  disc.renderOrder = 2;
  disc.visible = false;
  disc.userData.noPick = true;
  disc.raycast = () => {}; // never a click target: the card is for the propeller itself
  disc.quaternion.setFromUnitVectors(Z, prop.axis);
  disc.position.copy(prop.centre);
  disc.userData.baseQ = disc.quaternion.clone();
  prop.part.group.add(disc);
  return disc;
}

// ---- downwash rings ----
function makeRing() {
  const mat = new THREE.MeshBasicMaterial({ color: 0x8c8172, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.72, 1, 72), mat);
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 1;
  ring.visible = false;
  ring.raycast = () => {};
  return { mesh: ring, age: RING_LIFE, strength: 0, r0: 1, r1: 2 };
}

// ---- the paths: offsets from the vehicle's resting pivot, in root-local scene units, as functions of t ----
function quadPlan(W, prof = QUAD_PROFILE) {
  const T = prof.T;
  const H = prof.hoverK * W;
  const A = prof.loopA * W;
  const B = prof.loopB * W;
  const rise = prof.rise * W;
  const t1 = T.spool;
  const t2 = t1 + T.lift;
  const t3 = t2 + T.hover;
  const t4 = t3 + T.loop;
  const t5 = t4 + T.home;
  const t6 = t5 + T.descend;
  const t7 = t6 + T.spoolDown;
  const pos = (t, out) => {
    if (t < t1) return out.set(0, 0, 0);
    if (t < t2) return out.set(0, H * smoother((t - t1) / T.lift), 0);
    if (t < t3) return out.set(0, H, 0);
    if (t < t4) {
      const th = TAU * smoother((t - t3) / T.loop);
      const c = 1 - Math.cos(th);
      return out.set(A * 0.5 * c, H + rise * 0.5 * c, B * Math.sin(th));
    }
    if (t < t5) return out.set(0, H, 0);
    if (t < t6) {
      // Down quickly at first, then slowly onto the pad: a soft touchdown, not a drop.
      const u = (t - t5) / T.descend;
      return out.set(0, H * (1 - smooth(Math.pow(u, 0.8))), 0);
    }
    return out.set(0, 0, 0);
  };
  const phase = (t) => (t < t1 ? "spool" : t < t2 ? "lift" : t < t3 ? "hover" : t < t4 ? "loop" : t < t5 ? "home" : t < t6 ? "descend" : "spoolDown");
  // Throttle as a share of hover (1 = hovering): what the propellers spin on and the dust is blown by.
  const throttle = (t) => {
    if (t < t1) return 0.3 * smooth(t / t1);
    if (t < t1 + 0.5) return lerp(0.3, 1.1, smooth((t - t1) / 0.5));
    if (t < t6) return 1;
    return 1 - 0.95 * smooth((t - t6) / T.spoolDown) - 0.05;
  };
  // Retractable gear: up once it is well clear of the pad, down again as the descent starts.
  const gear = (t) => (t < t1 + T.lift * 0.5 ? 0 : t < t5 ? smoother((t - t1 - T.lift * 0.5) / GEAR_S) : 1 - smoother((t - t5) / GEAR_S));
  return { kind: "quad", H, T, prof, end: t7, pos, phase, throttle, gear, airborne: (t) => t > t1 && t < t6, landAt: t5 };
}

// The quadplane: lift off on the lift rotors, hover, then accelerate along the nose's heading as the cruise motor
// spools and the lift rotors spin down (the transition), fly a wing-borne circuit, slow back down to a hover over
// the pad as the lift rotors spin up again, and land. The air leg is one curve flown at a speed that ramps up and
// back down; throttle is per rotor group: { lift, cruise }.
function vtolPlan(W) {
  const T = VTOL;
  const V = WING_V_K * W;
  const H = VTOL_H_K * W;
  const h = H + VTOL_CIRCUIT_K * W;
  const r = 1.5 * W;
  const up = 3.6 * W;
  const dn = -3.4 * W;
  const x2 = 2 * r;
  const P = (x, y, z) => new THREE.Vector3(x, y, z);
  const s45 = Math.SQRT1_2;
  const curve = new THREE.CatmullRomCurve3(
    [
      P(0, H, 0),
      P(0, H + 0.04 * W, 1.0 * W),
      P(0, lerp(H, h, 0.5), up - 1.2 * W),
      P(r - r * s45, lerp(H, h, 0.85), up + r * s45),
      P(r, h, up + r),
      P(r + r * s45, h, up + r * s45),
      P(x2, h, up - 0.4 * W),
      P(x2, h, dn + 0.4 * W),
      P(r + r * s45, h, dn - r * s45),
      P(r, lerp(H, h, 0.9), dn - r),
      P(r - r * s45, lerp(H, h, 0.75), dn - r * s45),
      P(0, lerp(H, h, 0.4), dn + 0.3 * W),
      P(0, H + 0.04 * W, -1.0 * W),
      P(0, H, 0),
    ],
    false,
    "centripetal",
  );
  const Lc = curve.getLength();
  const dA = (V * T.accel) / 2;
  const dD = (V * T.decel) / 2;
  const tCruise = Math.max(0, (Lc - dA - dD) / V);
  const t1 = T.spool;
  const t2 = t1 + T.lift;
  const t3 = t2 + T.hover;
  const t4 = t3 + T.accel; // transition done
  const t5 = t4 + tCruise; // back-transition starts
  const t6 = t5 + T.decel; // stopped over the pad
  const t7 = t6 + T.home;
  const t8 = t7 + T.descend;
  const t9 = t8 + T.spoolDown;
  // Distance along the curve and speed, as functions of time.
  const sOf = (t) => {
    if (t < t3) return 0;
    if (t < t4) return (0.5 * V * (t - t3) ** 2) / T.accel;
    if (t < t5) return dA + V * (t - t4);
    if (t < t6) {
      const u = t - t5;
      return Math.min(Lc, dA + V * tCruise + V * u - (0.5 * V * u * u) / T.decel);
    }
    return Lc;
  };
  const speed = (t) => (t < t3 || t >= t6 ? 0 : t < t4 ? (V * (t - t3)) / T.accel : t < t5 ? V : V * (1 - (t - t5) / T.decel));
  const pos = (t, out) => {
    if (t < t1) return out.set(0, 0, 0);
    if (t < t2) return out.set(0, H * smoother((t - t1) / T.lift), 0);
    if (t < t3) return out.set(0, H, 0);
    if (t < t6) return curve.getPointAt(clamp01(sOf(t) / Lc), out);
    if (t < t7) return out.set(0, H, 0);
    if (t < t8) return out.set(0, H * (1 - smooth(Math.pow((t - t7) / T.descend, 0.8))), 0);
    return out.set(0, 0, 0);
  };
  const phase = (t) => (t < t1 ? "spool" : t < t2 ? "lift" : t < t3 ? "hover" : t < t4 ? "transition" : t < t5 ? "cruise" : t < t6 ? "backTransition" : t < t7 ? "home" : t < t8 ? "descend" : "spoolDown");
  // Wing-borne share: 0 hovering on the rotors, 1 flying on the wing.
  const wing = (t) => smooth((speed(t) / V - 0.25) / 0.6);
  const throttle = (t) => {
    const v = speed(t) / V;
    let lift;
    if (t < t1) lift = 0.3 * smooth(t / t1);
    else if (t < t1 + 0.5) lift = lerp(0.3, 1.1, smooth((t - t1) / 0.5));
    else if (t < t3 || t >= t6) lift = t < t8 ? 1 : 1 - 0.95 * smooth((t - t8) / T.spoolDown) - 0.05;
    else lift = 1 - smooth(v / LIFT_OFF_AT);
    let cruise = 0;
    if (t >= t3 && t < t4) cruise = smooth((t - t3) / 1.0) * 1.1;
    else if (t >= t4 && t < t5) cruise = 0.85;
    else if (t >= t5 && t < t6) cruise = 0.85 * (1 - smooth((t - t5) / (T.decel * 0.8)));
    return { lift: Math.max(0, lift), cruise: Math.max(0, cruise) };
  };
  return { kind: "vtol", H, T, end: t9, pos, phase, throttle, wing, speed, V, airborne: (t) => t > t1 && t < t8, landAt: t7 };
}

// st (a launch stand, else null): { drop, rail, zStop, yTD, lift } in root-local scene units, offsets from the
// resting pivot: drop = the stand's height, rail = how far it rides the stand before its tail is clear, zStop =
// where its belly slide ends (nose behind the stand), yTD = the belly on the deck, lift = how high it is carried
// over the saddles when it is put back.
function wingPlan(W, st = null) {
  const V = WING_V_K * W;
  const Lr = st ? st.rail : ROLL_K * W;
  const Lo = st ? -(st.zStop - SLIDE_K * W) : ROLLOUT_K * W;
  const yTD = st ? st.yTD : 0;
  const aRoll = (V * V) / (2 * Lr);
  const tRoll = (2 * Lr) / V;
  const Ls = st ? SLIDE_K * W : Lo; // ground run after touchdown: a belly slide off a stand, else the roll-out
  const tOut = (2 * Ls) / V;
  // A left-hand circuit: up the runway (+Z, the way the nose points), a climbing turn, the downwind leg, a
  // descending turn, and the final approach back along +Z onto the pad.
  const r = 1.5 * W; // turn radius
  const up = 3.6 * W; // upwind end of the circuit (z)
  const dn = -3.4 * W; // downwind end
  const h = 1.5 * W; // circuit height
  const x2 = 2 * r;
  const P = (x, y, z) => new THREE.Vector3(x, y, z);
  const s45 = Math.SQRT1_2;
  const curve = new THREE.CatmullRomCurve3(
    [
      P(0, 0, Lr),
      P(0, 0.06 * W, Lr + 0.55 * W),
      P(0, 0.45 * h, up - 1.2 * W),
      P(r - r * s45, 0.85 * h, up + r * s45),
      P(r, h, up + r),
      P(r + r * s45, h, up + r * s45),
      P(x2, h, up - 0.4 * W),
      P(x2, h, dn + 0.4 * W),
      P(r + r * s45, 0.92 * h, dn - r * s45),
      P(r, 0.82 * h, dn - r),
      P(r - r * s45, 0.68 * h, dn - r * s45),
      P(0, 0.5 * h, dn + 0.3 * W),
      P(0, yTD + 0.12 * W, -Lo - 0.9 * W),
      P(0, yTD, -Lo),
    ],
    false,
    "centripetal",
  );
  const L = curve.getLength();
  const t1 = WING.spool;
  const t2 = t1 + tRoll;
  const t3 = t2 + L / V;
  const t4 = t3 + tOut;
  const t5 = t4 + WING.spoolDown;
  const t6 = t5 + (st ? RESET_S : 0);
  const dOut = (V * V) / (2 * Ls);
  const zEnd = st ? st.zStop : 0; // where the slide stops
  const air = (t) => (t - t2) / (t3 - t2); // share of the air leg flown
  // From a stand: the motor is cut on final once it is below CUT_ALT_K spans, so the blades are parked before
  // the belly gets near the deck (until then the spinning disc clears the deck by the stand's own margin).
  let cut = null;
  if (st) {
    const q = new THREE.Vector3();
    for (let a = 0.8; a <= 1; a += 0.002) {
      curve.getPointAt(a, q);
      if (q.y < CUT_ALT_K * W) {
        cut = t2 + a * (t3 - t2);
        break;
      }
    }
    cut ??= t3 - PARK_S;
    cut = Math.min(cut, t3 - PARK_S);
  }
  const pos = (t, out) => {
    if (t < t1) return out.set(0, 0, 0);
    if (t < t2) {
      const u = t - t1;
      return out.set(0, 0, 0.5 * aRoll * u * u);
    }
    if (t < t3) {
      const a = air(t);
      curve.getPointAt(clamp01(a), out);
      // Never below the stand top while leaving it, never below the deck coming home.
      out.y = Math.max(a < 0.5 ? 0 : yTD, out.y);
      return out;
    }
    if (t < t4) {
      const u = t - t3;
      return out.set(0, yTD, -Lo + V * u - 0.5 * dOut * u * u);
    }
    if (!st || t >= t6 || t < t5) return out.set(0, st && t < t6 ? yTD : 0, st && t < t6 ? zEnd : 0);
    // Put back on the stand: up clear of the saddles, forward over them, down onto them.
    const u = (t - t5) / RESET_S;
    const y = u < 0.35 ? lerp(yTD, st.lift, smoother(u / 0.35)) : u < 0.75 ? st.lift : lerp(st.lift, 0, smoother((u - 0.75) / 0.25));
    return out.set(0, y, lerp(zEnd, 0, smoother((u - 0.3) / 0.5)));
  };
  const phase = (t) => {
    if (t < t1) return "spool";
    if (t < t2) return st ? "launch" : "roll";
    if (t < t3) {
      const a = air(t);
      return a < 0.18 ? "climb" : a < 0.8 ? "circuit" : cut !== null && t >= cut ? "glide" : "final";
    }
    if (t < t4) return st ? "slide" : "rollout";
    return t < t5 ? "spoolDown" : "reset";
  };
  const throttle = (t) => {
    if (t < t1) return 0.45 * smooth(t / t1);
    if (t < t2) return lerp(0.45, 1.1, smooth((t - t1) / 0.6));
    if (cut !== null && t >= cut) return 0.35 * (1 - smooth((t - cut) / 0.3));
    if (t < t3) {
      const a = air(t);
      return a < 0.18 ? 1.1 : a < 0.8 ? 0.85 : lerp(0.85, 0.35, smooth((a - 0.8) / 0.12));
    }
    if (t < t4) return 0.3;
    return 0.3 * (1 - smooth((t - t4) / WING.spoolDown));
  };
  // Nose above the path: in the climb, and in the flare just before touchdown. Off a stand, not until it has
  // left the stand (a nose-up on it would dip the tail into the saddles).
  const a0 = st ? t2 : t2 - 0.35;
  const aoa = (t) => {
    if (t < a0 || t > t3 + 0.25) return 0;
    if (t < t2 + 0.6) return CLIMB_AOA * smooth((t - a0) / (t2 + 0.6 - a0));
    const a = air(t);
    if (a < 0.18) return CLIMB_AOA * (1 - smooth((a - 0.1) / 0.08));
    if (t > t3 - 1.4) return FLARE_AOA * Math.sin(Math.PI * clamp01((t - (t3 - 1.4)) / 1.65));
    return 0;
  };
  // On the ground (and carried back to the stand) it stays level, nose along +Z: it is not flying a path.
  const level = (t) => t < t1 || t >= t4;
  return { kind: "wing", H: h, end: t6, pos, phase, throttle, aoa, level, cut, airborne: (t) => t > t2 && t < t3, landAt: t3 - 1.4, V };
}

export function createDroneFlight({ root, camera = null, controls = null, sfx = null, onTelemetry = null, onEnd = null } = {}) {
  const state = {
    active: false,
    phase: "idle",
    t: 0,
    throttle: 0,
    thr: null, // per rotor group on a quadplane: { lift, cruise }; null = every rotor on `throttle`
    plan: null,
    gear: [], // retractable landing gear pieces: { mesh, rest, retract }
    verdict: null,
    mission: null,
    fails: false,
    parts: [],
    props: [],
    discs: [],
    rings: [],
    ringClock: 0,
    craft: null,
    pivot: new THREE.Vector3(),
    groundY: 0,
    stand: null, // a fixed wing's launch stand (bounds.stand), else null
    parkAt: null, // the nose prop's parked angle: { s, n, minY } (parkPose)
    box: null,
    width: 10,
    homes: [],
    yaw: 0,
    cam: null,
    controlsWas: true,
    lastHtml: "",
  };
  const p0 = new THREE.Vector3();
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const vel = new THREE.Vector3();
  const acc = new THREE.Vector3();
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const m4 = new THREE.Matrix4();
  const vx = new THREE.Vector3();
  const vy = new THREE.Vector3();
  const vz = new THREE.Vector3();

  // ---- telemetry: the verdict's numbers only ----
  function telemetry() {
    const v = state.verdict ?? {};
    const endurance_s = (fin(v.hoverTime_min) ?? 0) * 60;
    const left = endurance_s > 0 ? clamp01(1 - state.t / endurance_s) : null;
    const label = PHASE_LABEL[state.phase] ?? "IN FLIGHT";
    const bits = [`<strong${state.fails ? ' class="nogo"' : ""}>${label}</strong>`, `T+${num(state.t, 0)} s`];
    const winged = state.plan?.kind === "wing" || (state.plan?.kind === "vtol" && state.plan.wing(state.t) > 0.5);
    if (winged) {
      if (fin(v.cruiseSpeed_ms) !== null) bits.push(`cruise ${num(v.cruiseSpeed_ms, 1)} m/s`);
      if (fin(v.stallSpeed_ms) !== null) bits.push(`stall ${num(v.stallSpeed_ms, 1)} m/s`);
    } else {
      const share = fin(v.hoverThrottleShare) ?? (fin(v.hoverTWR) > 0 ? 1 / v.hoverTWR : null);
      if (share !== null) bits.push(`hover throttle ${num(Math.min(1, share) * 100, 0)} %`);
    }
    if (fin(v.hoverCurrent_A) !== null) bits.push(`${num(v.hoverCurrent_A, 1)} A draw`);
    if (left !== null) bits.push(`pack ${num(left * 100, 0)} %`);
    bits.push("est.");
    return bits.join(" · ");
  }

  function summary() {
    const v = state.verdict ?? {};
    const m = state.mission;
    const out = [];
    if (state.fails) {
      const why = v.blockingWarnings?.[0] ?? v.warnings?.[0] ?? "the verdict says it cannot fly";
      return { headline: "Could not lift off", ok: false, sentences: [`${why.charAt(0).toUpperCase()}${why.slice(1)} (est.).`] };
    }
    if (state.plan?.kind === "wing") {
      if (fin(v.cruiseSpeed_ms) !== null) out.push(`Cruises at ${num(v.cruiseSpeed_ms, 1)} m/s, stalls at ${num(v.stallSpeed_ms, 1)} m/s (est.).`);
      if (fin(v.range_km) !== null) out.push(`One pack is ${num(v.hoverTime_min, 1)} min and ${num(v.range_km, 1)} km of level cruise (est.).`);
    } else {
      const share = fin(v.hoverThrottleShare);
      if (share !== null && fin(v.hoverCurrent_A) !== null) out.push(`Hovers at ${num(share * 100, 0)} % throttle, drawing ${num(v.hoverCurrent_A, 1)} A from a ${num(v.packVoltage_V, 1)} V pack (est.).`);
      if (state.plan?.kind === "vtol" && fin(v.cruiseSpeed_ms) !== null) out.push(`On the wing it cruises at ${num(v.cruiseSpeed_ms, 1)} m/s${fin(v.stallSpeed_ms) !== null ? `, stalls at ${num(v.stallSpeed_ms, 1)} m/s` : ""} (est.).`);
      if (fin(v.hoverTime_min) !== null) out.push(`The pack holds ${num(v.hoverTime_min, 1)} min of hover, ${num(v.mixedTime_min, 1)} min of mixed flying (est.).`);
    }
    if (m && fin(m.targetEndurance_min) !== null && fin(v.mixedTime_min) !== null) {
      const ok = v.mixedTime_min >= m.targetEndurance_min;
      out.push(`${m.name} wants ${num(m.targetEndurance_min, 0)} min: ${ok ? "covered" : `${num(m.targetEndurance_min - v.mixedTime_min, 1)} min short`} (est.).`);
    }
    return { headline: state.plan?.kind === "wing" ? "Landed back on the pad" : "Back on the pad", ok: Boolean(v.feasible), sentences: out };
  }

  // The deck under the vehicle (root-local y): the pad deck is at 0 under a stand, else the vehicle stands on it.
  const deckY = () => (state.stand ? 0 : state.groundY);

  // Where a stopped propeller hangs highest: the spin angle (as spinProps applies it) whose lowest blade point is
  // highest, and that point's root-local y. A two-blade prop parks level; a three-blade one with a blade up.
  function parkPose(prop) {
    const pts = [];
    const m = new THREE.Matrix4();
    for (const p of prop.blades) {
      const pos = p.pc.mesh.geometry.attributes.position;
      m.compose(p.rest.position, p.rest.quaternion, p.pc.mesh.scale);
      const step = Math.max(1, Math.floor(pos.count / 600));
      for (let i = 0; i < pos.count; i += step) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m));
    }
    const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(prop.part.group.matrixWorld);
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const n = clamp(prop.part.geom?.bladeCount | 0 || 2, 1, 8);
    let best = { s: 0, minY: -Infinity, n };
    for (let k = 0; k < 120; k++) {
      const sp = (k / 120) * (TAU / n);
      q.setFromAxisAngle(prop.axis, sp * prop.dir);
      let lo = Infinity;
      for (const p of pts) lo = Math.min(lo, v.copy(p).sub(prop.centre).applyQuaternion(q).add(prop.centre).applyMatrix4(toRoot).y);
      if (lo > best.minY) best = { s: sp, minY: lo, n };
    }
    return best;
  }

  // The launch-stand plan for wingPlan, from the stand (bounds.stand) and the vehicle's resting box.
  function standPlan() {
    const st = state.stand;
    const W = state.width;
    const b = state.box;
    const fr = st.fuseR_u ?? 0.03 * W;
    const zs = st.saddleZ_u?.length ? st.saddleZ_u : [0];
    const standRear = Math.min(...zs) - fr * 1.3; // the feet run fr × 0.9 past the saddles (anchors.js)
    const standFront = Math.max(...zs) + fr * 1.3;
    const margin = 0.04 * W;
    const prop = state.props.find((p) => p.part.kind === "drone-nose-propeller") ?? null;
    state.parkAt = null;
    let parkedDrop = 0;
    if (prop) {
      const pk = parkPose(prop);
      state.parkAt = pk;
      parkedDrop = Math.max(0, st.height_u - pk.minY);
    }
    return {
      drop: st.height_u,
      rail: standFront + margin - b.min.z, // until the tail is past the front saddle
      zStop: standRear - margin - b.max.z, // the nose (and its parked prop) stops behind the rear saddle
      yTD: DECK_MAT_K * W + parkedDrop - st.height_u,
      lift: fr * 0.8 + parkedDrop + 0.02 * W,
    };
  }

  // ---- set up / tear down ----
  function hangOnCraft(parts) {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const box = new THREE.Box3();
    for (const p of parts) if (p.group) box.expandByObject(p.group);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    box.applyMatrix4(inv);
    const size = box.getSize(new THREE.Vector3());
    state.width = Math.max(1, size.x, size.z);
    state.groundY = box.min.y;
    box.getCenter(state.pivot);
    const craft = new THREE.Group();
    craft.name = "drone-craft";
    craft.position.copy(state.pivot);
    root.add(craft);
    craft.updateMatrixWorld(true);
    state.box = box.clone();
    state.homes = parts.filter((p) => p.group).map((p) => ({ group: p.group, parent: p.group.parent, position: p.group.position.clone(), quaternion: p.group.quaternion.clone() }));
    for (const h of state.homes) craft.attach(h.group);
    state.craft = craft;
  }

  function putBack() {
    const craft = state.craft;
    if (!craft) return;
    for (const h of state.homes) {
      (h.parent ?? root).add(h.group);
      h.group.position.copy(h.position);
      h.group.quaternion.copy(h.quaternion);
    }
    state.homes = [];
    craft.removeFromParent();
    state.craft = null;
  }

  function cleanup() {
    putBack();
    for (const prop of state.props) {
      for (const p of prop.all) {
        p.pc.mesh.position.copy(p.rest.position);
        p.pc.mesh.quaternion.copy(p.rest.quaternion);
        p.pc.mesh.visible = true;
      }
    }
    for (const g of state.gear) {
      g.mesh.position.copy(g.rest.position);
      g.mesh.quaternion.copy(g.rest.quaternion);
    }
    state.gear = [];
    for (const d of state.discs) {
      d.removeFromParent();
      d.geometry.dispose();
      d.material.dispose();
    }
    for (const r of state.rings) {
      r.mesh.removeFromParent();
      r.mesh.geometry.dispose();
      r.mesh.material.dispose();
    }
    state.props = [];
    state.discs = [];
    state.rings = [];
    if (controls) controls.enabled = state.controlsWas;
  }

  // ---- per frame ----
  // A rotor's throttle: its group's on a quadplane, else the one throttle.
  const thrOf = (prop) => Math.max(0, state.thr ? state.thr[prop.group] ?? 0 : state.throttle);
  // The spin (as spinProps applies it) at which a stopped lift rotor lies fore and aft: one blade pointing aft
  // (a two-blade rotor then lies along its boom), the way a quadplane's rotors are parked for cruise.
  function alignedSpin(prop) {
    const b = prop.blades[0];
    if (!b) return 0;
    const pos = b.pc.mesh.geometry.attributes.position;
    const m = new THREE.Matrix4().compose(b.rest.position, b.rest.quaternion, b.pc.mesh.scale);
    const c = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) c.add(v.fromBufferAttribute(pos, i).applyMatrix4(m));
    c.multiplyScalar(1 / Math.max(1, pos.count)).sub(prop.centre);
    const psi = Math.atan2(c.x, c.z); // the blade's heading about +Y, from +Z toward +X
    return (Math.PI - psi) * prop.dir;
  }
  // Wind a rotor down onto `target` (a spin, as spinProps applies it), at least half a blade pitch further on.
  function parkProp(prop, target, n) {
    const pitch = TAU / n;
    const s0 = prop.spin;
    let s1 = target + Math.ceil((s0 + pitch * 0.5 - target) / pitch) * pitch;
    if (s1 < s0 + pitch * 0.5) s1 += pitch;
    prop.park = { t0: state.t, s0, s1 };
  }

  function spinProps(dt) {
    let fastest = 0;
    state.props.forEach((prop, i) => {
      const thr = thrOf(prop);
      const rps = thr <= 0.001 ? 0 : IDLE_RPS + (FLIGHT_RPS - IDLE_RPS) * smooth(Math.min(1, thr));
      fastest = Math.max(fastest, rps);
      const blur = smooth((thr - BLUR_FROM) / (BLUR_FULL - BLUR_FROM));
      // A quadplane's lift rotors wind down onto their fore-aft angle as the wing takes over, and let go of it
      // when they are spun up again.
      if (prop.group === "lift" && state.thr) {
        if (!prop.park && prop.ran && thr < 0.12) parkProp(prop, prop.aligned, clamp(prop.part.geom?.bladeCount | 0 || 2, 1, 8));
        else if (prop.park && thr >= 0.12 && state.t - prop.park.t0 > PARK_S) {
          prop.park = null;
          prop.ran = false;
        }
        if (thr >= 0.3) prop.ran = true;
      }
      if (prop.park) {
        const u = clamp01((state.t - prop.park.t0) / PARK_S);
        prop.spin = lerp(prop.park.s0, prop.park.s1, 1 - Math.pow(1 - u, 3));
      } else prop.spin += Math.min(rps, BLADE_RPS_MAX) * TAU * dt;
      prop.discSpin += rps * TAU * dt;
      const bladesOn = blur < 0.98;
      for (const p of prop.all) {
        const isBlade = prop.blades.includes(p);
        p.pc.mesh.visible = !isBlade || bladesOn;
        if (!p.pc.mesh.visible) continue;
        qa.setFromAxisAngle(prop.axis, prop.spin * prop.dir);
        p.pc.mesh.quaternion.copy(qa).multiply(p.rest.quaternion);
        p.pc.mesh.position.copy(p.rest.position).sub(prop.centre).applyQuaternion(qa).add(prop.centre);
      }
      const disc = state.discs[i];
      disc.visible = blur > 0.01;
      disc.material.opacity = DISC_ALPHA * blur;
      qb.setFromAxisAngle(Z, prop.discSpin * prop.dir);
      disc.quaternion.copy(disc.userData.baseQ).multiply(qb);
    });
    return fastest;
  }

  // Retractable gear: each leg swung about its own pivot by `amount` of its angle (0 down, 1 up).
  const gearAxis = new THREE.Vector3();
  const gearPivot = new THREE.Vector3();
  function moveGear(amount) {
    for (const g of state.gear) {
      const r = g.retract;
      qa.setFromAxisAngle(gearAxis.set(r.axis[0], r.axis[1], r.axis[2]).normalize(), r.angle * amount);
      g.mesh.quaternion.copy(qa).multiply(g.rest.quaternion);
      g.mesh.position.copy(g.rest.position).sub(gearPivot.set(r.pivot[0], r.pivot[1], r.pivot[2])).applyQuaternion(qa).add(gearPivot);
    }
  }

  function orient(t, dt) {
    const plan = state.plan;
    const h = 1 / 30;
    plan.pos(Math.max(0, t - h), pA);
    plan.pos(t + h, pB);
    plan.pos(t, p0);
    vel.subVectors(pB, pA).multiplyScalar(1 / (2 * h));
    acc.copy(pB).add(pA).addScaledVector(p0, -2).multiplyScalar(1 / (h * h));
    const craft = state.craft;
    const air = plan.airborne(t) ? 1 : 0;
    if (plan.kind === "quad") {
      const prof = plan.prof ?? QUAD_PROFILE;
      // Lean into the acceleration (a multirotor tilts its thrust to go anywhere), nose along the way it goes.
      const hs = Math.hypot(vel.x, vel.z);
      if (hs > 0.6 * state.width * 0.1) state.yaw += wrapPi(Math.atan2(vel.x, vel.z) - state.yaw) * ease(dt, prof.yawTau);
      const thrust = vx.set(acc.x, acc.y + QUAD_G_U, acc.z);
      const tilt = Math.acos(clamp(thrust.clone().normalize().y, -1, 1));
      if (tilt > prof.maxTilt) {
        const hl = Math.hypot(thrust.x, thrust.z) || 1;
        const k = (Math.tan(prof.maxTilt) * thrust.y) / hl;
        thrust.x *= k;
        thrust.z *= k;
      }
      // A little life in the hover: a slow bob and wander, gone on the ground.
      const w = smooth(clamp01(p0.y / (0.15 * state.width)));
      const bob = reduced ? 0 : w * prof.bob;
      p0.y += bob * 0.018 * state.width * Math.sin(t * 2.3);
      p0.x += bob * 0.01 * state.width * Math.sin(t * 1.3 + 1);
      p0.z += bob * 0.01 * state.width * Math.sin(t * 1.7 + 2);
      // On the pad before lift-off: the motors spooling make it tremble, nothing more.
      const shake = plan.phase(t) === "spool" || state.fails ? 0.0025 * state.width * smooth(state.throttle) : 0;
      if (shake) {
        p0.x += shake * Math.sin(t * 61);
        p0.z += shake * Math.sin(t * 47 + 1);
      }
      qa.setFromUnitVectors(UP, thrust.normalize());
      qb.setFromAxisAngle(UP, state.yaw);
      craft.quaternion.copy(qa).multiply(qb);
      const wob = bob * 0.025;
      if (wob) craft.quaternion.multiply(qb.setFromEuler(new THREE.Euler(wob * Math.sin(t * 1.9), 0, wob * Math.sin(t * 2.6 + 0.5))));
    } else if (plan.kind === "vtol") {
      // On its rotors it holds its heading and leans a little into its accelerations, like any multirotor; as
      // the wing takes over (plan.wing) it points along its path and banks into its turns like an aeroplane. The
      // transition's push comes from the cruise motor, so it stays level while it speeds up and slows down.
      const w = plan.wing(t);
      const ph = plan.phase(t);
      const hs = Math.hypot(vel.x, vel.z);
      if (hs > 0.05 * state.width) state.yaw += wrapPi(Math.atan2(vel.x, vel.z) - state.yaw) * ease(dt, 0.45);
      const rotorBorne = ph === "lift" || ph === "hover" || ph === "home" || ph === "descend";
      const thrust = vx.set(rotorBorne ? acc.x : 0, acc.y + QUAD_G_U, rotorBorne ? acc.z : 0);
      const tilt = Math.acos(clamp(thrust.clone().normalize().y, -1, 1));
      if (tilt > VTOL_TILT) {
        const hl = Math.hypot(thrust.x, thrust.z) || 1;
        const k = (Math.tan(VTOL_TILT) * thrust.y) / hl;
        thrust.x *= k;
        thrust.z *= k;
      }
      qa.setFromUnitVectors(UP, thrust.normalize());
      qb.setFromAxisAngle(UP, state.yaw);
      const qHover = qa.clone().multiply(qb);
      // The wing's attitude: nose along the path (its heading when barely moving), banked into the turn.
      const speed = vel.length();
      vz.copy(speed > 0.05 * state.width ? vel : vy.set(Math.sin(state.yaw), 0, Math.cos(state.yaw))).normalize();
      vx.crossVectors(UP, vz);
      if (vx.lengthSq() < 1e-6) vx.set(1, 0, 0);
      vx.normalize();
      vy.crossVectors(vz, vx).normalize();
      m4.makeBasis(vx, vy, vz);
      const qWing = new THREE.Quaternion().setFromRotationMatrix(m4);
      const bank = clamp(Math.atan2(acc.dot(vx), WING_G_U), -MAX_BANK, MAX_BANK);
      qWing.multiply(qa.setFromAxisAngle(Z, -bank));
      craft.quaternion.copy(qHover).slerp(qWing, w);
      // A little life: a hover bob on the rotors, a gentle float on the wing.
      const lifeH = reduced ? 0 : smooth(clamp01(p0.y / (0.1 * state.width))) * (1 - w);
      p0.y += lifeH * 0.012 * state.width * Math.sin(t * 2.1) + (reduced ? 0 : w * 0.005 * state.width * Math.sin(t * 1.7));
      p0.x += lifeH * 0.006 * state.width * Math.sin(t * 1.3 + 1);
      const shake = ph === "spool" || state.fails ? 0.002 * state.width * smooth(state.throttle) : 0;
      if (shake) {
        p0.x += shake * Math.sin(t * 61);
        p0.z += shake * Math.sin(t * 47 + 1);
      }
    } else {
      // A wing points along its path, banks into its turns and holds its nose up in the climb and the flare.
      const speed = vel.length();
      vz.copy(speed > 0.05 && !plan.level?.(t) ? vel : Z).normalize();
      vx.crossVectors(UP, vz);
      if (vx.lengthSq() < 1e-6) vx.set(1, 0, 0);
      vx.normalize();
      vy.crossVectors(vz, vx).normalize();
      m4.makeBasis(vx, vy, vz);
      craft.quaternion.setFromRotationMatrix(m4);
      const aLat = acc.dot(vx); // toward the left wing (+X when the nose is +Z)
      const bank = air * clamp(Math.atan2(aLat, WING_G_U), -MAX_BANK, MAX_BANK);
      craft.quaternion.multiply(qa.setFromAxisAngle(Z, -bank));
      craft.quaternion.multiply(qb.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -plan.aoa(t)));
      if (!reduced && air) p0.y += 0.006 * state.width * Math.sin(t * 1.7);
    }
    craft.position.copy(state.pivot).add(p0);
  }

  function dust(dt) {
    const plan = state.plan;
    const alt = state.craft.position.y - state.pivot.y;
    let strength = 0;
    if (plan.kind === "quad") strength = clamp01(state.throttle) * (1 - smooth(alt / (0.75 * plan.H)));
    else if (plan.kind === "vtol") strength = clamp01(state.thr?.lift ?? state.throttle) * (1 - smooth(alt / (0.75 * plan.H)));
    else if (alt < 0.05 * state.width) strength = 0.55 * clamp01(vel.length() / plan.V) * clamp01(state.throttle);
    if (state.phase === "spool") strength *= 0.5;
    state.ringClock += dt * strength;
    if (strength > 0.05 && state.ringClock >= RING_EVERY) {
      state.ringClock = 0;
      let ring = state.rings.find((r) => r.age >= RING_LIFE);
      if (!ring && state.rings.length < RING_POOL) {
        ring = makeRing();
        state.rings.push(ring);
        root.add(ring.mesh);
      }
      if (ring) {
        ring.age = 0;
        ring.strength = strength;
        ring.r0 = state.width * 0.32;
        ring.r1 = state.width * (plan.kind === "wing" ? 0.8 : 1.25);
        ring.mesh.position.set(state.craft.position.x, deckY() + 0.02, state.craft.position.z);
      }
    }
    for (const r of state.rings) {
      if (r.age >= RING_LIFE) {
        r.mesh.visible = false;
        continue;
      }
      r.age += dt;
      const u = clamp01(r.age / RING_LIFE);
      const s = lerp(r.r0, r.r1, 1 - Math.pow(1 - u, 2.2));
      r.mesh.scale.set(s, s, s);
      r.mesh.material.opacity = 0.55 * r.strength * Math.pow(1 - u, 1.6) * smooth(u / 0.12);
      r.mesh.visible = true;
    }
  }

  // Chase camera: behind and a little to one side of the way it is going, high enough to see the top, close
  // enough that the vehicle fills a good share of the frame; everything eased so it never jerks.
  function chaseCam(dt, t) {
    if (!camera || !controls) return;
    const c = state.cam;
    const plan = state.plan;
    const W = state.width;
    // A short lead along the velocity, so the vehicle sits a touch behind the frame's centre as it moves.
    const at = root.localToWorld(vx.copy(state.craft.position).addScaledVector(vel, 0.18));
    c.target.lerp(at, ease(dt, CAM_TAU.target));
    const ph = plan.phase(t);
    const moving = Math.hypot(vel.x, vel.z) > 0.25 * W;
    let az = c.az;
    let el;
    let d;
    if (plan.kind === "vtol") {
      if (moving) az = Math.atan2(vel.x, vel.z) + Math.PI + 0.55;
      else if (ph === "lift" || ph === "hover") az = c.az0 + 0.3 * smooth((t - plan.T.spool) / (plan.T.lift + plan.T.hover));
      el = ph === "spool" || ph === "descend" || ph === "spoolDown" ? 0.26 : ph === "lift" ? 0.18 : 0.24;
      d = W * (ph === "cruise" ? 2.1 : ph === "spool" || ph === "spoolDown" ? 1.6 : 1.85);
    } else if (plan.kind === "quad") {
      if (moving) az = state.yaw + Math.PI + 0.85;
      else if (ph === "lift" || ph === "hover") az = c.az0 + 0.35 * smooth((t - plan.T.spool) / (plan.T.lift + plan.T.hover));
      el = ph === "spool" ? 0.24 : ph === "lift" ? 0.14 : ph === "descend" || ph === "spoolDown" ? 0.24 : 0.2;
      d = W * (ph === "loop" ? 2.5 : ph === "spool" ? 1.9 : 2.15);
    } else {
      const heading = Math.atan2(vel.x, vel.z);
      if (moving) az = heading + Math.PI + 0.45;
      el = ph === "spool" || ph === "reset" ? 0.25 : ph === "roll" || ph === "rollout" || ph === "launch" || ph === "slide" ? 0.2 : 0.28;
      d = W * (ph === "spool" || ph === "spoolDown" || ph === "reset" ? 1.7 : 2.0);
    }
    if (reduced) az = c.az;
    c.az += wrapPi(az - c.az) * ease(dt, CAM_TAU.az);
    c.el += (el - c.el) * ease(dt, CAM_TAU.el);
    c.d += (d - c.d) * ease(dt, CAM_TAU.d);
    const ce = Math.cos(c.el);
    camera.position.set(c.target.x + Math.sin(c.az) * ce * c.d, c.target.y + Math.sin(c.el) * c.d, c.target.z + Math.cos(c.az) * ce * c.d);
    // Never under the deck.
    const floor = root.localToWorld(vz.set(0, deckY(), 0)).y + 0.15 * W;
    if (camera.position.y < floor) camera.position.y = floor;
    controls.target.copy(c.target);
    camera.lookAt(c.target);
  }

  function finish() {
    const s = summary();
    state.phase = "done";
    state.active = false;
    cleanup();
    sfx?.play?.("clunk", { gain: 0.4 });
    onEnd?.(s);
  }

  return {
    get active() {
      return state.active;
    },
    get phase() {
      return state.phase;
    },
    start({ parts = [], verdict = null, mission = null, bounds = null } = {}) {
      if (state.active || !root) return;
      cleanup();
      state.parts = parts;
      state.verdict = verdict;
      state.mission = mission ?? verdict?.mission ?? null;
      state.t = 0;
      state.throttle = 0;
      state.thr = null;
      state.ringClock = 0;
      state.yaw = 0;
      state.lastHtml = "";
      hangOnCraft(parts);
      // A quadplane (lift booms) hovers and flies; a plain wing flies only; everything else is a multirotor.
      const isVtol = parts.some((p) => p.kind === "drone-boom");
      const isWing = !isVtol && parts.some((p) => p.kind === "drone-wing" || p.kind === "drone-fuselage" || p.kind === "drone-nose-propeller");
      state.stand = isWing && bounds?.stand?.height_u > 0 ? bounds.stand : null;
      // A build the verdict grounds spools up, strains, and stays on the pad: the code decides, not the show.
      state.fails = !verdict || verdict.feasible === false;
      state.props = parts
        .filter((p) => p.kind === "drone-propeller" || p.kind === "drone-nose-propeller")
        .map(analyseProp)
        .filter(Boolean)
        .map((p) => Object.assign(p, { spin: 0, discSpin: 0, park: null, ran: false, group: isVtol && p.part.kind === "drone-nose-propeller" ? "cruise" : "lift" }));
      if (isVtol) for (const p of state.props) if (p.group === "lift") p.aligned = alignedSpin(p);
      const profile = parts.some((p) => p.kind === "drone-duct") ? WHOOP_PROFILE : state.props.length >= 6 ? HEAVY_PROFILE : QUAD_PROFILE;
      state.plan = isVtol ? vtolPlan(state.width) : isWing ? wingPlan(state.width, state.stand ? standPlan() : null) : quadPlan(state.width, profile);
      state.gear = parts
        .filter((p) => p.kind === "drone-gear")
        .flatMap((p) => p.pieces ?? [])
        .filter((pc) => pc.mesh?.userData?.retract)
        .map((pc) => ({ mesh: pc.mesh, rest: { position: pc.mesh.position.clone(), quaternion: pc.mesh.quaternion.clone() }, retract: pc.mesh.userData.retract }));
      state.discs = state.props.map(makeDisc);
      if (camera && controls) {
        const off = new THREE.Vector3().subVectors(camera.position, controls.target);
        const d = off.length() || 1;
        const az = Math.atan2(off.x, off.z);
        state.cam = { target: controls.target.clone(), az, az0: az, el: Math.asin(clamp(off.y / d, -1, 1)), d };
        state.controlsWas = controls.enabled;
        controls.enabled = false; // the chase camera flies the view; the user gets it back on the pad
      }
      state.active = true;
      state.phase = "spool";
      sfx?.play?.("ui", { gain: 0.4 });
    },
    stop() {
      const was = state.active || state.craft;
      state.active = false;
      state.phase = "idle";
      state.throttle = 0;
      if (was) cleanup();
    },
    update(dt) {
      if (!state.active) return;
      // The parts were taken down under it (reset, a new preset): put everything back and stop.
      if (state.parts.some((p) => p.built === false) || !state.craft) {
        this.stop();
        return;
      }
      state.t += dt;
      const t = state.t;
      const plan = state.plan;
      if (state.fails) {
        const STRAIN = 3.2;
        const Q = plan.kind === "wing" ? QUAD : plan.T;
        const end = Q.spool + STRAIN + Q.spoolDown;
        state.phase = t < Q.spool ? "spool" : t < Q.spool + STRAIN ? "strain" : "spoolDown";
        state.throttle = t < Q.spool ? 0.3 * smooth(t / Q.spool) : t < Q.spool + STRAIN ? lerp(0.3, 1.2, smooth((t - Q.spool) / 0.6)) : 1.2 * (1 - smooth((t - Q.spool - STRAIN) / Q.spoolDown));
        // A grounded quadplane strains on its lift rotors; its cruise motor stays still.
        if (plan.kind === "vtol") state.thr = { lift: state.throttle, cruise: 0 };
        // Sitting at the start of the plan: it never lifts. orient() reads the plan at t = 0.
        const keep = state.t;
        state.t = 0;
        orient(0, dt);
        state.t = keep;
        const shake = 0.004 * state.width * smooth(state.throttle);
        state.craft.position.x += shake * Math.sin(t * 61);
        state.craft.position.z += shake * Math.sin(t * 47 + 1);
        spinProps(dt);
        dust(dt);
        chaseCam(dt, 0);
        if (t >= end) return finish();
      } else {
        state.phase = plan.phase(t);
        const thr = plan.throttle(t);
        if (typeof thr === "number") state.throttle = thr;
        else {
          state.thr = thr;
          state.throttle = Math.max(thr.lift, thr.cruise);
        }
        const nose = plan.cut != null && t >= plan.cut && state.parkAt ? state.props.find((p) => p.part.kind === "drone-nose-propeller") : null;
        // Motor cut: wind the blades down onto the parked angle, at least half a blade pitch further on.
        if (nose && !nose.park) parkProp(nose, state.parkAt.s, state.parkAt.n);
        if (plan.gear && state.gear.length) moveGear(plan.gear(t));
        orient(t, dt);
        spinProps(dt);
        dust(dt);
        chaseCam(dt, t);
        if (t >= plan.end) return finish();
      }
      if (onTelemetry) {
        const html = telemetry();
        if (html !== state.lastHtml) onTelemetry((state.lastHtml = html), state.throttle > BLUR_FULL);
      }
    },
  };
}

