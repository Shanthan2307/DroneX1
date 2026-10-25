// The simulator pack (prototype/drone-assembly/src/simExport.js): a drone of many pieces goes out as one mesh
// per look per node, with the sub-pixel hardware left out, UVs stripped, vertices welded, the propellers named
// in motor order and the origin at the lowest point, and the glTF binary carries exactly that.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { DROP_UNDER_M, exportDroneGlb, packDrone } from "../../../prototype/drone-assembly/src/simExport.js";
import { MOTOR_BEARINGS } from "../../../prototype/drone-assembly/src/simProfile.js";
import { SCALE } from "../../../prototype/drone-assembly/src/scale.js";

const VIEW_K = 2; // scene units = metres × SCALE × viewK, so one unit is 1 / (SCALE × viewK) metres
const UNIT_M = 1 / (SCALE * VIEW_K);

interface Piece {
  mesh: THREE.Mesh;
  rest: { position: THREE.Vector3; quaternion: THREE.Quaternion };
}
interface Part {
  id: string;
  kind: string;
  group: THREE.Group;
  pieces: Piece[];
  built: boolean;
  geom?: { spinDir?: number; cruise?: boolean };
}

const piece = (geometry: THREE.BufferGeometry, material: THREE.Material, at: [number, number, number], extra: Record<string, unknown> = {}): Piece => {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...at);
  Object.assign(mesh.userData, { kind: "detail" }, extra);
  geometry.computeBoundingBox();
  return { mesh, rest: { position: mesh.position.clone(), quaternion: mesh.quaternion.clone() } };
};
const part = (id: string, kind: string, slotY: number, pieces: Piece[], geom?: Part["geom"]): Part => {
  const group = new THREE.Group();
  group.position.y = slotY;
  for (const p of pieces) group.add(p.mesh);
  return { id, kind, group, pieces, built: true, geom };
};

// A quad: a frame of two carbon plates (one carries UVs), a bolt too small to draw and a battery with its own
// look, four propellers at the arm ends, each a hub and a blade in two looks, two spinning clockwise.
function quad() {
  const carbon = new THREE.MeshStandardMaterial({ color: 0x111214, metalness: 0.2, roughness: 0.38, side: THREE.DoubleSide });
  const carbon2 = new THREE.MeshStandardMaterial({ color: 0x111316, metalness: 0.22, roughness: 0.41, side: THREE.DoubleSide }); // same look, other instance
  const pack = new THREE.MeshStandardMaterial({ color: 0x3355aa, metalness: 0, roughness: 0.6 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.9, roughness: 0.3 });
  const blade = new THREE.MeshStandardMaterial({ color: 0xff6600, metalness: 0, roughness: 0.7 });
  const plate = () => new THREE.BoxGeometry(0.4, 0.01, 0.4); // 0.4 u = 0.8 m across: has UVs and an index
  const bolt = new THREE.CylinderGeometry(0.002, 0.002, 0.004, 8); // 4 mm across in metres: under DROP_UNDER_M
  const unwrapped = new THREE.BoxGeometry(0.2, 0.1, 0.1).toNonIndexed();
  unwrapped.deleteAttribute("uv");
  const frame = part("drone-frame", "drone-frame", 0.05, [
    piece(plate(), carbon, [0, 0, 0], { kind: "shell" }),
    piece(plate(), carbon2, [0, 0.03, 0], { kind: "shell" }),
    piece(bolt, steel, [0.1, 0.02, 0.1]),
    piece(new THREE.CylinderGeometry(0.02, 0.02, 0.1, 12), steel, [-0.1, 0.02, -0.1]), // a standoff: 10 cm, kept
  ]);
  const battery = part("drone-battery", "drone-battery", 0.09, [piece(unwrapped, pack, [0, 0, 0])]);
  const props: Part[] = [];
  const arms: [number, number, number][] = [
    [0.3, 0, -0.3],
    [-0.3, 0, 0.3],
    [0.3, 0, 0.3],
    [-0.3, 0, -0.3],
  ];
  arms.forEach(([x, , z], i) => {
    const hub = piece(new THREE.CylinderGeometry(0.01, 0.01, 0.01, 8), steel, [x, 0, z], { spinAxis: "y" });
    const bl = piece(new THREE.BoxGeometry(0.25, 0.002, 0.02), blade, [x, 0.006, z]);
    props.push(part(`drone-propeller-${i}`, "drone-propeller", 0.1, [hub, bl], { spinDir: i % 2 ? -1 : 1 }));
  });
  return { parts: [frame, battery, ...props], frame, battery, props };
}

const byName = (root: THREE.Object3D, name: string) => {
  let found: THREE.Object3D | undefined;
  root.traverse((o) => {
    if (!found && o.name === name) found = o;
  });
  return found;
};
const meshesOf = (node: THREE.Object3D) => node.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);

describe("simulator pack", () => {
  const { parts } = quad();
  const packed = packDrone(parts, { viewK: VIEW_K, bearings: MOTOR_BEARINGS.X, spinner: null });

  it("merges the body into one mesh per look and drops the sub-pixel hardware", () => {
    const body = byName(packed.root, "Body")!;
    const meshes = meshesOf(body);
    // carbon (both plates, one look), steel (the standoff; the bolt is gone), the pack: three looks, three meshes
    expect(meshes.length).toBe(3);
    expect(packed.stats.pieces).toBe(5 + 8);
    expect(packed.stats.dropped).toBe(1);
    expect(packed.stats.primitives).toBe(3 + 4 * 2); // the body, then hub and blade of each propeller
    for (const m of meshes) {
      expect(m.geometry.index).not.toBeNull();
      expect(m.geometry.getAttribute("uv")).toBeUndefined();
      expect(m.geometry.getAttribute("normal")).toBeDefined();
      expect((m.material as THREE.MeshStandardMaterial).map).toBeNull();
    }
    const carbon = meshes.find((m) => (m.material as THREE.MeshStandardMaterial).side === THREE.DoubleSide)!;
    expect(carbon.geometry.getAttribute("position").count).toBe(2 * 24); // two welded boxes, 24 corners each (hard edges kept)
  });

  it("names the propellers in motor order, each one mesh per look, spun from their hubs", () => {
    const names = ["Propeller1", "Propeller2", "Propeller3", "Propeller4"];
    for (const n of names) {
      const node = byName(packed.root, n)!;
      expect(node, n).toBeDefined();
      expect(meshesOf(node).length).toBe(2);
      // the hub sits at the node's origin: the blade's and hub's merged geometry is centred on it
      for (const m of meshesOf(node)) {
        const c = m.geometry.boundingBox!.getCenter(new THREE.Vector3());
        expect(Math.abs(c.x)).toBeLessThan(1e-6);
        expect(Math.abs(c.z)).toBeLessThan(1e-6);
      }
    }
    expect(packed.rotors.length).toBe(4);
    expect(packed.rotors.filter((r) => r.ccw).length).toBe(2);
    expect(packed.spinner).toBeNull();
    expect(byName(packed.root, "Propeller5")).toBeUndefined();
  });

  it("stands on its origin in true metres with the nose at -Z", () => {
    packed.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(packed.root);
    const size = box.getSize(new THREE.Vector3());
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(Math.abs(box.min.x + box.max.x)).toBeLessThan(1e-6);
    expect(Math.abs(box.min.z + box.max.z)).toBeLessThan(1e-6);
    // arms at ±0.3 u plus half a blade (0.125 u): 0.85 u across, in metres
    expect(size.x).toBeCloseTo(0.85 * UNIT_M, 5);
    expect(size.z).toBeCloseTo(0.62 * UNIT_M, 5); // the blades lie along x: here it is the arms plus half a blade width
    expect(packed.root.scale.x).toBeCloseTo(UNIT_M, 9);
    expect(DROP_UNDER_M).toBeGreaterThan(0.004);
  });

  it("a mirrored piece keeps its faces outward", () => {
    const steel = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });
    const p = piece(new THREE.BoxGeometry(0.2, 0.2, 0.2), steel, [0, 0.1, 0], { kind: "shell" });
    p.mesh.scale.set(-1, 1, 1);
    const one = packDrone([part("drone-frame", "drone-frame", 0, [p])], { viewK: VIEW_K, bearings: [], spinner: null });
    const mesh = meshesOf(byName(one.root, "Body")!)[0];
    const pos = mesh.geometry.getAttribute("position");
    const idx = mesh.geometry.index!;
    // every face's winding normal points the same way as its vertex normal (outward)
    const nrm = mesh.geometry.getAttribute("normal");
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < idx.count; i += 3) {
      a.fromBufferAttribute(pos, idx.getX(i));
      b.fromBufferAttribute(pos, idx.getX(i + 1));
      c.fromBufferAttribute(pos, idx.getX(i + 2));
      n.fromBufferAttribute(nrm, idx.getX(i));
      const face = b.sub(a).cross(c.sub(a));
      expect(face.dot(n)).toBeGreaterThan(0);
    }
  });

  it("writes a glTF binary with those nodes and primitives", async () => {
    // GLTFExporter reads its Blobs back through FileReader, which Node does not have.
    const g = globalThis as unknown as { FileReader?: unknown };
    const had = g.FileReader;
    g.FileReader = class {
      result: ArrayBuffer | string | null = null;
      onloadend: null | (() => void) = null;
      readAsArrayBuffer(blob: Blob) {
        void blob.arrayBuffer().then((b) => {
          this.result = b;
          this.onloadend?.();
        });
      }
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then((b) => {
          this.result = `data:${blob.type};base64,${Buffer.from(b).toString("base64")}`;
          this.onloadend?.();
        });
      }
    };
    try {
      const { glb, rotors, stats } = await exportDroneGlb(quad().parts, { viewK: VIEW_K, bearings: MOTOR_BEARINGS.X, spinner: null });
      const buf = Buffer.from(glb as ArrayBuffer);
      expect(buf.subarray(0, 4).toString()).toBe("glTF");
      const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8"));
      const names = json.nodes.map((n: { name?: string }) => n.name);
      for (const n of ["DroneX", "Drone", "Body", "Propeller1", "Propeller2", "Propeller3", "Propeller4"]) expect(names).toContain(n);
      const prims = json.meshes.flatMap((m: { primitives: { attributes: Record<string, number> }[] }) => m.primitives);
      expect(prims.length).toBe(stats.primitives);
      expect(prims.length).toBe(11);
      for (const p of prims) expect(Object.keys(p.attributes).sort()).toEqual(["NORMAL", "POSITION"]);
      expect(json.materials.length).toBe(4); // carbon, steel, pack, blade
      expect(json.textures).toBeUndefined();
      expect(rotors.length).toBe(4);
      expect(buf.length).toBeLessThan(20_000);
    } finally {
      if (had) g.FileReader = had;
      else delete g.FileReader;
    }
  });
});
