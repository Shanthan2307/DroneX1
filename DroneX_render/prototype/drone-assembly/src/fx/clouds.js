// Cloud layer for the landing dive (ui/landing.js): a thin disc of soft cloud billboards the camera passes
// through; they fade near the camera so flying through stays clean. Sizes and colours are visual.
//   createCloudLayer({ altitude_u, radius_u, count }) -> { object3d, update(dt, { intensity = 1 }), dispose() }
import * as THREE from "three";

const noPick = (o) => ((o.raycast = () => {}), o);
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// ---------- instanced billboard particles ----------

const QUAD = new THREE.PlaneGeometry(1, 1);
const SPRITE_VERT = (body, { nearFade = false } = {}) => /* glsl */ `
  attribute vec4 aSeed;
  uniform float uTime;
  uniform float uI;
  varying vec2 vUv;
  varying float vA;
  varying vec3 vCol;
  varying float vSoft;
  ${body}
  void main() {
    vec3 c = vec3(0.0); vec2 sz = vec2(0.0); float a = 0.0; vec3 col = vec3(1.0); vec3 vel = vec3(0.0); float soft = 1.0;
    particle(c, sz, a, col, vel, soft);
    vec4 mv = modelViewMatrix * vec4(c, 1.0);
    vec2 d = (modelViewMatrix * vec4(vel, 0.0)).xy;
    float L = length(d);
    float rot = aSeed.z * 6.2831853;
    vec2 ax = L > 1e-6 ? d / L : vec2(cos(rot), sin(rot));   // long axis along the screen-space velocity
    vec2 ay = vec2(-ax.y, ax.x);
    mv.xy += ax * position.y * sz.y + ay * position.x * sz.x;
    ${nearFade ? "a *= smoothstep(0.15 * sz.x, 1.0 * sz.x, -mv.z);" : ""}
    gl_Position = a > 0.0 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);   // dead particles off-screen
    vUv = position.xy + 0.5; vA = a; vCol = col; vSoft = soft;
  }
`;
// blend: "add" (additive), "normal", or "premult": one draw mixing both (a particle with soft < 0 adds light, the
// rest cover like "normal"; |soft| is the falloff either way)
const SPRITE_FRAG = (additive, premult = false) => /* glsl */ `
  varying vec2 vUv;
  varying float vA;
  varying vec3 vCol;
  varying float vSoft;
  void main() {
    float r = length(vUv * 2.0 - 1.0);
    float g = pow(max(0.0, 1.0 - r), 1.0 + abs(vSoft));
    if (g <= 0.001) discard;
    ${premult ? "float ag = clamp(vA * g, 0.0, 1.0); gl_FragColor = vec4(vCol * ag, vSoft < 0.0 ? 0.0 : ag);" : additive ? "gl_FragColor = vec4(vCol * vA * g, 1.0);" : "gl_FragColor = vec4(vCol, clamp(vA * g, 0.0, 1.0));"}
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
function sprites({ count, uniforms = {}, body, additive = true, premult = false, nearFade = false, seed = 1, name }) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = QUAD.index;
  geo.setAttribute("position", QUAD.attributes.position);
  const rand = rng(seed);
  const s = new Float32Array(count * 4);
  for (let i = 0; i < s.length; i++) s[i] = rand();
  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(s, 4));
  geo.instanceCount = count;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uI: { value: 0 }, ...uniforms },
    vertexShader: SPRITE_VERT(body, { nearFade }),
    fragmentShader: SPRITE_FRAG(additive && !premult, premult),
    transparent: true,
    premultipliedAlpha: premult,
    depthWrite: false,
    blending: additive && !premult ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide, // the velocity-aligned basis can mirror the quad; never cull it
    fog: false,
  });
  const mesh = noPick(new THREE.Mesh(geo, mat));
  mesh.frustumCulled = false; // positions come from the shader
  mesh.name = name;
  return mesh;
}
const disposeAll = (object3d) => () => {
  object3d.traverse((o) => {
    if (o.geometry && o.geometry !== QUAD) o.geometry.dispose();
    o.material?.dispose();
  });
  object3d.removeFromParent();
};
const group = (name, ...children) => {
  const g = new THREE.Group();
  g.name = name;
  g.add(...children);
  return g;
};

// soft billboards in a thin disc; they fade near the camera so flying through stays clean.
export function createCloudLayer({ altitude_u = 50, radius_u = 60, count = 40 } = {}) {
  const mesh = sprites({
    count,
    additive: false,
    nearFade: true,
    seed: 61,
    name: "fx-clouds",
    uniforms: { uAlt: { value: altitude_u }, uRad: { value: radius_u } },
    body: /* glsl */ `
      uniform float uAlt, uRad;
      void particle(inout vec3 c, inout vec2 sz, inout float a, inout vec3 col, inout vec3 vel, inout float soft) {
        float r = uRad * sqrt(aSeed.x);
        float ang = aSeed.y * 6.2831853 + uTime * 0.003;
        c = vec3(sin(ang) * r, uAlt + (aSeed.z - 0.5) * uRad * 0.04, cos(ang) * r);
        float s = uRad * (0.12 + 0.2 * aSeed.w);
        sz = vec2(s * 0.45, s);       // wide along the (horizontal) long axis
        vel = vec3(1.0, 0.0, 0.0);
        a = uI * 0.38 * (1.0 - smoothstep(0.8, 1.0, sqrt(aSeed.x)));
        col = vec3(0.78, 0.8, 0.84);
        soft = 2.2;
      }
    `,
  });
  const object3d = group("fx-clouds", mesh);
  return {
    object3d,
    update(dt, { intensity = 1 } = {}) {
      mesh.material.uniforms.uTime.value += dt;
      mesh.material.uniforms.uI.value = intensity;
      object3d.visible = intensity > 0.002;
    },
    dispose: disposeAll(object3d),
  };
}

