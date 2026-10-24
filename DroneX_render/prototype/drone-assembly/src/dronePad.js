// The drone pad: a drone's landing pad on its field, sized from the vehicle's display scale (droneLayout.js
// droneSceneBounds radius_u), plus a fixed wing's launch stand. Pure three.js; materials from parts.js so the
// pad switches looks (painted / x-ray) with the vehicle through setPropLook.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { paintProp, propMaterial, propMaterials } from "./parts.js";
import { SCALE } from "./scale.js";

const noPick = (o) => ((o.raycast = () => {}), o);

//   createDronePad({ radius_u, stand }) -> { group, ringMat: null, layout: { b, padR, plinthH }, clamps: [] }
// radius_u is the vehicle's reach from its axis (droneSceneBounds), so the pad follows the drone's display scale,
// never its true size. What it builds, all flat (nothing stands between the camera and the drone):
//   a light concrete slab (rounded square, chamfered edge) on a dark asphalt apron; a dark rubber landing mat on
//   it with worn white paint (a circle, an H, corner ticks) and one brand-orange heading chevron at the front;
//   eight flush LED pucks round the mat.
// Deck top at y = 0 (the vehicle's slotY 0 stands on it). Painted by default, x-ray twins through setPropLook.
// Sizes are visual shares of radius_u (shape only, never shown as facts).
const DPAD = {
  slabHalf: 1.85, // slab half-width / radius_u
  slabT: 0.055, // slab thickness / radius_u
  slabCorner: 0.32, // slab corner radius / radius_u
  matR: 1.42, // landing mat radius / radius_u
  matT: 0.012,
  ringR: 1.2, // painted circle
  ringW: 0.04,
  hLeg: 0.5, // H: half height, leg offset, stroke width
  hX: 0.36,
  hW: 0.13,
  lightR: 1.6, // LED pucks
  apronR_u: 420, // the field reaches the fog (scene units)
  grass: 0x55603f,
};
function roundedRectShape(half, r) {
  const s = new THREE.Shape();
  s.moveTo(-half + r, -half);
  s.lineTo(half - r, -half);
  s.absarc(half - r, -half + r, r, -Math.PI / 2, 0, false);
  s.lineTo(half, half - r);
  s.absarc(half - r, half - r, r, 0, Math.PI / 2, false);
  s.lineTo(-half + r, half);
  s.absarc(-half + r, half - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-half, -half + r);
  s.absarc(-half + r, -half + r, r, Math.PI, 1.5 * Math.PI, false);
  return s;
}
// Flat XZ geometry from 2D shapes, facing up, planar UVs in units / tile.
function flatXZ(shapes, y, tile = 1) {
  const geo = new THREE.ShapeGeometry(shapes, 24).rotateX(-Math.PI / 2).translate(0, y, 0);
  const p = geo.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) uv.set([p.getX(i) / tile, p.getZ(i) / tile], i * 2);
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
}
const rectShape = (x0, y0, x1, y1) => {
  const s = new THREE.Shape();
  s.moveTo(x0, y0);
  s.lineTo(x1, y0);
  s.lineTo(x1, y1);
  s.lineTo(x0, y1);
  s.closePath();
  return s;
};
function ringShape(r0, r1) {
  const s = new THREE.Shape();
  s.absarc(0, 0, r1, 0, Math.PI * 2, false);
  const h = new THREE.Path();
  h.absarc(0, 0, r0, 0, Math.PI * 2, true);
  s.holes.push(h);
  return s;
}
// A mesh with an explicit painted / x-ray pair (setPropLook switches userData.looks).
function lookMesh(geo, painted, xray, name) {
  const m = noPick(new THREE.Mesh(geo, painted));
  m.userData.looks = { painted, xray };
  m.userData.nonPickable = true;
  m.name = name;
  return m;
}
// A fixed wing's launch stand (droneLayout.js STAND_CLEAR): two padded saddles under the fuselage on splayed
// aluminium posts and two feet along the deck, so the plane rests (and spools up) with its nose propeller's whole
// disc clear of the deck, and flies off the front of it. stand = bounds.stand: { height_u, saddleZ_u, fuseR_u }.
// The saddle's inner face meets the fuselage's underside at height_u. Proportions are shares of the fuselage
// radius (shape only).
function launchStand({ height_u: H, saddleZ_u: zs, fuseR_u: fr }, xrayDark) {
  const g = new THREE.Group();
  g.name = "dpad-launch-stand";
  const t = fr * 0.16; // saddle pad tube radius
  const rho = fr + t; // saddle arc radius: its inner face is the fuselage's round underside
  const half = Math.PI / 3; // the saddle wraps 60° either side of the bottom
  const xp = Math.sin(half) * rho; // where a post meets the saddle's end
  const yTop = H + fr - Math.cos(half) * rho;
  const pw = fr * 0.14; // post section
  const metal = [];
  const foam = [];
  for (const z of zs) {
    foam.push(new THREE.TorusGeometry(rho, t, 10, 28, 2 * half).rotateZ(-Math.PI / 2 - half).translate(0, H + fr, z));
    for (const sx of [-1, 1]) {
      // A post from the foot (splayed out) up to the saddle's end.
      const a = new THREE.Vector3(sx * xp * 1.35, 0, z);
      const b = new THREE.Vector3(sx * xp, yTop, z);
      const len = a.distanceTo(b);
      const post = new THREE.BoxGeometry(pw, len, pw).translate(0, len / 2, 0);
      post.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())).translate(a.x, a.y, a.z);
      metal.push(post);
    }
    // A cross tie between the posts, low down, so the pair reads as one rigid frame.
    metal.push(new THREE.BoxGeometry(xp * 2.5, pw * 0.8, pw * 0.8).translate(0, H * 0.28, z));
  }
  // Two feet along the deck, from saddle to saddle and a little past.
  const zl = Math.min(...zs) - fr * 0.9;
  const zh = Math.max(...zs) + fr * 0.9;
  for (const sx of [-1, 1]) metal.push(new THREE.BoxGeometry(pw * 2.2, pw * 0.9, zh - zl).translate(sx * xp * 1.35, pw * 0.45, (zl + zh) / 2));
  const frame = lookMesh(mergeGeometries(metal), new THREE.MeshStandardMaterial({ color: 0x2a2d32, metalness: 0.7, roughness: 0.38 }), xrayDark(), "dpad-stand-frame");
  const pads = lookMesh(mergeGeometries(foam), new THREE.MeshStandardMaterial({ color: 0xff7a2e, roughness: 0.85, metalness: 0 }), xrayDark(), "dpad-stand-saddles");
  for (const m of [frame, pads]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  g.add(frame, pads);
  return g;
}
export function createDronePad({ radius_u = 5, stand = null } = {}) {
  const R = Math.max(0.5, radius_u);
  const g = new THREE.Group();
  g.name = "pad";
  const mats = propMaterials();
  const half = DPAD.slabHalf * R;
  const T = DPAD.slabT * R;
  const ch = T * 0.35; // chamfer
  const xrayDark = () => new THREE.MeshStandardMaterial({ color: 0x0c0e14, metalness: 0.2, roughness: 0.9, transparent: true, opacity: 0.55, depthWrite: false });

  // Field: mown grass (the complex's slope olive over the apron's stain texture) out to the fog, a hair under
  // the slab's foot. A drone flies from a field, not a launch apron, and the green keeps the scene in daylight
  // when the elevated camera has no horizon in view.
  const apron = noPick(new THREE.Mesh(new THREE.CircleGeometry(DPAD.apronR_u, 96).rotateX(-Math.PI / 2).translate(0, -T - 0.004, 0), propMaterial(mats.body)));
  apron.receiveShadow = true;
  apron.name = "dpad-field";
  paintProp(apron, "apron", { repeat: [(2 * DPAD.apronR_u) / (12 * R)] })?.color.set(DPAD.grass);
  g.add(apron);

  // Slab: a rounded square with a chamfered top edge, light concrete, top at y = 0.
  const slabGeo = new THREE.ExtrudeGeometry(roundedRectShape(half - ch, DPAD.slabCorner * R), { depth: T - ch, bevelEnabled: true, bevelThickness: ch, bevelSize: ch, bevelSegments: 1, curveSegments: 16 })
    .rotateX(-Math.PI / 2)
    .translate(0, -T, 0); // extruded depth + both bevels spans [−T − ch, 0]: the top face at y = 0
  const slab = noPick(new THREE.Mesh(slabGeo, propMaterial(mats.body)));
  slab.receiveShadow = true;
  slab.name = "dpad-slab";
  paintProp(slab, "concrete", { repeat: [1 / (0.6 * R)] }); // extrude UVs are in units: one tile per 0.6 R
  g.add(slab);

  // Landing mat: dark rubber disc, a bevelled rim, just proud of the slab.
  const matR = DPAD.matR * R;
  const mt = DPAD.matT * R;
  const rubber = new THREE.MeshStandardMaterial({ color: 0x4f555d, roughness: 0.8, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const matGeo = new THREE.LatheGeometry([new THREE.Vector2(matR, 0.0005), new THREE.Vector2(matR - mt * 1.5, mt), new THREE.Vector2(0.001, mt)], 128);
  const mat = lookMesh(matGeo, rubber, xrayDark(), "dpad-mat");
  mat.receiveShadow = true;
  g.add(mat);

  // Paint on the mat: the circle, the H (legs along the vehicle's fore-aft axis, z) and four corner ticks on
  // the slab, worn white.
  const y = mt + 0.002 * R;
  const shapes = [ringShape(DPAD.ringR * R - (DPAD.ringW * R) / 2, DPAD.ringR * R + (DPAD.ringW * R) / 2)];
  const hl = DPAD.hLeg * R;
  const hx = DPAD.hX * R;
  const hw = DPAD.hW * R;
  shapes.push(rectShape(-hx - hw / 2, -hl, -hx + hw / 2, hl), rectShape(hx - hw / 2, -hl, hx + hw / 2, hl), rectShape(-hx, -hw / 2, hx, hw / 2));
  const ticks = [];
  const tick = 0.32 * R;
  const tw = 0.035 * R;
  const tc = half - 0.16 * R;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      ticks.push(rectShape(Math.min(sx * tc, sx * (tc - tick)), Math.min(sz * tc, sz * (tc - tw)), Math.max(sx * tc, sx * (tc - tick)), Math.max(sz * tc, sz * (tc - tw))));
      ticks.push(rectShape(Math.min(sx * tc, sx * (tc - tw)), Math.min(sz * tc, sz * (tc - tick)), Math.max(sx * tc, sx * (tc - tw)), Math.max(sz * tc, sz * (tc - tick))));
    }
  }
  // The mat's paint and the slab's corner ticks in one mesh (the ticks at the slab top).
  const paintGeo = mergeGeometries([flatXZ(shapes, y, 4 * SCALE), flatXZ(ticks, 0.002 * R, 4 * SCALE)]);
  const white = new THREE.MeshStandardMaterial({ color: 0xcfcdc6, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const marks = noPick(new THREE.Mesh(paintGeo, white));
  marks.name = "dpad-markings";
  marks.receiveShadow = true;
  g.add(marks);

  // Heading chevron: brand orange, in front of the circle on the +z (nose) side.
  const cv = new THREE.Shape();
  const cz = (DPAD.ringR + 0.05) * R;
  const cwid = 0.16 * R;
  const cdep = 0.1 * R;
  const cth = 0.05 * R;
  // Shape y becomes world −z once laid flat, so the nose side (+z) is negative y here.
  cv.moveTo(-cwid, -cz);
  cv.lineTo(-cwid, -cz - cth);
  cv.lineTo(0, -cz - cdep - cth);
  cv.lineTo(cwid, -cz - cth);
  cv.lineTo(cwid, -cz);
  cv.lineTo(0, -cz - cdep);
  cv.closePath();
  const orange = new THREE.MeshStandardMaterial({ color: 0xff7a2e, emissive: 0xff6a1a, emissiveIntensity: 0.35, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const chevron = noPick(new THREE.Mesh(flatXZ([cv], y), orange));
  chevron.name = "dpad-heading";
  g.add(chevron);

  // LED pucks: eight flush lights round the mat, cool white, on a dark bezel (one mesh each kind).
  const bez = [];
  const lens = [];
  const lr = 0.03 * R;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI * 2) / 8 + Math.PI / 8;
    const x = Math.cos(a) * DPAD.lightR * R;
    const z = Math.sin(a) * DPAD.lightR * R;
    bez.push(new THREE.CylinderGeometry(lr * 1.35, lr * 1.5, 0.012 * R, 20).translate(x, 0.006 * R, z));
    lens.push(new THREE.CylinderGeometry(lr, lr, 0.016 * R, 20).translate(x, 0.008 * R, z));
  }
  const bezel = noPick(new THREE.Mesh(mergeGeometries(bez), new THREE.MeshStandardMaterial({ color: 0x2a2d32, metalness: 0.7, roughness: 0.35 })));
  bezel.name = "dpad-light-bezels";
  const lensMesh = noPick(new THREE.Mesh(mergeGeometries(lens), new THREE.MeshStandardMaterial({ color: 0xdff4ff, emissive: 0xbfe6ff, emissiveIntensity: 1.6, roughness: 0.3 })));
  lensMesh.name = "dpad-lights";
  g.add(bezel, lensMesh);
  if (stand?.height_u > 0) g.add(launchStand(stand, xrayDark));

  return { group: g, ringMat: null, layout: { b: R, padR: half, plinthH: T }, clamps: [] };
}
