// The drone as built, packed as a glTF binary for the simulation engine's 3D map: a miniature of the exact parts
// on the pad, in true metres, in the engine's model conventions (read off its stock models): Y up, nose at -Z,
// +X to the right; each lift propeller its own node named Propeller1..N in ArduPilot motor order, so the motor
// outputs spin the right propellers; a nose or cruise propeller a node of its own, spun from the throttle.
//
//   exportDroneGlb(parts, { viewK, bearings, spinner }) -> Promise<{ glb: ArrayBuffer, rotors: [{ ccw }], spinner }>
//
// Materials go out as plain PBR (colour, metalness, roughness, vertex colours): the shader hooks, bump textures,
// edge lines and instanced bolts of the configurator look are left behind, since they are invisible at map
// scale and not every glTF viewer takes them.
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { SCALE } from "./scale.js";
import { assignMotors, bearingOf } from "./simProfile.js";

const PROP_KINDS = new Set(["drone-propeller", "drone-nose-propeller"]);

// One plain material per distinct look (colour, finish, emissive, vertex colours), so the file does not carry a
// copy per piece: the configurator clones its materials per mesh, so identity would give one per piece.
function plainMaterials() {
  const cache = new Map();
  const hex = (c) => (c ? c.getHex() : -1);
  return (mesh) => {
    const src = mesh.userData.looks?.painted ?? mesh.material;
    const key = [hex(src.color), src.metalness, src.roughness, hex(src.emissive), src.emissiveIntensity, Boolean(src.vertexColors), src.side, src.userData?.role].join("|");
    let m = cache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: src.color ? src.color.clone() : new THREE.Color(0x888888),
        metalness: Number.isFinite(src.metalness) ? src.metalness : 0.2,
        roughness: Number.isFinite(src.roughness) ? src.roughness : 0.6,
        vertexColors: Boolean(src.vertexColors),
        side: src.side ?? THREE.FrontSide,
      });
      if (src.emissive) {
        m.emissive = src.emissive.clone();
        m.emissiveIntensity = src.emissiveIntensity ?? 1;
      }
      m.name = src.name || src.userData?.role || "part";
      cache.set(key, m);
    }
    return m;
  };
}

// A piece at its rest pose (the exploded view and the flight move the live meshes; the export never does).
function restClone(pc, material, offset = null) {
  const mesh = new THREE.Mesh(pc.mesh.geometry, material(pc.mesh));
  mesh.position.copy(pc.rest?.position ?? pc.mesh.position);
  if (offset) mesh.position.sub(offset);
  mesh.quaternion.copy(pc.rest?.quaternion ?? pc.mesh.quaternion);
  mesh.scale.copy(pc.mesh.scale);
  mesh.name = pc.mesh.name;
  return mesh;
}

/**
 * @param {Array} parts the live parts (createPart); only built ones are packed
 * @param {{ viewK: number, bearings: number[], spinner: string|null }} opts display scale, ArduPilot motor layout,
 *   name for the nose/cruise propeller node
 */
export async function exportDroneGlb(parts, { viewK, bearings, spinner }) {
  const material = plainMaterials();
  const inner = new THREE.Group();
  inner.name = "Drone";
  const body = new THREE.Group();
  body.name = "Body";
  inner.add(body);
  const lift = [];
  let nose = null;

  for (const part of parts) {
    if (!part.built || !part.pieces?.length) continue;
    const slotY = part.group.position.y;
    if (!PROP_KINDS.has(part.kind)) {
      const g = new THREE.Group();
      g.name = part.id;
      g.position.y = slotY;
      for (const pc of part.pieces) g.add(restClone(pc, material));
      body.add(g);
      continue;
    }
    // A propeller: every piece is authored centred on its own hub axis and placed at the arm end, so the hub is
    // the tagged piece's rest position (droneFlight.js reads it the same way).
    const tagged = part.pieces.find((pc) => pc.mesh.userData?.spinAxis) ?? part.pieces[0];
    const hub = (tagged.rest?.position ?? tagged.mesh.position).clone();
    const node = new THREE.Group();
    node.position.set(hub.x, slotY + hub.y, hub.z);
    for (const pc of part.pieces) node.add(restClone(pc, material, hub));
    const ccw = part.geom?.spinDir !== -1;
    if (part.kind === "drone-nose-propeller" || part.geom?.cruise) nose = { node, ccw };
    else lift.push({ node, ccw, bearing_deg: bearingOf(hub.x, hub.z) });
    inner.add(node);
  }

  const ordered = assignMotors(lift, bearings);
  ordered.forEach((p, i) => (p.node.name = `Propeller${i + 1}`));
  const spinnerName = nose ? spinner || "Propeller" : null;
  if (nose) nose.node.name = spinnerName;

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
  root.scale.setScalar(1 / (viewK * SCALE));
  root.updateMatrixWorld(true);

  const glb = await new GLTFExporter().parseAsync(root, { binary: true });
  return { glb, rotors: ordered.map((p) => ({ ccw: p.ccw })), spinner: spinnerName };
}
