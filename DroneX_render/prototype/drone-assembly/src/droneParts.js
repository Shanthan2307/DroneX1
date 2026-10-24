// Procedural drone parts, generated from the drone manifest (src/droneLayout.js) at DISPLAY scale.
// The rocket builders live in parts.js; these are their drone counterparts and they obey the same rules,
// through the toolkit parts.js exports as KIT (docs/drone-integration.md §6). A part is a group at
// spec.slotY whose local y = 0 is the part's bottom, and a part is a mechanical assembly of separate pieces,
// not one primitive. A piece is one mechanical assembly's worth of merged geometry, and repeated hardware
// (screws, wire clamps, strap keepers) is static instanced detail through addDetail: one draw call, no animation.
//
// DISPLAY SCALE, and nothing here works without it (contract §2). Scene units are metres × SCALE, so a
// 225 mm quad at true scale is 0.056 units: smaller than a rivet on the rocket and inside the camera's
// minimum distance. So every builder starts with
//     const K = spec.geom.viewK;  const d = (m) => m * K;
// and authors EVERY dimension as d(trueMetres). piece() then applies SCALE once, exactly as for a rocket.
// The true metres stay in spec.geom / spec.record and in spec.height_m / diameter_m, and those are the only
// numbers the cards ever show. Never put a d()-multiplied number on screen.
//
// Sizes come from the dataset through spec.geom (true metres) and spec.record. Every other proportion in this
// file is a visual ratio of one of those sizes, used only to shape geometry where the data has none (how many
// vents a bell has, how wide a screw head is); they are the named constants under "visual proportions" below
// and they are never shown on screen as facts.
//
// Pieces carry the same fields the rocket pieces do (parts.js header): `order` is arrival order, bottom-up and
// inside-out; `explode` is a direction and a distance in scene units; `kind` is the draw role, not the vehicle
// part. "shell" is outer skin (edge lines, shadows, the clear/opaque toggle), "interior" is what shows through
// a clear shell, "detail" is small hardware. An arm's shell is the carbon arm and the motor bell; its interior
// is the stator, windings and magnets; its detail is the screws and the phase wires.
//
// SPINNING PIECES. src/droneFlight.js spins a propeller by turning each piece of a propeller part about the
// local axis named by mesh.userData.spinAxis ("y" on a quad, "z" on the wing's nose prop), through the mesh's
// origin, so every piece of that part is authored centred on its own hub axis at the origin and placed at the
// arm end through piece()'s x / y / z. Nothing off-axis is baked in, and the blade phase is baked
// into the geometry rather than left on the piece, so a spin cannot overwrite it. The motor's rotor does the
// same: the pieces that really turn (bell, cap, magnets, shaft) are centred on the motor axis and marked
// mesh.userData.spin = true; the stator, windings and base are not.
//
// FINISHES. The role materials on `mats` are the rocket's; a racing quad needs a few finishes the rocket has
// no role for (black anodised bells, copper windings, PCB solder mask, translucent polycarbonate props, TPU).
// tone() derives them from a role material, keeping its x-ray twin and its painted twin (both looks still
// switch), and caches them per material set so a whole drone shares one copy of each.
import * as THREE from "three";
import { KIT } from "./parts.js";
import { SCALE } from "./scale.js";

const {
  piece, box, cyl, lathe, latheUV, machinedRing, ogivePoints, domePoints, boltRing,
  merge, projectUV, addDetail, boltCircle, clampsAlong, rod, v3, radial, TAU, UP, DOWN, DS, clamp, lerp,
} = KIT;

// ---- visual proportions (shape only, never shown on screen as a fact) ----
const PLATE_W_SHARE = 0.66; // plate width / geom bodyW: an FPV body is about a battery wide, not a stack diagonal
const PLATE_W_DUCTED = 0.45; // ... on a ducted frame
const PLATE_L_SHARE = 0.46; // plate length / wheelbase (a 5-inch freestyle body is a long narrow plate)
const CAM_PIVOT_SHARE = 0.38; // the camera's tilt axis, forward of the centre / plate length
const CAM_BODYL_PER_WB = 0.3; // droneLayout writes camera geom.bodyL_m = 0.3 × wheelbase: how the camera finds the plate's front
const ARM_ROOT_SHARE = 0.27; // the arm's inboard end / armR, clear of the flight stack between the arm roots
const ARM_PAD_SHARE = 0.5; // how far out the bottom plate's arm pad reaches / armR
const ARM_PAD_W = 1.35; // arm pad half-width / arm half-width (the pad is wider than the arm it clamps)
const ARM_TIP_TAPER = 0.78; // arm width at the motor end / at the root (a carbon arm tapers outboard)
const ARM_ROOT_BOLTS = 2; // bolts clamping one arm between the plates
const STANDOFF_R_SHARE = 0.021; // aluminium standoff radius / wheelbase
const CAGE_GAP_SHARE = 0.46; // camera side plate spacing / body width (what a micro FPV camera fits between)
const STATOR_TEETH = 12; // 12 slots, 14 poles: the usual outrunner wind. Shape only, not a record field.
const BELL_MAGNETS = 14;
const BELL_WINDOWS = 6; // vent windows round the top of the bell, and the spokes of its cap
const MOTOR_SHAFT_SHARE = 0.38; // share of the record's height (which includes the shaft) standing above the bell
const MOTOR_BASE_SHARE = 0.15; // base height / bell-top height
const MOTOR_WALL_SHARE = 0.075; // bell wall thickness / outer radius
const MOTOR_WIRES = 3; // three phases leave every brushless motor
const PROP_LE_SHARE = 0.36; // pitch axis position back from the leading edge / chord
const PROP_CHORD_SHARE = 0.21; // maximum blade chord / propeller radius
const PROP_CHORD_DUCTED = 0.32; // ... on a ducted propeller
const PROP_PLANFORM = [0.5, 0.64, 0.78, 0.9, 0.97, 1.0, 0.99, 0.95, 0.88, 0.78, 0.64, 0.46, 0.22]; // chord, root → tip
const PROP_THICK_ROOT = 0.24; // section thickness / chord at the blade root
const PROP_THICK_TIP = 0.06; // ... and at the tip
const PROP_CAMBER = 0.05; // blade camber / chord (a propeller blade is a cambered plate, not a flat one)
const PROP_SWEEP = 0.34; // radians the tip trails the root: the curved, swept planform of a modern 5-inch prop
const BOARD_CORNER = 0.12; // PCB corner radius / board size
const PRINT_BAND_M = 0.009; // printed-shell layer banding pitch in TRUE metres: far coarser than the real
const PRINT_BAND_AMP_M = 0.0012; // 0.2 mm layer height, so the striation reads on screen at all
const WING_ELEVON_SPAN = 0.46; // elevon starts this far out along the half-span
const WING_ELEVON_CHORD = 0.26; // elevon chord / wing chord
const WING_TIP_TAPER = 0.6; // chord at the rounded tip / root chord
const SPAR_R_SHARE = 0.22; // spar tube radius / wing thickness
const DEPLOY_DEG = 18; // how far a control surface deflects in the deploy view

// ---- finishes (colour choices, not facts) ----
const ACCENT = 0xff5b1f; // TPU printed parts and polycarbonate props: one livery colour
const FIN = {
  bell: { color: 0x17191e, metalness: 0.85, roughness: 0.3 }, // black anodised aluminium
  copper: { color: 0xc4682c, metalness: 0.9, roughness: 0.3, map: null }, // enamelled copper windings
  magnet: { color: 0x9da2a8, metalness: 0.9, roughness: 0.34 }, // nickel-plated neodymium
  pcbBlack: { color: 0x0d0f12, metalness: 0.15, roughness: 0.42, map: null, emissive: 0x000000 },
  pcbGreen: { color: 0x0d3b26, metalness: 0.15, roughness: 0.38, map: null, emissive: 0x000000 },
  chip: { color: 0x1a1b1f, metalness: 0.1, roughness: 0.62, map: null, emissive: 0x000000 },
  gold: { color: 0xd8b25a, metalness: 1, roughness: 0.22 }, // ENIG pads, plated contacts
  tpu: { color: ACCENT, metalness: 0, roughness: 0.72, map: null, bumpMap: null, roughnessMap: null, clearcoat: 0 },
  wrap: { color: 0x101114, metalness: 0.15, roughness: 0.34, map: null, bumpMap: null, roughnessMap: null, clearcoat: 0.7, clearcoatRoughness: 0.2 },
  label: { color: 0xc4141e, metalness: 0.1, roughness: 0.4, map: null, bumpMap: null, roughnessMap: null, clearcoat: 0.6 },
  labelWhite: { color: 0xe8e8e4, metalness: 0, roughness: 0.5, map: null, bumpMap: null, roughnessMap: null },
  silicone: { color: 0x141518, metalness: 0, roughness: 0.6 },
  siliconeRed: { color: 0xa3141a, metalness: 0, roughness: 0.55 },
  nylonYellow: { color: 0xe0b21c, metalness: 0, roughness: 0.5 }, // XT60 / XT90 shells
  jst: { color: 0xe6e3da, metalness: 0, roughness: 0.6 },
  glass: { color: 0x1d2c55, metalness: 1, roughness: 0.04 }, // coated lens glass
  rubber: { color: 0x1c1d21, metalness: 0, roughness: 0.9, map: null, bumpMap: null, roughnessMap: null, clearcoat: 0 },
  // Pouch-cell laminate: satin aluminium, not the rocket's crinkled MLI foil, whose sparkle map and mirror
  // finish blew out to a white glare (with bloom) through a clear battery wrap in sunlight.
  pouch: { color: 0x7d8086, metalness: 0.6, roughness: 0.55, map: null, bumpMap: null, roughnessMap: null, clearcoat: 0 },
  // Moulded duct guard: black glass-filled nylon, a satin finish.
  duct: { color: 0x1e2025, metalness: 0.05, roughness: 0.5, map: null, bumpMap: null, roughnessMap: null, clearcoat: 0.25, clearcoatRoughness: 0.5 },
  // 21700 cell sleeves (a Li-ion pack's cells show as ribs under its clear-ish wrap) and their nickel strip.
  cell: { color: 0x2b4a7a, metalness: 0.2, roughness: 0.4, map: null, bumpMap: null, roughnessMap: null, clearcoat: 0.6 },
  // A light-grey printed airframe and a multispectral camera's grey anodised case.
  sensor: { color: 0x3a3d42, metalness: 0.55, roughness: 0.42 },
  // Moulded EPO foam: a plain off-white skin, no panel lines or print banding.
  foam: { color: 0xe6e5df, metalness: 0, roughness: 0.78, map: null, bumpMap: null, roughnessMap: null, clearcoat: 0.05 },
};

const DEG = Math.PI / 180;
const SEG = 28; // azimuthal segments for small lathed hardware (a motor bell is 28 mm across in reality)

// tone(mats, key): a finish derived from a role material, both looks kept (see FINISHES above).
const TONE_BASE = { bell: "darkMetal", copper: "bronze", magnet: "metal", pcbBlack: "panel", pcbGreen: "panel", chip: "darkMetal", gold: "mirror", tpu: "trim", wrap: "trim", label: "trim", labelWhite: "trim", silicone: "skirt", siliconeRed: "skirt", nylonYellow: "skirt", jst: "skirt", glass: "mirror", rubber: "trim", pouch: "metal", duct: "trim", cell: "trim", sensor: "darkMetal", foam: "body" };
const toneCache = new WeakMap();
function fit(m, o) {
  const ok = {};
  for (const k of Object.keys(o)) if (k in m) ok[k] = o[k];
  m.setValues(ok);
  m.userData = { ...m.userData };
  delete m.userData.soot; // a derived finish is clean: the soot hook is not carried over
  m.needsUpdate = true;
  return m;
}
function tone(mats, key) {
  let cache = toneCache.get(mats);
  if (!cache) toneCache.set(mats, (cache = new Map()));
  if (cache.has(key)) return cache.get(key);
  const base = mats[TONE_BASE[key]];
  let m;
  if (base.painted) {
    m = base.clone();
    Object.defineProperty(m, "painted", { value: fit(base.painted.clone(), FIN[key]) });
    if (base.asShell) Object.defineProperty(m, "asShell", { value: base.asShell });
  } else m = fit(base.clone(), FIN[key]);
  Object.defineProperty(m, "role", { value: base.role ?? TONE_BASE[key] });
  cache.set(key, m);
  return m;
}
// Translucent polycarbonate (or opaque glass-filled nylon) for a propeller, by the record's material.
function propMaterial(mats, material) {
  // A carbon-fibre propeller (a heavy-lift prop) is the carbon weave itself.
  if (/carbon|\bcf\b|cf\+/i.test(String(material ?? ""))) return mats.composite;
  const clear = /poly/i.test(String(material ?? "polycarbonate"));
  const key = clear ? "propPC" : "propNylon";
  let cache = toneCache.get(mats);
  if (!cache) toneCache.set(mats, (cache = new Map()));
  if (cache.has(key)) return cache.get(key);
  const look = clear
    ? new THREE.MeshPhysicalMaterial({ color: ACCENT, metalness: 0, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.06, transparent: true, opacity: 0.84, side: THREE.DoubleSide })
    : new THREE.MeshPhysicalMaterial({ color: 0x1b1c20, metalness: 0, roughness: 0.42, clearcoat: 0.4, clearcoatRoughness: 0.3, side: THREE.DoubleSide });
  const base = mats.composite;
  let m;
  if (base.painted) {
    m = base.clone();
    Object.defineProperty(m, "painted", { value: look });
    if (base.asShell) Object.defineProperty(m, "asShell", { value: base.asShell });
  } else m = look;
  Object.defineProperty(m, "role", { value: "composite" });
  cache.set(key, m);
  return m;
}
// A moulded foam airframe (geom.printed === false) wears the foam finish where a printed one wears its body skin.
const skinOf = (g, m) => (m === "body" && g?.printed === false ? "foam" : m);
const matOf = (mats, m) => (typeof m === "string" ? (FIN[m] ? tone(mats, m) : mats[m]) : m);

// ---------------------------------------------------------------------------------------------------------
// Geometry helpers. Everything takes display metres and returns geometry in display metres; piece() applies
// SCALE exactly once, as it does for the rocket builders.
// ---------------------------------------------------------------------------------------------------------

// Basis changes for the three plate planes. ExtrudeGeometry draws a shape in its own (X, Y) and extrudes
// along +Z, so a flat part gets turned into the plane it belongs in, baked into the geometry — the parts.js
// piece rule allows only a Y rotation on a piece, and these are all X/Z turns.
const TO_XZ = new THREE.Matrix4().makeRotationX(Math.PI / 2); // shape (x, z), thickness down −Y
const TO_YZ = new THREE.Matrix4().makeBasis(v3(0, 1, 0), v3(0, 0, 1), v3(1, 0, 0)); // shape (y, z), thickness +X

function shape2(outline, holes) {
  const s = new THREE.Shape(outline.map(([a, b]) => new THREE.Vector2(a, b)));
  for (const h of holes ?? []) if (h?.length) s.holes.push(new THREE.Path(h.map(([a, b]) => new THREE.Vector2(a, b))));
  return s;
}
// Extruded outline, optionally with a small edge bevel (a routed carbon edge catches the light; a sharp box
// edge does not). The bevel is kept inside the outline and inside the thickness, so sizes stay true.
function extrudeShape(outline, holes, thick, bev = 0) {
  if (!bev) return new THREE.ExtrudeGeometry(shape2(outline, holes), { depth: thick, bevelEnabled: false, curveSegments: 10 });
  const b = Math.min(bev, thick * 0.45);
  return new THREE.ExtrudeGeometry(shape2(outline, holes), { depth: thick - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 2, curveSegments: 10 }).translate(0, 0, b);
}
// A flat part lying in the horizontal plane: outline as [x, z], underside at y0.
const plateXZ = (outline, holes, thick, y0 = 0, bev = 0) => extrudeShape(outline, holes, thick, bev).applyMatrix4(TO_XZ).translate(0, y0 + thick, 0);
// A flat part standing across the span: outline as [x, y], thickness along +Z from z0.
const plateXY = (outline, holes, thick, z0 = 0, bev = 0) => extrudeShape(outline, holes, thick, bev).translate(0, 0, z0);
// A flat part standing fore-and-aft (an ear, a side plate): outline as [y, z], centred on x0.
const plateYZ = (outline, holes, thick, x0 = 0, bev = 0) => extrudeShape(outline, holes, thick, bev).applyMatrix4(TO_YZ).translate(x0 - thick / 2, 0, 0);

// A cylinder centred at (x, y, z) with its axis along one world axis: a pin, a standoff, a boom, a tube.
function bar(r, len, axis, x, y, z, seg = 10) {
  const g = cyl(r, r, len, seg).translate(0, -len / 2, 0);
  if (axis === "x") g.rotateZ(Math.PI / 2);
  else if (axis === "z") g.rotateX(Math.PI / 2);
  return g.translate(x, y, z);
}
// A lathe turned to look along +Z (a lens barrel, a nose, a motor on a nose), its profile y becoming z.
const toZ = (geo) => geo.rotateX(Math.PI / 2);
// A closed lathe from an outline that starts and ends on the axis side: hardware, hubs, bosses.
const solid = (pts, seg = SEG) => latheUV(lathe(pts, seg), { H: Math.max(1e-6, Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]))), R: Math.max(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])) });

const circle2 = (cx, cz, r, n = 12) => Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * TAU) * r, cz + Math.sin((i / n) * TAU) * r]);
// Rounded slot (a strap slot, a wire pass-through, an arm pad): length along the first axis.
function slot2(cx, cz, len, wid, n = 6) {
  const r = wid / 2;
  const a = Math.max(len / 2 - r, 0);
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push([cx + a + Math.cos(-Math.PI / 2 + (i / n) * Math.PI) * r, cz + Math.sin(-Math.PI / 2 + (i / n) * Math.PI) * r]);
  for (let i = 0; i <= n; i++) pts.push([cx - a + Math.cos(Math.PI / 2 + (i / n) * Math.PI) * r, cz + Math.sin(Math.PI / 2 + (i / n) * Math.PI) * r]);
  return pts;
}
// The same slot with its length along the second axis.
const slotV = (cx, cz, len, wid, n = 6) => slot2(0, 0, len, wid, n).map(([a, b]) => [cx + b, cz + a]);
// Rounded rectangle outline (PCBs, battery wrap faces, hatches, pads).
function rrect2(cx, cz, w, l, r0, n = 4) {
  const r = Math.min(r0, w / 2, l / 2);
  const pts = [];
  const cs = [[w / 2 - r, l / 2 - r, 0], [-(w / 2 - r), l / 2 - r, Math.PI / 2], [-(w / 2 - r), -(l / 2 - r), Math.PI], [w / 2 - r, -(l / 2 - r), -Math.PI / 2]];
  for (const [x, z, a0] of cs) for (let i = 0; i <= n; i++) pts.push([cx + x + Math.cos(a0 + (i / n) * (Math.PI / 2)) * r, cz + z + Math.sin(a0 + (i / n) * (Math.PI / 2)) * r]);
  return pts;
}
// A solid annular sector. A ring of these with gaps between them reads as a slotted can — a vented motor
// bell with real openings, which a part-turn lathe cannot give without leaving its ends open.
function sector(rIn, rOut, phi0, phi1, h, y0, seg = 6) {
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const p = lerp(phi0, phi1, i / seg);
    pts.push([Math.cos(p) * rOut, Math.sin(p) * rOut]);
  }
  for (let i = seg; i >= 0; i--) {
    const p = lerp(phi0, phi1, i / seg);
    pts.push([Math.cos(p) * rIn, Math.sin(p) * rIn]);
  }
  return plateXZ(pts, null, h, y0);
}

// Frame plate outline, as a polar function round the centre: a rounded rectangle (the body) smoothly unioned
// with one stadium per arm (the pad the arm clamps under). Smooth union, so the pads blend into the body with
// a routed fillet rather than a corner.
function rectRay(c, s, a, b, rc) {
  const ac = Math.abs(c);
  const as = Math.abs(s);
  const t = Math.min(ac > 1e-9 ? a / ac : Infinity, as > 1e-9 ? b / as : Infinity);
  const x = t * ac;
  const z = t * as;
  if (x <= a - rc || z <= b - rc) return t;
  const cx = a - rc;
  const cz = b - rc;
  const B = ac * cx + as * cz;
  return B + Math.sqrt(Math.max(0, B * B - (cx * cx + cz * cz - rc * rc)));
}
function stadiumRay(th, pa, len, w) {
  const dl = th - pa;
  const cd = Math.cos(dl);
  const sd = Math.abs(Math.sin(dl));
  if (cd <= 0) return 0;
  if (len * sd <= w) return len * cd + Math.sqrt(w * w - len * len * sd * sd);
  return w / sd;
}
const smax = (p, q, k) => (p + q + Math.sqrt((p - q) ** 2 + k * k)) / 2;
function lobedOutline({ a, b, rc, pads = [], k = 0, n = 200 }) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const th = (i / n) * TAU;
    let r = rectRay(Math.cos(th), Math.sin(th), a, b, rc);
    for (const p of pads) r = smax(r, stadiumRay(th, p.angle, p.len, p.w), k);
    pts.push([Math.cos(th) * r, Math.sin(th) * r]);
  }
  return pts;
}

// Signed volume of a triangle soup; negative means the triangles wind inward. A loft's handedness depends on
// which way its sections run, so rather than guess per call site, flip once here.
function fixWinding(geo) {
  const p = geo.attributes.position.array;
  let vol = 0;
  for (let i = 0; i < p.length; i += 9) {
    vol += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) + p[i + 1] * (p[i + 5] * p[i + 6] - p[i + 3] * p[i + 8]) + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6]);
  }
  if (vol >= 0) return geo;
  for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) [p[i + k], p[i + 6 + k]] = [p[i + 6 + k], p[i + k]];
  geo.computeVertexNormals();
  return geo;
}

// Lofts a closed outline along a run of stations: `rings` is a list of equal-length Vector3 arrays, each
// ordered the same way round the section. Quads between neighbouring rings and a triangle fan capping each
// end, so the result is a closed solid — an aerofoil blade, a wing panel, a printed rib. Flat shaded, which is
// what a printed panel with its layer bands wants.
function loft(rings) {
  const pos = [];
  const tri = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  const n = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      tri(rings[i][j], rings[i][k], rings[i + 1][k]);
      tri(rings[i][j], rings[i + 1][k], rings[i + 1][j]);
    }
  }
  for (const [ring, flip] of [[rings[0], true], [rings[rings.length - 1], false]]) {
    const c = ring.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / ring.length);
    for (let j = 0; j < ring.length; j++) {
      const k = (j + 1) % ring.length;
      if (flip) tri(c, ring[k], ring[j]);
      else tri(c, ring[j], ring[k]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return fixWinding(geo);
}
// The same loft, smooth along and round the run (shared vertices), with flat end caps: a propeller blade
// reads as one curved moulded surface, not as facets.
function loftSmooth(rings) {
  const n = rings[0].length;
  const m = rings.length;
  const pos = [];
  for (const ring of rings) for (const p of ring) pos.push(p.x, p.y, p.z);
  const idx = [];
  for (let i = 0; i < m - 1; i++) {
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      idx.push(i * n + j, i * n + k, (i + 1) * n + k, i * n + j, (i + 1) * n + k, (i + 1) * n + j);
    }
  }
  for (const [ring, flip] of [[rings[0], true], [rings[m - 1], false]]) {
    const s = pos.length / 3;
    for (const p of ring) pos.push(p.x, p.y, p.z);
    const c = ring.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / n);
    pos.push(c.x, c.y, c.z);
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      if (flip) idx.push(s + n, s + k, s + j);
      else idx.push(s + n, s + j, s + k);
    }
  }
  // Wind outward whichever way the sections run (signed volume, as fixWinding).
  let vol = 0;
  const P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [P(idx[t]), P(idx[t + 1]), P(idx[t + 2])];
    vol += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  if (vol < 0) for (let t = 0; t < idx.length; t += 3) [idx[t], idx[t + 2]] = [idx[t + 2], idx[t]];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return projectUV(geo);
}

// NACA 4-digit section from its designation: "NACA 2412" is 2 % camber at 40 % chord, 12 % thick. A name with
// no digits (Clark Y, MH 60) falls back to a symmetric 12 % section — shape only; the card shows the real
// designation out of the dataset, never this reading of it.
function naca4(name) {
  // Only a NACA designation is read as one: "S3021" is a Selig section, not 3 % camber at 2 tenths, 21 % thick.
  const m = /naca/i.test(String(name ?? "")) ? String(name).match(/(\d)(\d)(\d\d)/) : null;
  if (!m) return { camber: 0, camberAt: 0.4, thick: 0.12 };
  return { camber: Number(m[1]) / 100, camberAt: clamp(Number(m[2]) / 10, 0.1, 0.9), thick: Math.max(0.04, Number(m[3]) / 100) };
}
// The real NACA 4-digit section, as [chordFraction, camberOffset, halfThickness, side] going trailing edge →
// upper surface → leading edge → lower surface → trailing edge, on cosine spacing so the leading edge gets
// the points. Camber and thickness come back separately so a caller can scale them apart: a propeller blade
// is a thin strongly cambered plate, a wing is not.
function airfoilPoints(af, n = 14) {
  const { camber: m, camberAt: p, thick: t } = af;
  const yt = (x) => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const yc = (x) => (x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / (1 - p) ** 2) * (1 - 2 * p + 2 * p * x - x * x));
  const xs = Array.from({ length: n + 1 }, (_, i) => (1 - Math.cos((i / n) * Math.PI)) / 2);
  const up = xs.map((x) => [x, yc(x), yt(x), 1]);
  const lo = xs.map((x) => [x, yc(x), yt(x), -1]);
  return [...up.reverse(), ...lo.slice(1, -1)];
}
// Keeps the part of a section between two chord fractions, giving a closed shape with a straight cut face:
// a wing skin whose trailing quarter belongs to the elevon, or the elevon itself.
const cropSection = (sec, lo, hi) => sec.filter(([f]) => f >= lo && f <= hi);

// Printed-shell layer banding: station fractions over a run, each with the outward offset that makes one
// layer line. Coarser than a real 0.2 mm layer (see PRINT_BAND_M) so it reads on screen.
function printBands(len, band) {
  const n = clamp(Math.round(len / Math.max(band, 1e-6)), 2, 110);
  return Array.from({ length: n * 2 + 1 }, (_, i) => ({ s: i / (n * 2), off: i % 2 }));
}

// Re-frames instanced-detail transforms (already in scene units) by the same baked turn and shift a piece's
// geometry got, so its bolts land where the geometry did.
const reframe = (list, m) => list.map((b) => b.clone().premultiply(m));

// ---------------------------------------------------------------------------------------------------------
// The motor. Shared by drone-arm and drone-nose-motor, so a motor is the same machine wherever it is bolted.
// Base at y = 0, axis +Y, centred on the origin. Sizes are the motor record's, through geom: outer diameter
// and height, stator diameter and height, the mount circle and the prop-shaft diameter. The record's height
// includes the shaft, so the bell stops short of it (MOTOR_SHAFT_SHARE) and the shaft carries on through the
// propeller hub: a 2207 is a squat can with a shaft sticking out, not a tall tin.
// ---------------------------------------------------------------------------------------------------------

const bellTopOf = (H) => H * (1 - MOTOR_SHAFT_SHARE);

function motorKit(g, d) {
  const R = d(g.motorOuterR_m); // bell outer radius
  const H = d(g.motorH_m); // base to the tip of the shaft
  const sR = d(g.statorR_m); // stator outer radius
  const shR = d(g.shaftR_m); // prop shaft radius
  const mc = d(g.mountCircle_m) / 2; // motor mount hole circle radius
  const top = bellTopOf(H); // the bell's top face: where the propeller hub seats
  const baseH = top * MOTOR_BASE_SHARE;
  const wall = R * MOTOR_WALL_SHARE;
  const bellY0 = baseH * 1.08; // the bell's lip runs just clear of the base
  const bellH = top - bellY0;
  const capH = bellH * 0.14;
  const skirtTop = bellY0 + bellH * 0.58; // solid wall over the magnets up to here, vent windows above
  const winTop = top - capH;
  // The stator stack fills the bell; a long-stator motor is drawn as tall as its bell allows.
  const sH = Math.min(d(g.statorH_m), (bellH - capH) * 0.8);
  const sY0 = bellY0 + (bellH - capH - sH) * 0.5;
  const out = [];
  const add = (geo, mat, o) => out.push({ geo, mat, ...o });

  // Base: the stepped anodised mount the stator is pressed on, with its bearing boss.
  add(
    merge([
      solid([[shR * 1.1, 0], [R * 0.88, 0], [R * 0.92, baseH * 0.3], [R * 0.92, baseH * 0.62], [R * 0.8, baseH * 0.8], [sR * 0.55, baseH * 0.85], [sR * 0.5, sY0], [shR * 1.1, sY0], [shR * 1.1, 0]]),
    ]),
    "bell",
    { kind: "detail", order: 0, dir: DOWN, dist: baseH * 2, edges: true },
  );
  // Stator: a laminated steel stack with STATOR_TEETH teeth (real gaps between them), and one copper coil
  // round each tooth. Both are interior: they show through the vent windows and through a clear shell.
  {
    const lam = [];
    const nL = 8;
    for (let i = 0; i <= nL; i++) lam.push([sR * (i % 2 ? 0.45 : 0.47), sH * (i / nL)]);
    const teeth = [];
    const w = (TAU / STATOR_TEETH) * 0.36;
    for (let i = 0; i < STATOR_TEETH; i++) {
      const a0 = (i / STATOR_TEETH) * TAU;
      teeth.push(sector(sR * 0.44, sR * 0.97, a0 - w * 0.5, a0 + w * 0.5, sH, 0, 2));
      teeth.push(sector(sR * 0.88, sR, a0 - w * 1.2, a0 + w * 1.2, sH, 0, 4));
    }
    add(merge([latheUV(lathe(lam, SEG), { H: sH, R: sR * 0.47 }), ...teeth]).translate(0, sY0, 0), "steelDark", { kind: "interior", order: 0.2, dir: UP, dist: H * 0.5 });
    const coils = [];
    for (let i = 0; i < STATOR_TEETH; i++) {
      const a = (i / STATOR_TEETH) * TAU;
      // A coil is a rounded band wound round the tooth: a torus squashed onto the tooth's section.
      coils.push(new THREE.TorusGeometry(sR * 0.2, sR * 0.085, 6, 12).scale(0.75, 1.55, 1).rotateY(Math.PI / 2 - a).translate(Math.cos(a) * sR * 0.68, sH * 0.5, -Math.sin(a) * sR * 0.68));
    }
    add(merge(coils).translate(0, sY0, 0), "copper", { kind: "interior", order: 0.3, dir: UP, dist: H * 0.6 });
  }
  // Magnet ring glued inside the bell wall. Turns with the rotor; shows silver through the windows.
  const rMag = R - wall * 2.1;
  {
    const mg = [];
    const w = (TAU / BELL_MAGNETS) * 0.42;
    for (let i = 0; i < BELL_MAGNETS; i++) {
      const a0 = (i / BELL_MAGNETS) * TAU;
      mg.push(sector(rMag, R - wall * 0.98, a0 - w, a0 + w, sH * 1.08, sY0 - sH * 0.04, 2));
    }
    add(merge(mg), "magnet", { kind: "interior", order: 0.35, dir: UP, dist: H * 0.4, spin: true });
  }
  // Bell: the solid skirt over the magnets (two turned grooves in it), then BELL_WINDOWS pillars with real
  // windows between them up to the cap — the windings show through, as on a real vented bell.
  {
    const g1 = bellY0 + bellH * 0.18;
    const g2 = bellY0 + bellH * 0.4;
    const gw = bellH * 0.025;
    const skirt = solid([
      [R - wall, skirtTop], [R - wall, bellY0], [R * 0.965, bellY0], [R, bellY0 + bellH * 0.035],
      [R, g1 - gw], [R * 0.985, g1], [R, g1 + gw], [R, g2 - gw], [R * 0.985, g2], [R, g2 + gw], [R, skirtTop], [R - wall, skirtTop],
    ]);
    const pillars = [];
    const w = (TAU / BELL_WINDOWS) * 0.21;
    for (let i = 0; i < BELL_WINDOWS; i++) {
      const a0 = (i / BELL_WINDOWS) * TAU;
      pillars.push(sector(R - wall, R, a0 - w, a0 + w, winTop - skirtTop, skirtTop, 3));
    }
    add(merge([skirt, ...pillars.map(projectUV)]), "bell", { kind: "shell", order: 0.5, dir: UP, dist: H * 0.8, spin: true });
  }
  // Cap: the outer ring with its diamond-cut chamfer, BELL_WINDOWS spokes in to the hub, and the hub the
  // propeller seats on. The spokes line up with the pillars, so the windows read as one cut-out.
  {
    const ring = solid([[R * 0.7, winTop], [R, winTop], [R, top - capH * 0.42], [R * 0.93, top], [R * 0.7, top], [R * 0.7, winTop]]);
    const hub = solid([[shR * 1.04, winTop - capH * 0.4], [R * 0.34, winTop - capH * 0.4], [R * 0.34, top], [shR * 1.04, top], [shR * 1.04, winTop - capH * 0.4]]);
    const spokes = [];
    const w = (TAU / BELL_WINDOWS) * 0.12;
    for (let i = 0; i < BELL_WINDOWS; i++) {
      const a0 = (i / BELL_WINDOWS) * TAU;
      spokes.push(projectUV(sector(R * 0.3, R * 0.74, a0 - w, a0 + w, capH * 0.82, top - capH * 0.82, 2)));
    }
    add(merge([ring, hub, ...spokes]), "bell", {
      kind: "shell",
      order: 0.6,
      dir: UP,
      dist: H,
      spin: true,
      bolts: boltCircle(R * 0.52, top - capH * 0.2, 4, shR * 0.62, { phase: Math.PI / 4 }),
    });
    // The bright machined chamfer round the top edge and the lip round the bottom: what makes a black
    // anodised bell read as machined metal from across the room.
    add(merge([solid([[R * 0.92, top - capH * 0.02], [R * 0.995, top - capH * 0.42], [R * 1.004, top - capH * 0.4], [R * 0.93, top + capH * 0.02], [R * 0.92, top - capH * 0.02]]), machinedRing(R * 0.965, R * 1.004, bellH * 0.03, bellY0, SEG)]), "machined", {
      kind: "detail",
      order: 0.62,
      dir: UP,
      dist: H * 1.05,
      spin: true,
    });
  }
  // Shaft, threaded where the prop nut runs on, and the circlip under the base that holds the rotor in.
  {
    const pts = [[0, -baseH * 0.35], [shR, -baseH * 0.35], [shR, top + capH * 0.2]];
    const nT = 9;
    for (let i = 0; i <= nT; i++) pts.push([shR * (i % 2 ? 0.86 : 1), lerp(top + capH * 0.2, H - shR * 0.25, i / nT)]);
    pts.push([shR * 0.78, H], [0, H]);
    add(solid(pts, 12), "pipe", { kind: "detail", order: 0.7, dir: UP, dist: H * 1.3, spin: true });
    add(machinedRing(shR * 0.9, shR * 1.7, baseH * 0.16, -baseH * 0.28, 12), "darkMetal", { kind: "detail", order: 0.05, dir: DOWN, dist: H * 0.4, spin: true });
  }
  return Object.assign(out, { R, H, top, baseH, capH, bellY0, bellH, shR, mc, sR, sH, rMag });
}

// ---------------------------------------------------------------------------------------------------------
// The propeller. Shared by drone-propeller and drone-nose-propeller. Hub at y = 0, axis +Y, centred on the
// origin so droneFlight.js can spin each piece on its own hub.
// ---------------------------------------------------------------------------------------------------------

// One blade, root at rRoot (inside the hub), tip at rTip, built as a lofted sweep of a cambered section whose
// chord, camber and twist all change from root to tip. The twist is the real geometric-pitch relation for the
// record's pitch: a blade of pitch P advances P per turn, so its blade angle at radius r is atan(P / 2πr) —
// steep at the root, shallow at the tip. The planform (PROP_PLANFORM) and the sweep (PROP_SWEEP: the tip trails
// the root, so the blade curves back against its rotation) are visual.
function planformAt(s) {
  const k = s * (PROP_PLANFORM.length - 1);
  const i = Math.floor(k);
  return lerp(PROP_PLANFORM[i], PROP_PLANFORM[Math.min(PROP_PLANFORM.length - 1, i + 1)], k - i);
}
function bladeGeo({ rHub, rRoot, rTip, pitch, chordMax, spinDir, yMid, sweep = PROP_SWEEP, stations = 18 }) {
  const rings = [];
  for (let i = 0; i < stations; i++) {
    const s = i / (stations - 1);
    const r = lerp(rRoot, rTip, s);
    const c = chordMax * planformAt(s);
    const sec = airfoilPoints({ camber: PROP_CAMBER, camberAt: 0.38, thick: lerp(PROP_THICK_ROOT, PROP_THICK_TIP, Math.pow(s, 0.6)) }, 10);
    const beta = Math.atan2(pitch, TAU * Math.max(r, rHub)); // blade angle, from the record's pitch
    const cb = Math.cos(beta);
    const sb = Math.sin(beta);
    const phi = -sweep * s * s * spinDir; // the sweep: a turn about the hub axis growing toward the tip
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    rings.push(
      sec.map(([f, yc, yt, side]) => {
        const zc = (f - PROP_LE_SHARE) * c; // chordwise, from the pitch axis
        const y = (yc + side * yt) * c;
        // Twist: the leading edge (zc < 0) rises, so the blade meets the air at a positive angle.
        const X = r;
        const Z = (zc * cb + y * sb) * spinDir;
        return v3(X * cp + Z * sp, yMid - zc * sb + y * cb, -X * sp + Z * cp);
      }),
    );
  }
  return loftSmooth(rings);
}

function propKit(g, d, material) {
  const rTip = d(g.propR_m);
  const hubR = d(g.hubR_m);
  const hubH = d(g.hubH_m);
  const shR = d(g.shaftR_m ?? g.hubR_m * 0.38);
  const n = clamp(g.bladeCount | 0 || 3, 2, 6);
  const spin = g.spinDir >= 0 ? 1 : -1;
  const pitch = d(g.pitch_in * 0.0254); // the record's pitch, inches → metres, at display scale
  // The shaft standing above the bell (see motorKit): the hub sits on the bell and the nut takes the rest.
  const exposed = d(g.motorTopY_m ?? g.motorH_m ?? g.hubH_m * 4) * MOTOR_SHAFT_SHARE;
  const nutH = clamp(exposed - hubH, hubH * 0.55, hubH * 1.3);
  const out = [];
  const add = (geo, mat, o) => out.push({ geo, mat, ...o });

  // Hub: the moulded body with its shaft bore and the radiused top edge.
  add(solid([[shR * 1.05, 0], [hubR * 0.94, 0], [hubR, hubH * 0.1], [hubR, hubH * 0.78], [hubR * 0.84, hubH], [shR * 1.05, hubH], [shR * 1.05, 0]], SEG), "prop", { kind: "shell", order: 0, dir: UP, dist: hubH * 3 });
  // Blades. The blade phase is BAKED into the geometry, not left on the piece: droneFlight.js owns
  // mesh.rotation.y on propeller pieces.
  // A moulded polycarbonate FPV prop is strongly swept; a thin-electric nylon prop for a plane is nearly straight.
  // A ducted propeller is wide-bladed and nearly straight: the duct, not the tip shape, deals with the tip vortex.
  const sweep = g.ducted ? PROP_SWEEP * 0.35 : /poly/i.test(String(material ?? "polycarbonate")) ? PROP_SWEEP : PROP_SWEEP * 0.3;
  const chord = rTip * (g.ducted ? PROP_CHORD_DUCTED : PROP_CHORD_SHARE);
  const blade0 = bladeGeo({ rHub: hubR, rRoot: hubR * 0.6, rTip, pitch, chordMax: chord, spinDir: spin, yMid: hubH * 0.5, sweep });
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    add(blade0.clone().rotateY(-a), "prop", { kind: "shell", order: 0.2 + i * 0.02, dir: radial(a), dist: rTip * 0.6 });
  }
  // Prop nut: the flanged washer face, the hex and the domed nylon-insert cap.
  const y0 = hubH;
  add(
    merge([
      solid([[shR * 1.02, y0], [hubR * 0.74, y0], [hubR * 0.74, y0 + nutH * 0.14], [shR * 1.9, y0 + nutH * 0.22], [shR * 1.02, y0 + nutH * 0.22], [shR * 1.02, y0]], 20),
      cyl(shR * 1.95, shR * 1.95, nutH * 0.5, 6, 0, y0 + nutH * 0.2),
      solid([[0, y0 + nutH * 0.68], [shR * 1.72, y0 + nutH * 0.68], ...domePoints(shR * 1.72, nutH * 0.32, true, 6).map(([r, y]) => [r, y + y0 + nutH * 0.68])], 18),
    ]),
    "machined",
    { kind: "detail", order: 0.6, dir: UP, dist: hubH * 4 },
  );
  return Object.assign(out, { rTip, hubR, hubH, shR, n, spin });
}

// ---------------------------------------------------------------------------------------------------------
// drone-frame — the bottom plate, the standoffs, the top plate, the camera side plates and the small frame
// hardware. A true-X frame: four separate arms clamp under the body, so the plates are a long narrow body
// with an arm pad routed out toward each arm.
// ---------------------------------------------------------------------------------------------------------

// The frame body in plan, from the wheelbase, so every part that sits on the body can find its edges.
function bodyPlan(g, d) {
  const bw = d(g.bodyW_m);
  const wb = d(g.wheelbase_m);
  // A ducted frame's body is narrower: it sits between the duct rings, which come in close to it.
  return { PW: bw * (g.ducted ? PLATE_W_DUCTED : PLATE_W_SHARE), PL: wb * PLATE_L_SHARE, bw, wb };
}

function buildFrame(spec, mats) {
  const g = spec.geom;
  if (g.frameStyle === "round") return buildRoundFrame(spec, mats);
  const K = g.viewK;
  const d = (m) => m * K;
  const armR = d(g.armR_m);
  const { PW, PL, bw, wb } = bodyPlan(g, d);
  const bot = d(g.botPlateThick_m);
  const top = d(g.topPlateThick_m);
  const so = d(g.standoffH_m);
  const armW = d(g.armWidth_m) / 2;
  const armT = d(g.armThick_m);
  const stack = (g.stackMount_m ?? []).map(d);
  const n = g.armCount || 4;
  const angles = g.armAngles ?? Array.from({ length: n }, (_, i) => Math.PI / 4 + (i / n) * TAU);
  const rootR = armR * ARM_ROOT_SHARE;
  const padR = armR * ARM_PAD_SHARE;
  const padW = armW * ARM_PAD_W;
  const soR = wb * STANDOFF_R_SHARE;
  const U = SCALE; // explode distances are scene units: display metres × SCALE
  const out = [];
  const push = (geo, mat, o) => {
    const pc = piece(geo, matOf(mats, mat), o);
    out.push(pc);
    return pc;
  };
  const mix = (a, s, t) => [Math.cos(a) * s - Math.sin(a) * t, Math.sin(a) * s + Math.cos(a) * t];

  // Standoffs at the rear corners of the stack bay, clear of the arm roots; at the front the camera side
  // plates carry the top plate, as they do on a real freestyle frame.
  const earGap = bw * CAGE_GAP_SHARE;
  const zF = PL / 2;
  const sideL = so * 0.95;
  const sideX = earGap / 2 + armT * 0.25;
  const soPos = [[1, -1], [-1, -1]].map(([sx, sz]) => [sx * PW * 0.38, sz * PL * 0.35]);
  const frontScrews = [-1, 1].flatMap((s) => [[s * sideX, zF - sideL * 0.2], [s * sideX, zF - sideL * 0.8]]);
  const soHoles = soPos.map(([x, z]) => circle2(x, z, soR * 0.42, 10));
  const mountHoles = stack.flatMap((s) => [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sx, sz]) => circle2((sx * s) / 2, (sz * s) / 2, stack[0] * 0.06, 8)));
  const armBolts = angles.flatMap((a) => armRootBolts(rootR, padR).map((r) => mix(a, r, 0)));
  const armHoles = armBolts.map(([x, z]) => circle2(x, z, armW * 0.2, 8));

  // 1. Bottom plate: the body with an arm pad toward each arm, lightening slots fore and aft of the stack, the
  // stack holes and the arm bolt holes. Carbon (mats.composite: weave on projected UVs) with a routed edge.
  const botOutline = lobedOutline({ a: PW / 2, b: PL / 2, rc: PW * 0.22, pads: angles.map((angle) => ({ angle, len: padR, w: padW })), k: armW * 0.9 });
  const lighten = [slotV(0, PL * 0.33, PL * 0.12, PW * 0.18), slotV(0, -PL * 0.33, PL * 0.12, PW * 0.18), ...[-1, 1].map((s) => slotV(s * PW * 0.33, 0, PL * 0.22, PW * 0.09))];
  const botPlate = push(projectUV(plateXZ(botOutline, [...mountHoles, ...soHoles, ...armHoles, ...lighten], bot, 0, bot * 0.22)), "composite", {
    order: 0,
    dir: DOWN,
    dist: bot * U * 6,
    kind: "shell",
    side: DS,
  });
  // Screw heads under the plate: the standoff screws and the arm clamp bolts, black.
  addDetail(botPlate, "bolt", [...soPos, ...armBolts, ...frontScrews].flatMap(([x, z]) => boltCircle(0, 0, 1, armW * 0.42, { face: "down", cx: x, cz: z, h: armW * 0.16 })), { color: 0x1d1f24 });

  // 2. Aluminium standoffs: hex bars, one piece each so four fly in.
  const soGeo = projectUV(merge([cyl(soR, soR, so * 0.94, 6, 0, bot + so * 0.03), machinedRing(soR * 0.4, soR * 0.86, so * 0.03, bot, 12), machinedRing(soR * 0.4, soR * 0.86, so * 0.03, bot + so * 0.97, 12)]));
  soPos.forEach(([x, z], i) => push(soGeo, "pump", { x, z, order: 1 + i * 0.1, dir: v3(Math.sign(x), 0.4, Math.sign(z)), dist: so * U * 1.6, kind: "detail", edges: true }));

  // 3. Top plate: the body again, narrower, with the battery strap slots and a lightening pattern.
  const tw = PW * 0.94;
  const tl = PL * 0.9;
  const strapSlots = [-1, 1].map((s) => slotV(s * tw * 0.4, 0, tl * 0.22, tw * 0.07));
  const topLighten = [slotV(0, tl * 0.3, tl * 0.18, tw * 0.22), slotV(0, -tl * 0.3, tl * 0.18, tw * 0.22), rrect2(0, 0, tw * 0.3, tl * 0.2, tw * 0.08)];
  const topPlate = push(projectUV(plateXZ(rrect2(0, 0, tw, tl, tw * 0.2, 6), [...soHoles, ...strapSlots, ...topLighten], top, bot + so, top * 0.25)), "composite", {
    order: 10,
    dir: UP,
    dist: so * U * 1.4,
    kind: "shell",
    side: DS,
  });
  addDetail(topPlate, "bolt", [...soPos, ...frontScrews].flatMap(([x, z]) => boltCircle(0, bot + so + top, 1, armW * 0.42, { cx: x, cz: z, h: armW * 0.16 })), { color: 0x1d1f24 });

  // 4. Camera side plates: two carbon plates standing at the front of the body with the camera's pivot hole
  // and its tilt arc. The spacing is a visual proportion of the body — the airframe record says nothing about
  // what camera goes in it.
  const pivot = [bot + so * 0.55, PL * CAM_PIVOT_SHARE]; // (y, z) of the camera's tilt axis
  const arc = [];
  for (let i = 0; i <= 8; i++) {
    const t = lerp(-0.25, 0.85, i / 8) * Math.PI;
    arc.push([pivot[0] + Math.cos(t + Math.PI) * so * 0.28, pivot[1] + Math.sin(t + Math.PI) * so * 0.28]);
  }
  const arcSlot = [...arc.map(([y, z]) => [y + (y - pivot[0]) * 0.12, z + (z - pivot[1]) * 0.12]), ...[...arc].reverse().map(([y, z]) => [y - (y - pivot[0]) * 0.12, z - (z - pivot[1]) * 0.12])];
  const sideOutline = [[bot, zF - sideL], [bot, zF], [bot + so * 0.7, zF + so * 0.06], [bot + so + top, zF - so * 0.12], [bot + so + top, zF - sideL]];
  for (const s of [-1, 1]) {
    const sp = push(projectUV(plateYZ(sideOutline, [circle2(...pivot, so * 0.05, 10), arcSlot], armT * 0.5, s * sideX, armT * 0.1)), "composite", {
      order: 3 + (s + 1) * 0.1,
      dir: v3(s, 0.2, 0.5),
      dist: so * U * 1.6,
      kind: "shell",
      side: DS,
    });
    // The camera's pivot screw and its tilt-lock screw, heads out.
    addDetail(sp, "bolt", [boltXf(v3(s * (sideX + armT * 0.25), pivot[0], pivot[1]), v3(s, 0, 0), armW * 0.42, armW * 0.15), boltXf(v3(s * (sideX + armT * 0.25), arc[3][0], arc[3][1]), v3(s, 0, 0), armW * 0.36, armW * 0.13)], { color: 0x1d1f24 });
  }

  // 5. Rear TPU antenna mount between the plates: the receiver's two antenna tubes leave through it, and the
  // video antenna's connector (drone-electronics) seats in its centre.
  const zR = -PL / 2;
  push(projectUV(merge([plateYZ([[bot, zR], [bot, zR + so * 0.3], [bot + so * 0.5, zR + so * 0.22], [bot + so * 0.62, zR]], null, PW * 0.52, 0, so * 0.04), box(PW * 0.2, so * 0.36, so * 0.16, 0, bot + so * 0.66, zR + so * 0.07)])), "tpu", {
    order: 5,
    dir: v3(0, 0.2, -1),
    dist: PL * U * 0.3,
    kind: "detail",
    edges: true,
  });
  for (const s of [-1, 1]) {
    const a = v3(s * PW * 0.2, bot + so * 0.45, zR + so * 0.05);
    const b = v3(s * PW * 0.62, bot + so * 1.9, zR - so * 1.25);
    push(merge([rod(a, b, soR * 0.2, 8), solid([[0, 0], [soR * 0.34, 0], [soR * 0.34, soR * 1.6], [0, soR * 2]], 10).translate(0, 0, 0).applyMatrix4(alongMatrix(b, b.clone().sub(a)))]), "silicone", {
      order: 6 + (s + 1) * 0.1,
      dir: v3(s * 0.5, 0.6, -0.7),
      dist: PL * U * 0.5,
      kind: "detail",
    });
  }
  // 6. Battery pad: the grippy rubber sheet on the top plate the pack sits on.
  push(plateXZ(rrect2(0, 0, tw * 0.72, tl * 0.62, tw * 0.1), null, top * 0.5, bot + so + top), "rubber", { order: 8, dir: UP, dist: so * U * 1.8, kind: "detail" });
  // 7. Front TPU bumper on the nose of the bottom plate, under the camera.
  push(plateXZ(rrect2(0, zF - PL * 0.02, earGap * 1.1, PL * 0.07, PL * 0.03), null, bot * 1.4, bot), "tpu", { order: 2.5, dir: v3(0, 0, 1), dist: PL * U * 0.2, kind: "detail" });
  // 8. Buzzer at the rear of the bay, with its sound hole.
  push(merge([cyl(soR * 1.4, soR * 1.4, soR * 1.4, 14, -PW * 0.2, bot, -PL * 0.26), cyl(soR * 0.35, soR * 0.35, soR * 0.2, 8, -PW * 0.2, bot + soR * 1.4, -PL * 0.26)]), "chip", { order: 5.5, dir: v3(-0.6, 0.4, -0.7), dist: PL * U * 0.2, kind: "detail" });
  return out;
}

// One instanced-detail transform: a bolt head at p (display metres) facing n, `size` across and `h` tall.
function boltXf(p, n, size, h) {
  return new THREE.Matrix4().compose(p.clone().multiplyScalar(SCALE), new THREE.Quaternion().setFromUnitVectors(UP, n.clone().normalize()), new THREE.Vector3(size * SCALE, h * SCALE, size * SCALE));
}
// The two arm clamp bolts, as radii along the arm: the plate and the arm punch the same pattern.
const armRootBolts = (rootR, padR) => Array.from({ length: ARM_ROOT_BOLTS }, (_, k) => lerp(rootR * 1.12, padR * 0.88, k / Math.max(1, ARM_ROOT_BOLTS - 1)));
// A matrix that stands a +Y-authored part at p, pointing along dir.
function alongMatrix(p, dir) {
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  return new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
}

// ---------------------------------------------------------------------------------------------------------
// drone-arm — the carbon arm, its clamp bolts, the motor, the three phase wires and the TPU motor guard. The
// arm is authored along +X and turned onto its azimuth with the piece's own Y rotation (the parts.js rule: a
// piece may turn about Y, X/Z turns are baked in). Azimuth a ⇒ ry = −a, as in parts.js.
// ---------------------------------------------------------------------------------------------------------

function buildArm(spec, mats) {
  const g = spec.geom;
  if (g.armStyle === "tube") return buildTubeArm(spec, mats);
  const K = g.viewK;
  const d = (m) => m * K;
  const a = g.armAngle ?? 0;
  const armR = d(g.armR_m);
  const armT = d(g.armThick_m);
  const armW = d(g.armWidth_m) / 2;
  const ry = -a;
  const U = SCALE;
  const out = [];
  const motor = motorKit(g, d);
  const rootR = armR * ARM_ROOT_SHARE;
  const padR = armR * ARM_PAD_SHARE;
  const tipW = armW * ARM_TIP_TAPER;
  const motorPadR = motor.R * 0.86;
  const push = (geo, mat, o) => {
    const pc = piece(geo, matOf(mats, mat), { ry, ...o });
    out.push(pc);
    return pc;
  };

  // 1. The carbon arm (true armThick_m): a round inboard end clamped under the body, tapering out to a round
  // motor pad, with a lightening slot along it, the motor holes on the record's mount circle, the shaft
  // clearance and the clamp bolt holes. Routed edge, so it catches the light.
  const outline = [[rootR, armW], [padR, armW * 0.97], [armR - motorPadR * 1.25, tipW]];
  for (let k = 0; k <= 14; k++) {
    const th = Math.PI * 0.62 - (k / 14) * Math.PI * 1.24; // round the motor pad, +Z side → −Z side
    outline.push([armR + Math.cos(th) * motorPadR, Math.sin(th) * motorPadR]);
  }
  outline.push([armR - motorPadR * 1.25, -tipW], [padR, -armW * 0.97], [rootR, -armW]);
  for (let k = 1; k < 10; k++) {
    const ph = -Math.PI / 2 - (k / 10) * Math.PI; // round the inboard end
    outline.push([rootR + Math.cos(ph) * armW, Math.sin(ph) * armW]);
  }
  const holes = [circle2(armR, 0, motor.shR * 1.5, 12)];
  for (let i = 0; i < 4; i++) {
    const ph = Math.PI / 4 + (i / 4) * TAU;
    holes.push(circle2(armR + Math.cos(ph) * motor.mc, Math.sin(ph) * motor.mc, motor.mc * 0.13, 8));
  }
  for (const r of armRootBolts(rootR, padR)) holes.push(circle2(r, 0, armW * 0.2, 8));
  const slotA = padR * 1.08;
  const slotB = armR - motorPadR * 1.5;
  if (slotB - slotA > armW) holes.push(slot2((slotA + slotB) / 2, 0, slotB - slotA, armW * 0.62));
  const arm = push(projectUV(plateXZ(outline, holes, armT, 0, armT * 0.12)), "composite", { order: 0, dir: radial(a, -0.15), dist: armR * U * 0.35, kind: "shell", side: DS });
  // The motor's four screws come up from under the arm into the base.
  addDetail(arm, "bolt", boltCircle(motor.mc, 0, 4, motor.mc * 0.3, { face: "down", cx: armR, h: motor.mc * 0.12 }), { color: 0x1d1f24 });

  // 2. The motor, standing on the arm's motor pad. Its pieces stay centred on the motor axis (so the rotor
  // can be spun on its own axis) and are placed by x / z, not by baking the arm-end shift in.
  const motorY = armT;
  const mx = Math.cos(a) * armR;
  const mz = Math.sin(a) * armR;
  for (const m of motor) {
    const pc = piece(m.geo, matOf(mats, m.mat), { x: mx, z: mz, y: motorY, ry, order: 1 + (m.order ?? 0), dir: m.dir ?? UP, dist: (m.dist ?? motor.H) * U, kind: m.kind, edges: m.edges });
    if (m.bolts) addDetail(pc, "bolt", m.bolts, { color: 0x24262b });
    if (m.spin) pc.mesh.userData.spin = true; // droneFlight.js may turn these with the propeller
    out.push(pc);
  }

  // 3. Three phase wires leaving the motor base and running inboard along the arm, flat side by side, under a
  // heat-shrink sleeve for most of the run, with the zip ties that hold them down.
  const wR = motor.shR * 0.36;
  const wires = [];
  for (let i = 0; i < MOTOR_WIRES; i++) {
    const s = (i - 1) * wR * 2.1;
    const p0 = v3(armR - motor.R * 0.78, motorY + motor.baseH * 0.45, s);
    const cp = v3(armR - motor.R * 1.15, armT + wR, s);
    const p1 = v3(rootR * 0.9, armT + wR, s);
    wires.push(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(p0, cp, p1), 14, wR, 6, false));
  }
  push(merge(wires), "silicone", { order: 2, dir: UP, dist: motor.R * U, kind: "detail" });
  const sleeve = new THREE.LineCurve3(v3(armR - motor.R * 1.35, armT + wR * 1.1, 0), v3(padR * 1.02, armT + wR * 1.1, 0));
  // The sleeve, and two zip ties pulled tight round the arm and the sleeve.
  const ties = [0.3, 0.75].map((t) => {
    const p = sleeve.getPoint(t);
    return projectUV(plateYZ(rrect2(armT * 0.5 + wR * 0.6, 0, armT + wR * 3.2, armW * 2.12, armW * 0.25, 3), [rrect2(armT * 0.5 + wR * 0.6, 0, armT + wR * 2.6, armW * 1.98, armW * 0.2, 3)], wR * 1.2, p.x));
  });
  push(merge([projectUV(new THREE.TubeGeometry(sleeve, 2, wR, 10, false).scale(1, 0.75, 3.6).translate(0, armT * 0.02, 0)), ...ties]), "silicone", { order: 2.1, dir: UP, dist: motor.R * U * 1.2, kind: "detail" });
  // 4. The TPU motor guard under the motor pad — what a crash actually lands on — in the accent colour. A
  // ducted frame has none: the duct is the guard.
  if (!g.ducted) push(plateXZ(lobedOutline({ a: motorPadR * 0.95, b: motorPadR * 0.95, rc: motorPadR * 0.95, n: 40 }).map(([x, z]) => [x + armR, z]), [circle2(armR, 0, motor.shR * 2.2, 10)], armT * 0.45, -armT * 0.45, armT * 0.1), "tpu", {
    order: 3.6,
    dir: DOWN,
    dist: armT * U * 10,
    kind: "detail",
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// drone-propeller — hub, swept twisted blades and the prop nut, on the motor shaft at the arm tip. Every piece
// is centred on its own hub axis so droneFlight.js can spin it in place, and the whole propeller is set down
// onto the bell top (the part's slotY is the record's full motor height, which includes the shaft).
// ---------------------------------------------------------------------------------------------------------

function buildPropeller(spec, mats) {
  const g = spec.geom;
  const K = g.viewK;
  const d = (m) => m * K;
  const armR = d(g.armR_m ?? 0);
  const a = g.armAngle ?? 0;
  const seat = -d(g.motorTopY_m ?? 0) * MOTOR_SHAFT_SHARE; // from the shaft tip down to the bell top
  const U = SCALE;
  const out = [];
  const prop = propMaterial(mats, spec.record?.material);
  for (const p of propKit(g, d, spec.record?.material)) {
    const pc = piece(p.geo, p.mat === "prop" ? prop : matOf(mats, p.mat), {
      x: Math.cos(a) * armR,
      y: seat,
      z: Math.sin(a) * armR,
      order: p.order,
      dir: p.dir ?? UP,
      dist: (p.dist ?? 0.2) * U,
      kind: p.kind,
    });
    pc.mesh.userData.spinAxis = "y"; // centred on its hub: droneFlight turns it about its own local Y
    out.push(pc);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// drone-electronics — the 4-in-1 ESC, the flight controller and the video transmitter as a three-board stack
// on rubber grommets, with their components, the power lead and the video antenna. The boards are "interior"
// (they live inside the frame and show through a clear shell); the parts on them are "detail".
// ---------------------------------------------------------------------------------------------------------

function buildElectronics(spec, mats) {
  const g = spec.geom;
  const K = g.viewK;
  const d = (m) => m * K;
  const B = d(g.boardSize_m);
  const t = d(g.boardThick_m);
  const H = d(g.stackH_m);
  const so = d(g.standoffH_m);
  const mount = d((g.stackMount_m ?? [])[0] ?? g.boardSize_m * 0.85); // the hole pattern the boards bolt on
  const vtx = d(g.vtxW_m);
  const ant = d(g.antennaLen_m);
  const U = SCALE;
  const out = [];
  const push = (geo, mat, o) => {
    const pc = piece(geo, matOf(mats, mat), o);
    out.push(pc);
    return pc;
  };
  electronicsExtras(g, d, mats, push);
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sx, sz]) => [(sx * mount) / 2, (sz * mount) / 2]);
  const holes = corners.map(([x, z]) => circle2(x, z, mount * 0.06, 10));
  // Board heights: the ESC rides on its grommets clear of the arm roots, the flight controller above it, the
  // video transmitter on top, all below the top plate (so is the frame's standoff height).
  const escY = H * 0.3;
  const fcY = H * 0.78;
  const vY = Math.min(H * 1.12, so * 0.78);
  const board = (w, l, y) => plateXZ(rrect2(0, 0, w, l, w * BOARD_CORNER, 4), holes, t, y, t * 0.2);

  // 1–3. The three boards: black ESC, green flight controller, black video transmitter.
  push(board(B, B, escY), "pcbBlack", { order: 0, dir: DOWN, dist: H * U, kind: "interior", edges: true });
  push(board(B, B, fcY), "pcbGreen", { order: 6, dir: UP, dist: H * U * 1.4, kind: "interior", edges: true });
  push(plateXZ(rrect2(0, 0, vtx * 1.36, vtx * 1.36, vtx * 0.14, 4), holes, t, vY, t * 0.2), "pcbBlack", { order: 9, dir: UP, dist: H * U * 2, kind: "interior", edges: true });
  // 4. The four M3 stack screws through all three boards, and the soft grommets each board floats on.
  const stackTop = vY + t * 2;
  push(merge(corners.map(([x, z]) => cyl(mount * 0.045, mount * 0.045, stackTop, 8, x, 0, z))), "machined", { order: 0.1, dir: DOWN, dist: H * U * 0.6, kind: "detail" });
  push(
    merge(corners.flatMap(([x, z]) => [escY, fcY, vY].map((y) => solid([[mount * 0.05, y - t * 1.6], [mount * 0.1, y - t * 1.6], [mount * 0.075, y - t * 0.5], [mount * 0.1, y], [mount * 0.1, y + t * 1.8], [mount * 0.05, y + t * 1.8], [mount * 0.05, y - t * 1.6]], 10).translate(x, 0, z)))),
    "rubber",
    { order: 1, dir: DOWN, dist: H * U * 0.8, kind: "detail" },
  );
  push(merge(corners.map(([x, z]) => cyl(mount * 0.085, mount * 0.085, t * 2.6, 6, x, stackTop, z))), "chip", { order: 9.5, dir: UP, dist: H * U * 2.2, kind: "detail" });

  // ESC components: four groups of MOSFETs (one per motor) and their gate driver, the current-sense shunt,
  // the motor solder pads at the four corners and the battery pads at the rear.
  const ey = escY + t;
  push(
    merge(Array.from({ length: 4 }, (_, i) => {
      const ph = Math.PI / 4 + (i / 4) * TAU;
      const [x, z] = [Math.cos(ph) * B * 0.25, Math.sin(ph) * B * 0.25];
      return merge([box(B * 0.11, t * 1.1, B * 0.13, x - B * 0.06, ey + t * 0.55, z), box(B * 0.11, t * 1.1, B * 0.13, x + B * 0.06, ey + t * 0.55, z), box(B * 0.07, t * 0.9, B * 0.07, x * 0.45, ey + t * 0.45, z * 0.45)]);
    })),
    "chip",
    { order: 4.2, dir: UP, dist: H * U * 0.8, kind: "detail" },
  );
  push(
    merge([
      ...corners.flatMap(([x, z]) => [-1, 0, 1].map((k) => box(B * 0.06, t * 0.4, B * 0.06, x * 1.1, ey + t * 0.2, z * 0.82 + k * B * 0.07))),
      box(B * 0.16, t * 0.4, B * 0.1, -B * 0.14, ey + t * 0.2, -B * 0.42),
      box(B * 0.16, t * 0.4, B * 0.1, B * 0.14, ey + t * 0.2, -B * 0.42),
      box(B * 0.12, t * 0.9, B * 0.05, 0, ey + t * 0.45, B * 0.12),
    ]),
    "gold",
    { order: 4.5, dir: UP, dist: H * U * 0.5, kind: "detail" },
  );
  // The low-ESR capacitor across the battery pads: the biggest single part on a 5-inch stack, black sleeve.
  const capR = B * 0.13;
  push(merge([bar(capR, capR * 3.2, "x", 0, escY - capR * 0.2, -B * 0.5 - capR * 1.1, 16), bar(capR * 0.92, capR * 0.15, "x", capR * 1.66, escY - capR * 0.2, -B * 0.5 - capR * 1.1, 16)]), "chip", {
    order: 4.6,
    dir: v3(0, -0.2, -1),
    dist: H * U,
    kind: "detail",
  });
  // The battery lead off the ESC, out through the rear of the frame and up toward the pack: red and black.
  {
    const leadR = t * 1.3;
    const lead = (s) => new THREE.CatmullRomCurve3([v3(s * B * 0.14, ey + leadR, -B * 0.42), v3(s * B * 0.12, ey + leadR * 2, -B * 0.62), v3(s * B * 0.1, escY + H * 0.4, -B * 0.95), v3(s * B * 0.08, so + leadR * 3, -B * 1.25)]);
    push(new THREE.TubeGeometry(lead(-1), 16, leadR, 8, false), "silicone", { order: 5.4, dir: v3(0, -0.2, -1), dist: H * U, kind: "detail" });
    push(new THREE.TubeGeometry(lead(1), 16, leadR, 8, false), "siliconeRed", { order: 5.41, dir: v3(0, -0.2, -1), dist: H * U, kind: "detail" });
  }
  // The 8-pin harness from the ESC up to the flight controller, as a ribbon of wires and its two plugs.
  {
    const wires = [];
    for (let i = 0; i < 8; i++) {
      const x = B * 0.38;
      const z = (i - 3.5) * t * 0.9 - B * 0.05;
      wires.push(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(v3(x, ey + t * 1.4, z), v3(B * 0.6, (ey + fcY) / 2, z), v3(x, fcY + t * 1.6, z)), 8, t * 0.32, 4, false));
    }
    push(merge(wires), "silicone", { order: 6.5, dir: v3(1, 0, 0), dist: H * U * 0.8, kind: "detail" });
    push(merge([box(t * 3, t * 2.2, t * 8.2, B * 0.37, ey + t * 1.1, -B * 0.05), box(t * 3, t * 2.2, t * 8.2, B * 0.37, fcY + t + t * 1.1, -B * 0.05)]), "jst", { order: 6.6, dir: v3(1, 0, 0), dist: H * U * 0.8, kind: "detail" });
  }
  // Flight controller components: the MCU (a square QFP with its pin rows), the gyro, the regulators, the
  // USB-C port on the rear edge, the boot button and the solder pads.
  const fy = fcY + t;
  push(merge([box(B * 0.26, t * 0.9, B * 0.26, 0, fy + t * 0.45, B * 0.04), box(B * 0.08, t * 1.0, B * 0.08, -B * 0.24, fy + t * 0.5, -B * 0.16), box(B * 0.1, t * 1.2, B * 0.07, B * 0.24, fy + t * 0.6, -B * 0.2), box(B * 0.1, t * 1.2, B * 0.07, B * 0.24, fy + t * 0.6, B * 0.26), box(B * 0.06, t * 0.8, B * 0.04, -B * 0.26, fy + t * 0.4, B * 0.28)]), "chip", {
    order: 7,
    dir: UP,
    dist: H * U * 0.8,
    kind: "detail",
  });
  push(
    merge([
      ...[-1, 1].flatMap((s) => [box(B * 0.3, t * 0.4, B * 0.012, 0, fy + t * 0.2, B * 0.04 + s * B * 0.145), box(B * 0.012, t * 0.4, B * 0.3, s * B * 0.145, fy + t * 0.2, B * 0.04)]),
      ...Array.from({ length: 6 }, (_, i) => box(B * 0.05, t * 0.35, B * 0.07, (i - 2.5) * B * 0.075, fy + t * 0.18, B * 0.44)),
      ...Array.from({ length: 4 }, (_, i) => box(B * 0.07, t * 0.35, B * 0.05, -B * 0.44, fy + t * 0.18, (i - 1.5) * B * 0.09)),
    ]),
    "gold",
    { order: 7.1, dir: UP, dist: H * U * 0.8, kind: "detail" },
  );
  push(merge([box(B * 0.24, t * 2, B * 0.16, B * 0.06, fy + t, -B * 0.46), box(B * 0.18, t * 1.2, B * 0.04, B * 0.06, fy + t, -B * 0.55)]), "machined", { order: 7.2, dir: v3(0, 0.2, -1), dist: H * U, kind: "detail" });
  push(cyl(B * 0.03, B * 0.03, t * 1.5, 10, -B * 0.32, fy, -B * 0.36), "jst", { order: 7.4, dir: UP, dist: H * U * 0.8, kind: "detail" });

  // Video transmitter: its finned aluminium heatsink, the antenna connector and the coax to the rear mount,
  // and the antenna itself — a tube with the circularly polarised element in a translucent cap.
  push(
    merge([
      box(vtx * 1.0, t * 1.4, vtx * 1.0, 0, vY + t + t * 0.7, 0),
      ...Array.from({ length: 6 }, (_, i) => box(vtx * 0.92, t * 2.6, t * 0.9, 0, vY + t + t * 2.7, (i - 2.5) * vtx * 0.17)),
    ]),
    "pump",
    { order: 9.2, dir: UP, dist: H * U * 2.2, kind: "detail", edges: true },
  );
  {
    const p0 = v3(-vtx * 0.4, vY + t * 1.5, -vtx * 0.6);
    const pR = v3(0, so * 0.78, -B * 1.38); // the connector, seated in the frame's rear TPU mount
    const curve = new THREE.QuadraticBezierCurve3(p0, v3(-vtx * 0.3, vY + t * 2, -B * 0.95), pR);
    const coax = push(new THREE.TubeGeometry(curve, 10, t * 0.7, 6, false), "silicone", { order: 9.3, dir: v3(0, 0.2, -1), dist: H * U * 1.4, kind: "detail" });
    addDetail(coax, "clamp", clampsAlong(curve, t * 1.4, 1, 0.5, 0.5));
    const dir = v3(0, 0.62, -0.78).normalize();
    const tip = pR.clone().addScaledVector(dir, ant * 0.78);
    const M = alongMatrix(pR, dir);
    push(merge([solid([[0, 0], [t * 2.6, 0], [t * 2.6, t * 3], [t * 1.6, t * 3.6], [t * 1.5, ant * 0.8], [0, ant * 0.8]], 12).applyMatrix4(M), machinedRing(t * 1.5, t * 2.8, t * 3.6, -t * 2, 12).applyMatrix4(M)]), "silicone", {
      order: 9.6,
      dir: v3(0, 0.6, -1),
      dist: H * U * 2.4,
      kind: "detail",
    });
    const capPts = [[0, 0], [ant * 0.04, 0], [ant * 0.09, ant * 0.04], [ant * 0.1, ant * 0.08], ...domePoints(ant * 0.1, ant * 0.07, true, 6).slice(1).map(([r, y]) => [r, y + ant * 0.08])];
    push(solid(capPts, 16).applyMatrix4(alongMatrix(tip, dir)), "tpu", {
      order: 9.7,
      dir: v3(0, 0.6, -1),
      dist: H * U * 2.8,
      kind: "detail",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// drone-battery — the pack as a shrink-wrapped stack of pouch cells with its leads, the plugged XT connector
// and the strap over it. Every size is the battery record's, through geom: L_m, W_m, H_m and the cell count.
// The pack lies along the body with its leads out of the rear (−Z), where a real pack's leads come out.
// ---------------------------------------------------------------------------------------------------------

function buildBattery(spec, mats) {
  const g = spec.geom;
  const K = g.viewK;
  const d = (m) => m * K;
  const L = d(g.L_m);
  const W = d(g.W_m);
  const H = d(g.H_m);
  const cells = clamp(g.cells | 0 || 4, 1, 8);
  const strapW = d(g.strapW_m);
  const connector = spec.record?.connector ?? "XT60";
  const U = SCALE;
  const out = [];
  const zOff = d(g.z_m ?? 0); // a pack in a fuselage bay sits forward of the part's origin
  const push = (geo, mat, o) => {
    const pc = piece(geo, matOf(mats, mat), { z: zOff, ...o });
    out.push(pc);
    return pc;
  };
  const pad = H * 0.03; // the pack sits on the frame's rubber pad
  const r = Math.min(W, H) * 0.16; // the wrap's rounded long edges
  // A rounded section across the pack (x, y), extruded along its length: a pouch pack is a soft brick.
  const section = (w, h, rr, y0) => rrect2(0, y0 + h / 2, w, h, rr, 5);
  const along = (w, h, rr, len, y0, z0, bev) => projectUV(plateXY(section(w, h, rr, y0), null, len, z0, bev));
  const liion = /li-?ion/i.test(String(g.chemistry ?? ""));
  const cellH = (H * 0.9) / cells;
  const cellD = d(LIION_CELL_D_M);
  const nx = Math.max(1, Math.round(W / cellD));
  const ny = Math.max(1, Math.round(H / cellD));
  const nz = Math.max(1, Math.round(L / d(LIION_CELL_L_M)));

  if (liion) {
    // 1. The shrink wrap pulled tight over the cells: its section follows every row. 2. The label band.
    const wrapT = Math.min(W / nx, H / ny) * 0.035;
    const sec = liionSection(W - wrapT * 2, H - wrapT * 2, nx, ny, pad + wrapT, wrapT);
    push(projectUV(plateXY(sec, null, L, -L / 2, wrapT * 1.5)), "wrap", { order: 0, dir: UP, dist: H * U * 2, kind: "shell", side: DS });
    const secB = liionSection(W - wrapT * 2, H - wrapT * 2, nx, ny, pad + wrapT, wrapT * 1.6);
    push(projectUV(plateXY(secB, null, L * 0.36, -L * 0.1, 0)), "label", { order: 0.5, dir: UP, dist: H * U * 2.1, kind: "shell", edges: false });
    // 3. The cells: one piece per row along the pack, each a stack of cylinders end to end.
    const rx = (W - wrapT * 2) / nx / 2;
    const ry = (H - wrapT * 2) / ny / 2;
    const cr = Math.min(rx, ry) * 0.96;
    const cl = L / nz;
    for (let j = 0; j < ny; j++) {
      const geos = [];
      for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) geos.push(bar(cr, cl * 0.96, "z", -W / 2 + wrapT + rx * (2 * i + 1), pad + wrapT + ry * (2 * j + 1), -L / 2 + cl * (k + 0.5), 18));
      push(merge(geos), "cell", { order: 1 + j * 0.1, dir: UP, dist: H * U, kind: "interior" });
    }
    // The nickel strips across the cell ends.
    push(merge([-1, 1].map((s) => box(W * 0.86, H * 0.86, L * 0.006, 0, pad + H / 2, s * (L / 2 - L * 0.004)))), "machined", { order: 2, dir: v3(0, 0.3, -1), dist: H * U, kind: "interior" });
  } else {
  // 1. The shrink wrap: glossy black over the whole pack, with softened ends.
  push(along(W, H, r, L, pad, -L / 2, r * 0.45), "wrap", { order: 0, dir: UP, dist: H * U * 2, kind: "shell", side: DS });
  // 2. The printed label band round the middle, and the white stripe and top label on it.
  push(along(W * 1.006, H * 1.006, r * 1.01, L * 0.42, pad - H * 0.003, -L * 0.12, 0), "label", { order: 0.5, dir: UP, dist: H * U * 2.1, kind: "shell", edges: false });
  push(along(W * 1.008, H * 1.008, r * 1.01, L * 0.03, pad - H * 0.004, L * 0.33, 0), "labelWhite", { order: 0.55, dir: UP, dist: H * U * 2.1, kind: "shell", edges: false });
  push(plateXZ(rrect2(0, -L * 0.33, W * 0.6, L * 0.16, W * 0.04), null, H * 0.008, pad + H), "labelWhite", { order: 0.6, dir: UP, dist: H * U * 2.2, kind: "detail" });
  // 3…n. The pouch cells inside, one piece each: a 4S pack really is four cells in series.
  for (let i = 0; i < cells; i++) {
    push(plateXZ(rrect2(0, 0, W * 0.9, L * 0.94, r * 0.6, 3), null, cellH * 0.88, pad + H * 0.05 + i * cellH), "pouch", { order: 1 + i * 0.1, dir: UP, dist: H * U, kind: "interior" });
  }
  }
  // The nickel tabs joining the cells, at the lead end.
  if (!liion) push(merge(Array.from({ length: cells }, (_, i) => box(W * 0.3, cellH * 0.12, L * 0.03, (i % 2 ? 1 : -1) * W * 0.2, pad + H * 0.05 + (i + 0.9) * cellH, -L * 0.46))), "machined", { order: 2, dir: v3(0, 0.3, -1), dist: H * U, kind: "interior" });

  // The main lead: red and black silicone out of the rear face into the connector, plugged into the frame's
  // pigtail, its two shells mated. XT90 is the bigger plug; the shell follows the record's connector.
  const wr = Math.min(W, H) * (connector === "XT30" ? 0.06 : connector === "XT90" ? 0.085 : 0.075);
  const big = connector === "XT90" ? 1.45 : connector === "XT30" ? 0.75 : 1;
  const zp = -L / 2 - L * 0.16;
  const yp = pad + H * 0.62;
  const leg = (s) => new THREE.CatmullRomCurve3([v3(s * W * 0.16, pad + H * 0.5, -L / 2 + wr), v3(s * W * 0.16, pad + H * 0.52, -L / 2 - L * 0.04), v3(s * wr * 1.3, yp, zp + L * 0.04), v3(s * wr * 1.25, yp, zp)]);
  push(new THREE.TubeGeometry(leg(-1), 12, wr, 8, false), "silicone", { order: 4, dir: v3(0, 0, -1), dist: L * U * 0.4, kind: "detail" });
  push(new THREE.TubeGeometry(leg(1), 12, wr, 8, false), "siliconeRed", { order: 4.01, dir: v3(0, 0, -1), dist: L * U * 0.4, kind: "detail" });
  {
    const sw = wr * 4.6 * big * 0.8;
    const sh = wr * 2.4 * big * 0.8;
    const sl = wr * 3.4 * big * 0.8;
    // The two mated shells: a chamfered housing each, the female on the pack lead, the male on the pigtail.
    const shell = (z0, len) => projectUV(plateXY([[-sw / 2, yp - sh / 2], [sw / 2, yp - sh / 2], [sw / 2, yp + sh * 0.2], [sw * 0.3, yp + sh / 2], [-sw * 0.3, yp + sh / 2], [-sw / 2, yp + sh * 0.2]], null, len, z0, sh * 0.06));
    push(merge([shell(zp - sl, sl), shell(zp - sl * 2.05, sl * 1.0)]), "nylonYellow", { order: 4.1, dir: v3(0, 0, -1), dist: L * U * 0.5, kind: "detail", edges: true });
    // The frame side of the joint: the pigtail curling down off the plug toward the rear of the top plate.
    const tail = (s) => new THREE.CatmullRomCurve3([v3(s * wr * 1.25, yp, zp - sl * 2.05), v3(s * wr * 1.3, yp - H * 0.05, zp - sl * 2.6), v3(s * wr * 1.6, pad + H * 0.12, zp - sl * 2.4), v3(s * wr * 1.8, -H * 0.02, zp - sl * 1.4)]);
    push(merge([new THREE.TubeGeometry(tail(-1), 10, wr * 0.9, 8, false)]), "silicone", { order: 4.2, dir: v3(0, -0.4, -1), dist: L * U * 0.45, kind: "detail" });
    push(merge([new THREE.TubeGeometry(tail(1), 10, wr * 0.9, 8, false)]), "siliconeRed", { order: 4.21, dir: v3(0, -0.4, -1), dist: L * U * 0.45, kind: "detail" });
  }
  // Balance lead: a ribbon of cells + 1 thin wires out of the rear face into its white plug, tucked on top.
  {
    const bl = [];
    for (let i = 0; i <= cells; i++) {
      const x = (i - cells / 2) * wr * 0.55 - W * 0.22;
      bl.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([v3(x, pad + H * 0.85, -L / 2 + wr), v3(x, pad + H * 1.0, -L / 2 - L * 0.05), v3(x * 0.9, pad + H + wr * 0.3, -L / 2 + L * 0.06)]), 8, wr * 0.2, 4, false));
    }
    push(merge(bl), "silicone", { order: 4.4, dir: v3(-0.4, 0.3, -1), dist: L * U * 0.4, kind: "detail" });
    push(box(wr * 0.56 * (cells + 1) + wr * 0.4, wr * 1.1, wr * 2.2, -W * 0.22, pad + H + wr * 0.55, -L / 2 + L * 0.1), "jst", { order: 4.5, dir: v3(-0.4, 0.3, -1), dist: L * U * 0.45, kind: "detail" });
  }
  // The strap over the pack and down through the top plate's slots, with its keepers and the buckle. (A pack in
  // a fuselage bay is held by velcro on its floor, not a strap.)
  if (!g.bay) {
    const st = strapW * 0.09;
    const segs = [plateXY(rrect2(0, pad + H + st / 2, W + st * 2, st, st * 0.4), null, strapW, -strapW / 2)];
    for (const s of [-1, 1]) segs.push(box(st, H + pad + H * 0.08, strapW, s * (W / 2 + st / 2), (pad + H - H * 0.08) / 2, 0));
    const pc = push(projectUV(merge(segs)), "rubber", { order: 5, dir: UP, dist: H * U * 3, kind: "detail" });
    addDetail(pc, "strap", [-1, 1].map((k) => new THREE.Matrix4().compose(new THREE.Vector3(k * W * 0.3 * SCALE, (pad + H + st) * SCALE, 0), new THREE.Quaternion(), new THREE.Vector3(W * 0.08 * SCALE, st * 0.8 * SCALE, strapW * 0.96 * SCALE))));
    push(merge([box(strapW * 1.15, st * 3, strapW * 1.15, W * 0.12, pad + H + st * 1.5, 0), box(strapW * 0.75, st * 3.4, strapW * 0.4, W * 0.12, pad + H + st * 1.7, 0)]), "chip", { order: 5.1, dir: UP, dist: H * U * 3.4, kind: "detail", edges: true });
  }
  return out;
}
// ---------------------------------------------------------------------------------------------------------
// drone-camera — the payload. Branches on geom.type, because a thermal core, a LiDAR puck, a delivery pod and
// an FPV camera are four different machines. Sizes are the payload record's L / W / H.
// ---------------------------------------------------------------------------------------------------------

function buildCamera(spec, mats) {
  const g = spec.geom;
  if (g.type === "multispectral") return buildMultispectral(spec, mats);
  const K = g.viewK;
  const d = (m) => m * K;
  const W = d(g.W_m);
  const H = d(g.H_m);
  const L = d(g.L_m);
  const lensR = d(g.lensR_m ?? Math.min(g.W_m, g.H_m) * 0.3);
  const tilt = (g.tilt_deg ?? 0) * DEG;
  // Where the camera's tilt axis is. On a multirotor it is the pivot in the frame's side plates, found from
  // the plate length (bodyPlan: PLATE_L_SHARE × wheelbase; droneLayout gives the camera bodyL_m = 0.3 × the
  // wheelbase). On the fixed wing it is under the nose.
  const zFront = g.bodyL_m ? (d(g.bodyL_m) / CAM_BODYL_PER_WB) * PLATE_L_SHARE * CAM_PIVOT_SHARE : d((g.fuseL_m ?? g.L_m * 2) * 0.46);
  const U = SCALE;
  const out = [];
  const type = g.type ?? "camera";
  // Built lens-forward (+Z) about the tilt axis at the mounting ears, then tipped by the record's tilt and set
  // at the front of the vehicle. The tilt is baked into the geometry, never left as a piece rotation.
  const place = (geo) => geo.rotateX(-tilt).translate(0, H * 0.62, zFront);
  const push = (geo, mat, o) => {
    const pc = piece(place(geo), matOf(mats, mat), o);
    out.push(pc);
    return pc;
  };

  if (type === "cargo") {
    // A delivery pod: a capsule with an insulated liner, a lid on a latched seam, slung under the frame on two
    // straps from a carbon mount plate, with two landing skids reaching below it so it does not land on itself.
    // It is built in the part's own frame from the frame's underside (spec.slotY is how far this part sits
    // above it), lying along +Z.
    const R = Math.min(W, H) / 2;
    // The skid drop (frame underside to skid underside) is droneLayout's CARGO_DROP × min(W, H), and the layout
    // has already lifted the whole vehicle by exactly that, so the skids stand on the pad deck (y = 0).
    // In a quadplane's belly (g.belly) or under a frame on landing gear (g.underslung) the part's own y = 0 is
    // the underside it hangs from, and it has no skids of its own.
    const hung = Boolean(g.belly || g.underslung);
    const drop = hung ? 0 : d(g.skidDrop_m ?? 0);
    const yB = hung ? 0 : -(spec.slotY ?? 0) / SCALE + drop; // the frame's underside, in this part's display metres
    const zc = g.belly ? d(g.bellyZ_m ?? 0) : d(g.hangZ_m ?? 0);
    // The pod's axis, and the skids below it.
    const yC = yB - R * 1.2;
    const z0 = -L * 0.5;
    const zs = L * 0.44; // the lid seam, along the pod
    const along = (geo) => toZ(geo).translate(0, yC, z0);
    const p2 = (geo, mat, o) => {
      const pc = piece(geo, matOf(mats, mat), { z: zc, ...o });
      out.push(pc);
      return pc;
    };
    const rear = [[0, 0], ...domePoints(R, R * 0.7, false, 8).map(([r, y]) => [r, y + R * 0.7]).slice(1), [R, zs]];
    const front = [[R, zs], [R, L - R * 1.2], ...ogivePoints(R, R * 1.2, L - R * 1.2, 10)];
    p2(along(latheUV(lathe([...rear, [R * 0.9, zs], [0, zs]], 36), { H: L, R })), "body", { order: 0, dir: DOWN, dist: R * U * 2, kind: "shell", side: DS });
    p2(along(latheUV(lathe([[0, zs], [R * 0.9, zs], ...front], 36), { H: L, R })), "body", { order: 1, dir: v3(0, -0.3, 1), dist: R * U * 2.4, kind: "shell", side: DS });
    p2(along(latheUV(lathe([[R * 0.88, R * 0.3], [R * 0.88, zs * 0.98], [R * 0.84, zs * 0.98]], 28), { H: L, R })), "mliSilver", { order: 0.5, dir: DOWN, dist: R * U, kind: "interior" });
    p2(box(R * 1.0, R * 0.9, zs * 0.7, 0, yC, z0 + zs * 0.55), "label", { order: 0.6, dir: DOWN, dist: R * U, kind: "interior" });
    p2(along(machinedRing(R * 0.97, R * 1.035, R * 0.12, zs - R * 0.06, 36)), "machined", { order: 1.2, dir: v3(0, 0, 1), dist: R * U * 2.4, kind: "detail" });
    p2(along(latheUV(lathe([[R * 1.004, L * 0.72], [R * 0.985, L * 0.79]], 36), { H: L, R })), "tpu", { order: 1.3, dir: v3(0, 0, 1), dist: R * U * 2.4, kind: "detail" });
    // The red cross on both flanks, and the two latches on the lid seam.
    for (const sx of [-1, 1]) {
      const x = sx * R * 1.0;
      const zc = z0 + zs * 0.55;
      p2(merge([box(R * 0.03, R * 0.56, R * 0.18, x, yC, zc), box(R * 0.03, R * 0.18, R * 0.56, x, yC, zc)]), "label", { order: 1.4, dir: v3(sx, 0, 0), dist: R * U * 2, kind: "detail" });
      p2(merge([box(R * 0.14, R * 0.26, R * 0.34, sx * R * 1.03, yC, z0 + zs), bar(R * 0.05, R * 0.3, "y", sx * R * 1.1, yC, z0 + zs - R * 0.08, 8)]), "darkMetal", { order: 1.5, dir: v3(sx, 0, 0), dist: R * U * 2, kind: "detail" });
    }
    // The two straps round the pod and up to the mount plate, and the mount plate itself under the frame.
    for (const k of [-1, 1]) {
      const z = k * L * 0.2;
      p2(merge([toZ(latheUV(lathe([[R * 1.01, -R * 0.12], [R * 1.05, -R * 0.1], [R * 1.05, R * 0.1], [R * 1.01, R * 0.12]], 32), { H: R, R })).translate(0, yC, z), box(R * 0.24, yB - (yC + R), R * 0.26, 0, (yB + yC + R) / 2, z)]), "rubber", {
        order: 2 + k * 0.05,
        dir: DOWN,
        dist: R * U * 1.6,
        kind: "detail",
      });
    }
    const plate = p2(projectUV(plateXZ(rrect2(0, 0, R * 1.3, L * 0.62, R * 0.2, 5), [slotV(0, L * 0.12, L * 0.16, R * 0.3), slotV(0, -L * 0.12, L * 0.16, R * 0.3)], R * 0.06, yB - R * 0.06, R * 0.02)), "composite", { order: 3, dir: DOWN, dist: R * U, kind: "shell", side: DS });
    addDetail(plate, "bolt", [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sx, sz]) => boltXf(v3(sx * R * 0.5, yB - R * 0.06, sz * L * 0.26), DOWN, R * 0.09, R * 0.04)), { color: 0x1d1f24 });
    p2(merge([box(R * 0.4, R * 0.22, R * 0.5, 0, yB - R * 0.17, 0), bar(R * 0.05, R * 0.3, "y", 0, yB - R * 0.36, R * 0.1, 8)]), "chip", { order: 3.2, dir: DOWN, dist: R * U * 1.2, kind: "detail" });
    // Landing skids: two carbon legs a side down to a skid tube below the pod, with TPU feet.
    const yS = yB - drop + R * 0.08; // skid tube axis: its underside is the landing plane
    for (const sx of hung ? [] : [-1, 1]) {
      const legs = [-1, 1].map((sz) => rod(v3(sx * R * 0.6, yB - R * 0.06, sz * L * 0.24), v3(sx * R * 1.35, yS, sz * L * 0.3), R * 0.07, 10));
      p2(merge([...legs, bar(R * 0.08, L * 0.85, "z", sx * R * 1.35, yS, 0, 12)]), "composite", { order: 4 + sx * 0.1, dir: v3(sx, -1, 0), dist: R * U * 1.6, kind: "shell", side: DS });
      p2(merge([-1, 1].map((sz) => solid([[0, 0], [R * 0.09, 0], [R * 0.11, R * 0.12], [0, R * 0.14]], 12).applyMatrix4(alongMatrix(v3(sx * R * 1.35, yS, sz * L * 0.42), v3(0, 0, sz))))), "tpu", { order: 4.2 + sx * 0.1, dir: v3(sx, -1, 0), dist: R * U * 1.7, kind: "detail" });
    }
    return out;
  }

  if (type === "lidar") {
    // A compact spinning LiDAR: a machined base, a glass band round the optical drum, a dome cap.
    const R = W / 2;
    push(merge([machinedRing(R * 0.25, R, H * 0.3, 0, 28), boltRing(R * 0.8, H * 0.3, 6, R * 0.1, H * 0.06, R * 0.1)]), "machined", { order: 0, dir: DOWN, dist: H * U * 1.5, kind: "shell", edges: true });
    push(latheUV(lathe([[R * 0.92, H * 0.3], [R * 0.92, H * 0.72], [R * 0.82, H * 0.72]], 28), { H, R }), "mirror", { order: 1, dir: UP, dist: H * U * 1.8, kind: "shell" });
    push(merge([cyl(R * 0.68, R * 0.68, H * 0.4, 18, 0, H * 0.3), box(R * 0.5, H * 0.2, R * 0.3, 0, H * 0.4, R * 0.38)]), "darkMetal", { order: 2, dir: UP, dist: H * U * 1.5, kind: "interior" });
    push(machinedRing(R * 0.2, R * 0.6, H * 0.06, H * 0.66, 20), "machined", { order: 2.5, dir: UP, dist: H * U * 1.5, kind: "interior" });
    push(latheUV(lathe(domePoints(R * 0.92, H * 0.28, true, 6).map(([rr, yy]) => [rr, yy + H * 0.72]), 28), { H, R }), "body", { order: 3, dir: UP, dist: H * U * 2, kind: "shell", side: DS });
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i / 4) * TAU;
      push(cyl(R * 0.12, R * 0.12, H * 0.12, 8, Math.cos(a) * R * 0.78, -H * 0.12, Math.sin(a) * R * 0.78), "darkMetal", { order: 0.5 + i * 0.1, dir: DOWN, dist: H * U, kind: "detail" });
    }
    push(merge([box(R * 0.6, H * 0.12, R * 0.2, 0, H * 0.08, -R * 0.9), rod(v3(0, H * 0.1, -R * 0.9), v3(0, H * 0.02, -R * 1.5), R * 0.07, 5)]), "skirt", { order: 4, dir: v3(0, 0, -1), dist: R * U * 1.5, kind: "detail" });
    push(machinedRing(R * 0.1, R * 0.26, H * 0.08, -H * 0.1, 12), "machined", { order: 4.2, dir: DOWN, dist: H * U, kind: "detail" });
    for (const s of [-1, 1]) push(plateXZ(slot2(s * R * 1.1, 0, R * 0.55, R * 0.3), [circle2(s * R * 1.15, 0, R * 0.08, 8)], H * 0.08, -H * 0.1), "composite", { order: 5 + s * 0.1, dir: v3(s, 0, 0), dist: R * U * 1.5, kind: "detail" });
    push(merge([machinedRing(R * 0.3, R * 0.5, H * 0.1, H * 0.95, 16)]), "darkMetal", { order: 3.5, dir: UP, dist: H * U * 2.2, kind: "detail" });
    return out;
  }

  if (type === "thermal") {
    // A thermal core: a machined aluminium can with a germanium window (mats.gold is the only role that reads
    // like the warm coating on an LWIR lens) and a ribbon off the back.
    const R = Math.min(W, H) / 2;
    push(merge([toZ(machinedRing(R * 0.2, R * 0.98, L * 0.62, -L * 0.3, 24)), toZ(boltRing(R * 0.8, -L * 0.3, 4, R * 0.12, R * 0.1, R * 0.12))]), "machined", { order: 0, dir: DOWN, dist: R * U * 1.5, kind: "shell", edges: true });
    {
      const pts = [[lensR * 1.45, 0]];
      for (let i = 0; i <= 8; i++) pts.push([lensR * (i % 2 ? 1.22 : 1.38), (i / 8) * L * 0.3]);
      pts.push([lensR * 1.2, L * 0.34]);
      push(toZ(latheUV(lathe(pts, 22), { H: L * 0.34, R: lensR * 1.45 })).translate(0, 0, L * 0.3), "darkMetal", { order: 1, dir: v3(0, 0, 1), dist: L * U, kind: "shell" });
    }
    push(toZ(latheUV(lathe(domePoints(lensR * 1.12, lensR * 0.32, true, 5), 22), { H: lensR, R: lensR })).translate(0, 0, L * 0.64), "gold", { order: 2, dir: v3(0, 0, 1), dist: L * U * 1.4, kind: "detail", edges: true });
    push(toZ(machinedRing(lensR * 1.08, lensR * 1.45, lensR * 0.2, 0, 22)).translate(0, 0, L * 0.62), "machined", { order: 2.1, dir: v3(0, 0, 1), dist: L * U * 1.5, kind: "detail" });
    push(merge([toZ(cyl(R * 0.7, R * 0.7, L * 0.3, 18)).translate(0, 0, -L * 0.1), plateXY(rrect2(0, 0, R * 1.5, R * 1.5, R * 0.2), null, R * 0.08, -L * 0.14)]), "panel", { order: 0.6, dir: v3(0, 0, -1), dist: L * U, kind: "interior" });
    push(merge([plateXY(rrect2(0, 0, R * 1.6, R * 1.2, R * 0.2), null, R * 0.08, -L * 0.34), box(R * 0.5, R * 0.16, R * 0.2, 0, 0, -L * 0.52)]), "panel", { order: 3, dir: v3(0, 0, -1), dist: L * U * 1.4, kind: "detail" });
    for (const s of [-1, 1]) {
      push(plateYZ(rrect2(0, 0, R * 0.9, R * 0.5, R * 0.14), [circle2(0, 0, R * 0.1, 8)], R * 0.12, s * R * 1.04), "darkMetal", { order: 4 + s * 0.1, dir: v3(s, 0, 0), dist: R * U * 1.5, kind: "detail" });
      push(bar(R * 0.1, R * 0.3, "x", s * R * 1.12, 0, 0, 8), "machined", { order: 4.2 + s * 0.1, dir: v3(s, 0, 0), dist: R * U * 1.8, kind: "detail" });
    }
    push(merge([box(R * 0.5, R * 0.3, R * 0.12, 0, R * 0.62, -L * 0.1), rod(v3(0, R * 0.62, -L * 0.1), v3(0, R * 0.95, -L * 0.45), R * 0.06, 5)]), "skirt", { order: 5, dir: UP, dist: R * U * 1.8, kind: "detail" });
    push(merge([box(R * 1.3, R * 0.1, R * 0.5, 0, -R * 0.95, 0), bar(R * 0.08, R * 0.3, "y", 0, -R * 1.05, 0, 8)]), "composite", { order: 0.3, dir: DOWN, dist: R * U * 1.6, kind: "detail" });
    return out;
  }

  // Default: an FPV camera. A machined black case with a chamfered face, the M12 lens barrel with its knurled
  // focus ring and coated glass, the sensor board inside and the lead off the back. Built about its tilt axis
  // (the side plates' pivot screws go into its flanks), lens toward +Z, then tipped up by the record's tilt.
  const Lb = L * 0.72;
  push(projectUV(plateXY(rrect2(0, 0, W, H, W * 0.14, 5), null, Lb, -Lb * 0.55, W * 0.03)), "bell", { order: 0, dir: DOWN, dist: H * U * 1.5, kind: "shell", side: DS });
  push(projectUV(plateXY(rrect2(0, 0, W * 1.03, H * 1.03, W * 0.16, 5), [circle2(0, 0, lensR * 1.32, 20)], L * 0.07, Lb * 0.45 - L * 0.02, W * 0.025)), "bell", { order: 0.2, dir: v3(0, 0, 1), dist: L * U, kind: "shell", side: DS });
  push(plateXY(rrect2(0, 0, W * 0.86, H * 0.86, W * 0.08, 3), null, L * 0.03, -Lb * 0.3), "pcbGreen", { order: 0.4, dir: DOWN, dist: H * U, kind: "interior" });
  // The flank bosses the pivot screws thread into.
  push(merge([-1, 1].map((s) => bar(H * 0.16, W * 0.06, "x", s * W * 0.515, 0, 0, 14))), "machined", { order: 0.45, dir: DOWN, dist: H * U, kind: "detail" });
  {
    // The barrel: a threaded tube, the knurled focus ring on it, the front bezel and the glass.
    const z0 = Lb * 0.45 + L * 0.05;
    const pts = [[lensR * 1.22, 0]];
    for (let i = 0; i <= 8; i++) pts.push([lensR * (i % 2 ? 1.14 : 1.22), (i / 8) * L * 0.16]);
    for (let i = 0; i <= 14; i++) pts.push([lensR * (i % 2 ? 1.34 : 1.42), L * 0.16 + (i / 14) * L * 0.14]);
    pts.push([lensR * 1.18, L * 0.31], [lensR * 1.18, L * 0.36], [lensR * 0.96, L * 0.38], [lensR * 0.9, L * 0.34]);
    push(toZ(latheUV(lathe(pts, 24), { H: L * 0.4, R: lensR * 1.42 })).translate(0, 0, z0), "chip", { order: 1, dir: v3(0, 0, 1), dist: L * U, kind: "shell", edges: true });
    push(toZ(latheUV(lathe(domePoints(lensR * 0.93, lensR * 0.32, true, 6), 24), { H: lensR, R: lensR })).translate(0, 0, z0 + L * 0.335), "glass", { order: 2, dir: v3(0, 0, 1), dist: L * U * 1.4, kind: "detail", edges: true });
    push(toZ(machinedRing(lensR * 1.06, lensR * 1.24, L * 0.03, 0, 24)).translate(0, 0, z0 + L * 0.33), "machined", { order: 2.1, dir: v3(0, 0, 1), dist: L * U * 1.5, kind: "detail" });
  }
  // The lead off the back: its plug in the case, and the cable down toward the flight controller.
  {
    const p0 = v3(0, -H * 0.1, -Lb * 0.55);
    // Aimed up so that, once the camera is tipped back, the lead runs level into the stack, not under the frame.
    const p1 = v3(0, H * 0.25 + L * Math.tan(tilt) * 0.5, -L * 1.0);
    push(merge([box(W * 0.42, H * 0.22, L * 0.08, 0, -H * 0.1, -Lb * 0.57), new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(p0, v3(0, -H * 0.1, -L * 0.8), p1), 10, W * 0.045, 6, false)]), "silicone", { order: 4, dir: v3(0, 0.2, -1), dist: L * U * 1.4, kind: "detail" });
  }
  // A thin TPU guard round the front face, the accent colour every freestyle build wears.
  push(projectUV(plateXY(rrect2(0, 0, W * 1.1, H * 1.1, W * 0.2, 5), [rrect2(0, 0, W * 0.98, H * 0.98, W * 0.15, 5)], L * 0.08, Lb * 0.45 - L * 0.04, W * 0.02)), "tpu", { order: 3, dir: v3(0, 0, 1), dist: L * U * 1.2, kind: "detail" });
  return out;
}


// ---------------------------------------------------------------------------------------------------------
// Fixed wing. Bodies lie along +Z with the nose at +Z; the span runs along X. The shells are 3D printed, so
// they carry layer banding baked into the profile (printBands) — the only way to show print lines without
// adding a material to parts.js, which this file may not do.
// ---------------------------------------------------------------------------------------------------------

// Radius profile for a printed shell over y0..y1, sampled at band boundaries with the layer offset applied.
function bandedProfile(y0, y1, rOf, amp, band) {
  return printBands(Math.abs(y1 - y0), band).map(({ s, off }) => [rOf(s) + off * amp, lerp(y0, y1, s)]);
}
const latheOf = (pts, seg = 24, phi0 = 0, phiLen = TAU) =>
  latheUV(lathe(pts, seg, phi0, phiLen), { H: pts[pts.length - 1][1] - pts[0][1] || 1, R: Math.max(...pts.map((p) => p[0])), y0: pts[0][1], phiStart: phi0, phiLength: phiLen });

function buildFuselage(spec, mats) {
  const g = spec.geom;
  if (g.style === "pod") return buildPodFuselage(spec, mats);
  const K = g.viewK;
  const d = (m) => m * K;
  const L = d(g.fuseL_m);
  const R = d(g.fuseR_m);
  const tR = d(g.tailR_m);
  const noseL = d(g.noseL_m);
  const amp = g.printed === false ? 0 : d(PRINT_BAND_AMP_M); // no layer lines on a moulded (foam) airframe
  const band = d(PRINT_BAND_M) * (g.printed === false ? 6 : 1); // fewer, smooth stations on a moulded skin
  const U = SCALE;
  const out = [];
  // Built as a lathe about its own +Y (the station from tail to nose) and turned onto +Z, so the piece itself
  // carries no rotation: the X turn is baked in. The body axis sits at y = R, the nose at +Z, and the body is
  // squeezed in X because a printed fuselage is not round.
  const FLAT = 0.84; // fuselage width / height (shape only)
  const toBody = (geo) => toZ(geo.scale(FLAT, 1, 1)).translate(0, R, -L / 2);
  const push = (geo, mat, o) => {
    const pc = piece(geo, mats[mat], o);
    out.push(pc);
    return pc;
  };
  const yAft = L * 0.3;
  const yMid = L * 0.52;
  const yFwd = L * 0.76;
  const yNose = L - noseL;

  // 1–6. The printed shells, tail to nose. The forward bay is a half shell so the battery hatch can lift off.
  push(toBody(latheOf(bandedProfile(0, yAft, (s) => lerp(tR * 0.8, tR * 1.2, s), amp, band))), "body", { order: 0, dir: v3(0, 0, -1), dist: L * U * 0.22, kind: "shell", side: DS, ax: ["b", -1, 0] });
  push(toBody(latheOf(bandedProfile(yAft, yMid, (s) => lerp(tR * 1.2, R, Math.pow(s, 0.7)), amp, band))), "body", { order: 1, dir: v3(0, 0, -1), dist: L * U * 0.14, kind: "shell", side: DS, ax: ["b", -1, 1] });
  push(toBody(latheOf(bandedProfile(yMid, yFwd, () => R, amp, band))), "body", { order: 2, dir: UP, dist: L * U * 0.1, kind: "shell", side: DS, ax: ["b", 0, 0] });
  push(toBody(latheOf(bandedProfile(yFwd, yNose, () => R, amp, band), 20, Math.PI * 0.2, Math.PI * 1.6)), "body", { order: 3, dir: v3(0, -0.4, 1), dist: L * U * 0.1, kind: "shell", side: DS, ax: ["b", 1, 0] });
  push(toBody(latheOf([[R, yFwd], [R, yNose]], 14, Math.PI * 1.82, Math.PI * 0.56)), "body", {
    order: 4,
    dir: UP,
    dist: L * U * 0.16,
    kind: "shell",
    side: DS,
    deploy: { axis: v3(1, 0, 0), pivot: v3(0, R, yFwd - L / 2), angle: -55 * DEG, order: 0 },
  });
  push(toBody(latheOf(bandedProfile(yNose, L - noseL * 0.02, (s) => R * Math.sqrt(Math.max(0.03, 1 - s * s * 0.98)), amp, band))), "body", { order: 5, dir: v3(0, 0, 1), dist: L * U * 0.24, kind: "shell", side: DS, ax: ["b", 1, 1] });
  // 7. Nose ring: the reinforcing ring the motor mount bolts through.
  push(toBody(machinedRing(R * 0.3, R * 0.62, L * 0.012, L - noseL * 0.08, 20)), "machined", { order: 5.2, dir: v3(0, 0, 1), dist: L * U * 0.26, kind: "detail" });
  // 8–11. Internal formers: motor bulkhead, bay front, spar former, aft former — printed ribs, seen through
  // the shells in the clear look.
  const former = (y, r, th) => toBody(plateXZ(circle2(0, 0, r, 20), [circle2(0, 0, r * 0.45, 14), ...[-1, 1].map((s) => circle2(s * r * 0.62, 0, r * 0.15, 8))], th, y));
  [[yNose, R * 0.95, L * 0.01], [yFwd, R * 0.95, L * 0.01], [yMid + (yFwd - yMid) * 0.35, R * 0.95, L * 0.012], [yAft, tR * 1.15, L * 0.008]].forEach(([y, r, th], i) =>
    push(former(y, r, th), "trim", { order: 6 + i * 0.1, dir: UP, dist: R * U * 1.2, kind: "interior" }),
  );
  // 12. Spar socket: the tube the wing spar slides into, across the span.
  const ySpar = yMid + (yFwd - yMid) * 0.35 - L / 2;
  push(bar(R * 0.17, R * 2.1, "x", 0, R * 1.4, ySpar, 14), "composite", { order: 6.5, dir: UP, dist: R * U * 1.4, kind: "interior" });
  // 13. Keel: the printed floor the battery slides along.
  push(plateXZ(rrect2(0, (yFwd + yNose) / 2 - L / 2, R * 1.1, (yNose - yFwd) * 0.95, R * 0.1), null, L * 0.006, R * 0.42), "trim", { order: 6.8, dir: DOWN, dist: R * U * 1.2, kind: "interior" });
  // 14. Print seam rings at the segment joins, where the printed sections are glued.
  push(merge([yAft, yMid, yFwd, yNose].map((y) => toBody(machinedRing(R * 0.985, R * 1.015, L * 0.004, y, 22)))), "trim", { order: 7, dir: UP, dist: R * U, kind: "detail" });
  // 15–18. Two servo mounts with their servo bodies, and the pushrods back to the tail.
  for (const s of [-1, 1]) {
    const zS = yAft + (yMid - yAft) * 0.6 - L / 2;
    push(merge([box(R * 0.34, R * 0.3, R * 0.55, s * R * 0.5, R, zS), box(R * 0.12, R * 0.1, R * 0.75, s * R * 0.5, R + R * 0.16, zS)]), "darkMetal", { order: 8 + s * 0.1, dir: v3(s, 0, 0), dist: R * U * 1.4, kind: "detail" });
    push(rod(v3(s * R * 0.5, R + R * 0.2, zS), v3(s * tR * 0.5, R, -L / 2 + L * 0.05), R * 0.03, 4), "pipe", { order: 8.4 + s * 0.1, dir: v3(s, 0.2, -1), dist: R * U * 1.6, kind: "detail" });
  }
  // 19. Antenna mast on the spine.
  push(merge([cyl(R * 0.06, R * 0.08, R * 0.9, 8, 0, R * 1.9, yMid - L / 2), cyl(R * 0.14, R * 0.14, R * 0.1, 10, 0, R * 1.84, yMid - L / 2)]), "skirt", { order: 9, dir: UP, dist: R * U * 1.8, kind: "detail" });
  // 20. Hatch latch and 21–22. the two wing bolt lugs.
  push(merge([box(R * 0.3, R * 0.12, R * 0.2, 0, R * 1.84, yFwd - L / 2 + L * 0.02), bar(R * 0.05, R * 0.2, "y", 0, R * 1.76, yFwd - L / 2 + L * 0.02, 8)]), "machined", { order: 9.2, dir: UP, dist: R * U * 1.8, kind: "detail" });
  for (const s of [-1, 1]) push(merge([box(R * 0.26, R * 0.3, R * 0.26, s * R * 0.5, R * 1.45, yMid - L / 2 + L * 0.03), bar(R * 0.07, R * 0.4, "y", s * R * 0.5, R * 1.45, yMid - L / 2 + L * 0.03, 8)]), "trim", { order: 9.4 + s * 0.1, dir: UP, dist: R * U * 1.4, kind: "detail" });
  // 23. Tail skid under the boom.
  push(plateXZ(slot2(0, -L * 0.44, tR * 1.6, tR * 0.5), null, tR * 0.3, R - tR * 1.25), "skirt", { order: 9.8, dir: DOWN, dist: tR * U * 2, kind: "detail" });
  return out;
}

function buildWing(spec, mats) {
  const g = spec.geom;
  const K = g.viewK;
  const d = (m) => m * K;
  const span = d(g.span_m);
  const chord = d(g.chord_m);
  const thick = d(g.thick_m);
  const fuseR = d(g.fuseR_m ?? g.chord_m * 0.25);
  const air = naca4(g.airfoil); // the real NACA section, generated from the record's designation
  const sec = airfoilPoints(air, 13);
  const tk = thick / (chord * air.thick); // scale the section so its max thickness is geom.thick_m
  const dih = (g.dihedral_deg ?? 0) * DEG;
  const ribs = clamp(g.ribCount | 0 || 10, 4, 26);
  const amp = g.printed === false ? 0 : d(PRINT_BAND_AMP_M); // no layer lines on a moulded (foam) airframe
  const band = d(PRINT_BAND_M) * (g.printed === false ? 6 : 1); // fewer, smooth stations on a moulded skin
  const U = SCALE;
  const out = [];
  // A wing set fore or aft of the fuselage's middle (geom.z_m): every piece, and every hinge, moves with it.
  const zW = d(g.z_m ?? 0);
  const push = (geo, mat, o) => {
    if (zW) geo.translate(0, 0, zW);
    const dep = o.deploy && zW ? { ...o.deploy, pivot: o.deploy.pivot.clone().setZ(o.deploy.pivot.z + zW) } : o.deploy;
    const pc = piece(geo, matOf(mats, skinOf(g, mat)), { ...o, deploy: dep });
    out.push(pc);
    return pc;
  };
  const half = span / 2;
  const xElev = half * WING_ELEVON_SPAN;
  // A planform from the record (geom.tipChord_m: a straight centre section, then a linear taper), else the
  // rounded-tip constant chord.
  const tipC = g.tipChord_m ? d(g.tipChord_m) : null;
  const chordAt = tipC
    ? (x) => {
        const f = Math.abs(x) / half;
        const st = g.straight ?? 0.4;
        const c = f < st ? chord : lerp(chord, tipC, (f - st) / (1 - st));
        return c * lerp(1, 0.8, clamp((f - 0.96) / 0.04, 0, 1));
      }
    : (x) => chord * lerp(1, WING_TIP_TAPER, clamp((Math.abs(x) - half * 0.82) / (half * 0.18), 0, 1));
  const yAt = (x) => Math.abs(x) * Math.tan(dih);
  // One section ring at span station x, optionally cropped to a chord band; chord runs along Z with the
  // leading edge at +Z, thickness in Y, so a wing is a true aerofoil, not a flat plate.
  const ring = (x, crop = null, shrink = 1) => {
    const c = chordAt(x);
    const pts = crop ? cropSection(sec, crop[0], crop[1]) : sec;
    return pts.map(([f, yc, yt, side]) => v3(x, yAt(x) + (yc + side * yt * shrink) * c * tk, (0.5 - f) * c));
  };
  for (const s of [-1, 1]) {
    const k = s > 0 ? 0 : 0.5;
    // Inner skin, full chord.
    const inner = printBands(xElev - fuseR * 0.8, band).map(({ s: p, off }) => {
      const x = s * lerp(fuseR * 0.8, xElev, p);
      return ring(x).map((v) => v.setY(v.y + off * amp));
    });
    push(loft(inner), "body", { order: 0 + k, dir: v3(s, 0.2, 0), dist: half * U * 0.25, kind: "shell", side: DS });
    // Outer skin, trailing quarter cropped off for the elevon, rounded into the tip.
    const bands = printBands(half - xElev, band);
    const outer = bands.map(({ s: p, off }, i) => {
      const x = s * lerp(xElev, half, p);
      const r = ring(x, [0, 1 - WING_ELEVON_CHORD], i === bands.length - 1 ? 0.25 : 1);
      return r.map((v) => v.setY(v.y + off * amp));
    });
    push(loft(outer), "body", { order: 2 + k, dir: v3(s, 0.2, 0), dist: half * U * 0.4, kind: "shell", side: DS });
    // Elevon: the cropped tail of the same section, on a hinge, so it can deflect in the deploy view.
    const elev = [0.02, 0.5, 0.98].map((p) => ring(s * lerp(xElev, half, p), [1 - WING_ELEVON_CHORD + 0.015, 1]));
    push(loft(elev), "body", {
      order: 4 + k,
      dir: v3(s * 0.4, 0, -1),
      dist: half * U * 0.3,
      kind: "shell",
      side: DS,
      deploy: { axis: v3(1, 0, 0), pivot: v3(s * xElev, yAt(xElev), (0.5 - (1 - WING_ELEVON_CHORD)) * chord), angle: s * DEPLOY_DEG * DEG, order: s > 0 ? 0 : 1 },
    });
    // The hinge line: a dark tape strip along the top of the elevon joint, from the elevon root to the tip.
    {
      const cut = 1 - WING_ELEVON_CHORD;
      const iu = sec.findIndex(([f, , , side]) => side === 1 && f <= cut);
      const a = ring(s * xElev)[iu];
      const b = ring(s * half * 0.975)[iu];
      push(rod(a, b, chord * 0.006, 6), "skirt", { order: 4.5 + k, dir: v3(s * 0.4, 0.2, -1), dist: half * U * 0.3, kind: "detail" });
    }
    // Printed ribs inside the panel, merged per side: what shows through a clear LW-PLA shell.
    const rl = [];
    for (let i = 0; i < ribs; i++) {
      const x = s * lerp(fuseR * 0.9, half * 0.96, (i + 0.5) / ribs);
      const t = chord * 0.012;
      rl.push(loft([ring(x - s * t), ring(x + s * t)]));
    }
    // (A moulded foam wing is solid: no ribs.)
    if (g.printed !== false) push(merge(rl), "trim", { order: 6 + k, dir: v3(s, 0, 0), dist: half * U * 0.16, kind: "interior" });
    // Wingtip cap, then the servo with its horn and the pushrod into the elevon.
    push(loft([ring(s * half * 0.985, null, 0.3), ring(s * half, null, 0.06)]), "trim", { order: 7 + k, dir: v3(s, 0, 0), dist: half * U * 0.45, kind: "detail" });
    const sx = s * lerp(xElev, half, 0.3);
    push(merge([box(chord * 0.09, thick * 0.9, chord * 0.2, sx, yAt(sx), -chord * 0.08), box(chord * 0.03, thick * 1.4, chord * 0.07, sx, yAt(sx), -chord * 0.08)]), "darkMetal", { order: 8 + k, dir: DOWN, dist: thick * U * 4, kind: "detail" });
    push(rod(v3(sx, yAt(sx) + thick * 0.7, -chord * 0.12), v3(sx, yAt(sx) + thick * 0.2, -chord * 0.33), chord * 0.006, 4), "pipe", { order: 8.4 + k, dir: DOWN, dist: thick * U * 5, kind: "detail" });
  }
  // The spar through both panels, and the two root joiners that bolt the wing to the fuselage.
  const sparR = Math.max(thick * SPAR_R_SHARE, chord * 0.008);
  push(bar(sparR, span * 0.92, "x", 0, 0, chord * 0.08, 14), "composite", { order: 9, dir: UP, dist: thick * U * 5, kind: "interior" });
  for (const s of [-1, 1]) push(merge([box(chord * 0.1, thick * 1.1, chord * 0.5, s * fuseR * 0.7, 0, 0), bar(chord * 0.02, thick * 1.9, "y", s * fuseR * 0.7, -thick * 0.5, chord * 0.12, 8)]), "trim", { order: 9.4 + (s > 0 ? 0 : 0.1), dir: DOWN, dist: thick * U * 4, kind: "detail" });
  return out;
}

function buildTail(spec, mats) {
  const g = spec.geom;
  if (g.tailType === "v" || g.tailType === "inverted-v") return buildVTail(spec, mats);
  if (g.tailType === "h") return buildHTail(spec, mats);
  const K = g.viewK;
  const d = (m) => m * K;
  const hSpan = d(g.hSpan_m);
  const hChord = d(g.hChord_m);
  const vH = d(g.vHeight_m);
  const vC = d(g.vChord_m);
  const boomL = d(g.boomL_m);
  const tR = d(g.tailR_m ?? g.hChord_m * 0.12);
  const fuseL = d(g.fuseL_m ?? boomL * 2);
  const amp = g.printed === false ? 0 : d(PRINT_BAND_AMP_M); // no layer lines on a moulded (foam) airframe
  const band = d(PRINT_BAND_M) * (g.printed === false ? 6 : 1); // fewer, smooth stations on a moulded skin
  const zT = g.zT_m != null ? d(g.zT_m) : -fuseL / 2 + hChord * 0.35; // the tail group sits at the back of the body
  const sec = airfoilPoints(naca4(null), 11); // a tail is a symmetric section
  const U = SCALE;
  const out = [];
  const push = (geo, mat, o) => {
    const pc = piece(geo, matOf(mats, skinOf(g, mat)), o);
    out.push(pc);
    return pc;
  };
  const taperAt = (t) => lerp(1, 0.72, t);
  const hRing = (x, crop, taper, shrink = 1) => {
    const c = hChord * taper;
    return (crop ? cropSection(sec, crop[0], crop[1]) : sec).map(([f, yc, yt, side]) => v3(x, (yc + side * yt * shrink) * c, zT + (0.5 - f) * c));
  };
  const vRing = (y, crop, taper, shrink = 1) => {
    const c = vC * taper;
    return (crop ? cropSection(sec, crop[0], crop[1]) : sec).map(([f, yc, yt, side]) => v3((yc + side * yt * shrink) * c, y, zT + (0.5 - f) * c));
  };
  const cut = 1 - WING_ELEVON_CHORD;
  // 1–2. The boom from the body back to the tail, and its end fitting (none on a fuselage that runs to the tail).
  if (!g.noBoom) push(bar(tR, boomL, "z", 0, 0, zT + boomL * 0.5, 12), "composite", { order: 0, dir: v3(0, 0, 1), dist: boomL * U * 0.2, kind: "shell" });
  push(toZ(machinedRing(tR * 0.9, tR * 1.35, hChord * 0.1, 0, 14)).translate(0, 0, zT + hChord * 0.05), "machined", { order: 0.3, dir: v3(0, 0, -1), dist: tR * U * 3, kind: "detail" });
  for (const s of [-1, 1]) {
    const k = s > 0 ? 0 : 0.1;
    // 3–4. Stabiliser halves, trailing quarter cropped for the elevators.
    const rl = printBands(hSpan / 2, band).map(({ s: p, off }) => hRing(s * lerp(tR * 0.8, hSpan / 2, p), [0, cut], taperAt(p)).map((v) => v.setY(v.y + off * amp)));
    rl.push(hRing(s * hSpan * 0.5, [0, cut], 0.62, 0.15));
    push(loft(rl), "body", { order: 1 + k, dir: v3(s, 0, 0), dist: hSpan * U * 0.2, kind: "shell", side: DS });
    // 5–6. Elevators, hinged.
    const el = [0.03, 0.5, 0.97].map((p) => hRing(s * lerp(tR * 0.9, hSpan / 2, p), [cut + 0.015, 1], taperAt(p)));
    push(loft(el), "body", {
      order: 2 + k,
      dir: v3(s * 0.3, 0, -1),
      dist: hChord * U * 1.5,
      kind: "shell",
      side: DS,
      deploy: { axis: v3(1, 0, 0), pivot: v3(0, 0, zT + (0.5 - cut) * hChord), angle: DEPLOY_DEG * DEG, order: s > 0 ? 0 : 1 },
    });
    // 7–8. Stabiliser ribs per side.
    const rib = [];
    for (let i = 0; i < 4; i++) {
      const x = s * lerp(tR, hSpan * 0.46, (i + 0.5) / 4);
      const t = hChord * 0.014;
      rib.push(loft([hRing(x - s * t, [0, cut], 0.95), hRing(x + s * t, [0, cut], 0.95)]));
    }
    push(merge(rib), "trim", { order: 3 + k, dir: v3(s, 0, 0), dist: hSpan * U * 0.1, kind: "interior" });
    // 9–12. Control horns and pushrods.
    const hx = s * hSpan * 0.16;
    push(box(hChord * 0.045, hChord * 0.18, hChord * 0.06, hx, -hChord * 0.09, zT - hChord * 0.28), "darkMetal", { order: 4 + k, dir: DOWN, dist: hChord * U, kind: "detail" });
    push(rod(v3(hx, -hChord * 0.15, zT - hChord * 0.28), v3(hx * 0.6, -tR * 0.6, zT + boomL * 0.55), hChord * 0.008, 4), "pipe", { order: 4.4 + k, dir: DOWN, dist: hChord * U * 1.4, kind: "detail" });
  }
  // 13. The fin, 14. the rudder on its hinge, 15. the fin ribs.
  {
    const rl = printBands(vH, band).map(({ s: p, off }) => vRing(lerp(tR * 0.6, vH, p), [0, cut], taperAt(p)).map((v) => v.setX(v.x + off * amp)));
    rl.push(vRing(vH, [0, cut], 0.58, 0.15));
    push(loft(rl), "body", { order: 5, dir: UP, dist: vH * U * 0.3, kind: "shell", side: DS });
    const rd = [0.03, 0.5, 0.97].map((p) => vRing(lerp(tR * 0.7, vH, p), [cut + 0.015, 1], taperAt(p)));
    push(loft(rd), "body", {
      order: 6,
      dir: v3(0, 0.3, -1),
      dist: vC * U * 1.5,
      kind: "shell",
      side: DS,
      deploy: { axis: v3(0, 1, 0), pivot: v3(0, 0, zT + (0.5 - cut) * vC), angle: DEPLOY_DEG * DEG, order: 2 },
    });
    const rib = [];
    for (let i = 0; i < 3; i++) {
      const y = lerp(tR, vH * 0.9, (i + 0.5) / 3);
      const t = vC * 0.014;
      rib.push(loft([vRing(y - t, [0, cut], 0.95), vRing(y + t, [0, cut], 0.95)]));
    }
    push(merge(rib), "trim", { order: 7, dir: UP, dist: vH * U * 0.15, kind: "interior" });
  }
  // 16. Hinge strips along both hinge lines, 17. the boom clamp, 18. the tail skid.
  push(merge([box(hSpan * 0.9, hChord * 0.014, hChord * 0.03, 0, 0, zT + (0.5 - cut) * hChord), box(vC * 0.024, vH * 0.9, hChord * 0.03, 0, vH * 0.5, zT + (0.5 - cut) * vC)]), "skirt", { order: 8, dir: v3(0, 0, -1), dist: hChord * U, kind: "detail" });
  push(merge([toZ(machinedRing(tR * 1.05, tR * 1.5, hChord * 0.16, 0, 14)).translate(0, 0, zT + boomL * 0.9), box(tR * 0.5, tR * 3.2, hChord * 0.14, 0, 0, zT + boomL * 0.9)]), "darkMetal", { order: 8.4, dir: v3(0, 0, 1), dist: tR * U * 3, kind: "detail" });
  push(plateXZ(slot2(0, zT + hChord * 0.1, tR * 2.2, tR * 0.6), null, tR * 0.4, -tR * 1.35), "skirt", { order: 8.8, dir: DOWN, dist: tR * U * 3, kind: "detail" });
  return out;
}

function buildNoseMotor(spec, mats) {
  const g = spec.geom;
  const K = g.viewK;
  const d = (m) => m * K;
  const fuseL = d(g.fuseL_m);
  const fuseR = d(g.fuseR_m ?? g.motorOuterR_m * 2);
  const U = SCALE;
  const out = [];
  const motor = motorKit(g, d);
  // The motor hangs off the nose looking forward, so its +Y axis is turned onto +Z — baked in, as the piece
  // rule requires. z0 is the nose face.
  // A pusher (geom.pusher) is the same motor turned to face aft (−Z) on the tail cone's end face (geom.faceZ_m),
  // at the fuselage axis (geom.axisY_m).
  const s = g.pusher ? -1 : 1;
  const z0 = g.faceZ_m != null ? d(g.faceZ_m) : fuseL / 2;
  const ay = g.axisY_m != null ? d(g.axisY_m) : fuseR;
  const shift = v3(0, ay, z0 - s * motor.H * 0.02);
  const turnX = (geo) => (s > 0 ? toZ(geo) : geo.rotateX(-Math.PI / 2));
  const forward = (geo) => turnX(geo).translate(shift.x, shift.y, shift.z);
  // The same turn and shift, in scene units, for the instanced bolts.
  const frame = new THREE.Matrix4().makeTranslation(shift.x * SCALE, shift.y * SCALE, shift.z * SCALE).multiply(new THREE.Matrix4().makeRotationX((s * Math.PI) / 2));

  for (const m of motor) {
    const pc = piece(forward(m.geo), matOf(mats, m.mat), { order: 1 + (m.order ?? 0), dir: v3(0, 0, s), dist: (m.dist ?? motor.H) * U, kind: m.kind });
    if (m.bolts) addDetail(pc, "bolt", reframe(m.bolts, frame));
    if (m.spin) pc.mesh.userData.spin = true;
    out.push(pc);
  }
  // The printed X mount the motor bolts to, and the four standoffs through the nose ring.
  const mountHoles = [circle2(0, 0, motor.shR * 2.6, 10), ...Array.from({ length: 4 }, (_, i) => circle2(Math.cos(Math.PI / 4 + (i / 4) * TAU) * motor.mc, Math.sin(Math.PI / 4 + (i / 4) * TAU) * motor.mc, motor.mc * 0.17, 8))];
  out.push(piece(turnX(plateXZ(circle2(0, 0, motor.mc * 1.6, 18), mountHoles, motor.baseH * 0.4, 0)).translate(0, ay, z0 - s * motor.baseH * 0.45), mats.trim, { order: 0, dir: v3(0, 0, -s), dist: motor.baseH * U * 4, kind: "detail" }));
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i / 4) * TAU;
    out.push(piece(bar(motor.mc * 0.17, motor.baseH * 0.9, "z", Math.cos(a) * motor.mc, ay + Math.sin(a) * motor.mc, z0 - s * motor.baseH * 0.9, 8), mats.machined, { order: 0.2 + i * 0.05, dir: radial(a), dist: motor.mc * U * 2, kind: "detail" }));
  }
  // The three phase wires back through the nose ring into the fuselage.
  const wR = motor.shR * 0.45;
  for (let i = 0; i < MOTOR_WIRES; i++) {
    const o = (i - 1) * wR * 2.4;
    const p0 = v3(o, ay + motor.R * 0.6, z0 - s * motor.baseH * 0.2);
    const p1 = v3(o * 0.4, ay + motor.R * 0.1, z0 - s * fuseR * 1.5);
    const curve = new THREE.QuadraticBezierCurve3(p0, v3(o, ay + motor.R * 0.25, z0 - s * fuseR * 0.6), p1);
    const pc = piece(new THREE.TubeGeometry(curve, 12, wR, 6, false), mats.skirt, { order: 2 + i * 0.05, dir: v3(Math.sign(o) || 1, 0.3, -s), dist: motor.R * U * 1.5, kind: "detail" });
    out.push(pc);
  }
  return out;
}

function buildNosePropeller(spec, mats) {
  const g = spec.geom;
  const K = g.viewK;
  const d = (m) => m * K;
  const fuseL = d(g.fuseL_m);
  const fuseR = d(g.fuseR_m ?? g.propR_m * 0.3);
  const motorH = d(g.motorH_m ?? g.hubH_m * 4);
  const hubR = d(g.hubR_m);
  const hubH = d(g.hubH_m);
  const U = SCALE;
  const out = [];
  // A tractor prop: the same propeller, turned to face +Z (the X turn baked into the geometry) and set ahead of
  // the motor by the piece's own position, so every piece stays centred on its hub. Its spin axis is then the
  // mesh's local Z, which mesh.userData.spinAxis says (a Y turn would flip the disc, not spin it).
  // A pusher's faces aft from the tail cone's end face (see buildNoseMotor).
  const s = g.pusher ? -1 : 1;
  const face = g.faceZ_m != null ? d(g.faceZ_m) : fuseL / 2;
  const ay = g.axisY_m != null ? d(g.axisY_m) : fuseR;
  const z0 = face + s * (-motorH * 0.02 + bellTopOf(motorH)); // the hub seats on the bell, as on the quad
  const turn = new THREE.Matrix4().makeRotationX((s * Math.PI) / 2);
  const prop = propMaterial(mats, spec.record?.material);
  const turnX = (geo) => (s > 0 ? toZ(geo) : geo.rotateX(-Math.PI / 2));
  const add = (geo, mat, o, bolts) => {
    const pc = piece(turnX(geo), mat, { y: ay, z: z0, ...o });
    if (bolts) addDetail(pc, "bolt", reframe(bolts, turn));
    pc.mesh.userData.spinAxis = "z";
    out.push(pc);
  };
  for (const p of propKit(g, d, spec.record?.material)) {
    add(p.geo, p.mat === "prop" ? prop : matOf(mats, p.mat), { order: p.order, dir: p.dir ? v3(p.dir.x, p.dir.z, s * p.dir.y) : v3(0, 0, s), dist: (p.dist ?? 0.2) * U, kind: p.kind }, p.bolts);
  }
  // The spinner over the hub and nut, on its backplate: what turns a motor stuck on a nose into an aeroplane.
  const sR = hubR * 1.45;
  add(solid([[0, -hubH * 0.15], [sR, -hubH * 0.15], [sR, hubH * 0.15], ...ogivePoints(sR, sR * 2.4, hubH * 0.15, 12)], SEG), matOf(mats, "machined"), { order: 0.8, dir: v3(0, 0, s), dist: hubH * U * 6, kind: "shell", edges: true });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Heavy-lift round frame (geom.frameStyle "round", a folding hexacopter): two round carbon centre plates of the
// record's diameter, the folding-arm clamps between them on the arm lines, aluminium standoffs between the
// clamps, and the arm-clamp bolts. Local y = 0 is the bottom plate's underside, as for every frame.
// ---------------------------------------------------------------------------------------------------------

const ROUND_HOLE_R = 0.13; // centre wiring hole / plate radius
const ROUND_SLOT_R = 0.62; // lightening slots' radius / plate radius
const CLAMP_L_SHARE = 0.3; // arm clamp length / plate radius
const RETRACT_DEG = 78; // how far the gear legs swing up in flight (shape only)

// Points turned by `ang` about the origin and moved to (cx, cz): a slot or a pad on a radial line.
const turnPts = (pts, ang, cx = 0, cz = 0) => pts.map(([x, z]) => [cx + x * Math.cos(ang) - z * Math.sin(ang), cz + x * Math.sin(ang) + z * Math.cos(ang)]);

function buildRoundFrame(spec, mats) {
  const g = spec.geom;
  const d = (m) => m * g.viewK;
  const R = d(g.bodyW_m) / 2;
  const bot = d(g.botPlateThick_m);
  const top = d(g.topPlateThick_m);
  const so = d(g.standoffH_m);
  const tR = d(g.tubeR_m);
  const tY = bot + d(g.tubeY_m);
  const angles = g.armAngles ?? [];
  const n = angles.length || 6;
  const U = SCALE;
  const out = [];
  const push = (geo, mat, o) => {
    const pc = piece(geo, matOf(mats, mat), o);
    out.push(pc);
    return pc;
  };
  // Plate: a disc with the wiring hole, three lightening slots a bay and the clamp bolt holes on each arm line.
  const boltR = [0.78, 0.94].map((k) => k * R);
  const holes = [circle2(0, 0, R * ROUND_HOLE_R, 24)];
  const bolts = [];
  angles.forEach((a) => {
    const mid = a + Math.PI / n;
    for (let k = -1; k <= 1; k++) holes.push(turnPts(slot2(0, 0, R * 0.2, R * 0.07), mid + Math.PI / 2, Math.cos(mid + (k * Math.PI) / (n * 2.6)) * R * ROUND_SLOT_R, Math.sin(mid + (k * Math.PI) / (n * 2.6)) * R * ROUND_SLOT_R));
    for (const r of boltR) for (const s of [-1, 1]) {
      const [x, z] = turnPts([[r, s * tR * 1.45]], a)[0];
      holes.push(circle2(x, z, tR * 0.18, 8));
      bolts.push([x, z]);
    }
  });
  const disc = circle2(0, 0, R, 120);
  const botPc = push(projectUV(plateXZ(disc, holes, bot, 0, bot * 0.2)), "composite", { order: 0, dir: DOWN, dist: so * U * 2, kind: "shell", side: DS });
  addDetail(botPc, "bolt", bolts.flatMap(([x, z]) => boltCircle(0, 0, 1, tR * 0.5, { face: "down", cx: x, cz: z, h: tR * 0.18 })), { color: 0x1d1f24 });
  const topPc = push(projectUV(plateXZ(disc, holes, top, bot + so, top * 0.2)), "composite", { order: 10, dir: UP, dist: so * U * 2.4, kind: "shell", side: DS });
  addDetail(topPc, "bolt", bolts.flatMap(([x, z]) => boltCircle(0, bot + so + top, 1, tR * 0.5, { cx: x, cz: z, h: tR * 0.18 })), { color: 0x1d1f24 });
  // Folding clamps: an anodised block between the plates on each arm line, with the socket the tube runs into.
  const cl = R * CLAMP_L_SHARE;
  const clamp = projectUV(merge([box(cl, so * 0.96, tR * 3.3, R - cl * 0.42, bot + so / 2, 0), bar(tR * 1.32, cl * 0.35, "x", R + cl * 0.02, tY, 0, 18)]));
  angles.forEach((a, i) => push(clamp.clone(), "bell", { ry: -a, order: 2 + i * 0.1, dir: radial(a, 0.2), dist: R * U * 0.35, kind: "detail", edges: true }));
  // Standoffs between the clamps, and a power board in the middle with its lead.
  const soGeo = merge([cyl(tR * 0.42, tR * 0.42, so, 6, 0, bot)]);
  angles.forEach((a, i) => {
    const mid = a + Math.PI / n;
    push(soGeo.clone(), "pump", { x: Math.cos(mid) * R * 0.86, z: Math.sin(mid) * R * 0.86, order: 1 + i * 0.05, dir: radial(mid, 0.3), dist: so * U * 1.5, kind: "detail", edges: true });
  });
  push(plateXZ(circle2(0, 0, R * 0.42, 40), [circle2(0, 0, R * 0.1, 16)], bot * 0.8, bot + so * 0.08), "pcbBlack", { order: 3, dir: UP, dist: so * U, kind: "interior" });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// drone-arm, round-tube style: a carbon tube from its folding hinge out to a clamp-on motor mount, rising by
// the record's dihedral, with the ESC zip-tied under it and the phase wires along it. The motor itself is the
// shared motorKit, centred on its axis so its rotor can spin.
// ---------------------------------------------------------------------------------------------------------

function buildTubeArm(spec, mats) {
  const g = spec.geom;
  const d = (m) => m * g.viewK;
  const a = g.armAngle ?? 0;
  const ry = -a;
  const armR = d(g.armR_m);
  const tR = d(g.tubeR_m);
  const tY = d(g.tubeY_m);
  const len = d(g.armLen_m);
  const plateR = d(g.plateR_m ?? g.armR_m * 0.35);
  const rise = len * Math.sin((g.dihedral_deg ?? 0) * DEG);
  const yTop = d(g.motorBaseY_m);
  const mountT = d(g.mountT_m ?? g.tubeR_m * 0.35);
  const U = SCALE;
  const motor = motorKit(g, d);
  const out = [];
  const push = (geo, mat, o) => {
    const pc = piece(geo, matOf(mats, mat), { ry, ...o });
    out.push(pc);
    return pc;
  };
  const r0 = plateR * 0.72;
  const rEnd = armR + motor.R * 0.55;
  const yAt = (r) => tY + rise * clamp((r - (armR - len)) / len, 0, 1);
  const out0 = { dir: radial(a, -0.1), dist: armR * U * 0.3 };
  // 1. The tube.
  push(projectUV(rod(v3(r0, yAt(r0), 0), v3(rEnd, yAt(rEnd), 0), tR, 18)), "composite", { order: 0, ...out0, kind: "shell", side: DS });
  push(bar(tR * 1.03, tR * 0.5, "x", rEnd, yAt(rEnd), 0, 16), "rubber", { order: 0.1, ...out0, kind: "detail" });
  // 2. The folding hinge just outside the plates: knuckle, pin and lock collar.
  const rh = plateR * 1.12;
  push(merge([box(tR * 1.8, tR * 2.7, tR * 2.6, rh, yAt(rh), 0), bar(tR * 0.32, tR * 3.1, "z", rh, yAt(rh), 0, 10), bar(tR * 1.18, tR * 0.9, "x", rh + tR * 1.6, yAt(rh + tR * 1.6), 0, 18)]), "bell", { order: 0.3, ...out0, kind: "detail", edges: true });
  push(bar(tR * 0.38, tR * 0.3, "z", rh, yAt(rh), tR * 1.6, 10), "machined", { order: 0.31, ...out0, kind: "detail" });
  // 3. The motor mount: a clamp round the tube and the round plate the motor bolts to.
  const yc = yAt(armR);
  const cb = yc - tR * 1.15;
  const ct = yTop - mountT;
  const mount = push(merge([box(tR * 3, ct - cb, tR * 2.7, armR - motor.R * 0.1, (cb + ct) / 2, 0), cyl(motor.R * 1.18, motor.R * 1.18, mountT, 28, armR, ct)]), "bell", { order: 0.5, ...out0, kind: "detail", edges: true });
  addDetail(mount, "bolt", boltCircle(motor.mc, ct, 4, motor.mc * 0.3, { face: "down", cx: armR, h: motor.mc * 0.12 }), { color: 0x1d1f24 });
  // 4. The motor.
  for (const m of motor) {
    const pc = piece(m.geo, matOf(mats, m.mat), { x: Math.cos(a) * armR, z: Math.sin(a) * armR, y: yTop, ry, order: 1 + (m.order ?? 0), dir: m.dir ?? UP, dist: (m.dist ?? motor.H) * U, kind: m.kind, edges: m.edges });
    if (m.bolts) addDetail(pc, "bolt", m.bolts, { color: 0x24262b });
    if (m.spin) pc.mesh.userData.spin = true;
    out.push(pc);
  }
  // 5. The ESC under the tube, in its black shrink, held by two zip ties, and its wires: three phases out to
  // the motor, the power pair in to the centre.
  const rm = lerp(rh, armR, 0.32);
  const eL = len * 0.17;
  const eH = tR * 1.2;
  const eW = tR * 1.9;
  const yE = yAt(rm) - tR - eH / 2 - tR * 0.05;
  push(merge([box(eL, eH, eW, rm, yE, 0)]), "wrap", { order: 2, dir: DOWN, dist: tR * U * 4, kind: "detail", edges: true });
  push(box(eL * 0.5, eH * 0.02, eW * 0.7, rm, yE - eH / 2 - eH * 0.01, 0), "label", { order: 2.05, dir: DOWN, dist: tR * U * 4, kind: "detail" });
  push(merge([-0.3, 0.3].map((k) => plateYZ(rrect2(yE + tR * 0.6, 0, eH + tR * 2.6, eW * 1.12, tR * 0.4, 3), [rrect2(yE + tR * 0.6, 0, eH + tR * 2.3, eW * 1.02, tR * 0.3, 3)], tR * 0.35, rm + k * eL))), "rubber", { order: 2.1, dir: DOWN, dist: tR * U * 4.2, kind: "detail" });
  const wr = tR * 0.17;
  const wires = [];
  for (let i = 0; i < MOTOR_WIRES; i++) {
    const s = (i - 1) * wr * 2.3;
    wires.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([v3(armR - motor.R * 0.7, yTop + motor.baseH * 0.4, s), v3(armR - motor.R * 1.4, yc - tR * 0.9, s), v3(rm + eL / 2, yE, s)]), 14, wr, 6, false));
  }
  push(merge(wires), "silicone", { order: 2.2, dir: DOWN, dist: tR * U * 3, kind: "detail" });
  const lead = (s) => new THREE.CatmullRomCurve3([v3(rm - eL / 2, yE, s * wr * 1.6), v3(lerp(rm - eL / 2, r0, 0.5), yAt(r0) - tR * 1.1, s * wr * 1.6), v3(r0, yAt(r0) - tR * 0.8, s * wr * 1.6)]);
  push(new THREE.TubeGeometry(lead(-1), 12, wr * 1.3, 6, false), "silicone", { order: 2.3, dir: DOWN, dist: tR * U * 3, kind: "detail" });
  push(new THREE.TubeGeometry(lead(1), 12, wr * 1.3, 6, false), "siliconeRed", { order: 2.31, dir: DOWN, dist: tR * U * 3, kind: "detail" });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// drone-duct — a ducted frame's moulded guard: one ring round each propeller, with a rounded inlet lip, outer
// ribs, and webs tying each ring to its neighbours. Sizes are visual ratios of the propeller (droneLayout.js
// DUCT_*): the maker publishes no duct dimensions.
// ---------------------------------------------------------------------------------------------------------

function buildDuct(spec, mats) {
  const g = spec.geom;
  const d = (m) => m * g.viewK;
  const armR = d(g.armR_m);
  const rI = d(g.ductR_m);
  const w = d(g.wall_m);
  const D = d(g.depth_m);
  const propY = d(g.propY_m);
  const y0 = Math.max(0, propY - D * 0.6);
  const y1 = y0 + D;
  const rO = rI + w;
  const U = SCALE;
  const out = [];
  const angles = g.armAngles ?? [];
  const n = angles.length || 4;
  // The ring's section: a straight inner wall, a bellmouth inlet rolling over the top and out, a thin outer wall.
  const lip = [];
  for (let i = 0; i <= 8; i++) {
    const t = (i / 8) * Math.PI;
    lip.push([rI + w * 0.55 - Math.cos(t) * w * 0.85, y1 - w * 0.75 + Math.sin(t) * w * 0.75]);
  }
  const sect = [[rI, y0 + w * 0.4], [rI + w * 0.25, y0], [rO, y0], [rO, y1 - w * 0.75], ...lip.reverse().map(([r, y]) => [r, y]), [rI, y1 - w * 1.3], [rI, y0 + w * 0.4]];
  const ring = latheUV(lathe(sect, 64), { H: D, R: rO, y0 });
  // Six ribs round the outside, and the two mounting tabs down onto the arm.
  const ribs = [];
  for (let k = 0; k < 8; k++) {
    const ph = (k / 8) * TAU + Math.PI / 8;
    ribs.push(box(w * 1.2, D * 0.82, w * 0.55, 0, y0 + D * 0.45, 0).rotateY(-ph).translate(Math.cos(ph) * (rO + w * 0.3), 0, Math.sin(ph) * (rO + w * 0.3)));
  }
  angles.forEach((a, i) => {
    const x = Math.cos(a) * armR;
    const z = Math.sin(a) * armR;
    const pc = piece(merge([ring.clone(), ...ribs.map((r) => r.clone())]), matOf(mats, "duct"), { x, z, order: i * 0.2, dir: radial(a, 0.35), dist: rO * U * 0.8, kind: "shell", side: DS });
    out.push(pc);
  });
  // Webs between neighbouring rings, and a brace from each ring in to the body: one moulding, one piece.
  const webs = [];
  angles.forEach((a, i) => {
    const b = angles[(i + 1) % n];
    const ca = v3(Math.cos(a) * armR, 0, Math.sin(a) * armR);
    const cb = v3(Math.cos(b) * armR, 0, Math.sin(b) * armR);
    const dir = cb.clone().sub(ca);
    const dist = dir.length();
    dir.normalize();
    const p0 = ca.clone().addScaledVector(dir, rI + w * 0.5);
    const p1 = cb.clone().addScaledVector(dir, -(rI + w * 0.5));
    const L = Math.max(w, p0.distanceTo(p1));
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    if (dist > 2 * rI) webs.push(box(L, D * 0.5, w * 1.1, 0, 0, 0).rotateY(-Math.atan2(dir.z, dir.x)).translate(mid.x, y0 + D * 0.3, mid.z));
    // the brace in toward the body, low, over the arm
    const inner = ca.clone().multiplyScalar((armR - rI - w * 0.5) / armR);
    const body = ca.clone().multiplyScalar((d(g.bodyW_m) * 0.42) / armR);
    const bl = Math.max(w, inner.distanceTo(body));
    const bm = inner.clone().add(body).multiplyScalar(0.5);
    webs.push(box(bl, D * 0.28, d(g.armWidth_m) * 0.9, 0, 0, 0).rotateY(-a).translate(bm.x, y0 + D * 0.14, bm.z));
  });
  out.push(piece(merge(webs), matOf(mats, "duct"), { order: n * 0.2 + 0.1, dir: UP, dist: D * U * 2, kind: "shell", side: DS }));
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// drone-gear — retractable landing gear: two legs, each from its retract unit on a rail under the plates down
// to a T and a skid tube with rubber end caps. Its y = 0 is the deck; the record's ground clearance is the
// top. Each leg carries mesh.userData.retract { pivot (scene units, part-local), axis, angle }: droneFlight.js
// swings it up after lift-off and down before touchdown.
// ---------------------------------------------------------------------------------------------------------

function buildGear(spec, mats) {
  const g = spec.geom;
  const d = (m) => m * g.viewK;
  const C = d(g.clear_m);
  const S = d(g.spread_m) / 2;
  const L = d(g.skidL_m);
  const r = d(g.tubeR_m);
  const U = SCALE;
  const out = [];
  const push = (geo, mat, o) => {
    const pc = piece(geo, matOf(mats, mat), o);
    out.push(pc);
    return pc;
  };
  const boxH = C * 0.13;
  for (const s of [-1, 1]) {
    const x = s * S;
    const k = s > 0 ? 0 : 0.5;
    // The rail under the plates and the retract unit on it.
    push(merge([box(r * 2.2, r * 1.1, L * 0.5, x, C - r * 0.55, 0)]), "composite", { order: 0 + k, dir: v3(s, 0.3, 0), dist: S * U * 0.4, kind: "detail", edges: true });
    push(merge([box(r * 3.2, boxH, r * 5.2, x, C - r * 1.1 - boxH / 2, 0), bar(r * 0.55, r * 3.6, "x", x, C - r * 1.1 - boxH * 0.62, 0, 12)]), "bell", { order: 0.1 + k, dir: v3(s, 0, 0), dist: S * U * 0.5, kind: "detail", edges: true });
    const yp = C - r * 1.1 - boxH * 0.62;
    const fx = x + s * C * 0.1;
    const legGeo = merge([rod(v3(x, yp, 0), v3(fx, r * 2.6, 0), r, 14), bar(r * 1.3, r * 3.2, "z", fx, r * 2.0, 0, 14), bar(r, L, "z", fx, r, 0, 16)]);
    const retract = { pivot: [x * U, yp * U, 0], axis: [0, 0, 1], angle: s * RETRACT_DEG * DEG };
    const leg = push(projectUV(legGeo), "composite", { order: 1 + k, dir: v3(s, -0.4, 0), dist: S * U * 0.6, kind: "shell", side: DS });
    leg.mesh.userData.retract = retract;
    const caps = push(merge([-1, 1].map((sz) => bar(r * 1.12, r * 1.6, "z", fx, r, sz * (L / 2 + r * 0.4), 14))), "rubber", { order: 1.2 + k, dir: v3(s, -0.4, 0), dist: S * U * 0.65, kind: "detail" });
    caps.mesh.userData.retract = retract;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// drone-boom — a quadplane's lift boom: the carbon tube (square or round, the record's section and length)
// fore and aft under the wing, the printed mounts that hold it to the wing, a printed motor mount at each end
// and the lift motors on them. Local y = 0 is the boom's underside.
// ---------------------------------------------------------------------------------------------------------

function buildBoom(spec, mats) {
  const g = spec.geom;
  const d = (m) => m * g.viewK;
  const x = d(g.x_m);
  const zC = d(g.zC_m);
  const L = d(g.len_m);
  const W = d(g.secW_m);
  const H = d(g.secH_m);
  const gap = d(g.wingGap_m ?? 0);
  const U = SCALE;
  const out = [];
  const motor = motorKit(g, d);
  const s = Math.sign(x) || 1;
  const push = (geo, mat, o) => {
    const pc = piece(geo, matOf(mats, mat), o);
    out.push(pc);
    return pc;
  };
  const od = { dir: v3(s, -0.3, 0), dist: Math.abs(x) * U * 0.25 + H * U * 4 };
  // 1. The tube.
  push(projectUV(g.round ? bar(W / 2, L, "z", x, H / 2, zC, 16) : box(W, H, L, x, H / 2, zC)), "composite", { order: 0, ...od, kind: "shell", side: DS });
  // 2. Two mounts up into the wing's underside, at the wing's spar stations; on a twin-boom airframe a nacelle
  // fairs the boom into the wing.
  const mz = (g.mountZ_m ?? [g.zC_m + g.len_m * 0.12, g.zC_m - g.len_m * 0.12]).map(d);
  push(merge(mz.map((z) => box(W * 2.4, H * 1.5 + gap * 0.3, W * 3.2, x, H * 0.75 + gap * 0.15, z))), "trim", { order: 0.2, ...od, kind: "detail", edges: true });
  if (g.nacelle) {
    const nz0 = Math.min(...mz) - W * 3;
    const nz1 = Math.max(...mz) + W * 5;
    const nr = W * 1.5;
    const prof = [[0, 0], ...domePoints(nr, (nz1 - nz0) * 0.3, false, 6).map(([r, y]) => [r, y + (nz1 - nz0) * 0.3]).slice(1), [nr, (nz1 - nz0) * 0.7], ...ogivePoints(nr, (nz1 - nz0) * 0.3, (nz1 - nz0) * 0.7, 8)];
    push(projectUV(toZ(latheUV(lathe(prof, 24), { H: nz1 - nz0, R: nr })).translate(x, H / 2 + nr * 0.25, nz0)), "body", { order: 0.25, ...od, kind: "shell", side: DS });
  }
  // 3. Motor mounts and motors at the ends.
  for (const [i, zr] of (g.motorZ_m ?? []).entries()) {
    const z = d(zr);
    const R = motor.R;
    push(merge([box(W * 2.3, H * 1.6, R * 2.0, x, H * 0.5, z), cyl(R * 1.1, R * 1.1, H * 0.35, 24, x, H, z)]), "trim", { order: 0.4 + i * 0.1, ...od, kind: "detail", edges: true });
    for (const m of motor) {
      const pc = piece(m.geo, matOf(mats, m.mat), { x, z, y: H + H * 0.35, order: 1 + i * 0.5 + (m.order ?? 0) * 0.4, dir: m.dir ?? UP, dist: (m.dist ?? motor.H) * U, kind: m.kind, edges: m.edges });
      if (m.bolts) addDetail(pc, "bolt", m.bolts, { color: 0x24262b });
      if (m.spin) pc.mesh.userData.spin = true;
      out.push(pc);
    }
    // the phase wires along the boom's underside toward the wing
    const wr = H * 0.09;
    const wires = [];
    for (let k = 0; k < MOTOR_WIRES; k++) {
      const off = (k - 1) * wr * 2.2;
      wires.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([v3(x + off, H + H * 0.35 + motor.baseH * 0.3, z - Math.sign(z - zC) * R * 0.7), v3(x + off, -wr, z - Math.sign(z - zC) * R * 1.6), v3(x + off, -wr, zC + Math.sign(z - zC) * L * 0.14)]), 12, wr, 5, false));
    }
    push(merge(wires), "silicone", { order: 2 + i * 0.1, ...od, kind: "detail" });
  }
  // End caps.
  push(merge([-1, 1].map((k) => (g.round ? bar(W * 0.52, H * 0.4, "z", x, H / 2, zC + k * L / 2, 14) : box(W * 1.04, H * 1.04, H * 0.4, x, H / 2, zC + k * L / 2)))), "rubber", { order: 3, ...od, kind: "detail" });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// A quadplane's printed pod fuselage (geom.style "pod"): a smooth body of revolution, rounded nose, widest at
// the wing, tapering to a slim tail cone whose end face carries a pusher motor (or closed, for a tractor). It
// stands on two printed main skids under the wing and, with a pusher, a ventral fin tip at the tail long
// enough to keep the propeller's disc off the deck. Body along +Z, nose at +Z, axis at y = fuseR.
// ---------------------------------------------------------------------------------------------------------

const POD_FLAT = 0.9; // fuselage width / height (shape only)

function buildPodFuselage(spec, mats) {
  const g = spec.geom;
  const d = (m) => m * g.viewK;
  const L = d(g.fuseL_m);
  const R = d(g.fuseR_m);
  const tR = d(g.tailR_m);
  const amp = g.printed === false ? 0 : d(PRINT_BAND_AMP_M); // no layer lines on a moulded (foam) airframe
  const band = d(PRINT_BAND_M) * (g.printed === false ? 6 : 1); // fewer, smooth stations on a moulded skin
  const drop = d(g.skidDrop_m ?? 0);
  const U = SCALE;
  const out = [];
  const push = (geo, mat, o) => {
    const pc = piece(geo, matOf(mats, skinOf(g, mat)), o);
    out.push(pc);
    return pc;
  };
  // Stations run from the tail end (y = 0 of the lathe) to the nose (y = len); toBody turns them onto +Z.
  const zTail = g.pusher ? d(g.faceZ_m) : L / 2 - d(g.podL_m ?? g.fuseL_m);
  const len = L / 2 - zTail;
  const toBody = (geo) => toZ(geo.scale(POD_FLAT, 1, 1)).translate(0, R, zTail);
  const rEnd = g.pusher ? Math.max(tR * 1.1, d(g.cMotorR_m ?? g.tailR_m) * 0.95) : tR * 0.5;
  const tMax = 0.55; // share of the length, from the tail, where it reaches full width
  const tNose = 0.86;
  const rOf = (t) => (t < tMax ? lerp(rEnd, R, Math.pow(smoothstep(t / tMax), 0.75)) : t < tNose ? R : R * Math.sqrt(Math.max(0.02, 1 - ((t - tNose) / (1 - tNose)) ** 2)));
  const seg = (t0, t1, phi0, phiLen) => {
    const pts = printBands((t1 - t0) * len, band).map(({ s, off }) => {
      const t = lerp(t0, t1, s);
      return [rOf(t) + off * amp * (t < 0.995 ? 1 : 0), t * len];
    });
    if (t1 >= 0.999) pts.push([0, len]);
    if (t0 <= 0.001) pts.unshift([0, 0]);
    return toBody(latheOf(pts, 32, phi0, phiLen));
  };
  const tHatch0 = 0.6;
  const tHatch1 = 0.84;
  push(seg(0, 0.32), "body", { order: 0, dir: v3(0, 0, -1), dist: L * U * 0.12, kind: "shell", side: DS });
  push(seg(0.32, tHatch0), "body", { order: 1, dir: DOWN, dist: R * U * 1.2, kind: "shell", side: DS });
  push(seg(tHatch0, tHatch1, Math.PI * 0.2, Math.PI * 1.6), "body", { order: 2, dir: DOWN, dist: R * U * 1.4, kind: "shell", side: DS });
  push(seg(tHatch0, tHatch1, Math.PI * 1.8, Math.PI * 0.4), "body", {
    order: 3,
    dir: UP,
    dist: R * U * 2.6,
    kind: "shell",
    side: DS,
    deploy: { axis: v3(1, 0, 0), pivot: v3(0, R * 2, zTail + tHatch0 * len), angle: -50 * DEG, order: 0 },
  });
  push(seg(tHatch1, 1), "body", { order: 4, dir: v3(0, 0, 1), dist: L * U * 0.14, kind: "shell", side: DS });
  // Seams between the printed sections, and the nose's camera window.
  push(merge([0.32, tHatch0, tHatch1].map((t) => toBody(machinedRing(rOf(t) * 0.99, rOf(t) * 1.012, L * 0.004, t * len, 28)))), "trim", { order: 4.5, dir: UP, dist: R * U, kind: "detail" });
  const zn = zTail + 0.965 * len;
  push(toZ(latheUV(lathe(domePoints(R * 0.2, R * 0.12, true, 6), 20), { H: R * 0.12, R: R * 0.2 })).translate(0, R, zn), "glass", { order: 4.6, dir: v3(0, 0, 1), dist: L * U * 0.16, kind: "detail", edges: true });
  // Inside: formers, the spar sockets at the wing and the keel the battery rides on.
  const zw = d(g.wingZ_m ?? 0);
  const former = (z, r) => plateXY(circle2(0, R, r * 0.95, 24).map(([x, y]) => [x * POD_FLAT, y]), [circle2(0, R, r * 0.45, 14)], L * 0.008, z);
  push(merge([0.3, 0.45, tHatch0, tHatch1].map((t) => former(zTail + t * len, rOf(t)))), "trim", { order: 5, dir: UP, dist: R * U, kind: "interior" });
  push(merge([-1, 1].map((k) => bar(R * 0.1, R * 2.2, "x", 0, R * 1.5, zw + k * d(g.rootChord_m ?? 0.2) * 0.2, 12))), "composite", { order: 5.2, dir: UP, dist: R * U * 1.2, kind: "interior" });
  push(plateXZ(rrect2(0, zTail + (tHatch0 + 0.02) * len + (tHatch1 - tHatch0) * len * 0.5, R * 1.1, (tHatch1 - tHatch0) * len * 1.1, R * 0.1), null, L * 0.005, R * 0.35), "trim", { order: 5.4, dir: DOWN, dist: R * U, kind: "interior" });
  // Landing legs under the booms (geom.gear "legs"): a moulded strut from each boom down to a rubber foot.
  const zs = d(g.skidZ_m ?? 0);
  if (g.gear === "legs") {
    const gx = d(g.gearX_m ?? 0);
    const top = d(g.gearTopY_m ?? 0);
    for (const s of [-1, 1]) {
      const k = s > 0 ? 0 : 0.2;
      const a = v3(s * gx, top + R * 0.05, zs);
      const b = v3(s * (gx + R * 0.15), -drop + R * 0.12, zs - R * 0.1);
      push(projectUV(merge([rod(a, b, R * 0.12, 12), box(R * 0.5, R * 0.18, R * 0.7, s * gx, top - R * 0.02, zs)])), "body", { order: 6 + k, dir: v3(s, -1, 0), dist: R * U * 2, kind: "shell", side: DS });
      push(solid([[0, 0], [R * 0.2, 0], [R * 0.2, R * 0.1], [R * 0.12, R * 0.16], [0, R * 0.16]], 14).translate(b.x, -drop, b.z), "rubber", { order: 6.1 + k, dir: v3(s, -1, 0), dist: R * U * 2.1, kind: "detail" });
    }
  }
  // The main skids: a printed blade each side from the belly, out and down to a foot on the deck.
  for (const s of g.gear === "legs" ? [] : [-1, 1]) {
    const k = s > 0 ? 0 : 0.2;
    const a = v3(s * R * 0.42, R * 0.18, zs);
    const c = v3(s * R * 1.0, -drop * 0.35, zs - R * 0.15);
    const b = v3(s * (R * 1.15 + drop * 0.42), -drop + R * 0.09, zs - R * 0.3);
    const curve = new THREE.QuadraticBezierCurve3(a, c, b);
    const blade = new THREE.TubeGeometry(curve, 16, R * 0.11, 10, false).scale(1, 1, 1);
    push(projectUV(merge([blade, solid([[0, 0], [R * 0.13, 0], [R * 0.13, R * 0.5], [0, R * 0.55]], 12).rotateX(Math.PI / 2).translate(b.x, b.y, b.z - R * 0.25)])), "trim", { order: 6 + k, dir: v3(s, -1, 0), dist: R * U * 2, kind: "shell", side: DS });
    push(bar(R * 0.13, R * 0.12, "z", b.x, b.y, b.z + R * 0.3, 12), "rubber", { order: 6.1 + k, dir: v3(s, -1, 0), dist: R * U * 2.1, kind: "detail" });
  }
  // The ventral fin tip under the tail cone, down to the deck: the third leg when the propeller is a pusher.
  if (g.finTip) {
    const zf = d(g.finTipZ_m ?? zTail + len * 0.1);
    const t = (zf - zTail) / len;
    const yTop = R - rOf(clamp(t, 0, 1)) * 0.8;
    const yBot = -drop + R * 0.04;
    const c = rOf(clamp(t, 0, 1)) * 3.2;
    const sec = airfoilPoints(naca4(null), 9);
    const ringAt = (y, cc) => sec.map(([f, yc, yt, side]) => v3((yc + side * yt) * cc, y, zf + (0.5 - f) * cc - (yTop - y) * 0.35));
    push(loft([ringAt(yTop + R * 0.1, c), ringAt((yTop + yBot) / 2, c * 0.85), ringAt(yBot, c * 0.6)]), "body", { order: 7, dir: DOWN, dist: R * U * 2, kind: "shell", side: DS });
    push(bar(c * 0.12, c * 0.4, "z", 0, yBot + c * 0.06, zf - (yTop - yBot) * 0.35, 10), "tpu", { order: 7.1, dir: DOWN, dist: R * U * 2.2, kind: "detail" });
  }
  return out;
}
const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// ---------------------------------------------------------------------------------------------------------
// V-tail / inverted V-tail (geom.tailType): two tapered panels at the record-type's angle, each with its
// ruddervator on a hinge, ribs inside, and the fairing they plug into on the tail cone.
// ---------------------------------------------------------------------------------------------------------

function buildVTail(spec, mats) {
  const g = spec.geom;
  const d = (m) => m * g.viewK;
  const span = d(g.span_m);
  const c0 = d(g.chord_m);
  const zT = d(g.zT_m);
  const tR = d(g.tailR_m);
  const amp = g.printed === false ? 0 : d(PRINT_BAND_AMP_M); // no layer lines on a moulded (foam) airframe
  const band = d(PRINT_BAND_M) * (g.printed === false ? 6 : 1); // fewer, smooth stations on a moulded skin
  const inv = g.tailType === "inverted-v";
  const ang = (g.vdih_deg ?? 35) * DEG * (inv ? -1 : 1);
  const half = span / 2 / Math.cos(Math.abs(ang)); // panel length along its own span
  const sec = airfoilPoints(naca4(null), 11);
  const cut = 1 - WING_ELEVON_CHORD - 0.08;
  const U = SCALE;
  const out = [];
  const push = (geo, mat, o) => {
    const pc = piece(geo, matOf(mats, skinOf(g, mat)), o);
    out.push(pc);
    return pc;
  };
  const taper = (p) => lerp(1, 0.55, p);
  const sweepZ = (p) => -p * c0 * 0.45; // the panels sweep back toward the tip
  // A section ring at distance r along the panel (authored flat along +X), then turned up by the V angle.
  const ringAt = (r, crop, k, shrink = 1) => {
    const p = r / half;
    const c = c0 * taper(p) * k;
    return (crop ? cropSection(sec, crop[0], crop[1]) : sec).map(([f, yc, yt, side]) => v3(r, (yc + side * yt * shrink) * c, zT + (0.5 - f) * c + sweepZ(p)));
  };
  for (const s of [-1, 1]) {
    const k = s > 0 ? 0 : 0.3;
    const turn = (geo) => geo.rotateZ(ang).scale(s, 1, 1);
    const r0 = tR * 0.6;
    const rl = printBands(half - r0, band).map(({ s: p, off }) => ringAt(lerp(r0, half, p), [0, cut], 1).map((v) => v.setY(v.y + off * amp)));
    rl.push(ringAt(half, [0, cut], 0.85, 0.2));
    const skin = loft(rl);
    if (s < 0) flipTris(skin);
    push(turn(skin), "body", { order: 1 + k, dir: v3(s * Math.cos(ang), Math.sin(ang), 0), dist: span * U * 0.18, kind: "shell", side: DS });
    const rv = [0.04, 0.5, 0.97].map((p) => ringAt(lerp(r0, half, p), [cut + 0.015, 1], 1));
    const rud = loft(rv);
    if (s < 0) flipTris(rud);
    const hinge = v3(Math.cos(ang) * s, Math.sin(ang), 0);
    push(turn(rud), "body", {
      order: 2 + k,
      dir: v3(s * 0.3, 0, -1),
      dist: c0 * U * 1.2,
      kind: "shell",
      side: DS,
      deploy: { axis: hinge, pivot: v3(0, 0, zT + (0.5 - cut) * c0), angle: s * DEPLOY_DEG * DEG, order: s > 0 ? 0 : 1 },
    });
    const ribs = [];
    for (let i = 0; i < 4; i++) {
      const r = lerp(r0 * 1.5, half * 0.92, (i + 0.5) / 4);
      const t = c0 * 0.012;
      ribs.push(loft([ringAt(r - t, [0, cut], 0.95), ringAt(r + t, [0, cut], 0.95)]));
    }
    push(turn(merge(ribs)), "trim", { order: 3 + k, dir: v3(s, 0.3, 0), dist: span * U * 0.1, kind: "interior" });
    // the servo horn and pushrod on the panel's underside
    const hp = v3(half * 0.25, -c0 * 0.06, zT - c0 * 0.25);
    push(turn(merge([box(c0 * 0.05, c0 * 0.14, c0 * 0.07, hp.x, hp.y, hp.z), rod(hp, v3(r0, -c0 * 0.05, zT + c0 * 1.1), c0 * 0.008, 4)])), "darkMetal", { order: 4 + k, dir: DOWN, dist: c0 * U, kind: "detail" });
  }
  // The root fairing on the tail cone the two spars plug into.
  push(merge([bar(tR * 1.15, c0 * 0.9, "z", 0, 0, zT, 18)]), "body", { order: 0, dir: v3(0, 0, -1), dist: c0 * U * 0.8, kind: "shell", side: DS });
  return out;
}
// ---------------------------------------------------------------------------------------------------------
// H-tail (geom.tailType "h", a twin-boom airframe): a stabiliser between the two booms' ends with its elevator,
// and a fin on each boom end reaching up above it and down to the deck, where its foot is the rear leg.
// Local y = 0 is the boom axis.
// ---------------------------------------------------------------------------------------------------------

function buildHTail(spec, mats) {
  const g = spec.geom;
  const d = (m) => m * g.viewK;
  const half = d(g.span_m) / 2;
  const c0 = d(g.chord_m);
  const zT = d(g.zT_m);
  const up = d(g.finH_m);
  const down = d(g.finDown_m);
  const bR = d(g.boomR_m ?? g.chord_m * 0.05);
  const amp = g.printed === false ? 0 : d(PRINT_BAND_AMP_M); // no layer lines on a moulded (foam) airframe
  const band = d(PRINT_BAND_M) * (g.printed === false ? 6 : 1); // fewer, smooth stations on a moulded skin
  const sec = airfoilPoints(naca4(null), 11);
  const cut = 1 - WING_ELEVON_CHORD - 0.04;
  const U = SCALE;
  const out = [];
  const push = (geo, mat, o) => {
    const pc = piece(geo, matOf(mats, skinOf(g, mat)), o);
    out.push(pc);
    return pc;
  };
  const hRing = (x, crop, c) => (crop ? cropSection(sec, crop[0], crop[1]) : sec).map(([f, yc, yt, side]) => v3(x, (yc + side * yt) * c, zT + (0.5 - f) * c));
  // 1. Stabiliser, 2. elevator on its hinge.
  const rl = printBands(half * 2, band).map(({ s: p, off }) => hRing(lerp(-half + bR, half - bR, p), [0, cut], c0).map((v) => v.setY(v.y + off * amp)));
  push(loft(rl), "body", { order: 0, dir: v3(0, 0, -1), dist: c0 * U, kind: "shell", side: DS });
  push(loft([hRing(-half + bR * 1.5, [cut + 0.015, 1], c0), hRing(half - bR * 1.5, [cut + 0.015, 1], c0)]), "body", {
    order: 1,
    dir: v3(0, 0.3, -1),
    dist: c0 * U * 1.4,
    kind: "shell",
    side: DS,
    deploy: { axis: v3(1, 0, 0), pivot: v3(0, 0, zT + (0.5 - cut) * c0), angle: DEPLOY_DEG * DEG, order: 0 },
  });
  // 3–4. The fins: a tapered aerofoil plate on each boom end, swept, its foot a TPU skid on the deck.
  const fc = c0 * 0.95;
  const fRing = (x, y, c, dz) => sec.map(([f, yc, yt, side]) => v3(x + (yc + side * yt) * c, y, zT + (0.5 - f) * c + dz));
  for (const s of [-1, 1]) {
    const x = s * half;
    const k = s > 0 ? 0 : 0.2;
    const rings = printBands(up + down, band).map(({ s: p, off }) => {
      const y = lerp(-down + bR * 0.3, up, p);
      const t = y > 0 ? y / up : -y / down;
      const c = fc * (y > 0 ? lerp(1, 0.62, t) : lerp(1, 0.7, t));
      return fRing(x, y, c, y > 0 ? -t * fc * 0.35 : -t * fc * 0.1).map((v) => v.setX(v.x + off * amp * s));
    });
    push(loft(rings), "body", { order: 2 + k, dir: v3(s, 0, -0.3), dist: half * U * 0.5, kind: "shell", side: DS });
    push(bar(bR * 1.5, fc * 0.5, "z", x, -down + bR * 0.9, zT - fc * 0.05, 12), "tpu", { order: 2.1 + k, dir: v3(s, -0.5, 0), dist: half * U * 0.5, kind: "detail" });
    // the boom-end socket the fin and stabiliser plug onto
    push(bar(bR * 1.35, fc * 0.6, "z", x, 0, zT + fc * 0.05, 14), "darkMetal", { order: 2.2 + k, dir: v3(s, 0, 0), dist: half * U * 0.3, kind: "detail", edges: true });
  }
  return out;
}
// Mirroring a loft in X turns its triangles inside out: swap two corners of each.
function flipTris(geo) {
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) [p[i + 3 + k], p[i + 6 + k]] = [p[i + 6 + k], p[i + 3 + k]];
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------------------------------------
// Electronics extras: a GPS on a folding mast (long-range and heavier builds), and the video system's own
// camera in the nose when the build carries no camera payload. Both live in the electronics weight.
// ---------------------------------------------------------------------------------------------------------

const GPS_MAST_PER_WB = 0.17; // mast height / wheelbase
const GPS_PUCK_PER_WB = 0.06; // puck diameter / wheelbase
function electronicsExtras(g, d, mats, push) {
  const U = SCALE;
  const wb = d(g.wheelbase_m ?? 0.225);
  const top = d(g.topY_m ?? g.standoffH_m);
  if (g.gps) {
    const bl = d(g.bodyL_m ?? g.wheelbase_m * 0.3);
    const zM = g.round ? -bl * 0.42 : -bl * 0.5 - wb * 0.02;
    const h = wb * GPS_MAST_PER_WB;
    const pr = (wb * GPS_PUCK_PER_WB) / 2;
    const tilt = g.round ? 0 : 0.5; // radians back on a quad's tail, upright on a hex
    const tip = v3(0, top + Math.cos(tilt) * h, zM - Math.sin(tilt) * h);
    push(merge([rod(v3(0, top, zM), tip, pr * 0.1, 8), box(pr * 0.5, pr * 0.35, pr * 0.5, 0, top + pr * 0.17, zM)]), "composite", { order: 10, dir: UP, dist: h * U * 0.8, kind: "detail", edges: true });
    push(merge([solid([[0, 0], [pr, 0], [pr, pr * 0.32], [pr * 0.8, pr * 0.55], [0, pr * 0.6]], 28).translate(tip.x, tip.y, tip.z)]), "chip", { order: 10.2, dir: UP, dist: h * U * 1.2, kind: "shell", edges: true });
    push(plateXZ(circle2(tip.x, tip.z, pr * 0.5, 4).map(([x, z]) => [x, z]), null, pr * 0.03, tip.y + pr * 0.6), "gold", { order: 10.3, dir: UP, dist: h * U * 1.3, kind: "detail" });
    push(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(v3(0, top, zM * 0.6), v3(pr * 0.3, top + h * 0.1, zM), tip.clone().add(v3(pr * 0.2, -pr * 0.2, 0))), 10, pr * 0.05, 5, false), "silicone", { order: 10.4, dir: UP, dist: h * U, kind: "detail" });
  }
  if (g.fpvCam) {
    // In the front cage, between the frame's side plates (bodyPlan / CAGE_GAP_SHARE), tipped back 25°.
    const bw = d(g.bodyW_m ?? g.wheelbase_m * 0.3);
    const W = bw * CAGE_GAP_SHARE * 0.86;
    const so = d(g.standoffH_m);
    const zF = wb * PLATE_L_SHARE * CAM_PIVOT_SHARE;
    const tilt = 25 * DEG;
    const place = (geo) => geo.rotateX(-tilt).translate(0, so * 0.55, zF);
    const lr = W * 0.3;
    push(place(projectUV(plateXY(rrect2(0, 0, W, W, W * 0.16, 5), null, W * 0.9, -W * 0.5, W * 0.04))), "bell", { order: 11, dir: v3(0, 0, 1), dist: W * U * 3, kind: "shell", side: DS });
    push(place(toZ(latheUV(lathe([[lr * 1.3, 0], [lr * 1.3, W * 0.22], [lr * 1.1, W * 0.3], [0, W * 0.3]], 24), { H: W * 0.3, R: lr * 1.3 })).translate(0, 0, W * 0.4)), "chip", { order: 11.1, dir: v3(0, 0, 1), dist: W * U * 3.4, kind: "detail", edges: true });
    push(place(toZ(latheUV(lathe(domePoints(lr * 0.9, lr * 0.3, true, 6), 24), { H: lr, R: lr })).translate(0, 0, W * 0.7)), "glass", { order: 11.2, dir: v3(0, 0, 1), dist: W * U * 3.6, kind: "detail" });
    push(place(merge([-1, 1].map((s) => bar(W * 0.14, W * 0.08, "x", s * W * 0.52, 0, 0, 12)))), "machined", { order: 11.3, dir: v3(0, 0, 1), dist: W * U * 3, kind: "detail" });
  }
}

// ---------------------------------------------------------------------------------------------------------
// drone-camera, multispectral: a five-band camera's case with its lens array facing the ground, hung on a
// damped mount under the frame (or looking forward from the nose when there is no landing gear to hang it in).
// Sizes are the payload record's L / W / H.
// ---------------------------------------------------------------------------------------------------------

function buildMultispectral(spec, mats) {
  const g = spec.geom;
  const d = (m) => m * g.viewK;
  const W = d(g.W_m);
  const H = d(g.H_m);
  const L = d(g.L_m);
  const zH = d(g.hangZ_m ?? 0);
  const U = SCALE;
  const out = [];
  // Authored lens-down, its mount's top at y = 0 (the frame's underside). Without gear it is turned to look
  // forward and set in the nose, like an FPV camera.
  const under = Boolean(g.underslung);
  const zFront = g.bodyL_m ? (d(g.bodyL_m) / CAM_BODYL_PER_WB) * PLATE_L_SHARE * 0.5 : 0;
  const fix = (geo) => (under ? geo.translate(0, 0, zH) : geo.translate(0, H * 0.75, 0).rotateX(-Math.PI / 2).translate(0, H * 0.62, zFront + H * 0.4));
  const push = (geo, mat, o) => {
    const pc = piece(fix(geo), matOf(mats, mat), o);
    out.push(pc);
    return pc;
  };
  const pt = H * 0.05;
  const dh = H * 0.12;
  const yCase = -(pt * 2 + dh); // case top
  const yBot = yCase - H;
  // Mount: top plate, four dampers, lower plate.
  push(projectUV(plateXZ(rrect2(0, 0, W * 1.25, L * 1.1, W * 0.1, 4), [circle2(0, 0, W * 0.15, 12)], pt, -pt, pt * 0.3)), "composite", { order: 0, dir: UP, dist: H * U * 0.6, kind: "detail", edges: true });
  push(merge([[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sx, sz]) => solid([[0, 0], [W * 0.07, 0], [W * 0.09, dh * 0.5], [W * 0.07, dh], [0, dh]], 14).translate(sx * W * 0.48, -pt - dh, sz * L * 0.42))), "rubber", { order: 0.2, dir: DOWN, dist: H * U * 0.6, kind: "detail" });
  push(projectUV(plateXZ(rrect2(0, 0, W * 1.2, L * 1.05, W * 0.1, 4), null, pt, yCase, pt * 0.3)), "composite", { order: 0.4, dir: DOWN, dist: H * U * 0.9, kind: "detail", edges: true });
  // The case.
  push(projectUV(plateXZ(rrect2(0, 0, W, L, W * 0.12, 5), null, H, yBot, W * 0.04)), "sensor", { order: 1, dir: DOWN, dist: H * U * 1.4, kind: "shell", side: DS });
  push(box(W * 1.004, H * 0.08, L * 0.5, 0, yBot + H * 0.7, 0), "labelWhite", { order: 1.1, dir: DOWN, dist: H * U * 1.4, kind: "detail" });
  // The lens array: six apertures, two rows of three, the panchromatic one larger.
  const lr = Math.min(W, L) * 0.1;
  const lenses = [];
  const glass = [];
  for (const sx of [-1, 1]) {
    for (const k of [-1, 0, 1]) {
      const r = sx > 0 && k === 0 ? lr * 1.3 : lr;
      const x = sx * W * 0.22;
      const z = k * L * 0.28;
      lenses.push(machinedRing(r * 1.05, r * 1.45, H * 0.07, yBot - H * 0.05, 24).translate(x, 0, z));
      glass.push(latheUV(lathe(domePoints(r * 1.02, r * 0.28, false, 6), 20), { H: r, R: r }).translate(x, yBot - H * 0.05, z));
    }
  }
  push(merge(lenses), "machined", { order: 2, dir: DOWN, dist: H * U * 1.8, kind: "detail", edges: true });
  push(merge(glass), "glass", { order: 2.1, dir: DOWN, dist: H * U * 2, kind: "detail" });
  // The data / power lead off the back up into the frame.
  push(merge([box(W * 0.3, H * 0.18, L * 0.06, 0, yBot + H * 0.55, -L * 0.53), new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(v3(0, yBot + H * 0.55, -L * 0.56), v3(0, yBot + H * 0.6, -L * 0.8), v3(0, -pt, -L * 0.6)), 10, W * 0.025, 6, false)]), "silicone", { order: 3, dir: v3(0, 0, -1), dist: L * U * 0.6, kind: "detail" });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// A Li-ion pack built from cylindrical cells (battery chemistry "Li-ion"): rows of cells under a tight
// shrink wrap whose section follows them. Cell size is the 21700 format the name gives (21 mm across, 70 mm
// long): a visual size used only to count the rows; the pack's outside is the record's L × W × H.
// ---------------------------------------------------------------------------------------------------------

const LIION_CELL_D_M = 0.021;
const LIION_CELL_L_M = 0.07;
function liionSection(W, H, nx, ny, pad, wrap) {
  const rx = W / nx / 2;
  const ry = H / ny / 2;
  const cx = (i) => -W / 2 + rx * (2 * i + 1);
  const cy = (j) => pad + ry * (2 * j + 1);
  const pts = [];
  const arc = (x, y, a0, a1, n = 6) => {
    for (let i = 0; i <= n; i++) {
      const a = lerp(a0, a1, i / n);
      pts.push([x + Math.cos(a) * (rx + wrap), y + Math.sin(a) * (ry + wrap)]);
    }
  };
  for (let i = 0; i < nx; i++) arc(cx(i), cy(0), Math.PI * (i === 0 ? 1 : 1.25), Math.PI * (i === nx - 1 ? 2 : 1.75));
  for (let j = 0; j < ny; j++) arc(cx(nx - 1), cy(j), -Math.PI * (j === 0 ? 0 : 0.25), Math.PI * (j === ny - 1 ? 0 : 0.25), 4);
  for (let i = nx - 1; i >= 0; i--) arc(cx(i), cy(ny - 1), Math.PI * (i === nx - 1 ? 0 : 0.25), Math.PI * (i === 0 ? 1 : 0.75));
  for (let j = ny - 1; j >= 0; j--) arc(cx(0), cy(j), Math.PI * (j === ny - 1 ? 1 : 0.75), Math.PI * (j === 0 ? 1 : 1.25), 4);
  // drop near-duplicates where two arcs meet
  return pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-6 * (W + H));
}

// ---------------------------------------------------------------------------------------------------------

export const DRONE_BUILDERS = {
  "drone-frame": buildFrame,
  "drone-arm": buildArm,
  "drone-propeller": buildPropeller,
  "drone-electronics": buildElectronics,
  "drone-battery": buildBattery,
  "drone-camera": buildCamera,
  "drone-fuselage": buildFuselage,
  "drone-wing": buildWing,
  "drone-tail": buildTail,
  "drone-nose-motor": buildNoseMotor,
  "drone-nose-propeller": buildNosePropeller,
  "drone-duct": buildDuct,
  "drone-gear": buildGear,
  "drone-boom": buildBoom,
};
