// Drone layout: turns a drone build (+ the drone catalog) into an ordered manifest of parts, in the same
// PartSpec shape layout.js produces for rockets. choreo.js, parts.js, optionShelf.js, ui/card.js and
// ui/select.js all read PartSpecs, so a drone manifest is a drop-in replacement and the whole configurator —
// assembly, option shelf, cards, explode, launch — works on a drone without a second screen.
// The full contract is docs/drone-integration.md; §2 and §5 are the parts that matter here.
//
// DISPLAY SCALE. Scene units are metres × SCALE (0.25), so a 70 m rocket is 17.5 scene units tall and about 1
// unit wide. A 225 mm quad at true scale is 0.056 units: smaller than a rivet on the rocket and well inside
// the camera's minimum distance. So a drone is drawn at a display scale, viewK, chosen per airframe so that
// every drone spans the same number of scene units however big the real thing is:
//     viewK = DISPLAY_FOOTPRINT_U / (footprint_m × SCALE)
// footprint_m is the vehicle's widest horizontal extent (multirotor: wheelbase + prop diameter; fixed wing:
// wingspan), and DISPLAY_FOOTPRINT_U is how wide that is drawn. A 225 mm quad on 5" props comes out near ×113,
// the 1.2 m fixed wing near ×33, and both fill the view the way a rocket does.
// Scene-unit fields (slotY, height, radius) are therefore true metres × viewK × SCALE. The true metres travel
// alongside, in height_m / diameter_m and in geom, and those are the only ones the cards ever show: a card
// says "225 mm wheelbase" because that is the fact, while the screen draws it far larger so you can see it.
//
// Build order, bottom-up in spirit and the order a real build goes together:
//   multirotor:  frame → arms + motors → electronics stack → battery → camera → propellers
//   fixed wing:  fuselage → wing → tail → motor → battery → camera → propeller
// Propellers come last: they are the last thing bolted on before a flight, and the best reveal.

import { SCALE } from "./scale.js";

// ---- display scale ----
const DISPLAY_FOOTPRINT_U = 10; // scene units a drone's widest extent is drawn at (visual choice, not a fact)

// ---- visual proportions (shape only; never shown on screen as facts) ----
const ARM_WIDTH_M = 0.015; // carbon arm width where the record gives only its thickness
const STACK_BOARD_M = 0.036; // 30.5 × 30.5 mm hole pattern on a 36 mm board: the FPV standard stack size
const STACK_BOARD_THICK_M = 0.0016; // one PCB
const STACK_H_M = 0.018; // flight controller + 4-in-1 ESC on their grommets
const VTX_W_M = 0.022;
const ANTENNA_LEN_M = 0.065;
const CAM_TILT_DEG = 25; // the camera is raked back; a freestyle quad flies nose-down
const STRAP_W_M = 0.02; // battery strap
// A slung cargo pod (droneParts.js buildCamera, type "cargo") hangs under the frame on landing skids whose
// underside is CARGO_DROP × the pod's smaller cross dimension below the frame's underside. The whole vehicle is
// lifted by that much so the skids, not the pod or the frame, stand on the pad deck. Visual ratio, not a fact.
export const CARGO_DROP = 1.23;
const FUSE_R_SHARE = 0.043; // fixed-wing fuselage radius / its length
const TAIL_R_SHARE = 0.018; // tail boom radius / fuselage length
const NOSE_SHARE = 0.17; // nose length / fuselage length
const WING_THICK_SHARE = 0.12; // aerofoil thickness / chord (a NACA 2412 is 12 %)
const DIHEDRAL_DEG = 3;
const TAIL_H_SPAN_SHARE = 0.34; // horizontal stabiliser span / wingspan
const TAIL_CHORD_SHARE = 0.62; // stabiliser chord / wing chord
const TAIL_V_SHARE = 0.16; // fin height / wingspan
// A fixed wing has no landing gear (the Model A is hand-launched and belly-landed), and its nose propeller
// reaches below the fuselage: on the deck the spinning disc would cut into it. So it rests on a launch stand
// (anchors.js createDronePad draws it) tall enough for the whole disc to clear the deck by STAND_CLEAR × the
// propeller radius, and every part is lifted by that much, as the cargo skids lift a courier. Two saddles under
// the fuselage, STAND_SADDLE_Z × its length either side of its middle (well clear of the nose and the prop).
// Visual ratios, not facts.
const STAND_CLEAR = 0.2;
const STAND_SADDLE_Z = 0.13;

// Multirotor variants (shape only, never shown as facts).
// A frame record with no standoff height gets STANDOFF_FALLBACK_M, or STANDOFF_PER_WB × its wheelbase when that
// is less: a 2.5" whoop is not as tall as a 5" freestyle frame.
const STANDOFF_FALLBACK_M = 0.028;
const STANDOFF_PER_WB = 0.16;
// A ducted frame (airframe.ducted) draws a duct ring round each propeller. GEPRC publishes neither the duct's
// inner diameter nor its depth, so both are visual ratios of the propeller's diameter.
export const DUCT_ID_PER_PROP = 1.06; // duct inner diameter / propeller diameter (the tip gap)
const DUCT_DEPTH_PER_PROP = 0.34; // duct depth / propeller diameter
const DUCT_WALL_PER_PROP = 0.045; // duct wall thickness / propeller diameter
// A folding round-tube frame (airframe.armLength_mm, a heavy-lift hex): tube diameter / arm length where the
// record has no tube diameter, and the depth of the plate sandwich the folding clamps sit in / tube diameter.
const ARM_TUBE_D_PER_LEN = 0.064;
const CLAMP_H_PER_TUBE = 1.6;
// A long-range or heavier build carries a GPS on a mast and longer antennas: from this wheelbase up (visual rule).
const GPS_FROM_WB_M = 0.3;
const LR_ANTENNA_PER_WB = 0.3; // antenna length / wheelbase on those builds
// Retractable landing gear (airframe.groundClearance_mm): leg spread and skid length / centre plate diameter.
const GEAR_SPREAD_PER_PLATE = 0.78;
const GEAR_SKID_PER_PLATE = 1.35;
// Quadplane (airframe.type "vtol_quadplane"). The record gives span, length, root and mean chord, boom length and
// section, the lift and cruise propeller sizes; the rest is shape:
const VTOL_FUSE_R_SHARE = 0.058; // pod fuselage radius / its length
const VTOL_WING_AT = 0.33; // wing leading edge, back from the nose / fuselage length
const VTOL_WING_STRAIGHT = 0.4; // straight (root-chord) share of the half-span before the outer taper
const VTOL_ROOT_PER_MAC = 1.15; // root chord / mean chord where the record gives no root chord
const LIFT_SPAN_SHARE = 0.31; // lift-motor spacing across / wingspan, with no spacing in the record (read off the Stork manual's plan view)
const LIFT_RECT_ASPECT = 1.35; // lift-motor spacing fore-aft / across, when only the diagonal is published (read off the VTBIRD frame drawing)
const BOOM_AT_CHORD = 0.35; // lift-motor rectangle's centre, back from the root leading edge / root chord
const BOOM_D_PER_SPAN = 0.011; // round boom diameter / wingspan where the record gives no section
const TWIN_POD_FAT = 1.6; // a twin-boom pod is a short, fat body: its radius / VTOL_FUSE_R_SHARE × its length
const TWIN_POD_SHARE = 0.62; // pod length / overall length on a twin-boom (H-tail) airframe, whose length runs to the tail
const TAIL_SPAN_SHARE_V = 0.3; // V-tail tip-to-tip span / wingspan
const TAIL_CHORD_SHARE_V = 0.55; // tail root chord / wing root chord
const VTAIL_DIHEDRAL_DEG = 35; // each V-tail panel's angle up from the horizontal
const H_FIN_SHARE = 0.11; // an H-tail fin's height above the boom / wingspan
const SKID_CLEAR = 0.2; // the cruise propeller's disc clears the deck by this share of its radius
const POD_CLEAR = 0.15; // a belly payload clears the deck by this share of its height

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
const byId = (list, id) => (id ? (list ?? []).find((x) => x.id === id) : undefined);
const mm = (x, fallback) => (Number.isFinite(x) ? x / 1000 : fallback);

export const DRONE_KINDS = [
  "drone-frame",
  "drone-arm",
  "drone-electronics",
  "drone-battery",
  "drone-camera",
  "drone-propeller",
  "drone-fuselage",
  "drone-wing",
  "drone-tail",
  "drone-nose-motor",
  "drone-nose-propeller",
  "drone-duct",
  "drone-gear",
  "drone-boom",
];

// A build is a drone's when it names an airframe. Rocket builds carry stages instead.
export const isDroneBuild = (build) => Boolean(build?.airframeId);
export const isDronePreset = (preset) => Boolean(preset?.airframeId);

// The vehicle's widest horizontal extent in true metres: what viewK is set from.
export function footprint_m(airframe, propeller) {
  if (airframe?.type === "multirotor") {
    const wb = mm(airframe.wheelbase_mm, 0.225);
    const prop = mm(propeller?.diameter_mm, 0.127);
    // A ducted frame reaches to the outside of its ducts, not just the propeller tips.
    return wb + (airframe.ducted ? prop * (DUCT_ID_PER_PROP + 2 * DUCT_WALL_PER_PROP) : prop);
  }
  return mm(airframe?.wingspan_mm, 1.2);
}

export const droneViewK = (airframe, propeller) => DISPLAY_FOOTPRINT_U / (Math.max(0.02, footprint_m(airframe, propeller)) * SCALE);

// ---------------------------------------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------------------------------------

export function droneBuildManifest(build, droneCatalog) {
  const airframe = byId(droneCatalog?.airframes, build?.airframeId);
  const motor = byId(droneCatalog?.motors, build?.motorId);
  const propeller = byId(droneCatalog?.propellers, build?.propellerId);
  const battery = byId(droneCatalog?.batteries, build?.batteryId);
  const payload = byId(droneCatalog?.payloads, build?.payloadId);

  const out = [];
  const warnings = [];
  if (!airframe) {
    out.warnings = [`airframe "${build?.airframeId ?? ""}" is not in the dataset`];
    return out;
  }
  if (!motor) warnings.push(`motor "${build?.motorId ?? ""}" is not in the dataset`);

  const K = droneViewK(airframe, propeller);
  const u = (m) => m * K * SCALE; // true metres → scene units at display scale
  let idx = 0;
  const push = (spec) => {
    out.push({
      stageIndex: null,
      count: 1,
      derived: false,
      note: "",
      slot: null,
      ...spec,
      geom: { viewK: K, ...spec.geom },
      key: KEYS[idx++] ?? null,
    });
  };

  if (airframe.type === "multirotor") {
    const lift_m = multirotor({ push, u, airframe, motor, propeller, battery, payload, warnings });
    // Landing gear stands the vehicle up: every part but the gear (whose y = 0 is the deck) rises by its height.
    if (lift_m > 0) for (const p of out) if (p.kind !== "drone-gear") p.slotY += u(lift_m);
  } else if (airframe.type === "vtol_quadplane") {
    const cruiseMotor = byId(droneCatalog?.motors, build?.cruiseMotorId) ?? motor;
    const cruiseProp = byId(droneCatalog?.propellers, build?.cruisePropellerId) ?? null;
    const lift_m = quadplane({ push, u, airframe, motor, propeller, cruiseMotor, cruiseProp, battery, payload });
    for (const p of out) p.slotY += u(lift_m);
  } else {
    // The two VTOL airframes in the dataset are a wing and a fuselage with lift rotors added, so they are laid
    // out as the aeroplane they are. Their lift booms and rotors are not drawn yet, and the warning says so
    // rather than letting the screen imply the vehicle is something it is not.
    if (airframe.type?.startsWith("vtol")) {
      warnings.push(`${airframe.name}: its lift rotors are not drawn yet, only the wing and fuselage`);
    }
    const stand = fixedWing({ push, u, airframe, motor, propeller, battery, payload });
    for (const p of out) p.slotY += u(stand.height_m);
    out.stand = {
      height_u: u(stand.height_m),
      saddleZ_u: [-1, 1].map((k) => u(k * STAND_SADDLE_Z * stand.fuseL_m)),
      fuseR_u: u(stand.fuseR_m),
    };
  }

  // A cargo pod stands the vehicle on its skids: lift every part by the skid drop (droneParts.js reads it back
  // from the payload's geom.skidDrop_m, so the pod still hangs from the frame and the skids end at y = 0).
  // (Not on a quadplane, whose pod rides in its belly between its own skids, nor on a frame on landing gear.)
  if (payload?.type === "cargo" && airframe.type !== "vtol_quadplane" && !hasGear(airframe)) {
    const drop_m = CARGO_DROP * Math.min(mm(payload.width_mm, 0.029), mm(payload.height_mm, 0.018));
    for (const p of out) {
      p.slotY += u(drop_m);
      if (p.id === "drone-camera") p.geom.skidDrop_m = drop_m;
    }
  }

  out.warnings = warnings;
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Multirotor
// ---------------------------------------------------------------------------------------------------------

const hasGear = (airframe) => airframe?.type === "multirotor" && Number.isFinite(airframe.groundClearance_mm) && airframe.groundClearance_mm > 0;
const MOTOR_SEAT_SHARE = 0.62; // the bell top / the motor record's height (droneParts.js MOTOR_SHAFT_SHARE = 0.38 above it)

function multirotor({ push, u, airframe, motor, propeller, battery, payload, warnings }) {
  const wb = mm(airframe.wheelbase_mm, 0.225); // motor shaft to motor shaft, diagonally
  const armR = wb / 2;
  const armThick = mm(airframe.armThickness_mm, 0.0055);
  const motorH = mm(motor?.height_mm, 0.0335);
  const motorOuterR = mm(motor?.outerDiameter_mm, 0.0275) / 2;
  const propR = mm(propeller?.diameter_mm, 0.127) / 2;
  const hubH = mm(propeller?.hubThickness_mm, 0.007);
  // A wider arm under a bigger motor: the arm's pad has to carry the bell (no change on a 5" frame).
  const armWidth = Math.max(ARM_WIDTH_M, motorOuterR);
  // Round-tube folding arms (a heavy-lift hex): the record gives the arm's length and its dihedral.
  const tube = Number.isFinite(airframe.armLength_mm);
  const armLen = mm(airframe.armLength_mm, armR);
  const tubeD = mm(airframe.armTubeDiameter_mm, armLen * ARM_TUBE_D_PER_LEN);
  const round = Number.isFinite(airframe.centerPlateDiameter_mm);
  const plateD = mm(airframe.centerPlateDiameter_mm, 0);
  const standoffFallback = tube ? Math.max(STANDOFF_FALLBACK_M, tubeD * CLAMP_H_PER_TUBE) : Math.min(STANDOFF_FALLBACK_M, wb * STANDOFF_PER_WB);
  const standoffH = mm(airframe.standoffHeight_mm, standoffFallback);
  const topPlate = mm(airframe.topPlateThickness_mm, 0.002);
  const botPlate = mm(airframe.bottomPlateThickness_mm, 0.0025);
  const armCount = airframe.motorCount || 4;
  const stackMount = (airframe.stackMount_mm ?? [20, 30.5]).map((x) => x / 1000);
  const ducted = Boolean(airframe.ducted);
  const gear = hasGear(airframe);
  const gearH = gear ? airframe.groundClearance_mm / 1000 : 0;
  const longRange = wb >= GPS_FROM_WB_M;
  const dihedral = tube ? airframe.armDihedral_deg ?? 0 : 0;
  // Where a motor's base sits, above the bottom plate's top face: on the flat arm, or on a clamp-on mount on top
  // of the tube, which rises along the arm by its dihedral.
  const tubeY = standoffH / 2; // tube axis, mid-way between the plates
  const mountT = tubeD * 0.35;
  const motorBase = tube ? tubeY + tubeD / 2 + mountT + armLen * Math.sin((dihedral * Math.PI) / 180) : armThick;

  // The frame's own body is the plate pair: wide enough for the stack and the battery, not the whole wheelbase
  // (the arms carry the motors out to the wheelbase). A plate about a third of the wheelbase is the usual
  // proportion on a true-X frame. The camera has to fit between the side plates (droneParts CAGE_GAP_SHARE).
  const camW = payload && payload.type === "camera" ? mm(payload.width_mm, 0.029) : 0;
  const bodyW = round ? plateD : Math.max(STACK_BOARD_M * 1.5, wb * 0.3, (camW / 0.46) * 1.06);
  const bodyL = round ? plateD : Math.max(bodyW, mm(battery?.length_mm, 0.076) * 0.95);

  // The nose (+Z) between two arms: a true X on four arms (45°), a hex-X on six, evenly round.
  const a0 = Math.PI / 2 - Math.PI / armCount;
  const armAngles = Array.from({ length: armCount }, (_, i) => a0 + (i * 2 * Math.PI) / armCount);

  if (propeller && propR * 2 > mm(airframe.maxPropDiameter_in * 25.4, Infinity)) {
    warnings.push(`${propeller.name} is wider than the ${airframe.name} takes`);
  }

  // 0. Landing gear first: the vehicle stands on it. Its own y = 0 is the deck.
  if (gear) {
    push({
      id: "drone-gear",
      kind: "drone-gear",
      name: "Retractable landing gear",
      sub: `electric retracts · ${(gearH * 1000).toFixed(0)} mm ground clearance`,
      record: airframe,
      slotY: 0,
      height: u(gearH),
      radius: u((plateD * GEAR_SKID_PER_PLATE) / 2),
      height_m: gearH,
      diameter_m: plateD * GEAR_SKID_PER_PLATE,
      icon: "ring",
      note: "Part of the airframe: the frame's net weight includes it. Its ground clearance is the record's; leg spread and skid length are drawn in proportion to the centre plate.",
      geom: {
        clear_m: gearH,
        spread_m: plateD * GEAR_SPREAD_PER_PLATE,
        skidL_m: plateD * GEAR_SKID_PER_PLATE,
        tubeR_m: tubeD * 0.42,
      },
    });
  }

  // 1. Frame: bottom plate, standoffs, top plate. Local y = 0 is the bottom plate's underside.
  const frameH = botPlate + standoffH + topPlate;
  push({
    id: "drone-frame",
    kind: "drone-frame",
    name: airframe.name,
    sub: `${armCount}-arm ${tube ? "folding " : ""}carbon frame · ${(wb * 1000).toFixed(0)} mm wheelbase`,
    record: airframe,
    slot: "airframe",
    slotY: 0,
    height: u(frameH),
    radius: u(Math.max(bodyW, bodyL) / 2),
    height_m: frameH,
    diameter_m: Math.max(bodyW, bodyL),
    icon: "ring",
    geom: {
      type: "multirotor",
      frameStyle: round ? "round" : "x",
      wheelbase_m: wb,
      armR_m: armR,
      armThick_m: armThick,
      armWidth_m: armWidth,
      standoffH_m: standoffH,
      topPlateThick_m: topPlate,
      botPlateThick_m: botPlate,
      armCount,
      armAngles,
      bodyW_m: bodyW,
      bodyL_m: bodyL,
      stackMount_m: stackMount,
      ducted,
      tubeR_m: tubeD / 2,
      tubeY_m: tubeY,
      gear,
      hasCamera: Boolean(payload) && !gear,
    },
  });

  // 2. Arms + motors, one part per arm: four parts flying in one after another is the best moment in the build.
  // The arm is sandwiched between the plates, so it sits at the bottom plate's top face.
  armAngles.forEach((armAngle, index) => {
    push({
      id: `drone-arm-${index}`,
      kind: "drone-arm",
      name: motor?.name ?? "Motor",
      sub: motor ? `arm ${index + 1} · ${motor.kv} KV · ${motor.stator} stator` : `arm ${index + 1}`,
      record: motor ?? null,
      derived: !motor,
      slot: "motor",
      slotY: u(botPlate),
      height: u(motorBase + motorH),
      radius: u(armR + motorOuterR),
      height_m: motorH,
      diameter_m: mm(motor?.outerDiameter_mm, 0.0275),
      icon: "engine",
      geom: {
        index,
        armAngle,
        armR_m: armR,
        armThick_m: armThick,
        armWidth_m: armWidth,
        motorOuterR_m: motorOuterR,
        motorH_m: motorH,
        statorR_m: mm(motor?.statorDiameter_mm, 0.022) / 2,
        statorH_m: mm(motor?.statorHeight_mm, 0.007),
        shaftR_m: mm(motor?.propShaftDiameter_mm, 0.005) / 2,
        mountCircle_m: mm(motor?.mountCircle_mm ?? airframe.motorMount_mm, 0.016),
        standoffH_m: standoffH,
        ducted,
        armStyle: tube ? "tube" : "plate",
        armLen_m: armLen,
        tubeR_m: tubeD / 2,
        tubeY_m: tubeY,
        mountT_m: mountT,
        motorBaseY_m: motorBase,
        dihedral_deg: dihedral,
        folding: Boolean(airframe.foldingArms),
        plateR_m: plateD / 2,
      },
    });
  });

  // 2b. Ducts: one moulded guard round all the propellers, on the arm ends.
  if (ducted) {
    const D = propR * 2;
    const ductR = (D * DUCT_ID_PER_PROP) / 2;
    const wall = D * DUCT_WALL_PER_PROP;
    const depth = D * DUCT_DEPTH_PER_PROP;
    push({
      id: "drone-duct",
      kind: "drone-duct",
      name: "Propeller ducts",
      sub: `one-piece duct guard · ${armCount} rings`,
      record: null,
      derived: true,
      slotY: u(botPlate),
      height: u(depth),
      radius: u(armR + ductR + wall),
      height_m: depth,
      diameter_m: (ductR + wall) * 2,
      icon: "ring",
      note: "Part of the frame (its published weight is taken to include the ducts). The maker publishes no duct diameter or depth, so the rings are drawn in proportion to the propeller; the duct's effect on thrust is not modelled.",
      geom: {
        armAngles,
        armR_m: armR,
        ductR_m: ductR,
        wall_m: wall,
        depth_m: depth,
        // The propeller's plane above the bottom plate's top face: arm, bell top, half the hub.
        propY_m: motorBase + motorH * MOTOR_SEAT_SHARE + hubH * 0.5,
        bodyW_m: bodyW,
        armWidth_m: armWidth,
        armThick_m: armThick,
      },
    });
  }

  // 3. Electronics stack: flight controller + 4-in-1 ESC on their grommets, between the plates.
  push({
    id: "drone-stack",
    kind: "drone-electronics",
    name: armCount > 4 ? "Flight controller + ESCs" : "Flight controller + 4-in-1 ESC",
    sub: `avionics stack · ${stackMount.map((x) => (x * 1000).toFixed(1)).join("/")} mm mount`,
    record: null,
    derived: true,
    slotY: u(botPlate + 0.002),
    height: u(STACK_H_M),
    radius: u(STACK_BOARD_M / 2),
    height_m: STACK_H_M,
    diameter_m: STACK_BOARD_M,
    icon: "ring",
    note: "Not a dataset record: every build needs a stack, and its mass is in the electronics allowance the verdict uses.",
    geom: {
      // An all-in-one board on a whoop's narrow body is only as big as its hole pattern needs.
      boardSize_m: ducted ? Math.min(STACK_BOARD_M, stackMount[0] + 0.004) : STACK_BOARD_M,
      boardThick_m: STACK_BOARD_THICK_M,
      stackH_m: STACK_H_M,
      standoffH_m: standoffH,
      vtxW_m: ducted ? VTX_W_M * 0.8 : VTX_W_M,
      antennaLen_m: longRange ? Math.max(ANTENNA_LEN_M, wb * LR_ANTENNA_PER_WB) : ANTENNA_LEN_M,
      gps: longRange,
      // No camera payload: the video system's own camera (inside the electronics weight) looks out of the nose.
      fpvCam: !payload,
      bodyW_m: bodyW,
      bodyL_m: bodyL,
      topY_m: standoffH + topPlate - 0.002,
      round,
      armCount,
      wheelbase_m: wb,
    },
  });

  // 4. Battery, strapped on the top plate.
  const battH = mm(battery?.height_mm, 0.033);
  const battL = mm(battery?.length_mm, 0.076);
  const battW = mm(battery?.width_mm, 0.038);
  push({
    id: "drone-battery",
    kind: "drone-battery",
    name: battery?.name ?? "Battery pack",
    sub: battery ? `${battery.cells_s}S ${battery.capacity_mAh} mAh ${battery.chemistry} · ${battery.weight_g} g` : "battery pack",
    record: battery ?? null,
    derived: !battery,
    slot: "battery",
    slotY: u(botPlate + standoffH + topPlate),
    height: u(battH),
    radius: u(Math.max(battL, battW) / 2),
    height_m: battH,
    diameter_m: Math.max(battL, battW),
    icon: "tank",
    geom: {
      L_m: battL,
      W_m: battW,
      H_m: battH,
      cells: battery?.cells_s ?? 4,
      chemistry: battery?.chemistry ?? "LiPo",
      strapW_m: STRAP_W_M,
    },
  });

  // 5. Camera / payload: in the cage ears at the front of the frame, or slung under a frame on landing gear.
  if (payload) {
    const under = gear;
    push({
      id: "drone-camera",
      kind: "drone-camera",
      name: payload.name,
      sub: `${payload.type} payload · ${payload.weight_g} g`,
      record: payload,
      slot: "payload",
      slotY: under ? 0 : u(botPlate + standoffH * 0.15),
      height: u(mm(payload.height_mm, 0.018)),
      radius: u(mm(payload.width_mm, 0.029) / 2),
      height_m: mm(payload.height_mm, 0.018),
      diameter_m: mm(payload.width_mm, 0.029),
      icon: "nose",
      geom: {
        type: payload.type,
        W_m: mm(payload.width_mm, 0.029),
        H_m: mm(payload.height_mm, 0.018),
        L_m: mm(payload.length_mm, 0.029),
        lensR_m: Math.min(mm(payload.width_mm, 0.029), mm(payload.height_mm, 0.018)) * 0.3,
        tilt_deg: CAM_TILT_DEG,
        bodyL_m: mm(airframe.wheelbase_mm, 0.225) * 0.3,
        underslung: under,
        hangZ_m: under ? plateD * 0.18 : 0,
        hangDrop_m: under ? gearH : 0,
      },
    });
  }

  // 6. Propellers, on the motor shafts. Adjacent props counter-rotate (a quad's standard prop-out layout).
  armAngles.forEach((armAngle, index) => {
    push({
      id: `drone-prop-${index}`,
      kind: "drone-propeller",
      name: propeller?.name ?? "Propeller",
      sub: propeller
        ? `${propeller.diameter_in}" × ${propeller.pitch_in}" · ${propeller.bladeCount}-blade`
        : `propeller ${index + 1}`,
      record: propeller ?? null,
      derived: !propeller,
      slot: "propeller",
      slotY: u(botPlate + motorBase + motorH),
      height: u(hubH),
      radius: u(armR + propR), // how far the disc reaches from the vehicle's axis, which is what framing needs
      height_m: hubH,
      diameter_m: mm(propeller?.diameter_mm, 0.127),
      icon: "nose",
      geom: {
        index,
        armAngle,
        armR_m: armR,
        propR_m: propR,
        hubR_m: mm(propeller?.hubDiameter_mm, tube ? motorOuterR * 0.9 : 0.013) / 2,
        hubH_m: hubH,
        shaftR_m: mm(propeller?.shaftHole_mm ?? motor?.propShaftDiameter_mm, 0.005) / 2,
        bladeCount: propeller?.bladeCount ?? 3,
        pitch_in: propeller?.pitch_in ?? 4.5,
        spinDir: index % 2 === 0 ? 1 : -1,
        motorTopY_m: motorH,
        ducted,
      },
    });
  });
  return gearH;
}

// ---------------------------------------------------------------------------------------------------------
// Fixed wing
// ---------------------------------------------------------------------------------------------------------

function fixedWing({ push, u, airframe, motor, propeller, battery, payload }) {
  const span = mm(airframe.wingspan_mm, 1.2);
  const chord = mm(airframe.wingChord_mm, 0.16);
  const fuseL = mm(airframe.fuselageLength_mm, 0.82);
  const fuseR = fuseL * FUSE_R_SHARE;
  const tailR = fuseL * TAIL_R_SHARE;
  const motorH = mm(motor?.height_mm, 0.0335);
  const propR = mm(propeller?.diameter_mm, 0.2286) / 2;

  // 1. Fuselage. Local y = 0 is its lowest point; the body lies along +Z.
  push({
    id: "drone-fuselage",
    kind: "drone-fuselage",
    name: airframe.name,
    sub: `3D-printed fuselage · ${airframe.printMaterial ?? "LW-PLA"} · ${(fuseL * 1000).toFixed(0)} mm`,
    record: airframe,
    slot: "airframe",
    slotY: 0,
    height: u(fuseR * 2),
    radius: u(fuseL / 2),
    height_m: fuseR * 2,
    diameter_m: fuseL,
    icon: "tank",
    geom: {
      type: "fixed_wing_3dprint",
      fuseL_m: fuseL,
      fuseR_m: fuseR,
      tailR_m: tailR,
      noseL_m: fuseL * NOSE_SHARE,
      printMaterial: airframe.printMaterial ?? "LW-PLA",
    },
  });

  // 2. Wing, on the fuselage's shoulder.
  push({
    id: "drone-wing",
    kind: "drone-wing",
    name: `${airframe.airfoil ?? "NACA 2412"} wing`,
    sub: `${(span * 1000).toFixed(0)} mm span · AR ${airframe.aspectRatio?.toFixed(1) ?? "?"}`,
    record: airframe,
    slotY: u(fuseR * 1.55),
    height: u(chord * WING_THICK_SHARE),
    radius: u(span / 2),
    height_m: chord * WING_THICK_SHARE,
    diameter_m: span,
    icon: "ring",
    geom: {
      span_m: span,
      chord_m: chord,
      thick_m: chord * WING_THICK_SHARE,
      airfoil: airframe.airfoil ?? "NACA 2412",
      ribCount: airframe.internalRibCount ?? 14,
      dihedral_deg: DIHEDRAL_DEG,
      fuseR_m: fuseR,
    },
  });

  // 3. Tail: horizontal stabiliser with elevons and a fin, at the back of the fuselage.
  push({
    id: "drone-tail",
    kind: "drone-tail",
    name: "Tail group",
    sub: "stabiliser, fin and control surfaces",
    record: null,
    derived: true,
    slotY: u(fuseR * 1.1),
    height: u(span * TAIL_V_SHARE),
    radius: u(span * TAIL_H_SPAN_SHARE / 2),
    height_m: span * TAIL_V_SHARE,
    diameter_m: span * TAIL_H_SPAN_SHARE,
    icon: "ring",
    note: "Not a dataset record: the tail is sized from the wing by the proportions in droneLayout.js.",
    geom: {
      hSpan_m: span * TAIL_H_SPAN_SHARE,
      hChord_m: chord * TAIL_CHORD_SHARE,
      vHeight_m: span * TAIL_V_SHARE,
      vChord_m: chord * TAIL_CHORD_SHARE,
      boomL_m: fuseL * 0.5,
      fuseL_m: fuseL,
      tailR_m: tailR,
    },
  });

  // 4. Tractor motor on the nose.
  push({
    id: "drone-motor",
    kind: "drone-nose-motor",
    name: motor?.name ?? "Motor",
    sub: motor ? `tractor motor · ${motor.kv} KV · ${motor.stator} stator` : "tractor motor",
    record: motor ?? null,
    derived: !motor,
    slot: "motor",
    slotY: u(fuseR * 0.6),
    height: u(motorH),
    radius: u(mm(motor?.outerDiameter_mm, 0.0275) / 2),
    height_m: motorH,
    diameter_m: mm(motor?.outerDiameter_mm, 0.0275),
    icon: "engine",
    geom: {
      motorOuterR_m: mm(motor?.outerDiameter_mm, 0.0275) / 2,
      motorH_m: motorH,
      statorR_m: mm(motor?.statorDiameter_mm, 0.022) / 2,
      statorH_m: mm(motor?.statorHeight_mm, 0.007),
      shaftR_m: mm(motor?.propShaftDiameter_mm, 0.005) / 2,
      mountCircle_m: mm(motor?.mountCircle_mm ?? airframe.motorMount_mm, 0.016),
      fuseL_m: fuseL,
      fuseR_m: fuseR,
    },
  });

  // 5. Battery in the nose bay (where a plane's pack goes, for the centre of gravity).
  if (battery) {
    push({
      id: "drone-battery",
      kind: "drone-battery",
      name: battery.name,
      sub: `${battery.cells_s}S ${battery.capacity_mAh} mAh ${battery.chemistry} · ${battery.weight_g} g`,
      record: battery,
      slot: "battery",
      slotY: u(fuseR * 0.35),
      height: u(mm(battery.height_mm, 0.022)),
      radius: u(mm(battery.length_mm, 0.062) / 2),
      height_m: mm(battery.height_mm, 0.022),
      diameter_m: Math.max(mm(battery.length_mm, 0.062), mm(battery.width_mm, 0.03)),
      icon: "tank",
      geom: {
        L_m: mm(battery.length_mm, 0.062),
        W_m: mm(battery.width_mm, 0.03),
        H_m: mm(battery.height_mm, 0.022),
        cells: battery.cells_s,
        chemistry: battery.chemistry,
        strapW_m: STRAP_W_M,
        bayW_m: fuseR * 1.6,
        fuseL_m: fuseL,
      },
    });
  }

  // 6. Payload, under the nose.
  if (payload) {
    push({
      id: "drone-camera",
      kind: "drone-camera",
      name: payload.name,
      sub: `${payload.type} payload · ${payload.weight_g} g`,
      record: payload,
      slot: "payload",
      slotY: 0,
      height: u(mm(payload.height_mm, 0.018)),
      radius: u(mm(payload.width_mm, 0.029) / 2),
      height_m: mm(payload.height_mm, 0.018),
      diameter_m: mm(payload.width_mm, 0.029),
      icon: "nose",
      geom: {
        type: payload.type,
        W_m: mm(payload.width_mm, 0.029),
        H_m: mm(payload.height_mm, 0.018),
        L_m: mm(payload.length_mm, 0.029),
        lensR_m: Math.min(mm(payload.width_mm, 0.029), mm(payload.height_mm, 0.018)) * 0.3,
        tilt_deg: 0, // a plane's camera looks straight down
        fuseL_m: fuseL,
        fuseR_m: fuseR,
      },
    });
  }

  // 7. Tractor propeller, last on.
  if (propeller) {
    push({
      id: "drone-prop-0",
      kind: "drone-nose-propeller",
      name: propeller.name,
      sub: `${propeller.diameter_in}" × ${propeller.pitch_in}" tractor · ${propeller.bladeCount}-blade`,
      record: propeller,
      slot: "propeller",
      slotY: u(fuseR * 0.6),
      height: u(mm(propeller.hubThickness_mm, 0.008)),
      radius: u(propR),
      height_m: mm(propeller.hubThickness_mm, 0.008),
      diameter_m: mm(propeller.diameter_mm, 0.2286),
      icon: "nose",
      geom: {
        index: 0,
        propR_m: propR,
        hubR_m: mm(propeller.hubDiameter_mm, 0.016) / 2,
        hubH_m: mm(propeller.hubThickness_mm, 0.008),
        shaftR_m: mm(propeller.shaftHole_mm ?? motor?.propShaftDiameter_mm, 0.005) / 2,
        bladeCount: propeller.bladeCount ?? 2,
        pitch_in: propeller.pitch_in ?? 6,
        spinDir: 1,
        fuseL_m: fuseL,
        fuseR_m: fuseR,
        motorH_m: motorH,
      },
    });
  }

  // The launch stand under it all (see STAND_CLEAR): the propeller hub sits at the prop part's slotY plus the
  // fuselage radius (droneParts.js buildNosePropeller sets its pieces at y = fuseR), so the disc's lowest point
  // is propR below that. With no propeller there is nothing to clear and the stand is just a low cradle.
  const hubY = fuseR * 0.6 + fuseR;
  const clear = propeller ? Math.max(0, propR - hubY) + STAND_CLEAR * propR : fuseR * 0.5;
  return { height_m: clear, fuseL_m: fuseL, fuseR_m: fuseR };
}

// ---------------------------------------------------------------------------------------------------------
// Quadplane (airframe.type "vtol_quadplane"): a fixed wing with lift rotors on booms under the wing and one
// cruise motor, pusher (airframe.pusher) or tractor. Drawn from the record's span, length, root and mean chord,
// wing area, boom count, length and section, lift-motor spacing, tail type and propeller sizes; every null is a
// named visual ratio above. It stands on its own skids (a ventral fin at the tail when the propeller is a pusher),
// tall enough that the cruise propeller's disc and a belly payload clear the deck. Body along +Z, nose at +Z.
// Returns how far every part is lifted (the skid height under the fuselage's lowest point).
// ---------------------------------------------------------------------------------------------------------

function tailKind(tail) {
  const t = String(tail ?? "").toLowerCase();
  if (/inv/.test(t) && /v/.test(t)) return "inverted-v";
  if (/^v\b|v-tail|v tail|vtail/.test(t)) return "v";
  if (/^h\b|h-tail|h tail|twin/.test(t)) return "h";
  if (/t-tail|t tail/.test(t)) return "t";
  return "conventional";
}

function quadplane({ push, u, airframe, motor, propeller, cruiseMotor, cruiseProp, battery, payload }) {
  const span = mm(airframe.wingspan_mm, 1.5);
  const L = mm(airframe.fuselageLength_mm, span * 0.62); // overall length
  const tailK = tailKind(airframe.tail);
  const twin = tailK === "h"; // tail booms carry the tail; the pod is shorter than the overall length
  const area = Number.isFinite(airframe.wingArea_dm2) ? airframe.wingArea_dm2 / 100 : null; // m²
  const mac = mm(airframe.wingChord_mm, area ? area / span : span / 8);
  const root = mm(airframe.rootChord_mm, mac * VTOL_ROOT_PER_MAC);
  // Tip chord from the wing area: a straight centre section at the root chord, then a linear taper to the tip
  // (mean chord = area / span). Without an area, a fixed visual taper.
  const f = VTOL_WING_STRAIGHT;
  const tip = area ? clampN((2 * (area / span - f * root)) / (1 - f) - root, root * 0.35, root) : root * 0.6;
  const podL = twin ? L * TWIN_POD_SHARE : L;
  const fuseR = podL * VTOL_FUSE_R_SHARE * (twin ? TWIN_POD_FAT : 1);
  const tailR = podL * TAIL_R_SHARE;
  const pusher = airframe.pusher === true;
  const liftPropR = mm(propeller?.diameter_mm, mm((airframe.liftPropDiameter_in ?? 7) * 25.4, 0.178)) / 2;
  const cruisePropR = mm(cruiseProp?.diameter_mm, mm((airframe.cruisePropDiameter_in ?? 9) * 25.4, 0.229)) / 2;
  const motorH = mm(motor?.height_mm, 0.0335);
  const motorOuterR = mm(motor?.outerDiameter_mm, 0.0275) / 2;
  const cMotorH = mm(cruiseMotor?.height_mm, 0.034);
  const cMotorR = mm(cruiseMotor?.outerDiameter_mm, 0.028) / 2;
  const thick = root * WING_THICK_SHARE;

  // Along the body (z, from the middle of the overall length): wing, lift motors, tail, the cruise motor's face.
  const zLE = L / 2 - VTOL_WING_AT * podL;
  const zW = zLE - root / 2; // wing chord centre at the root
  const hTail = tailK === "conventional" || tailK === "t";
  const tChord = root * TAIL_CHORD_SHARE_V;
  // A pusher's motor sits on the pod's tail end face, its propeller behind it; a tractor's on the nose.
  const faceZ = pusher ? L / 2 - podL + cMotorH * 0.9 : L / 2;
  const zT = twin ? -L / 2 + tChord * 0.5 : pusher ? faceZ + tChord * 0.62 : -L / 2 + tChord * 0.5;

  // Lift motors: a rectangle (across × fore-aft) centred on the wing's forward chord.
  const diag = mm(airframe.liftMotorDiagonal_mm, null);
  const spanX = mm(airframe.liftMotorSpan_x_mm, diag ? diag / Math.hypot(1, LIFT_RECT_ASPECT) : span * LIFT_SPAN_SHARE);
  const boomCount = Math.max(1, Math.round(airframe.boomCount ?? 2));
  const liftCount = Math.max(boomCount, Math.round(airframe.liftMotorCount ?? 4));
  const perBoom = Math.max(1, Math.round(liftCount / boomCount));
  const boomL0 = mm(airframe.boomLength_mm, null);
  const spanY = mm(airframe.liftMotorSpan_y_mm, diag ? (diag * LIFT_RECT_ASPECT) / Math.hypot(1, LIFT_RECT_ASPECT) : (boomL0 ?? root * 2.2) - motorOuterR * 2.4);
  const zB = zLE - BOOM_AT_CHORD * root;
  // Boom: the record's length (a lift boom under the wing), or on a twin-boom airframe from the front lift motor
  // back to the tail.
  const zFront = zB + spanY / 2 + motorOuterR * 1.2;
  const zBack = twin ? zT - tChord * 0.55 : zB - spanY / 2 - motorOuterR * 1.2;
  const boomL = twin ? zFront - zBack : boomL0 ?? zFront - zBack;
  const zC = twin ? (zFront + zBack) / 2 : zB;
  const sec = Array.isArray(airframe.boomSection_mm) ? airframe.boomSection_mm.map((x) => x / 1000) : null;
  const roundBoom = !sec;
  const secW = sec ? sec[0] : mm(airframe.boomDiameter_mm, span * BOOM_D_PER_SPAN);
  const secH = sec ? sec[1] ?? sec[0] : secW;
  const boomXs = boomCount === 1 ? [0] : Array.from({ length: boomCount }, (_, i) => -spanX / 2 + (i * spanX) / (boomCount - 1));
  const motorZs = perBoom === 1 ? [0] : Array.from({ length: perBoom }, (_, i) => spanY / 2 - (i * spanY) / (perBoom - 1));

  // Heights, from the fuselage's lowest point (y = 0 before the lift): the axis at fuseR, the wing's chord line
  // high on the body, the booms tucked under the wing (which rises by its dihedral out to them).
  const axisY = fuseR;
  const wingY = fuseR * 1.4;
  const dih = (DIHEDRAL_DEG * Math.PI) / 180;
  const boomTop = (x) => wingY + Math.abs(x) * Math.tan(dih) - thick * 0.42;
  const boomAxisY = boomTop(spanX / 2) - secH / 2;
  // Standing height: the cruise propeller's disc and a belly payload clear the deck.
  const podH = payload ? mm(payload.height_mm, 0.05) : 0;
  const axisAbove = Math.max(cruisePropR * (1 + SKID_CLEAR), fuseR + podH * (1 + POD_CLEAR), fuseR * 1.8);
  const lift = axisAbove - fuseR;
  const legs = String(airframe.landingGear ?? "").toLowerCase() === "legs";
  // A printed airframe shows its layer lines; a moulded foam one does not.
  const printed = /\bpla\b|-pla\b|\basa\b|petg|print/i.test(`${airframe.printMaterial ?? ""} ${airframe.material ?? ""} ${airframe.name ?? ""}`);

  // 1. Fuselage, with its landing gear. Local y = 0 is its lowest point; the gear reaches `lift` below it.
  push({
    id: "drone-fuselage",
    kind: "drone-fuselage",
    name: airframe.name,
    sub: `${(L * 1000).toFixed(0)} mm long · ${pusher ? "pusher" : "tractor"} · on landing ${legs ? "legs" : "skids"}`,
    record: airframe,
    slot: "airframe",
    slotY: 0,
    height: u(fuseR * 2),
    radius: u(L / 2),
    height_m: fuseR * 2,
    diameter_m: L,
    icon: "tank",
    geom: {
      type: "vtol_quadplane",
      style: "pod",
      printed,
      fuseL_m: L,
      podL_m: podL,
      fuseR_m: fuseR,
      tailR_m: tailR,
      pusher,
      faceZ_m: faceZ,
      cMotorR_m: cMotorR,
      skidDrop_m: lift,
      gear: legs ? "legs" : "skids",
      // Legs stand under the booms; skids under the body, both a little ahead of the centre of the lift motors.
      gearX_m: legs ? spanX / 2 : 0,
      gearTopY_m: legs ? boomAxisY - secH / 2 : 0,
      skidZ_m: zB + root * 0.12,
      finTip: pusher && !twin,
      finTipZ_m: zT - tChord * 0.1,
      wingZ_m: zW,
      rootChord_m: root,
    },
  });

  // 2. Wing.
  push({
    id: "drone-wing",
    kind: "drone-wing",
    name: airframe.airfoil ? `${airframe.airfoil} wing` : "Wing",
    sub: `${(span * 1000).toFixed(0)} mm span${airframe.rootChord_mm ? ` · root chord ${(root * 1000).toFixed(0)} mm` : ""}`,
    record: airframe,
    slotY: u(wingY),
    height: u(thick),
    radius: u(span / 2),
    height_m: thick,
    diameter_m: span,
    icon: "ring",
    geom: {
      span_m: span,
      chord_m: root,
      rootChord_m: root,
      tipChord_m: tip,
      straight: f,
      z_m: zW,
      thick_m: thick,
      airfoil: airframe.airfoil ?? "",
      ribCount: 18,
      printed,
      dihedral_deg: DIHEDRAL_DEG,
      fuseR_m: fuseR,
    },
  });

  // 3. Tail: on the pod's tail cone (V, inverted V, conventional) or between the booms' ends (H).
  const tSpan = twin ? spanX : span * (hTail ? TAIL_H_SPAN_SHARE : TAIL_SPAN_SHARE_V);
  push({
    id: "drone-tail",
    kind: "drone-tail",
    name: tailK === "v" ? "V-tail" : tailK === "inverted-v" ? "Inverted V-tail" : tailK === "h" ? "H-tail" : "Tail group",
    sub: tailK === "h" ? "stabiliser between the booms, a fin on each" : hTail ? "stabiliser, fin and control surfaces" : "two ruddervators",
    record: null,
    derived: true,
    slotY: u(twin ? boomAxisY : axisY),
    height: u(twin ? span * H_FIN_SHARE : tSpan * 0.4),
    radius: u(Math.hypot(tSpan / 2, L / 2)),
    height_m: twin ? span * H_FIN_SHARE : tSpan * 0.4,
    diameter_m: tSpan,
    icon: "ring",
    note: "Not a dataset record: the tail type is the record's, its size is drawn from the wing by the proportions in droneLayout.js.",
    geom: {
      tailType: tailK,
      printed,
      zT_m: zT,
      span_m: tSpan,
      chord_m: tChord,
      vdih_deg: VTAIL_DIHEDRAL_DEG,
      finH_m: span * H_FIN_SHARE,
      finDown_m: boomAxisY + lift, // an H-tail's fins reach the deck: the rear legs
      boomR_m: secW / 2,
      // the conventional builder's fields
      hSpan_m: tSpan,
      hChord_m: tChord,
      vHeight_m: span * TAIL_V_SHARE,
      vChord_m: tChord,
      boomL_m: 0,
      fuseL_m: L,
      tailR_m: tailR,
      noBoom: true,
    },
  });

  // 4. Booms, each with its lift motors.
  boomXs.forEach((x, index) => {
    push({
      id: `drone-boom-${index}`,
      kind: "drone-boom",
      name: motor?.name ?? "Lift motor",
      sub: `${twin ? "tail" : "lift"} boom ${index + 1} · ${perBoom} × ${motor ? `${motor.kv} KV` : "motor"} lift motors`,
      record: motor ?? null,
      derived: !motor,
      slot: "motor",
      slotY: u(boomTop(x) - secH),
      height: u(secH + motorH),
      radius: u(Math.hypot(Math.abs(x), Math.max(Math.abs(zC - boomL / 2), Math.abs(zC + boomL / 2)))),
      height_m: motorH,
      diameter_m: mm(motor?.outerDiameter_mm, 0.0275),
      icon: "engine",
      geom: {
        index,
        x_m: x,
        zC_m: zC,
        len_m: boomL,
        secW_m: secW,
        secH_m: secH,
        round: roundBoom,
        motorZ_m: motorZs.map((z) => zB + z),
        mountZ_m: [zLE - root * 0.15, zLE - root * 0.8],
        nacelle: twin,
        motorOuterR_m: motorOuterR,
        motorH_m: motorH,
        statorR_m: mm(motor?.statorDiameter_mm, 0.022) / 2,
        statorH_m: mm(motor?.statorHeight_mm, 0.007),
        shaftR_m: mm(motor?.propShaftDiameter_mm ?? motor?.shaftDiameter_mm, 0.005) / 2,
        mountCircle_m: mm(motor?.mountCircle_mm ?? airframe.motorMount_mm, 0.016),
        wingGap_m: thick * 0.42,
      },
    });
  });

  // 5. Cruise motor, on the pod's tail (pusher) or the nose (tractor).
  push({
    id: "drone-motor",
    kind: "drone-nose-motor",
    name: cruiseMotor?.name ?? "Cruise motor",
    sub: cruiseMotor ? `${pusher ? "pusher" : "tractor"} cruise motor · ${cruiseMotor.kv} KV · ${cruiseMotor.stator} stator` : "cruise motor",
    record: cruiseMotor ?? null,
    derived: !cruiseMotor,
    slotY: 0,
    height: u(cMotorR * 2),
    radius: u(Math.abs(faceZ) + cMotorH),
    height_m: cMotorH,
    diameter_m: cMotorR * 2,
    icon: "engine",
    geom: {
      motorOuterR_m: cMotorR,
      motorH_m: cMotorH,
      statorR_m: mm(cruiseMotor?.statorDiameter_mm, 0.022) / 2,
      statorH_m: mm(cruiseMotor?.statorHeight_mm, 0.007),
      shaftR_m: mm(cruiseMotor?.propShaftDiameter_mm ?? cruiseMotor?.shaftDiameter_mm, 0.005) / 2,
      mountCircle_m: mm(cruiseMotor?.mountCircle_mm ?? airframe.motorMount_mm, 0.016),
      fuseL_m: L,
      fuseR_m: fuseR,
      axisY_m: axisY,
      faceZ_m: faceZ,
      pusher,
    },
  });

  // 6. Battery, in the fuselage's forward bay.
  if (battery) {
    const bH = mm(battery.height_mm, 0.03);
    push({
      id: "drone-battery",
      kind: "drone-battery",
      name: battery.name,
      sub: `${battery.cells_s}S ${battery.capacity_mAh} mAh ${battery.chemistry} · ${battery.weight_g} g`,
      record: battery,
      slot: "battery",
      slotY: u(Math.max(fuseR * 0.25, axisY - bH * 0.55)),
      height: u(bH),
      radius: u(Math.abs(zLE) + mm(battery.length_mm, 0.1)),
      height_m: bH,
      diameter_m: Math.max(mm(battery.length_mm, 0.1), mm(battery.width_mm, 0.04)),
      icon: "tank",
      geom: {
        L_m: mm(battery.length_mm, 0.1),
        W_m: mm(battery.width_mm, 0.04),
        H_m: bH,
        cells: battery.cells_s,
        chemistry: battery.chemistry,
        strapW_m: STRAP_W_M,
        z_m: zLE + mm(battery.length_mm, 0.1) * 0.15,
        bay: true,
      },
    });
  }

  // 7. Payload, hung under the belly at the wing: a pod, a camera or a sensor looking down.
  if (payload) {
    push({
      id: "drone-camera",
      kind: "drone-camera",
      name: payload.name,
      sub: `${payload.type} payload · ${payload.weight_g} g`,
      record: payload,
      slot: "payload",
      slotY: 0,
      height: u(podH),
      radius: u(Math.abs(zLE) + mm(payload.length_mm, 0.03)),
      height_m: podH,
      diameter_m: mm(payload.width_mm, 0.029),
      icon: "nose",
      geom: {
        type: payload.type,
        W_m: mm(payload.width_mm, 0.029),
        H_m: podH,
        L_m: mm(payload.length_mm, 0.029),
        lensR_m: Math.min(mm(payload.width_mm, 0.029), podH) * 0.3,
        tilt_deg: 0,
        fuseL_m: L,
        fuseR_m: fuseR,
        belly: payload.type === "cargo",
        bellyZ_m: zLE - root * 0.3,
        underslung: payload.type !== "cargo",
        hangZ_m: zLE - root * 0.3,
      },
    });
  }

  // 8. Lift propellers on the boom motors. Diagonal pairs turn the same way, as on any quad.
  let k = 0;
  boomXs.forEach((x) => {
    motorZs.forEach((dz) => {
      const z = zB + dz;
      push({
        id: `drone-prop-${k}`,
        kind: "drone-propeller",
        name: propeller?.name ?? "Lift propeller",
        sub: propeller ? `${propeller.diameter_in}" × ${propeller.pitch_in}" lift · ${propeller.bladeCount}-blade` : `lift propeller ${k + 1}`,
        record: propeller ?? null,
        derived: !propeller,
        slot: "propeller",
        slotY: u(boomTop(x) + motorH + secH * 0.35),
        height: u(mm(propeller?.hubThickness_mm, 0.007)),
        radius: u(Math.hypot(x, z) + liftPropR),
        height_m: mm(propeller?.hubThickness_mm, 0.007),
        diameter_m: liftPropR * 2,
        icon: "nose",
        geom: {
          index: k,
          armAngle: Math.atan2(z, x),
          armR_m: Math.hypot(x, z),
          propR_m: liftPropR,
          hubR_m: mm(propeller?.hubDiameter_mm, motorOuterR * 1.1) / 2,
          hubH_m: mm(propeller?.hubThickness_mm, 0.007),
          shaftR_m: mm(propeller?.shaftHole_mm ?? motor?.propShaftDiameter_mm, 0.005) / 2,
          bladeCount: propeller?.bladeCount ?? 2,
          pitch_in: propeller?.pitch_in ?? 4,
          spinDir: Math.sign(x || 1) * Math.sign(dz || 1) > 0 ? 1 : -1,
          motorTopY_m: motorH,
          lift: true,
        },
      });
      k++;
    });
  });

  // 9. Cruise propeller, last on.
  if (cruiseProp || cruiseMotor) {
    push({
      id: `drone-prop-${k}`,
      kind: "drone-nose-propeller",
      name: cruiseProp?.name ?? "Cruise propeller",
      sub: cruiseProp ? `${cruiseProp.diameter_in}" × ${cruiseProp.pitch_in}" ${pusher ? "pusher" : "tractor"} · ${cruiseProp.bladeCount}-blade` : "cruise propeller",
      record: cruiseProp ?? null,
      derived: !cruiseProp,
      slotY: 0,
      height: u(cruisePropR * 2),
      radius: u(Math.abs(faceZ) + cMotorH + 0.01),
      height_m: mm(cruiseProp?.hubThickness_mm, 0.008),
      diameter_m: cruisePropR * 2,
      icon: "nose",
      geom: {
        index: k,
        propR_m: cruisePropR,
        hubR_m: mm(cruiseProp?.hubDiameter_mm, cMotorR * 1.1) / 2,
        hubH_m: mm(cruiseProp?.hubThickness_mm, 0.008),
        shaftR_m: mm(cruiseProp?.shaftHole_mm ?? cruiseMotor?.propShaftDiameter_mm, 0.005) / 2,
        bladeCount: cruiseProp?.bladeCount ?? 2,
        pitch_in: cruiseProp?.pitch_in ?? 6,
        spinDir: 1,
        fuseL_m: L,
        fuseR_m: fuseR,
        motorH_m: cMotorH,
        axisY_m: axisY,
        faceZ_m: faceZ,
        pusher,
        cruise: true,
      },
    });
  }
  return lift;
}
const clampN = (x, a, b) => Math.min(b, Math.max(a, x));

// ---------------------------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------------------------

// Same shape layout.sceneBounds returns, so the camera framing, the pad and the hologram all work unchanged.
// A drone is wide and flat where a rocket is tall and thin, so height_u comes out small and radius_u large;
// that is the truth about the vehicle and the framing code already handles both.
export function droneSceneBounds(manifest) {
  let height_u = 0;
  let radius_u = 0;
  for (const p of manifest) {
    height_u = Math.max(height_u, p.slotY + p.height);
    radius_u = Math.max(radius_u, p.radius);
  }
  const K = manifest[0]?.geom?.viewK ?? 1;
  const stand = manifest.stand ?? null;
  return {
    height_u,
    radius_u,
    // height_m is what the HUD shows as the vehicle's size, so it must be the TRUE height, not the drawn one
    // (and not the launch stand a fixed wing rests on, which is not part of it).
    height_m: (height_u - (stand?.height_u ?? 0)) / SCALE / K,
    baseRadius_u: radius_u,
    viewK: K,
    stand, // fixed wing: { height_u, saddleZ_u, fuseR_u } of the launch stand, else null
  };
}
