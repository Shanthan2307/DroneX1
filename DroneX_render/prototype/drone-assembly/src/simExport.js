// The drone as built, packed as a glTF binary for the simulation engine's 3D map: a miniature of the exact parts
// on the pad, in true metres, in the engine's model conventions (read off its stock models): Y up, nose at -Z,
// +X to the right; each lift propeller its own node named Propeller1..N in ArduPilot motor order, so the motor
// outputs spin the right propellers; a nose or cruise propeller a node of its own, spun from the throttle.
//
//   exportDroneGlb(parts, { viewK, bearings, spinner }) -> Promise<{ glb: ArrayBuffer, rotors: [{ ccw }], spinner, stats }>
//   packDrone(parts, { viewK, bearings, spinner })      -> { root, rotors, spinner, stats }   (the scene the glb is made of)
//
// The map draws the whole model twice a frame (once for its silhouette) and compiles a shader per primitive, so
// the pack is built for the map, not for the configurator: every piece of the body is baked into one mesh per
// look, each propeller into one mesh per look, so a 200-piece drone goes out as a couple of dozen primitives;
// bolts, clamps and screw heads too small to cover a pixel at map scale are left out (shells never are); UVs go,
// since nothing is textured; vertices are welded. Materials go out as plain PBR (colour, metalness, roughness,
// vertex colours), one per distinct look: the shader hooks, bump textures, LED glow, edge lines and instanced
// bolts of the configurator look are left behind, since they are invisible at map scale and not every glTF
// viewer takes them.
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { SCALE } from "./scale.js";
import { assignMotors, bearingOf } from "./simProfile.js";

const PROP_KINDS = new Set(["drone-propeller", "drone-nose-propeller"]);

// A piece smaller than this across (true metres) is a bolt, a clamp or a screw head: the map draws a whole drone
// at 40 to a few hundred pixels wide, so it is under a pixel there. Shells and propellers are always kept.
export const DROP_UNDER_M = 0.025;

// One plain material per distinct look, with the look quantised (colour to 1/32 steps, metalness to quarters,
// roughness to fifths) so the configurator's dozens of near-black variants of one finish fold into one, and one
// draw call, on the map.
function plainMaterials() {
  const cache = new Map();
  const q = (v, step) => Math.round(v / step) * step;
  const rgb = (c) => (c ? [q(c.r, 1 / 32), q(c.g, 1 / 32), q(c.b, 1 / 32)] : [0.53, 0.53, 0.53]);
  const lookOf = (mesh) => {
    const m = mesh.userData.looks?.painted ?? mesh.material;
    return Array.isArray(m) ? m[0] : m;
  };
  return (mesh) => {
    const src = lookOf(mesh);
    const color = rgb(src.color);
    const metalness = q(Number.isFinite(src.metalness) ? src.metalness : 0.2, 0.25);
    const roughness = q(Number.isFinite(src.roughness) ? src.roughness : 0.6, 0.2);
    const vertexColors = Boolean(src.vertexColors);
    const side = src.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide;
    const key = [...color, metalness, roughness, vertexColors, side].join("|");
    let m = cache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: new THREE.Color(...color), metalness, roughness, vertexColors, side });
      m.name = src.name || src.userData?.role || "part";
      cache.set(key, m);
    }
    return m;
  };
}

// A piece's geometry with its rest pose baked in, cut down to what the map shades: positions, normals and, for a
// vertex-coloured look, colours. Welded to an indexed geometry; a mirrored pose (negative scale) gets its winding
// put back so the faces still look outward.
function bake(geometry, matrix, wantColors) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", geometry.getAttribute("position").clone());
  if (geometry.getAttribute("normal")) g.setAttribute("normal", geometry.getAttribute("normal").clone());
  if (wantColors) {
    const c = geometry.getAttribute("color");
    g.setAttribute("color", c ? c.clone() : new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count * 3).fill(1), 3));
  }
  if (geometry.index) g.setIndex(geometry.index.clone());
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  g.applyMatrix4(matrix);
  const welded = mergeVertices(g);
  g.dispose();
  if (matrix.determinant() < 0) {
    const idx = welded.index.array;
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    welded.index.needsUpdate = true;
  }
  return welded;
}

// The pieces gathered under one node, merged into one mesh per look.
function makeBucket() {
  return new Map(); // material -> [geometry]
}
function addPiece(bucket, pc, matrix, material) {
  const list = bucket.get(material) ?? [];
  list.push(bake(pc.mesh.geometry, matrix, material.vertexColors));
  bucket.set(material, list);
}
function flush(bucket, node, stats) {
  for (const [material, geos] of bucket) {
    const merged = geos.length === 1 ? geos[0] : mergeVertices(mergeGeometries(geos, false));
    if (geos.length > 1) for (const g of geos) g.dispose();
    merged.computeBoundingBox();
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `${node.name}:${material.name}`;
    node.add(mesh);
    stats.primitives++;
    stats.vertices += merged.getAttribute("position").count;
    stats.triangles += merged.index.count / 3;
  }
  bucket.clear();
}

// The widest extent of a piece in true metres, from its authored bounding box and pose.
function pieceSize_m(pc, unit) {
  const g = pc.mesh.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  const s = pc.mesh.scale;
  const size = g.boundingBox.getSize(new THREE.Vector3()).multiply(new THREE.Vector3(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)));
  return size.length() * unit;
}

/**
 * The drone packed as a three.js scene in the engine's conventions, ready for GLTFExporter (exportDroneGlb) or
 * for a test to look at.
 * @param {Array} parts the live parts (createPart); only built ones are packed
 * @param {{ viewK: number, bearings: number[], spinner: string|null }} opts display scale, ArduPilot motor layout,
 *   name for the nose/cruise propeller node
 */
export function packDrone(parts, { viewK, bearings, spinner }) {
  const material = plainMaterials();
  const unit = 1 / (viewK * SCALE); // true metres per scene unit
  const stats = { primitives: 0, vertices: 0, triangles: 0, pieces: 0, dropped: 0 };
  const inner = new THREE.Group();
  inner.name = "Drone";
  const body = new THREE.Group();
  body.name = "Body";
  inner.add(body);
  const bodyBucket = makeBucket();
  const lift = [];
  let nose = null;
  const pose = (pc, offset = null) => {
    const p = (pc.rest?.position ?? pc.mesh.position).clone();
    if (offset) p.sub(offset);
    return new THREE.Matrix4().compose(p, pc.rest?.quaternion ?? pc.mesh.quaternion, pc.mesh.scale);
  };

  for (const part of parts) {
    if (!part.built || !part.pieces?.length) continue;
    const slotY = part.group.position.y;
    if (!PROP_KINDS.has(part.kind)) {
      const slot = new THREE.Matrix4().makeTranslation(0, slotY, 0);
      for (const pc of part.pieces) {
        stats.pieces++;
        if (pc.mesh.userData.kind !== "shell" && pieceSize_m(pc, unit) < DROP_UNDER_M) {
          stats.dropped++;
          continue;
        }
        addPiece(bodyBucket, pc, slot.clone().multiply(pose(pc)), material(pc.mesh));
      }
      continue;
    }
    // A propeller: every piece is authored centred on its own hub axis and placed at the arm end, so the hub is
    // the tagged piece's rest position (droneFlight.js reads it the same way).
    const tagged = part.pieces.find((pc) => pc.mesh.userData?.spinAxis) ?? part.pieces[0];
    const hub = (tagged.rest?.position ?? tagged.mesh.position).clone();
    const node = new THREE.Group();
    node.position.set(hub.x, slotY + hub.y, hub.z);
    const bucket = makeBucket();
    for (const pc of part.pieces) {
      stats.pieces++;
      addPiece(bucket, pc, pose(pc, hub), material(pc.mesh));
    }
    const ccw = part.geom?.spinDir !== -1;
    if (part.kind === "drone-nose-propeller" || part.geom?.cruise) nose = { node, bucket, ccw };
    else lift.push({ node, bucket, ccw, bearing_deg: bearingOf(hub.x, hub.z) });
    inner.add(node);
  }
  flush(bodyBucket, body, stats);

  const ordered = assignMotors(lift, bearings);
  ordered.forEach((p, i) => (p.node.name = `Propeller${i + 1}`));
  const spinnerName = nose ? spinner || "Propeller" : null;
  if (nose) nose.node.name = spinnerName;
  for (const p of nose ? [...ordered, nose] : ordered) flush(p.bucket, p.node, stats);

  // The vehicle's origin is its lowest point (the skids, gear or belly), centred horizontally. The map clamps a
  // vehicle on the ground to the 3D tiles' surface, so anything below the origin would be buried; in flight the
  // few centimetres this draws it higher than its true centre are invisible at map scale.
  const box = new THREE.Box3().setFromObject(inner);
  if (!box.isEmpty()) inner.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);

  // Scene units are metres × SCALE × viewK; the engine wants true metres with the nose at -Z.
  const root = new THREE.Group();
  root.name = "DroneX";
  root.add(inner);
  root.rotation.y = Math.PI;
  root.scale.setScalar(unit);
  root.updateMatrixWorld(true);
  return { root, rotors: ordered.map((p) => ({ ccw: p.ccw })), spinner: spinnerName, stats };
}

/** The packed drone as a glTF binary. The scene's geometries are released once written. */
export async function exportDroneGlb(parts, opts) {
  const { root, rotors, spinner, stats } = packDrone(parts, opts);
  try {
    const glb = await new GLTFExporter().parseAsync(root, { binary: true });
    return { glb, rotors, spinner, stats };
  } finally {
    root.traverse((o) => o.geometry?.dispose());
  }
}
