// Procedural parts, generated from a part manifest (droneLayout.js), and the shared toolkit, materials and
// looks every part builder uses (KIT; the builders themselves are in droneParts.js and register through
// registerBuilders). A part is a group at spec.slotY whose local y = 0 is the part's bottom, made of separate
// pieces. Rivet rows, bolt circles, pipe clamps and straps are static instanced detail on the pieces (see
// "instanced fine detail").
// Piece rules: translation-only children (rotation about Y allowed, X/Z rotations baked into the geometry);
// every mesh has its own material clone, mesh.userData.partId = spec.id and mesh.userData.kind
// ("shell" | "interior" | "detail"). Each piece carries:
//   order       arrival order, bottom-up
//   engine      sub-assembly index for staggered arrival, else null (also on mesh.userData.engine)
//   explode     { dir, dist } radial opening, scene units, used as rest + dir × dist
//   axisOffset  scene units along +Y in the axial pull-apart view (see axisOffsets)
//   spin        radians about Y carried on arrival/departure (see assignSpins)
//
// Geometry is authored in metres and scaled by SCALE once. Every proportion that is not a dataset field is a
// visual ratio for shape only and is never shown on screen as a fact.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SCALE } from "./scale.js";

// Two looks per piece (round 15), switched by setShellOpacity: painted PBR (default, shell value ≥ 0.9: clear-
// coated paint with micro-roughness, soot near the base, brushed bare-metal bells, black composite with a weave
// normal, edge lines at 0.15) and the round-10 x-ray look (docs/v2-design.md §5, below 0.9: dark see-through
// graphite shells with a peach fresnel rim, opaque steel internals, peach edge lines). ?look=classic shows the
// round-9 painted look with no switching.
const XRAY = !(typeof location !== "undefined" && /[?&]look=classic(&|$)/.test(location.search ?? ""));
export const LOOK = XRAY ? "xray" : "classic";
const PEACH = 0xffb48a;
const SHELL_OPACITY = 0.55; // built; choreo sets 0.30 exploded, 0.15 selected through setShellOpacity
const LINE_STRUCT = 0.55; // rings, flanges, bell lips, fins, legs, shell rims and seams
const LINE_FINE = 0.2; // weld lands, raceway clamps, shell panel seams
const LINE_INTERIOR = 0.3; // internals seen through the shells (domes, baffles, bottles)
const PAINT_AT = 0.9; // setShellOpacity at or above this shows the painted look
const LINE_PAINT = 0.15; // structural edge lines over paint (others scale by the same factor)

export const COLORS = {
  body: 0xd6d8d4,
  accent: 0x15171c,
  metal: 0x3b3f48,
  gold: 0xc9a24a,
  panel: 0x1b2a4a,
  holo: 0x5cc8ff,
  select: 0xffb020,
};

const S = SCALE;
const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const DS = THREE.DoubleSide;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
// Azimuth a (from +X toward +Z, as in layout.js) ↔ lathe phi (from +Z toward +X): phi = π/2 − a.
const radial = (a, y = 0) => new THREE.Vector3(Math.cos(a), y, Math.sin(a)).normalize();
const radialPhi = (phi, y = 0) => new THREE.Vector3(Math.sin(phi), y, Math.cos(phi)).normalize();
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------- procedural textures (pixel-generated once, shared by every material of every preset) ----------

function hash2(x, y, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed + 1, 2147483629);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
// Tileable value noise: u, v in [0, 1), P lattice cells per tile.
function vnoise(u, v, P, seed) {
  const x = u * P;
  const y = v * P;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const g = (i, j) => hash2((((ix + i) % P) + P) % P, (((iy + j) % P) + P) % P, seed);
  return lerp(lerp(g(0, 0), g(1, 0), sx), lerp(g(0, 1), g(1, 1), sx), sy);
}
function fbm(u, v, P, seed, octaves = 4) {
  let sum = 0;
  let norm = 0;
  for (let o = 0, a = 0.5; o < octaves; o++, a *= 0.5) {
    sum += a * vnoise(u, v, P << o, seed + o);
    norm += a;
  }
  return sum / norm;
}

// fill(u, v) -> [r, g, b] in 0..1. Data maps pack bump height in R and a roughness factor in G
// (three reads bumpMap.r and roughnessMap.g), so one texture serves both slots.
function dataTexture(w, h, fill, { srgb = false, channel = 0, tile_m = 0 } = {}) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill((x + 0.5) / w, (y + 0.5) / h);
      const i = (y * w + x) * 4;
      data[i] = clamp(r, 0, 1) * 255;
      data[i + 1] = clamp(g, 0, 1) * 255;
      data[i + 2] = clamp(b, 0, 1) * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, w, h);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.channel = channel;
  if (tile_m) t.repeat.set(1 / tile_m, 1 / tile_m); // geometry UVs of that channel are in metres
  t.needsUpdate = true;
  return t;
}

// The roll pattern's black areas on normalized shell UVs (u around, v along): alternating eighths on the lower
// part and a counter-phased band at the top. Shared by the textures and the rivet layout (no rivets on black).
const rollBlack = (u, v) => {
  const sector = Math.floor(u * 8);
  return (v < 0.3 && sector % 2 === 0) || (v > 0.93 && sector % 2 === 1);
};

let TEX = null;
function textures() {
  if (TEX) return TEX;
  const W = 256;
  const px = 1 / W;
  TEX = {
    // Tank skin, 4 m tile on uv1 (metres): a ring weld every 4 m (raised bead, a little shinier), a vertical
    // panel seam (shallow groove) and low-frequency paint unevenness.
    seams: dataTexture(
      W,
      W,
      (u, v) => {
        const n = fbm(u, v, 4, 11);
        const weld = Math.exp(-(((v - 0.5) / (1.6 * px)) ** 2));
        const seam = Math.exp(-(((u - 0.5) / (1.0 * px)) ** 2));
        return [0.5 + 0.22 * weld - 0.25 * seam + (n - 0.5) * 0.08, 0.93 + (n - 0.5) * 0.14 - 0.15 * weld, 1];
      },
      { channel: 1, tile_m: 4 },
    ),
    // Regenerative-cooling tube ridges on engine bells: one ridge per tile across u (geometry repeats u).
    ridges: dataTexture(32, 8, (u) => {
      const r = 0.5 + 0.5 * Math.cos(u * TAU);
      return [r, 0.8 + 0.2 * (1 - r), 1];
    }),
    // Knurled / machined rings: fine diamond knurl, 6 cm tile on uv1 (metres).
    knurl: dataTexture(
      64,
      64,
      (u, v) => {
        const a = Math.abs(Math.sin((u + v) * Math.PI * 4));
        const b = Math.abs(Math.sin((u - v) * Math.PI * 4));
        const h = Math.min(a, b);
        return [h, 0.75 + 0.25 * (1 - h), 1];
      },
      { channel: 1, tile_m: 0.06 },
    ),
    // Crinkled multi-layer insulation: ridged noise for the bump, varied roughness, 1.2 m tile.
    crinkle: dataTexture(
      W,
      W,
      (u, v) => {
        const n = fbm(u, v, 6, 3, 5);
        const ridged = 1 - Math.abs(2 * n - 1);
        // Blanket seams every 0.6 m (two per tile each way): a sewn, taped groove, a little more matte.
        const d = (t) => Math.min(t % 0.5, 0.5 - (t % 0.5)) / 0.5;
        const seam = Math.max(Math.exp(-((d(u) / 0.02) ** 2)), Math.exp(-((d(v) / 0.02) ** 2)));
        return [ridged ** 2 * (1 - 0.85 * seam), 0.55 + 0.45 * fbm(u, v, 4, 7) + 0.25 * seam, 1];
      },
      { tile_m: 1.2 },
    ),
    // Octaweb heat-shield "dance floor": 0.5 m plates with grooves and corner bolts, a shade per plate
    // (colour, sRGB; R doubles as bump). 1 m tile on uv (metres).
    plates: dataTexture(
      W,
      W,
      (u, v) => {
        const cu = (u * 2) % 1;
        const cv = (v * 2) % 1;
        const groove = Math.min(cu, 1 - cu, cv, 1 - cv) < 0.015 ? 1 : 0;
        const bolt = [0.06, 0.94].some((x) => [0.06, 0.94].some((y) => Math.hypot(cu - x, cv - y) < 0.02)) ? 1 : 0;
        const shade = 0.82 + 0.18 * hash2(Math.floor(u * 2), Math.floor(v * 2), 31) + 0.06 * (fbm(u, v, 8, 33, 3) - 0.5);
        const k = groove ? 0.35 : bolt ? 1.0 : shade;
        return [k, k, k];
      },
      { srgb: true, tile_m: 1 },
    ),
    // Solar cells: dark blue cells with thin bus-bar lines, 0.8 m tile (colour, sRGB).
    cells: dataTexture(
      128,
      128,
      (u, v) => {
        const cu = (u * 4) % 1;
        const cv = (v * 4) % 1;
        const line = cu < 0.04 || cv < 0.04 ? 1 : 0;
        const shade = 0.9 + 0.1 * Math.sin(cv * Math.PI);
        return line ? [0.5, 0.52, 0.56] : [0.07 * shade, 0.11 * shade, 0.24 * shade];
      },
      { srgb: true, tile_m: 0.8 },
    ),
    // Black-and-white roll pattern on normalized UVs (u around, v along the shell): alternating eighths on the
    // lower part and a counter-phased band at the top. A visual reading of the photos, not a drawing.
    roll: dataTexture(
      W,
      512,
      (u, v) => (rollBlack(u, v) ? [0.06, 0.06, 0.065] : [0.92, 0.92, 0.9]),
      { srgb: true },
    ),
    // Alpha for the roll pattern on x-ray shells: black bands opaque, the rest at the shell opacity (G channel).
    rollAlpha: dataTexture(W, 512, (u, v) => (rollBlack(u, v) ? [1, 1, 1] : [SHELL_OPACITY, SHELL_OPACITY, SHELL_OPACITY])),
    // Sprayed foam: mottled orange-brown (colour, sRGB); its red channel doubles as the bump. 3 m tile on uv1.
    foam: dataTexture(
      W,
      W,
      (u, v) => {
        const n = fbm(u, v, 8, 21, 5);
        const k = 0.78 + 0.4 * n;
        return [0.78 * k, 0.37 * k, 0.13 * k];
      },
      { srgb: true, channel: 1, tile_m: 3 },
    ),
    // Paint skin, 4 m tile on uv1: the seams map's welds and panel seam (R bump) plus micro-roughness noise in G
    // so highlights break up across the clear coat.
    paint: dataTexture(
      W,
      W,
      (u, v) => {
        const n = fbm(u, v, 4, 11);
        const micro = fbm(u, v, 24, 5, 3);
        const weld = Math.exp(-(((v - 0.5) / (1.6 * px)) ** 2));
        const seam = Math.exp(-(((u - 0.5) / (1.0 * px)) ** 2));
        return [0.5 + 0.22 * weld - 0.25 * seam, 0.9 + (micro - 0.5) * 0.22 + (n - 0.5) * 0.12 - 0.12 * weld, 1];
      },
      { channel: 1, tile_m: 4 },
    ),
    // Brushed metal: fine streaks along v (roughness in G), for the bare-metal bells; uv.x counts cooling tubes.
    brushed: (() => {
      const tex = dataTexture(256, 8, (u) => {
        const n = 0.6 * vnoise(u, 0, 128, 61) + 0.4 * vnoise(u, 0, 32, 62);
        return [0.5, 0.7 + 0.5 * (n - 0.5), 1];
      });
      tex.repeat.set(1 / 12, 1);
      return tex;
    })(),
    // Carbon composite twill as a normal map (from the weave height below), 0.5 m tile on uv1.
    weaveN: (() => {
      const h = (u, v) => {
        const cu = Math.floor(u * 16);
        const cv = Math.floor(v * 16);
        const alongU = (((cu + cv) % 4) + 4) % 4 < 2;
        const f = alongU ? (((v * 16) % 1) + 1) % 1 : (((u * 16) % 1) + 1) % 1;
        return 0.5 + 0.3 * Math.sin(f * Math.PI);
      };
      const e = 1 / 128;
      return dataTexture(
        128,
        128,
        (u, v) => {
          const dx = (h(u + e, v) - h(u - e, v)) * 1.6;
          const dy = (h(u, v + e) - h(u, v - e)) * 1.6;
          const l = Math.hypot(dx, dy, 1);
          return [(-dx / l) * 0.5 + 0.5, (-dy / l) * 0.5 + 0.5, (1 / l) * 0.5 + 0.5];
        },
        { channel: 1, tile_m: 0.5 },
      );
    })(),
    // Carbon composite twill, 0.5 m tile on uv1.
    weave: dataTexture(
      64,
      64,
      (u, v) => {
        const cu = Math.floor(u * 16);
        const cv = Math.floor(v * 16);
        const alongU = (cu + cv) % 4 < 2;
        const f = alongU ? (v * 16) % 1 : (u * 16) % 1;
        const h = 0.5 + 0.3 * Math.sin(f * Math.PI);
        return [h, 0.85 + 0.15 * (alongU ? 1 : 0.6), 1];
      },
      { channel: 1, tile_m: 0.5 },
    ),
  };
  return TEX;
}

// ---------- materials ----------

export function createMaterials() {
  const t = textures();
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const metal = (color, roughness = 0.34, metalness = 0.9) => std({ color, metalness, roughness });
  // Matte paint, low metalness, seams/welds from the shared skin texture.
  const painted = (color, extra = {}) =>
    std({ color, metalness: 0.05, roughness: 0.62, bumpMap: t.seams, bumpScale: 1.2, roughnessMap: t.seams, ...extra });
  const mli = (color) => std({ color, metalness: 1, roughness: 0.34, bumpMap: t.crinkle, bumpScale: 2.2, roughnessMap: t.crinkle });
  const classic = {
    body: painted(COLORS.body),
    roll: painted(0xe4e4e0, { map: t.roll }),
    foam: std({ color: 0xffffff, map: t.foam, bumpMap: t.foam, bumpScale: 1.6, metalness: 0, roughness: 0.9 }),
    bronze: painted(0xa65f35, { metalness: 0.12, roughness: 0.66 }),
    silver: painted(0xb9bdc2, { metalness: 0.7, roughness: 0.34 }),
    composite: std({ color: 0x141518, metalness: 0.22, roughness: 0.5, bumpMap: t.weave, bumpScale: 0.6, roughnessMap: t.weave }),
    raceway: painted(0xc4c6c1),
    skirt: std({ color: 0x24262b, metalness: 0.5, roughness: 0.6 }),
    heatShield: std({ color: 0x1d1e21, metalness: 0.25, roughness: 0.88 }),
    metal: metal(0xa8acb2, 0.3),
    darkMetal: metal(0x3b3f48, 0.42, 0.85),
    // Inside the tanks: bare aluminium, not the painted finish.
    interior: metal(0xb7bbc1, 0.38, 0.85),
    // Machined rings and flanges: bright metal with a fine knurl.
    machined: std({ color: 0xaeb2b9, metalness: 1, roughness: 0.26, bumpMap: t.knurl, bumpScale: 0.8, roughnessMap: t.knurl }),
    // Engines: dark ridged metal bell (per-vertex colour = faint heat tint toward the throat, lighter flanges)
    // and bare-metal sub-assemblies around it.
    engine: std({ color: 0xffffff, vertexColors: true, metalness: 0.8, roughness: 0.55, envMapIntensity: 0.6, bumpMap: t.ridges, bumpScale: 0.25, roughnessMap: t.ridges }),
    chamber: metal(0x6e5d50, 0.38),
    powerhead: metal(0x8d9198, 0.36),
    valve: metal(0x5d6168, 0.4, 0.85),
    pump: metal(0xb3b7bd, 0.3, 0.92),
    pipe: metal(0xc4c8ce, 0.24, 0.95),
    actuator: metal(0x9a9ea6, 0.2, 0.95),
    gimbal: metal(0x2a2c31, 0.5, 0.8),
    gridFin: metal(0x4d5056, 0.46, 0.85),
    gold: mli(COLORS.gold),
    mliSilver: mli(0xc6c9ce),
    // Gold-coated mirror segments (smooth, unlike the crinkled blankets).
    mirror: std({ color: 0xd9ad55, metalness: 1, roughness: 0.12 }),
    // Ablative composite nozzle (visuals.engines[id].bellFinish "ablative"): tan, matte.
    ablative: std({ color: 0xc9b597, metalness: 0, roughness: 0.9 }),
    // Two-tone foil blankets (gold / black / silver per vertex colour), e.g. the LM descent stage.
    foil: std({ color: 0xffffff, vertexColors: true, metalness: 1, roughness: 0.34, bumpMap: t.crinkle, bumpScale: 2.2, roughnessMap: t.crinkle }),
    panel: std({ color: 0xffffff, map: t.cells, metalness: 0.45, roughness: 0.28, emissive: 0x050b1a, emissiveIntensity: 1 }),
    // legacy keys (kept so older callers still find them)
    accent: std({ color: COLORS.accent, metalness: 0.5, roughness: 0.5 }),
    dark: std({ color: 0x23262e, metalness: 0.7, roughness: 0.55 }),
  };
  // Roles used by the builders (same keys in both looks).
  classic.trim = classic.body; // painted parts that are not shells (fins, IU ring, CM, dish)
  classic.leg = classic.composite;
  classic.copv = classic.composite;
  classic.steelDark = classic.darkMetal;
  // Role names travel with the materials into piece() (mesh.userData.role): the bells are found by role.
  const tag = (set) => {
    for (const k of Object.keys(set)) if (!Object.hasOwn(set[k], "role")) Object.defineProperty(set[k], "role", { value: k });
  };
  if (!XRAY) return tag(classic), classic;
  const x = xrayMaterials(t, classic);
  const paint = paintedMaterials(t, classic);
  // Each role gets its own x-ray object (the x-ray set shares a few) carrying its painted twin; piece() reads
  // material.painted and keeps both on the mesh (setShellOpacity switches).
  const seen = new Set();
  for (const k of Object.keys(x)) {
    let m = x[k];
    if (seen.has(m)) {
      const c = cloneMat(m);
      if (m.asShell) Object.defineProperty(c, "asShell", { value: m.asShell });
      m = x[k] = c;
    }
    seen.add(m);
    if (paint[k]) Object.defineProperty(m, "painted", { value: paint[k], configurable: true });
  }
  tag(x);
  return x;
}

// Soot: darkens paint toward the part's base in uneven vertical streaks, and dulls its roughness and clear
// coat. Per material: material.soot = { value: Vector4(y0, height, strength, 0) } in mesh-local units: full
// strength at y0, gone by y0 + height
// (set by createPart; strength 0 = clean). The streak pattern runs on the mesh-local azimuth.
//
// Frost (same hook): a matte blue-white layer over cryogenic tank skin above an edge at mesh-local y, the edge
// wavering with 3D noise and drifting slowly in time; patchy inside. material.frost = { value: Vector4(edgeY,
// waver, amount, softness) } (amount 0 = none). The time uniform is shared and set before each frosted draw.
// Instanced detail on a shell (its rivets) takes the same hook with its host's uniforms (see createPart), so the
// rivets soot and frost with the skin they sit on.
const frostTime = { value: 0 };
const tickFrost = () => (frostTime.value = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000);
function sootHook(shader) {
  shader.uniforms.uSoot = this.soot ?? (this.soot = { value: new THREE.Vector4(0, 1, 0, 0) });
  shader.uniforms.uFrost = this.frost ?? (this.frost = { value: new THREE.Vector4(0, 0, 0, 1) });
  shader.uniforms.uFrostT = frostTime;
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec2 vSoot;\nvarying vec3 vSootP;")
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      vec3 sootP = position;
      #ifdef USE_INSTANCING
        sootP = (instanceMatrix * vec4(position, 1.0)).xyz; // instanced detail: in its host piece's frame
      #endif
      vSoot = vec2(sootP.y, atan(sootP.x, sootP.z));
      vSootP = sootP;`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
      varying vec2 vSoot;
      varying vec3 vSootP;
      uniform vec4 uSoot, uFrost;
      uniform float uFrostT;
      float frostH(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float frostN(vec3 p) {
        vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(frostH(i), frostH(i + vec3(1, 0, 0)), f.x), mix(frostH(i + vec3(0, 1, 0)), frostH(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(frostH(i + vec3(0, 0, 1)), frostH(i + vec3(1, 0, 1)), f.x), mix(frostH(i + vec3(0, 1, 1)), frostH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
      }`,
    )
    .replace(
      "#include <map_fragment>",
      `#include <map_fragment>
      float sootStreak = 0.5 + 0.25 * sin(vSoot.y * 23.0 + 1.7 * sin(vSoot.y * 7.0)) + 0.25 * sin(vSoot.y * 61.0 + 0.4);
      float sootG = 1.0 - smoothstep(uSoot.x, uSoot.x + uSoot.y * (0.55 + 0.9 * sootStreak), vSoot.x);
      float soot = uSoot.z * sootG * (2.0 - sootG);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.032, 0.03), soot);
      float frost = 0.0;
      if (uFrost.z > 0.0) {
        vec3 fp = vSootP * 4.0 + vec3(0.0, 0.0, uFrostT * 0.02);
        float edge = uFrost.x + uFrost.y * (frostN(fp) + 0.5 * frostN(fp * 2.7) - 0.75);
        float fine = 0.6 * frostN(vSootP * 9.0) + 0.4 * frostN(vSootP * 25.0);
        frost = uFrost.z * smoothstep(edge - uFrost.w, edge + uFrost.w, vSoot.x) * (0.65 + 0.35 * frostN(vSootP * 5.0 + 3.1)) * (1.0 - soot);
        float wet = uFrost.z * exp(-pow((vSoot.x - edge + 2.5 * uFrost.w) / uFrost.w, 2.0)); // condensation under the line
        diffuseColor.rgb *= 1.0 - 0.14 * wet;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.81, 0.9) * (0.74 + 0.3 * fine), frost);
      }`,
    )
    .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(roughnessFactor, 0.85, soot), 0.92, frost);")
    .replace(
      "#include <lights_physical_fragment>",
      `#include <lights_physical_fragment>
      #ifdef USE_CLEARCOAT
        material.clearcoat *= (1.0 - 0.8 * soot) * (1.0 - frost);
      #endif`,
    );
}
const sootKey = () => "paint-soot-frost-v4";

// Bell glow: an emissive ramp on the nozzle while it fires, orange at the lip to dull red at the throat, the
// inside (back faces) brightest. Chained after any hook the material already has (the x-ray shell's rim).
// material.glow = { value: Vector4(lipY, throatY, intensity, 0) } in mesh-local units, shared by both looks.
const GLOW_LIP = new THREE.Color(1.0, 0.42, 0.1);
const GLOW_THROAT = new THREE.Color(0.6, 0.07, 0.02);
function addBellGlow(m, glow) {
  const prev = m.onBeforeCompile;
  const prevKey = prev === THREE.Material.prototype.onBeforeCompile ? "" : m.customProgramCacheKey();
  m.glow = glow;
  m.onBeforeCompile = function (shader, renderer) {
    prev.call(this, shader, renderer);
    shader.uniforms.uGlow = this.glow;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vGlowY;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlowY = position.y;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vGlowY;\nuniform vec4 uGlow;")
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        if (uGlow.z > 0.0) {
          float glowT = clamp((vGlowY - uGlow.x) / max(uGlow.y - uGlow.x, 1e-5), 0.0, 1.0);
          vec3 glowC = mix(vec3(${GLOW_LIP.toArray().map((v) => v.toFixed(3))}), vec3(${GLOW_THROAT.toArray().map((v) => v.toFixed(3))}), glowT);
          totalEmissiveRadiance += glowC * uGlow.z * (gl_FrontFacing ? 0.35 : 1.0) * 1.6;
        }`,
      );
  };
  m.customProgramCacheKey = () => `${prevKey}|bell-glow-v1`;
}
const BELL_ROLES = new Set(["engine", "ablative"]);
// Painted PBR twins of every role (round 15). Paint: MeshPhysicalMaterial, clear coat 0.4, roughness 0.35-0.5
// broken up by the paint map's micro-roughness, soot near the base (sootHook). Bells: brushed bare metal with an
// anisotropic highlight. Composite: black with a weave normal. Metals and blankets keep their classic look.
// polygonOffset on all, so the faint edge lines sit cleanly on them. Colours are visual.
function paintedMaterials(t, classic) {
  const po = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const phys = (o) => new THREE.MeshPhysicalMaterial({ metalness: 0, roughness: 0.42, clearcoat: 0.4, clearcoatRoughness: 0.22, fog: true, ...po, ...o });
  const sooty = (m) => {
    m.onBeforeCompile = sootHook;
    m.customProgramCacheKey = sootKey;
    m.userData.soot = true;
    return m;
  };
  const paint = (color, extra = {}) => phys({ color, roughnessMap: t.paint, bumpMap: t.paint, bumpScale: 1.0, ...extra });
  const composite = () => phys({ color: 0x15161a, metalness: 0.2, roughness: 0.38, roughnessMap: t.weave, normalMap: t.weaveN, normalScale: new THREE.Vector2(0.7, 0.7), clearcoat: 0.5, clearcoatRoughness: 0.18 });
  const keep = (m) => {
    const c = cloneMat(m);
    Object.assign(c, po);
    return c;
  };
  const white = sooty(paint(0xc4c6c2)); // light grey, so the shading reads in the sun (round 22: no flat white)
  return {
    body: white,
    roll: sooty(paint(0xc4c4c0, { map: t.roll })),
    foam: sooty(phys({ color: 0xffffff, map: t.foam, bumpMap: t.foam, bumpScale: 1.6, roughness: 0.82, clearcoat: 0.05 })),
    bronze: sooty(paint(0xa65f35, { metalness: 0.15, roughness: 0.45 })),
    silver: sooty(paint(0xb9bdc2, { metalness: 0.7, roughness: 0.35 })),
    composite: sooty(composite()),
    // Octaweb heat shield: dark plates with grooves and bolts (the "dance floor").
    heatShield: phys({ color: 0x3a3b3e, metalness: 0.35, roughness: 0.72, map: t.plates, bumpMap: t.plates, bumpScale: 1.2, clearcoat: 0 }),
    raceway: paint(0xc4c6c1),
    skirt: keep(classic.skirt),
    metal: keep(classic.metal),
    darkMetal: keep(classic.darkMetal),
    interior: keep(classic.interior),
    steelDark: keep(classic.darkMetal),
    trim: paint(0xe9eae6),
    leg: composite(),
    copv: composite(),
    machined: keep(classic.machined),
    // Bare-metal bell: vertex colours (heat tint, flanges) lifted to read as metal, brushed streaks, tube ridges.
    // (vertex colours × 1.25: dark brushed metal; brighter read as chrome and blew out under bloom)
    engine: phys({ color: new THREE.Color(1.25, 1.25, 1.25), vertexColors: true, metalness: 1, roughness: 0.42, roughnessMap: t.brushed, bumpMap: t.ridges, bumpScale: 0.25, anisotropy: 0.55, anisotropyRotation: Math.PI / 2, clearcoat: 0, envMapIntensity: 0.9 }),
    chamber: keep(classic.chamber),
    powerhead: keep(classic.powerhead),
    valve: keep(classic.valve),
    pump: keep(classic.pump),
    pipe: keep(classic.pipe),
    actuator: keep(classic.actuator),
    gimbal: keep(classic.gimbal),
    // Cast titanium grid fins: grey metal, rough, a faint warm heat tint.
    gridFin: phys({ color: 0x8a8580, metalness: 0.85, roughness: 0.52, roughnessMap: t.paint, clearcoat: 0 }),
    gold: keep(classic.gold),
    mliSilver: keep(classic.mliSilver),
    foil: keep(classic.foil),
    mirror: phys({ color: 0xe0b45a, metalness: 1, roughness: 0.08, clearcoat: 0 }),
    ablative: phys({ color: 0xcdb99b, metalness: 0, roughness: 0.88, roughnessMap: t.paint, clearcoat: 0 }),
    panel: keep(classic.panel),
    accent: keep(classic.accent),
    dark: keep(classic.dark),
  };
}

// Fresnel rim in peach, added to the emissive term; the rim also lifts alpha so silhouettes read through.
function fresnelRim(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <emissivemap_fragment>",
    `#include <emissivemap_fragment>
    float xrayRim = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 4.0) * 0.8;
    totalEmissiveRadiance += vec3(1.0, 0.706, 0.541) * xrayRim;
    diffuseColor.a = min(1.0, diffuseColor.a + xrayRim * 0.3);`,
  );
}
const fresnelKey = () => "xray-shell-rim-v2";

function xrayMaterials(t, classic) {
  // X-ray shell: graphite, see-through, no depth write, front faces only. Finishes survive as tints;
  // `scale` multiplies the shell opacity (darker composite reads denser; the roll pattern's black bands are
  // opaque through its alphaMap, so its base opacity is scaled to 1).
  const shell = (color, { scale = 1, map = null, alphaMap = null } = {}) => {
    // Low metalness so the key light shades the cylinder light → shadow (depth); clearcoat adds a soft sheen.
    const m = new THREE.MeshPhysicalMaterial({ color, roughness: 0.55, metalness: 0.25, clearcoat: 0.25, clearcoatRoughness: 0.4, fog: true, transparent: true, opacity: clamp(SHELL_OPACITY * scale, 0, 1), depthWrite: false, side: THREE.FrontSide, map, alphaMap });
    m.onBeforeCompile = fresnelRim;
    m.customProgramCacheKey = fresnelKey;
    m.userData.opacityScale = scale;
    return m;
  };
  // Opaque internals: polygon offset pushes faces back so the edge lines sit cleanly on them.
  const po = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const steel = (color, roughness, metalness, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, fog: true, ...po, ...extra });
  const light = steel(0xb9bec7, 0.35, 0.6); // brushed steel; 0.6 so internals read as lit forms, not mirrors
  const dark = steel(0x4a4f58, 0.4, 0.85);
  const sh = {
    white: shell(0x202328),
    roll: shell(0x24272c, { map: t.roll, alphaMap: t.rollAlpha, scale: 1 / SHELL_OPACITY }),
    foam: shell(0x45291a),
    bronze: shell(0x3a2e25),
    silver: shell(0x2f3338),
    composite: shell(0x101114, { scale: 1.2 }),
    gold: shell(0x382f1d),
    heat: shell(0x151618, { scale: 1.15 }),
  };
  // A material that is not a shell but whose piece may be (bell extension, MLI bus skins) names its shell.
  const asShell = (m, s) => Object.defineProperty(m, "asShell", { value: s });
  return {
    body: sh.white,
    roll: sh.roll,
    foam: sh.foam,
    bronze: sh.bronze,
    silver: asShell(steel(0xc3c7cd, 0.32, 0.9), sh.silver),
    composite: sh.composite,
    heatShield: sh.heat,
    raceway: dark,
    skirt: dark,
    metal: light,
    darkMetal: dark,
    interior: light,
    steelDark: dark,
    trim: light,
    leg: dark,
    copv: dark,
    machined: steel(0xc6cad1, 0.24, 1, { bumpMap: t.knurl, bumpScale: 0.6, roughnessMap: t.knurl }),
    engine: asShell(steel(0xffffff, 0.5, 0.8, { vertexColors: true, envMapIntensity: 0.6, bumpMap: t.ridges, bumpScale: 0.25, roughnessMap: t.ridges }), sh.white),
    chamber: steel(0xa59c93, 0.36, 0.9),
    powerhead: light,
    valve: dark,
    pump: dark,
    pipe: dark,
    actuator: light,
    gimbal: dark,
    gridFin: dark,
    gold: asShell(steel(COLORS.gold, 0.34, 1, { bumpMap: t.crinkle, bumpScale: 2.2, roughnessMap: t.crinkle }), sh.gold),
    mliSilver: asShell(steel(0xc6c9ce, 0.34, 1, { bumpMap: t.crinkle, bumpScale: 2.2, roughnessMap: t.crinkle }), sh.silver),
    foil: asShell(steel(0xffffff, 0.34, 1, { vertexColors: true, bumpMap: t.crinkle, bumpScale: 2.2, roughnessMap: t.crinkle }), sh.gold),
    mirror: steel(0xd9ad55, 0.15, 1),
    ablative: asShell(steel(0xc9b597, 0.85, 0.05), sh.white),
    panel: steel(0xffffff, 0.28, 0.45, { map: t.cells, emissive: 0x050b1a, emissiveIntensity: 1 }),
    accent: classic.accent,
    dark: dark,
  };
}

// Peach technical edge lines (x-ray look): one shared base, cloned per line object so opacity can follow
// its shell. Structural lines come from the mesh geometry (or a cleaner line-only geometry); fine lines (weld
// lands, clamps) from an optional extra geometry, at a lower opacity. userData.base = opacity when built.
let lineBase = null;
const edgeCache = new WeakMap();
// Depth cue: far lines fade more than fog alone gives, alpha *= 1 − 0.6 · smoothstep(fogNear, fogFar, depth),
// using the scene's linear fog uniforms (no-op without fog or with exponential fog).
function lineDepthAlpha(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <fog_fragment>",
    `#include <fog_fragment>
    #if defined( USE_FOG ) && !defined( FOG_EXP2 )
      gl_FragColor.a *= 1.0 - 0.6 * smoothstep( fogNear, fogFar, vFogDepth );
    #endif`,
  );
}
const lineDepthKey = () => "xray-line-depth-v1";
// Peach technical line material (fog on, depth fade): the edge lines on every piece.
export function peachLineMaterial(opacity = LINE_STRUCT) {
  lineBase ??= new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: LINE_STRUCT, depthTest: true, fog: true });
  const m = lineBase.clone();
  m.onBeforeCompile = lineDepthAlpha; // set per clone: Material.copy drops shader hooks
  m.customProgramCacheKey = lineDepthKey;
  m.opacity = opacity;
  return m;
}
function lineChild(mesh, geo, base, name) {
  let eg = edgeCache.get(geo);
  if (!eg) edgeCache.set(geo, (eg = new THREE.EdgesGeometry(geo, 25)));
  const m = peachLineMaterial(base);
  const lines = new THREE.LineSegments(eg, m);
  lines.raycast = () => {}; // picking stays on the meshes
  lines.name = name;
  lines.userData.base = base;
  mesh.add(lines);
  return lines;
}
// lineGeo === false: no structural layer (long shells whose rims are drawn by their rings).
function addEdges(mesh, { kind, lineGeo = null, fineGeo = null } = {}) {
  if (lineGeo !== false) mesh.userData.edges = lineChild(mesh, lineGeo ?? mesh.geometry, kind === "interior" ? LINE_INTERIOR : LINE_STRUCT, "edges");
  if (fineGeo) mesh.userData.edgesFine = lineChild(mesh, fineGeo, LINE_FINE, "edges-fine");
}

const finishMat = (mats, finish) =>
  ({ "white-black-roll": mats.roll, "orange-foam": mats.foam, bronze: mats.bronze, silver: mats.silver, "black-composite": mats.composite })[finish] ??
  mats.body;
// Short structures (thrust-section skin) take the stage colour but never the roll pattern (mapped per shell).
const plainFinish = (mats, finish) => finishMat(mats, finish === "white-black-roll" ? "white" : finish);

// ---------- geometry helpers (metres) ----------

const lathe = (pts, segments, phiStart = 0, phiLength = TAU) =>
  new THREE.LatheGeometry(
    pts.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0005), y)),
    segments,
    phiStart,
    phiLength,
  );

// Lathe UVs: uv = (phi / 2π, y / H) normalized (finish maps), uv1 = (arc length, y) in metres (skin textures).
function latheUV(geo, { phiStart = 0, phiLength = TAU, H = 1, R = 1, y0 = 0 }) {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const uv1 = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const phi = phiStart + uv.getX(i) * phiLength;
    const y = pos.getY(i);
    uv.setXY(i, phi / TAU, (y - y0) / H);
    uv1[i * 2] = phi * R;
    uv1[i * 2 + 1] = y;
  }
  geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
  return geo;
}

// Planar UVs in metres by dominant normal axis, on both channels (crinkle, cells, skin seams on small parts).
function projectUV(geo) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    const az = Math.abs(n.getZ(i));
    let u;
    let v;
    if (ay >= ax && ay >= az) (u = p.getX(i)), (v = p.getZ(i));
    else if (ax >= az) (u = p.getZ(i)), (v = p.getY(i));
    else (u = p.getX(i)), (v = p.getY(i));
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("uv1", new THREE.BufferAttribute(uv.slice(), 2));
  return geo;
}

// Merge into one geometry (one piece, one material). Keeps only the attributes every input has.
function merge(geos) {
  let list = geos.filter(Boolean);
  if (list.some((g) => !g.index)) list = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const names = Object.keys(list[0].attributes).filter((n) => list.every((g) => g.attributes[n]));
  for (const g of list) {
    for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n);
    g.clearGroups();
  }
  const out = mergeGeometries(list, false);
  if (!out) throw new Error("parts.js: geometry merge failed");
  return out;
}

const box = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const cyl = (rTop, rBot, h, seg, x = 0, y = 0, z = 0, open = false) =>
  new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open).translate(x, y + h / 2, z); // y = bottom
const tube = (a, c, b, r, seg = 8) => new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, c, b), seg, r, 6, false);
const rod = (a, b, r, seg = 2) => tube(a, a.clone().lerp(b, 0.5), b, r, seg);

// Box spanning a → b (long axis), thin side facing `out` (baked orientation, no mesh rotation needed).
function strut(a, b, w, d, out) {
  const yAxis = b.clone().sub(a);
  const len = yAxis.length();
  yAxis.normalize();
  const zAxis = new THREE.Vector3().crossVectors(out, yAxis).normalize();
  const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
  return new THREE.BoxGeometry(d, len, w)
    .applyMatrix4(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis))
    .translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

// Machined ring between radii rIn..rOut, height h, bottom at y0: chamfered edges and a shallow centre groove
// so it catches crisp highlights (the anime.js-lens look). Closed lathe profile.
function machinedRing(rIn, rOut, h, y0 = 0, seg = 64) {
  const w = rOut - rIn;
  const c = Math.min(0.25 * w, 0.18 * h);
  const g = Math.min(0.3 * w, 0.1 * h);
  const pts = [
    [rIn, y0 + h],
    [rIn, y0],
    [rOut - c, y0],
    [rOut, y0 + c],
    [rOut, y0 + 0.38 * h],
    [rOut - g, y0 + 0.44 * h],
    [rOut - g, y0 + 0.56 * h],
    [rOut, y0 + 0.62 * h],
    [rOut, y0 + h - c],
    [rOut - c, y0 + h],
    [rIn, y0 + h],
  ];
  return latheUV(lathe(pts, seg), { H: h, R: rOut, y0 });
}

// Tangent ogive of base radius R and length L starting at y0 (s measured from the base).
function ogivePoints(R, L, y0, n = 32) {
  const rho = (R * R + L * L) / (2 * R);
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const s = (L * i) / n;
    pts.push([Math.sqrt(Math.max(rho * rho - s * s, 0)) + R - rho, y0 + s]);
  }
  return pts;
}

// Elliptical dome as a lathe profile; up = bulges up from the rim at y=0 to y=h, else down to y=-h.
function domePoints(R, h, up, n = 12) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI / 2) * (i / n);
    pts.push([R * Math.cos(a), (up ? 1 : -1) * h * Math.sin(a)]);
  }
  return up ? pts : pts.reverse();
}

// Ring of n small blocks (bolt heads, knurl teeth) on radius r centred at height y: w tangential,
// h tall, d radial. One merged geometry with uv/uv1, so it merges into rings, flanges and lathes.
function boltRing(r, y, n, w, h = w, d = w, phase = 0) {
  const geos = [];
  for (let i = 0; i < n; i++) {
    const phi = phase + (i / n) * TAU;
    geos.push(new THREE.BoxGeometry(d, h, w).rotateY(phi - Math.PI / 2).translate(Math.sin(phi) * r, y, Math.cos(phi) * r));
  }
  return projectUV(merge(geos));
}
const paint = (geo, rgb) => {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(rgb, i * 3);
  geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return geo;
};

// Per-profile-point vertex colours for a lathe (vertex index = segmentIndex × points + pointIndex).
function colorLathe(geo, nPts, colorOf) {
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set(colorOf(i % nPts, geo.attributes.position.getY(i)), i * 3);
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return geo;
}

// ---------- piece factory ----------

// Material clone that keeps a shader hook (Material.copy drops onBeforeCompile / customProgramCacheKey).
function cloneMat(src) {
  const m = src.clone();
  if (src.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) {
    m.onBeforeCompile = src.onBeforeCompile;
    m.customProgramCacheKey = src.customProgramCacheKey;
  }
  return m;
}

const scaled = new WeakSet();
const probeOf = new WeakMap(); // lander leg mesh → its contact-probe geometry (drawn on the landerOf copy only)
function toUnits(geo) {
  if (!scaled.has(geo)) {
    geo.scale(S, S, S);
    scaled.add(geo);
  }
  return geo;
}

// Geometry and offsets in metres; explode.dist in scene units.
//   ax   = [group, side, rank] tag for the axial pull-apart (see axisOffsets)
//   sym  = axisymmetric piece on the axis (own alternating spin); off-axis pieces share the part's spin so a
//          ring of shells / a cluster rotates rigidly in the exploded view (see assignSpins)
//   kind = "shell" | "interior" | "detail"; engine = engine index or null
function piece(geo, material, { x = 0, y = 0, z = 0, ry = 0, order = 0, dir = UP, dist = 0.4, side, ax = null, sym = false, kind = "detail", engine = null, edges = kind === "shell", lineGeo = null, fineGeo = null, deploy = null, follow = null, lander = null, landerLeg = null, dock = false, probe = null } = {}) {
  const g = toUnits(geo);
  g.computeBoundingBox();
  const xrayShell = XRAY && kind === "shell";
  const src = xrayShell && material.asShell ? material.asShell : material;
  const mat = cloneMat(src);
  if (side !== undefined && !xrayShell) mat.side = side; // x-ray shells stay front-side
  // Painted twin (default look); both live on the mesh and setShellOpacity switches between them.
  const painted = XRAY && material.painted ? cloneMat(material.painted) : null;
  if (painted && side !== undefined) painted.side = side;
  const mesh = new THREE.Mesh(g, painted ?? mat);
  mesh.userData.role = material.role ?? null;
  if (painted) {
    mesh.userData.looks = { xray: mat, painted };
    for (const m of [mat, painted]) if (m.emissive) m.userData.emissive0 = [m.emissive.getHex(), m.emissiveIntensity];
  }
  mesh.position.set(x * S, y * S, z * S);
  mesh.rotation.y = ry;
  // Performance: only shells cast and receive shadows (internals sit inside them anyway).
  mesh.castShadow = kind === "shell";
  mesh.receiveShadow = kind === "shell";
  mesh.userData.kind = kind;
  mesh.userData.engine = engine;
  // Edge lines only on shells (default) and pieces marked edges: true (domes, rings, fins, legs, payload
  // bodies); never on bolts, clamps, pipes, pumps, stringers. lineGeo / fineGeo (metres, same frame as geo)
  // give a cleaner structural layer (e.g. a ring without its bolts) and a fine layer.
  if (XRAY && edges) addEdges(mesh, { kind, lineGeo: lineGeo && toUnits(lineGeo), fineGeo: fineGeo && toUnits(fineGeo) });
  // deploy is given in the geometry's own frame (metres, before the Y turn); store it part-local.
  const hingeOf = (h) => {
    if (!h) return null;
    const qy = new THREE.Quaternion().setFromAxisAngle(UP, ry);
    return {
      axis: h.axis.clone().normalize().applyQuaternion(qy),
      pivot: h.pivot.clone().multiplyScalar(S).applyQuaternion(qy).add(mesh.position),
      angle: h.angle,
      order: h.order ?? 0,
    };
  };
  const dep = hingeOf(deploy);
  // Landable sub-part (landerOf): lander = "descent" | "ascent" | "leg"; a leg's hinge is landerLeg, kept out of
  // `deploy` so the payload's own deploy (the SLA petals) does not swing it; dock marks the docking apex.
  if (lander) mesh.userData.lander = lander;
  if (probe) probeOf.set(mesh, toUnits(probe));
  if (dock) mesh.userData.dock = true;
  // follow points are given like the deploy pivot (metres, the geometry's own frame).
  let fol = null;
  if (follow) {
    const qy = new THREE.Quaternion().setFromAxisAngle(UP, ry);
    const toPart = (p) => p.clone().multiplyScalar(S).applyQuaternion(qy).add(mesh.position);
    fol = { leader: follow.leader, B: toPart(follow.B), L: toPart(follow.L), end: follow.end };
  }
  return { mesh, order, explode: { dir: dir.clone().normalize(), dist }, ax, sym, kind, engine, deploy: dep, follow: fol, landerLeg: hingeOf(landerLeg) };
}

// ---------- instanced fine detail ----------

// Static fine detail at no animation cost (density pass): rivet rows along seams, bolt circles on flanges,
// pipe clamps and raceway straps. One InstancedMesh per detail type per piece, a child of the piece's mesh, so
// it moves with the piece. Transforms are authored in metres in the piece geometry's own frame and stored in
// scene units (shared by every piece of the same shape, e.g. the engines of a cluster). The unit geometries
// are shared module-wide; a part's detail meshes share one painted and one x-ray material per detail type and
// colour (userData.looks, switched by setShellOpacity like the pieces; both MeshStandardMaterial with the same
// features, so the switch compiles nothing), so they draw back to back without material changes (nothing
// animates detail materials; pieces keep their own clones). On a shell piece the detail shows in the painted look only (userData.lookOnly "painted"): an
// x-ray shell is see-through and would leave it floating. No shadows, no edge lines, never picked
// (userData.nonPickable, raycast no-op); it is not a piece, so deploys, explode layouts and the line budget
// ignore it (check-budget counts each InstancedMesh as one mesh). mesh.userData.details lists them.
const DETAIL = {
  bolt: { painted: { color: 0x8c9199, metalness: 0.9, roughness: 0.32 }, xray: { color: 0xa3a9b2, metalness: 0.85, roughness: 0.3 } },
  rivet: { painted: { color: 0xb6b8b4, metalness: 0.45, roughness: 0.42 }, xray: { color: 0x5a5f68, metalness: 0.8, roughness: 0.4 } },
  clamp: { painted: { color: 0x767b83, metalness: 0.85, roughness: 0.4 }, xray: { color: 0xb4bac3, metalness: 0.7, roughness: 0.35 } },
  strap: { painted: { color: 0xa3a5a1, metalness: 0.5, roughness: 0.48 }, xray: { color: 0x5a5f68, metalness: 0.8, roughness: 0.4 } },
};
let detailGeos = null;
const detailGeo = (type) =>
  (detailGeos ??= {
    bolt: new THREE.CylinderGeometry(0.5, 0.5, 1, 6).translate(0, 0.5, 0), // hex head, unit across, base on y = 0, axis +Y
    rivet: lathe([[0.5, 0], [0.42, 0.16], [0.26, 0.28], [0, 0.32]], 6), // domed head, unit across
    clamp: new THREE.TorusGeometry(1, 0.22, 4, 10).rotateX(Math.PI / 2), // band round +Y, unit radius
    strap: new THREE.BoxGeometry(1, 1, 1), // centred unit box
  })[type];

// One instance (metres in, scene units out): the unit detail at p with its +Y turned onto n, scaled along its
// own axes, turned by `twist` about n.
const xfQ = new THREE.Quaternion();
const xfT = new THREE.Quaternion();
const xfN = new THREE.Vector3();
function xf(p, n, sx, sy = sx, sz = sx, twist = 0) {
  xfQ.setFromUnitVectors(UP, xfN.copy(n).normalize());
  if (twist) xfQ.multiply(xfT.setFromAxisAngle(UP, twist));
  return new THREE.Matrix4().compose(p.clone().multiplyScalar(S), xfQ, new THREE.Vector3(sx * S, sy * S, sz * S));
}
function instAttr(list) {
  const a = new Float32Array(list.length * 16);
  list.forEach((m, i) => m.toArray(a, i * 16));
  return new THREE.InstancedBufferAttribute(a, 16);
}
// Bolt heads on a circle of radius r at height y round (cx, cz): on a flange face (face "up" / "down") or
// standing out of a band (face "out"). size: across flats; h: head height.
function boltCircle(r, y, n, size, { face = "up", h = 0.6 * size, phase = 0, cx = 0, cz = 0 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const phi = phase + ((i + 0.5) / n) * TAU;
    const o = radialPhi(phi);
    out.push(xf(v3(cx + o.x * r, y, cz + o.z * r), face === "up" ? UP : face === "down" ? DOWN : o, size, h, size, phi));
  }
  return out;
}
// Rivet heads from a to b at about `pitch` apart, on a surface facing radially out from the Y axis.
function rivetRow(a, b, pitch, size) {
  const n = Math.max(2, Math.round(a.distanceTo(b) / pitch) + 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = a.clone().lerp(b, i / (n - 1));
    out.push(xf(p, v3(p.x, 0, p.z), size));
  }
  return out;
}
// Rivet heads round an arc of radius r at height y, lathe azimuth phi0 → phi1.
function rivetArc(r, y, phi0, phi1, pitch, size) {
  const n = Math.max(2, Math.round((r * Math.abs(phi1 - phi0)) / pitch) + 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = radialPhi(lerp(phi0, phi1, i / (n - 1)));
    out.push(xf(o.clone().multiplyScalar(r).setY(y), o, size));
  }
  return out;
}
// Pipe clamps: a band round a pipe of radius r at n points of a curve, between t0 and t1.
function clampsAlong(curve, r, n, t0 = 0.18, t1 = 0.82) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? (t0 + t1) / 2 : lerp(t0, t1, i / (n - 1));
    out.push(xf(curve.getPoint(t), curve.getTangent(t), 1.25 * r, 0.9 * r, 1.25 * r));
  }
  return out;
}
// Adds one InstancedMesh of `type` to a piece; list = Matrix4[] (from the helpers above) or a shared
// InstancedBufferAttribute. color overrides the painted colour (rivets take their host's paint).
let detailMats = null; // while createPart builds a part: `${type}|${color}` → { painted, xray }
function addDetail(pc, type, list, { lookOnly = null, color = null } = {}) {
  const attr = list?.isInstancedBufferAttribute ? list : instAttr(list ?? []);
  if (!attr.count) return null;
  const spec = DETAIL[type];
  const mk = (o) => new THREE.MeshStandardMaterial({ fog: true, ...o });
  const key = `${type}|${color}`;
  let pair = detailMats?.get(key);
  if (!pair) {
    pair = { painted: mk(color === null ? spec.painted : { ...spec.painted, color }), xray: XRAY ? mk(spec.xray) : null };
    detailMats?.set(key, pair);
  }
  const { painted, xray } = pair;
  const inst = new THREE.InstancedMesh(detailGeo(type), painted, attr.count);
  inst.instanceMatrix = attr;
  inst.castShadow = inst.receiveShadow = false;
  inst.raycast = () => {};
  Object.assign(inst.userData, { kind: "detail", detail: type, nonPickable: true });
  if (xray) inst.userData.looks = { painted, xray };
  if (lookOnly) inst.userData.lookOnly = lookOnly;
  pc.mesh.add(inst);
  (pc.mesh.userData.details ??= []).push(inst);
  return inst;
}

// ---------- parts ----------

// The geometry toolkit, for the part builders in src/droneParts.js (docs/drone-integration.md §6). Geometry is
// authored in metres and piece()/toUnits apply SCALE.
export const KIT = {
  piece, box, cyl, tube, rod, strut, lathe, latheUV, machinedRing, ogivePoints, domePoints, boltRing,
  merge, paint, colorLathe, toUnits, addDetail, boltCircle, rivetRow, rivetArc, clampsAlong,
  peachLineMaterial, addEdges, finishMat, plainFinish, projectUV,
  v3, radial, radialPhi, TAU, UP, DOWN, DS, clamp, lerp, COLORS, LOOK, XRAY,
  LINE_STRUCT, LINE_FINE, LINE_INTERIOR,
};

// The part builders, by kind: src/droneParts.js registers DRONE_BUILDERS here (main.js), so parts.js keeps no
// import of the drone side.
const BUILDERS = {};

export function registerBuilders(map) {
  Object.assign(BUILDERS, map);
}

// Axial pull-apart (anime.js-lens style). Pieces tagged ax = [group, side, rank] stack away from their group's
// core (side 0 stays) along Y: side +1 above the core, side −1 below, rank 0 nearest; pieces sharing a rank
// form one layer that moves together; layers are separated by `gap`, so nothing overlaps. Groups
// "top"/"bottom" stack beyond everything else in the part. Untagged pieces stay (0).
function axisOffsets(pieces, gap) {
  const extent = (list, withOffset) =>
    list.reduce(([lo, hi], p) => [Math.min(lo, p.bottomY + (withOffset ? p.axisOffset : 0)), Math.max(hi, p.topY + (withOffset ? p.axisOffset : 0))], [Infinity, -Infinity]);
  const stack = (list, coreLo, coreHi) => {
    for (const sign of [1, -1]) {
      const side = list.filter((p) => p.ax[1] === sign);
      const ranks = [...new Set(side.map((p) => p.ax[2]))].sort((a, b) => a - b);
      let cursor = sign > 0 ? coreHi : coreLo;
      for (const r of ranks) {
        const layer = side.filter((p) => p.ax[2] === r);
        const [lo, hi] = extent(layer, false);
        const off = sign > 0 ? cursor + gap - lo : cursor - gap - hi;
        for (const p of layer) p.axisOffset = off;
        cursor = sign > 0 ? hi + off : lo + off;
      }
    }
  };
  const groups = new Map();
  for (const p of pieces) {
    p.axisOffset = 0;
    if (!p.ax) continue;
    if (!groups.has(p.ax[0])) groups.set(p.ax[0], []);
    groups.get(p.ax[0]).push(p);
  }
  for (const [name, list] of groups) {
    if (name === "top" || name === "bottom") continue;
    const core = list.filter((p) => p.ax[1] === 0);
    const [lo, hi] = extent(core.length ? core : list, false);
    stack(list, lo, hi);
  }
  const placed = pieces.filter((p) => !p.ax || (p.ax[0] !== "top" && p.ax[0] !== "bottom"));
  const [lo, hi] = placed.length ? extent(placed, true) : [0, 0];
  for (const name of ["top", "bottom"]) if (groups.has(name)) stack(groups.get(name), lo, hi);
}

// Spins (radians about Y, 0.5–1.5 turns, alternating sign in arrival order). Off-axis pieces of a part share
// one spin so rings of shells, legs and engine columns rotate rigidly about the stack axis in the exploded
// view (no collisions); axisymmetric pieces get their own. Deterministic per part id.
function assignSpins(pieces, partId) {
  let seed = 0;
  for (const c of partId) seed = (seed * 31 + c.charCodeAt(0)) | 0;
  const turns = (k) => 0.5 + hash2(k, 7, seed);
  let sign = 1;
  let shared = null;
  pieces.forEach((p, i) => {
    if (p.sym) {
      p.spin = sign * turns(i) * TAU;
      sign = -sign;
    } else {
      if (shared === null) {
        shared = sign * turns(-1) * TAU;
        sign = -sign;
      }
      p.spin = shared;
    }
  });
}

export function createPart(spec, mats) {
  const group = new THREE.Group();
  group.name = spec.id;
  group.position.y = spec.slotY;
  detailMats = new Map(); // the part's detail materials (addDetail)
  const built = BUILDERS[spec.kind](spec, mats);
  detailMats = null;
  const pieces = built.map((p, i) => {
    const bb = p.mesh.geometry.boundingBox;
    p.mesh.userData.partId = spec.id;
    p.mesh.name = `${spec.id}:${i}`;
    for (const d of p.mesh.userData.details ?? []) {
      d.userData.partId = spec.id;
      d.name = `${p.mesh.name}:${d.userData.detail}`;
    }
    group.add(p.mesh);
    return {
      mesh: p.mesh,
      index: i,
      order: p.order ?? i,
      engine: p.engine,
      kind: p.kind,
      bottomY: bb.min.y + p.mesh.position.y,
      topY: bb.max.y + p.mesh.position.y,
      rest: { position: p.mesh.position.clone(), quaternion: p.mesh.quaternion.clone() },
      explode: p.explode,
      deploy: p.deploy,
      follow: p.follow,
      landerLeg: p.landerLeg,
      ax: p.ax,
      sym: p.sym,
      axisOffset: 0,
      spin: 0,
    };
  });
  // The painted materials' soot uniform, per piece from its own bottom edge up; strength 0 (no soot on a drone).
  for (const p of pieces) {
    const m = p.mesh.userData.looks?.painted;
    if (!m?.userData.soot) continue;
    const bb = p.mesh.geometry.boundingBox;
    m.soot = { value: new THREE.Vector4(bb.min.y, 1, 0, 0) };
  }
  // Followers: point each at its leader's part piece and list it on the leader (applyDeploy poses them).
  for (const p of pieces) {
    if (!p.follow) continue;
    const leader = pieces[built.indexOf(p.follow.leader)];
    p.follow = { ...p.follow, leader };
    (leader.followers ??= []).push(p);
  }
  // Bell glow: each engine's bell pieces share a lip-to-throat range (part-local y), one uniform per piece
  // shared by both looks (the glow strength stays 0: cold metal).
  const bellY = new Map();
  for (const p of pieces) {
    if (!BELL_ROLES.has(p.mesh.userData.role)) continue;
    const r = bellY.get(p.engine) ?? [Infinity, -Infinity];
    bellY.set(p.engine, [Math.min(r[0], p.bottomY), Math.max(r[1], p.topY)]);
  }
  for (const p of pieces) {
    const r = BELL_ROLES.has(p.mesh.userData.role) && bellY.get(p.engine);
    if (!r) continue;
    const glow = { value: new THREE.Vector4(r[0] - p.mesh.position.y, r[1] - p.mesh.position.y, 0, 0) };
    p.mesh.userData.bellGlow = glow;
    for (const m of new Set([p.mesh.material, ...Object.values(p.mesh.userData.looks ?? {})])) addBellGlow(m, glow);
  }
  // Rivets on a sooty / frosty skin take the skin's hook and uniforms, so they darken and frost with it. The
  // part's rivet material is shared by its quarters (equal values); a rivet set whose host differs gets its own.
  const same = (a, b) => (!a && !b) || (a && b && a.value.equals(b.value));
  for (const p of pieces) {
    const host = p.mesh.userData.looks?.painted;
    if (!host?.userData.soot) continue;
    for (const d of p.mesh.userData.details ?? []) {
      if (d.userData.detail !== "rivet") continue;
      let m = d.userData.looks?.painted ?? d.material;
      if (m.soot && same(m.soot, host.soot) && same(m.frost, host.frost)) continue;
      if (m.soot) {
        m = m.clone();
        if (d.userData.looks) d.userData.looks = { ...d.userData.looks, painted: m };
        if (d.material !== d.userData.looks?.xray) d.material = m;
      }
      m.soot = host.soot;
      m.frost = host.frost;
      m.onBeforeCompile = sootHook;
      m.customProgramCacheKey = sootKey;
      if (host.frost) d.onBeforeRender = tickFrost;
    }
  }
  axisOffsets(pieces, clamp(0.035 * spec.height, 0.04, 0.3));
  pieces.sort((a, b) => a.order - b.order || a.bottomY - b.bottomY);
  assignSpins(pieces, spec.id);
  for (const p of pieces) {
    delete p.ax;
    delete p.sym;
  }
  const part = { ...spec, group, pieces, built: false, busy: false };
  registerForDetail(part);
  return part;
}

// Shell pieces of a part, and their look: value ≥ PAINT_AT shows the painted materials (opaque, every edge line
// at LINE_PAINT / LINE_STRUCT of its built opacity); below it the x-ray materials, shells at opacity value and
// their lines scaled with them. Lines keep userData.base current for the look, so a caller that resets lines to
// base × dim (choreo) follows. A material switched out gets its own emissive back (no stuck highlight).
export const shellPieces = (part) => part.pieces.filter((p) => p.mesh.userData.kind === "shell");
const lineK = LINE_PAINT / LINE_STRUCT;
export function setShellOpacity(part, value) {
  const paint = value >= PAINT_AT;
  for (const p of part.pieces) {
    const looks = p.mesh.userData.looks;
    if (!looks) continue;
    const want = paint ? looks.painted : looks.xray;
    if (p.mesh.material !== want) {
      const old = p.mesh.material;
      const e0 = old.userData.emissive0;
      if (e0) old.emissive.setHex(e0[0]), (old.emissiveIntensity = e0[1]);
      p.mesh.material = want;
    }
    for (const e of [p.mesh.userData.edges, p.mesh.userData.edgesFine]) {
      if (!e) continue;
      e.userData.base0 ??= e.userData.base;
      e.userData.base = paint ? e.userData.base0 * lineK : e.userData.base0;
      e.material.opacity = e.userData.base;
    }
    // Instanced detail follows its piece's look; detail on a shell shows in the painted look only.
    for (const d of p.mesh.userData.details ?? []) {
      const dl = d.userData.looks;
      if (dl) d.material = paint ? dl.painted : dl.xray;
      if (d.userData.lookOnly) d.visible = d.userData.lookOnly === (paint ? "painted" : "xray");
    }
  }
  if (paint) return;
  for (const p of shellPieces(part)) {
    const m = p.mesh.material;
    if (!m.transparent) (m.transparent = true), (m.needsUpdate = true);
    m.opacity = clamp(value * (m.userData.opacityScale ?? 1), 0, 1);
    for (const e of [p.mesh.userData.edges, p.mesh.userData.edgesFine]) if (e) e.material.opacity = clamp((e.userData.base * value) / SHELL_OPACITY, 0, 1);
  }
}

// ---------- detail level (frame-time guard, ?lite=1) ----------

// setDetailLevel(level, target?): 2 = everything; 1 = instanced detail (rivets, bolts, clamps, straps) hidden
// and edge lines only on shells; 0 = no instanced detail, no lines, and the smallest 40 % of each part's
// "detail"-kind pieces (by bounding radius) not drawn. Hiding moves an object to HIDDEN_LAYER, which no camera,
// shadow camera or default Raycaster sees: nothing recompiles, `visible` stays the choreography's (build
// animations and the look switch keep working), hidden pieces keep animating and are never picked, and the
// original layers come back exactly on the way up. target: a part, an array of parts, or none for every live
// part (createPart registers them and applies the current level to new parts). Returns the level set.
const HIDDEN_LAYER = 31;
let detailLevel = 2;
const liveParts = new Set(); // WeakRef<part>
function registerForDetail(part) {
  // the smallest 40 % of the detail-kind pieces, by bounding radius (scene units)
  const small = part.pieces
    .filter((p) => p.kind === "detail")
    .map((p) => {
      const g = p.mesh.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      return [p, g.boundingSphere.radius];
    })
    .sort((a, b) => a[1] - b[1]);
  part.lodSmall = new Set(small.slice(0, Math.floor(small.length * 0.4)).map(([p]) => p));
  if (typeof WeakRef !== "undefined") liveParts.add(new WeakRef(part));
  if (detailLevel !== 2) applyDetailLevel(part, detailLevel);
}
function hideOn(o, hide) {
  if (!o) return;
  const u = (o.userData.lod ??= { mask: o.layers.mask });
  o.layers.mask = hide ? 1 << HIDDEN_LAYER : u.mask;
}
function applyDetailLevel(part, level) {
  for (const p of part.pieces) {
    const m = p.mesh;
    hideOn(m, level === 0 && part.lodSmall?.has(p));
    const shell = m.userData.kind === "shell";
    for (const e of [m.userData.edges, m.userData.edgesFine]) hideOn(e, level === 0 || (level === 1 && !shell));
    for (const d of m.userData.details ?? []) hideOn(d, level < 2);
  }
  part.detailLevel = level;
}
export function setDetailLevel(level = 2, target = null) {
  const lv = Number.isFinite(+level) ? clamp(Math.round(+level), 0, 2) : 2;
  let parts;
  if (target) parts = [].concat(target);
  else {
    detailLevel = lv;
    parts = [];
    for (const ref of liveParts) {
      const part = ref.deref();
      if (part) parts.push(part);
      else liveParts.delete(ref);
    }
  }
  for (const part of parts) if (part?.pieces) applyDetailLevel(part, lv);
  return lv;
}

// ---------- environment ----------

// Materials for the static props (the drone pad and stand): one material set, cloned per mesh.
let propMats = null;
export function propMaterials() {
  propMats ??= createMaterials();
  return propMats;
}
export const propMaterial = (m) => cloneMat(m);
const LINE_PROP = 0.35;

// Painted props: concrete, asphalt, painted markings and dark steel for the drone pad and the launch stand
// (per-member shade from vertex colours where the geometry has them). Colours and tiles are visual.
const PROP_LINE_K = LINE_PAINT / LINE_PROP; // prop lines over paint: the props' 0.35 level becomes 0.15
let propTex = null;
function propTextures() {
  if (propTex) return propTex;
  // Concrete: large stains, form-panel blotches and fine aggregate speckle (colour, sRGB; R doubles as bump).
  const concrete = dataTexture(
    256,
    256,
    (u, v) => {
      const stain = fbm(u, v, 3, 71, 4);
      const agg = vnoise(u, v, 128, 72);
      const fleck = hash2(Math.floor(u * 256), Math.floor(v * 256), 73);
      const k = 0.86 + 0.16 * (stain - 0.5) + 0.07 * (agg - 0.5) + (fleck > 0.97 ? -0.12 : fleck < 0.02 ? 0.08 : 0);
      return [k, k * 0.985, k * 0.96];
    },
    { srgb: true },
  );
  // Grain: roughness variation for steel (G), streaky along v like weathered galvanizing.
  const grain = dataTexture(128, 128, (u, v) => {
    const n = 0.6 * vnoise(u, v * 0.25, 32, 81) + 0.4 * vnoise(u, v, 8, 82);
    return [0.5, 0.82 + 0.36 * (n - 0.5), 1];
  });
  // Pad paint wear: off-white with dirt (colour) and chips where the deck shows through (alpha in G).
  const wear = dataTexture(
    256,
    256,
    (u, v) => {
      const k = 0.92 - 0.16 * Math.max(0, fbm(u, v, 6, 91, 4) - 0.45) - 0.05 * vnoise(u, v, 64, 92);
      return [k, k * 0.99, k * 0.96];
    },
    { srgb: true },
  );
  const wearAlpha = dataTexture(256, 256, (u, v) => {
    const chip = fbm(u, v, 16, 93, 3) * 0.7 + vnoise(u, v, 96, 94) * 0.3;
    const a = chip > 0.66 ? 0 : 1;
    return [a, a, a];
  });
  // Apron: dark asphalt / concrete, large soft stains over a fine grain (colour, sRGB).
  const apron = dataTexture(
    512,
    512,
    (u, v) => {
      const k = 0.8 + 0.28 * (fbm(u, v, 4, 101, 4) - 0.5) + 0.1 * (vnoise(u, v, 256, 102) - 0.5);
      return [k, k, k * 1.02];
    },
    { srgb: true },
  );
  propTex = { concrete, grain, wear, wearAlpha, apron };
  return propTex;
}
// A texture clone with its own repeat (shares the pixels).
function tiled(tex, rx, ry = rx) {
  const t = tex.clone();
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}
// Scorch: darkens a prop toward its origin's axis (the pad centre) in uneven radial streaks.
// material.scorch = { value: Vector4(r0, r1, strength, 0) }: full strength inside r0, gone past r1.
function scorchHook(shader) {
  shader.uniforms.uScorch = this.scorch ?? (this.scorch = { value: new THREE.Vector4(0, 1, 0, 0) });
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vScorchP;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvScorchP = position;");
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vScorchP;\nuniform vec4 uScorch;")
    .replace(
      "#include <map_fragment>",
      `#include <map_fragment>
      float scA = atan(vScorchP.z, vScorchP.x);
      float scS = 0.5 + 0.3 * sin(scA * 17.0 + 2.0 * sin(scA * 5.0)) + 0.2 * sin(scA * 43.0);
      float scG = 1.0 - smoothstep(uScorch.x, uScorch.x + (uScorch.y - uScorch.x) * (0.5 + 0.7 * scS), length(vScorchP.xz));
      float scorch = uScorch.z * scG * (2.0 - scG);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.045, 0.04), scorch);`,
    )
    .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 1.0, scorch);");
}
const scorchKey = () => "prop-scorch-v1";
let propPaint = null;
function propPaintMaterials() {
  if (propPaint) return propPaint;
  const t = propTextures();
  const po = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const std = (o) => new THREE.MeshStandardMaterial({ fog: true, metalness: 0, ...po, ...o });
  const scorchable = (m) => {
    m.onBeforeCompile = scorchHook;
    m.customProgramCacheKey = scorchKey;
    return m;
  };
  propPaint = {
    concrete: scorchable(std({ color: 0xb3b0aa, roughness: 0.92, map: t.concrete, bumpMap: t.concrete, bumpScale: 0.6 })),
    trench: scorchable(std({ color: 0x5a5550, roughness: 0.96, map: t.concrete, bumpMap: t.concrete, bumpScale: 0.8 })),
    steel: std({ color: 0x34373c, metalness: 0.75, roughness: 0.42, roughnessMap: t.grain }),
    galv: std({ color: 0x5b5f64, metalness: 0.65, roughness: 0.5, roughnessMap: t.grain }),
    galvShaded: std({ color: 0x5b5f64, vertexColors: true, metalness: 0.65, roughness: 0.5, roughnessMap: t.grain }),
    person: std({ color: 0x16181c, roughness: 0.85 }),
    // Pad markings: matte white paint, worn (chips cut out by alpha test), drawn over the deck.
    marking: std({ color: 0xe9e7e1, roughness: 0.88, map: t.wear, alphaMap: t.wearAlpha, alphaTest: 0.5, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    apron: std({ color: 0x2c2d30, roughness: 0.96, map: t.apron }),
  };
  return propPaint;
}
// Gives a prop mesh its painted twin (default) next to its x-ray material; key names propPaintMaterials().
// Returns the painted clone so callers can set its textures or scorch. No-op in the classic look.
// lineK: painted line opacity / x-ray line opacity (default PROP_LINE_K; thin lattices go lower so their lines
// do not tint the steel).
export function paintProp(mesh, key, { repeat = null, scorch = null, lineK = PROP_LINE_K } = {}) {
  if (!XRAY) return null;
  mesh.userData.paintLineK = lineK;
  const painted = cloneMat(propPaintMaterials()[key]);
  if (repeat && painted.map) painted.map = tiled(painted.map, ...repeat);
  if (repeat && painted.bumpMap) painted.bumpMap = painted.map ?? tiled(painted.bumpMap, ...repeat);
  if (scorch) painted.scorch = { value: new THREE.Vector4(...scorch, 0) };
  mesh.userData.looks = { xray: mesh.material, painted };
  mesh.material = painted;
  for (const e of [mesh.userData.edges, ...mesh.children.filter((c) => c.isLineSegments)]) {
    if (!e?.userData || e.userData.base === undefined) continue;
    e.userData.base0 ??= e.userData.base;
    e.userData.base = e.userData.base0 * lineK;
    e.material.opacity = e.userData.base;
  }
  return painted;
}
// Switches every prop under root (the drone pad) between "painted" (default) and "xray": material twins,
// edge lines (0.15 vs 0.35 level), objects that exist only in one look (userData.lookOnly: the holo rings vs
// the pad markings, the person's line figure) and per-look opacities (userData.lookOpacity: the polar grid).
// Props follow the builder: x-ray only while the whole build is in the clear look.
export function setPropLook(root, look = "painted") {
  const paint = look !== "xray";
  root.traverse((o) => {
    const looks = o.userData.looks;
    if (looks && !o.userData.partId) {
      o.material = paint ? looks.painted : looks.xray;
      for (const e of o.children) {
        if (!e.isLineSegments || e.userData.base0 === undefined) continue;
        e.userData.base = paint ? e.userData.base0 * (o.userData.paintLineK ?? PROP_LINE_K) : e.userData.base0;
        e.material.opacity = e.userData.base;
      }
    }
    if (o.userData.lookOnly) o.visible = o.userData.lookOnly === (paint ? "painted" : "xray");
    const op = o.userData.lookOpacity;
    if (op && o.material) o.material.opacity = paint ? op.painted : op.xray;
  });
}
export function createStars(count = 1400) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 90 + Math.random() * 40;
    const theta = Math.random() * TAU;
    const phi = Math.acos(Math.random() * 0.98 - 0.08); // mostly above the horizon
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0x9fb4d8, size: 0.35, sizeAttenuation: true, transparent: true, opacity: 0.8, fog: false });
  return new THREE.Points(geo, mat);
}
