// Planets: the landing page's globe.
//   createPlanet({ kind: "earth" | "moon" | "mars", radius_u, mode }) -> { object3d, update(t, camera?), setSunDir(v3), dispose() }
//     mode "photoreal" (default): NASA maps (src/assets/planets/SOURCES.md), day/night blend, ocean glint, bump
//     relief, a cloud sphere with cloud shadows, a single-scatter atmosphere shell; Earth 3 draws, Mars 2, Moon 1.
//   skyAt(altitude_m, sunDir, body) -> { zenith, horizon, stars }   sky colours for the background.
//   planetTexture(name, { srgb }) -> the shared map textures (world.js's far layer uses them too).
// The line-art mode (dark shaded bodies, warm key, peach rims and lines; everything procedural):
//   createPlanet({ ..., mode: "lineart" })
//     3 draws: the body (one ShaderMaterial: shading, surface, Earth's clouds), a peach graticule every 15°
//     (opacity 0.12, turns with the body), and a thin additive atmosphere shell (Earth, Mars; the Moon has none).
//     Slow self-rotation in update(t) (t in seconds); pass the camera too and the graticule fades as the globe
//     gets small on screen (15° lines would crowd into a cage). setSunDir(world direction) moves the terminator.
// Planet materials ignore fog so a distant globe is not swallowed by the per-frame fog band around the vehicle.
import * as THREE from "three";
import { atmosphereFor } from "./bodies.js";

const PEACH = new THREE.Color(1.0, 0.706, 0.541);
const SPIN = 0.015; // rad/s self-rotation
const DEFAULT_SUN = new THREE.Vector3(-0.45, 0.75, 0.5).normalize(); // matches the warm key (upper-left-front)

// Per kind: surface colours (linear) and atmosphere.
const KINDS = {
  earth: { define: "KIND_EARTH", base: [0.03, 0.045, 0.07], land: [0.08, 0.09, 0.08], atmo: [0.3, 0.5, 1.0], atmoGain: 0.4 },
  moon: { define: "KIND_MOON", base: [0.13, 0.13, 0.135], land: [0.085, 0.085, 0.09], atmo: null, atmoGain: 0 },
  mars: { define: "KIND_MARS", base: [0.2, 0.08, 0.04], land: [0.11, 0.05, 0.03], atmo: [0.9, 0.55, 0.35], atmoGain: 0.3 },
};

const NOISE = /* glsl */ `
  float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p) { float s = 0.0; float a = 0.5; for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s / 0.875; }
  // Cellular craters: bowl inside the radius, raised rim just outside (height in units of the body radius × k).
  float craters(vec3 p, float freq) {
    vec3 q = p * freq; vec3 i = floor(q); vec3 f = fract(q);
    float best = 8.0; float rnd = 0.0;
    for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec3 g = vec3(float(x), float(y), float(z));
      vec3 o = vec3(hash3(i + g), hash3(i + g + 19.1), hash3(i + g + 47.3));
      vec3 r = g + o - f; float d = dot(r, r);
      if (d < best) { best = d; rnd = hash3(i + g + 71.7); }
    }
    float rad = 0.18 + 0.3 * rnd;
    float d = sqrt(best) / rad;
    float bowl = d < 1.0 ? (d * d - 1.0) * 0.6 : 0.0;
    float rim = exp(-pow((d - 1.0) / 0.14, 2.0)) * 0.35;
    return (bowl + rim) * step(0.35, rnd + 0.2);
  }
`;

const bodyVertex = /* glsl */ `
  varying vec3 vObj;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  void main() {
    vObj = normalize(position);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const bodyFragment = /* glsl */ `
  uniform vec3 uSunDir, uSunColor, uRim, uBase, uLand, uAmbient;
  uniform float uTime, uRadius;
  varying vec3 vObj;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  ${NOISE}
  // Screen-space bump (three's perturbNormalArb): h is a height in world units.
  vec3 bump(vec3 N, float h) {
    vec3 dpx = dFdx(vWorldPos); vec3 dpy = dFdy(vWorldPos);
    float dhx = dFdx(h); float dhy = dFdy(h);
    vec3 r1 = cross(dpy, N); vec3 r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
    return normalize(abs(det) * N - grad);
  }
  void main() {
    vec3 N0 = normalize(vNormalW);
    vec3 N = N0;
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 albedo = uBase;
    float glint = 0.0;
    float clouds = 0.0;
    float land = 0.0;
  #ifdef KIND_EARTH
    float c = fbm3(vObj * 1.7 + 3.1);
    land = smoothstep(0.53, 0.57, c);
    albedo = mix(uBase, uLand, land);
    albedo += uRim * 0.05 * exp(-pow((c - 0.55) / 0.012, 2.0));              // faint warm coastline
    glint = (1.0 - land) * pow(max(dot(reflect(-L, N0), V), 0.0), 60.0) * 0.35; // ocean sun glint
    // Cloud band: noise drifting in longitude, strongest in the mid latitudes.
    float a = uTime * 0.01;
    vec3 cp = vec3(vObj.x * cos(a) - vObj.z * sin(a), vObj.y, vObj.x * sin(a) + vObj.z * cos(a));
    float band = smoothstep(0.75, 0.2, abs(vObj.y)) * smoothstep(0.0, 0.25, abs(vObj.y) + 0.05);
    clouds = smoothstep(0.58, 0.78, fbm3(cp * vec3(4.0, 9.0, 4.0) + 5.3)) * band * 0.3;
  #endif
  #ifdef KIND_MOON
    float maria = smoothstep(0.45, 0.62, fbm3(vObj * 1.6 + 7.0));
    albedo = mix(uBase, uLand, maria);
    float h = craters(vObj, 7.0) + 0.5 * craters(vObj + 3.3, 17.0);
    N = bump(N0, h * uRadius * 0.012);
    albedo *= 0.9 + 0.2 * vnoise(vObj * 40.0);
  #endif
  #ifdef KIND_MARS
    float dark = smoothstep(0.42, 0.66, fbm3(vObj * 2.0 + 1.7));
    albedo = mix(uBase, uLand, dark);
    float cap = smoothstep(0.82, 0.9, abs(vObj.y) + 0.04 * vnoise(vObj * 12.0));
    albedo = mix(albedo, vec3(0.32, 0.3, 0.3), cap);
    N = bump(N0, craters(vObj, 9.0) * uRadius * 0.006);
  #endif
    float ndl = dot(N, L);
    float diff = smoothstep(-0.04, 1.0, ndl);
    vec3 col = albedo * (uSunColor * diff * 1.25 + uAmbient);
    col = mix(col, vec3(0.55, 0.57, 0.6) * (uSunColor * diff * 1.5 + uAmbient * 2.0), clouds);
    col += uSunColor * glint * diff;
    float ndl0 = dot(N0, L);
    col += uRim * exp(-pow(ndl0 / 0.1, 2.0)) * 0.06;                                  // warm terminator
    float fres = pow(1.0 - clamp(dot(N0, V), 0.0, 1.0), 4.0);
    fres = pow(fres, 1.25);                                                              // narrow on huge globes
    col += uRim * fres * (0.1 + 0.9 * smoothstep(-0.25, 0.6, ndl0)) * 0.35;           // peach fresnel rim
  #ifdef KIND_EARTH
    // Night-side city lights: sparse warm dots on land, clustered by a population noise.
    float night = smoothstep(0.06, -0.2, ndl0);
    float pop = smoothstep(0.45, 0.72, fbm3(vObj * 5.0 + 9.0));
    float city = step(0.955, hash3(floor(vObj * 170.0))) * land * pop;
    col += vec3(1.0, 0.72, 0.42) * city * night * (1.0 - clouds) * 0.8;
  #endif
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const atmoFragment = /* glsl */ `
  uniform vec3 uSunDir, uColor;
  uniform float uGain;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float rim = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 3.0);
    float lit = smoothstep(-0.35, 0.6, dot(N, normalize(uSunDir)));
    gl_FragColor = vec4(uColor * rim * (0.15 + 0.85 * lit) * uGain, 1.0);
  }
`;

function graticule(radius) {
  const pos = [];
  const pt = (lat, lon) => [radius * Math.cos(lat) * Math.sin(lon), radius * Math.sin(lat), radius * Math.cos(lat) * Math.cos(lon)];
  const step = (15 * Math.PI) / 180;
  for (let lon = 0; lon < Math.PI * 2 - 1e-6; lon += step) {
    for (let i = 0; i < 48; i++) pos.push(...pt(-Math.PI / 2 + (i * Math.PI) / 48, lon), ...pt(-Math.PI / 2 + ((i + 1) * Math.PI) / 48, lon));
  }
  for (let lat = -Math.PI / 2 + step; lat < Math.PI / 2 - 1e-6; lat += step) {
    for (let i = 0; i < 96; i++) pos.push(...pt(lat, (i * Math.PI * 2) / 96), ...pt(lat, ((i + 1) * Math.PI * 2) / 96));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

// Line-art mode (procedural shading + peach graticule): kept for the builder's twin compare.
function createLineartPlanet({ kind = "earth", radius_u = 40 } = {}) {
  const k = KINDS[kind] ?? KINDS.earth;
  const R = Math.max(1e-3, radius_u);
  const sun = { value: DEFAULT_SUN.clone() };
  const time = { value: 0 };
  const object3d = new THREE.Group();
  object3d.name = `planet:${kind}`;

  const bodyMat = new THREE.ShaderMaterial({
    defines: { [k.define]: "" },
    uniforms: {
      uSunDir: sun,
      uTime: time,
      uRadius: { value: R },
      uSunColor: { value: new THREE.Color(1.0, 0.86, 0.72) },
      uRim: { value: PEACH.clone() },
      uBase: { value: new THREE.Color(...k.base) },
      uLand: { value: new THREE.Color(...k.land) },
      uAmbient: { value: new THREE.Color(0.012, 0.014, 0.02) },
    },
    vertexShader: bodyVertex,
    fragmentShader: bodyFragment,
    fog: false,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 96), bodyMat);
  body.name = "planet-body";
  body.raycast = () => {};
  object3d.add(body);

  const gratMat = new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: 0.12, depthWrite: false, fog: false });
  const grat = new THREE.LineSegments(graticule(R * 1.003), gratMat);
  grat.name = "planet-graticule";
  grat.raycast = () => {};
  body.add(grat); // turns with the body

  let atmo = null;
  if (k.atmo) {
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: { uSunDir: sun, uColor: { value: new THREE.Color(...k.atmo) }, uGain: { value: k.atmoGain } },
      vertexShader: bodyVertex,
      fragmentShader: atmoFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.025, 96, 64), atmoMat);
    atmo.name = "planet-atmosphere";
    atmo.raycast = () => {};
    object3d.add(atmo);
  }

  const centre = new THREE.Vector3();
  return {
    object3d,
    radius_u: R,
    mode: "lineart",
    setScale(s = 1) {
      object3d.scale.setScalar(s);
      bodyMat.uniforms.uRadius.value = R * s;
    },
    update(t = 0, camera = null) {
      body.rotation.y = t * SPIN;
      time.value = t;
      if (camera) {
        // angular radius on screen: full graticule above ~0.12 rad, down to a quarter below ~0.02 rad
        const ang = R / Math.max(1e-6, camera.position.distanceTo(object3d.getWorldPosition(centre)));
        gratMat.opacity = 0.12 * THREE.MathUtils.clamp((ang - 0.02) / 0.1, 0.25, 1);
      }
    },
    setSunDir(v) {
      if (v && v.lengthSq() > 0) sun.value.copy(v).normalize();
    },
    dispose() {
      body.geometry.dispose();
      bodyMat.dispose();
      grat.geometry.dispose();
      gratMat.dispose();
      if (atmo) atmo.geometry.dispose(), atmo.material.dispose();
      object3d.removeFromParent();
    },
  };
}

// Static URLs so Vite and Next/Turbopack both bundle the files.
const MAP_URLS = {
  earth_day: new URL("./assets/planets/earth_day.jpg", import.meta.url).href,
  earth_night: new URL("./assets/planets/earth_night.jpg", import.meta.url).href,
  earth_clouds: new URL("./assets/planets/earth_clouds.jpg", import.meta.url).href,
  earth_bump: new URL("./assets/planets/earth_bump.jpg", import.meta.url).href,
  moon_color: new URL("./assets/planets/moon_color.jpg", import.meta.url).href,
  moon_disp: new URL("./assets/planets/moon_disp.jpg", import.meta.url).href,
  mars_color: new URL("./assets/planets/mars_color.jpg", import.meta.url).href,
  mars_bump: new URL("./assets/planets/mars_bump.jpg", import.meta.url).href,
};
// The shared map textures by name (see MAP_URLS), e.g. for world.js; 1×1 placeholders outside a browser.
export const planetTexture = (name, opts) => planetMap(name, opts);

// Textures load once in the browser and are shared; outside a browser (node checks) a 1×1 placeholder stands in.
const texCache = new Map();
function planetMap(name, { srgb = true } = {}) {
  if (texCache.has(name)) return texCache.get(name);
  let tex;
  if (typeof document !== "undefined" && MAP_URLS[name]) {
    tex = new THREE.TextureLoader().load(MAP_URLS[name]);
    tex.anisotropy = 8;
  } else {
    tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    tex.needsUpdate = true;
  }
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  texCache.set(name, tex);
  return tex;
}

// Per body: maps, relief (bump height in units of the radius), atmosphere (colour, scale height / radius,
// Mie forward-scatter share, gain), clouds.
const REAL = {
  earth: { color: "earth_day", bump: "earth_bump", night: "earth_night", clouds: "earth_clouds", relief: 0.004, ocean: 1, atmo: { color: [0.3, 0.52, 1.0], H: 0.014, mie: 0.25, gain: 1.4, haze: 0.55 } },
  moon: { color: "moon_color", bump: "moon_disp", relief: 0.006, ocean: 0, atmo: null },
  mars: { color: "mars_color", bump: "mars_bump", relief: 0.006, ocean: 0, atmo: { color: [0.85, 0.55, 0.32], H: 0.01, mie: 1.0, gain: 0.8, haze: 0.3 } },
};

const realVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const realBodyFragment = /* glsl */ `
  uniform sampler2D uColor, uBump, uNight, uClouds;
  uniform vec3 uSunDir, uSunColor, uAtmo;
  uniform float uRelief, uRadius, uOcean, uHasNight, uHasClouds, uCloudU, uHaze;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  vec3 bump(vec3 N, float h) {
    vec3 dpx = dFdx(vWorldPos); vec3 dpy = dFdy(vWorldPos);
    float dhx = dFdx(h); float dhy = dFdy(h);
    vec3 r1 = cross(dpy, N); vec3 r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    return normalize(abs(det) * N - sign(det) * (dhx * r1 + dhy * r2));
  }
  void main() {
    vec3 N0 = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 L = normalize(uSunDir);
    vec3 albedo = texture2D(uColor, vUv).rgb;
    float h = texture2D(uBump, vUv).r;
    vec3 N = bump(N0, h * uRelief * uRadius);
    float ndl0 = dot(N0, L);
    float diff = max(dot(N, L), 0.0) * smoothstep(-0.05, 0.1, ndl0);
    // Cloud shadows: the cloud map sampled a little toward the sun (in the local east/north frame).
    float shade = 1.0;
    float cover = 0.0;
    if (uHasClouds > 0.5) {
      vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), N0) + vec3(1e-5));
      vec3 north = cross(N0, east);
      vec2 toSun = vec2(dot(L, east), dot(L, north));
      vec2 cuv = vec2(vUv.x + uCloudU, vUv.y);
      cover = texture2D(uClouds, cuv).r;
      shade = 1.0 - 0.45 * smoothstep(0.15, 0.9, texture2D(uClouds, cuv - toSun * 0.004).r);
    }
    vec3 col = albedo * uSunColor * diff * 1.35 * shade;
    // Ocean glint where the topography map is at sea level.
    float ocean = uOcean * (1.0 - smoothstep(0.004, 0.03, h));
    vec3 Hh = normalize(L + V);
    col += uSunColor * pow(max(dot(N0, Hh), 0.0), 220.0) * ocean * 0.5 * step(0.0, ndl0) * shade;
    // City lights on the night side, dimmed under clouds.
    float night = 1.0 - smoothstep(-0.18, 0.08, ndl0);
    col += texture2D(uNight, vUv).rgb * night * uHasNight * 1.6 * (1.0 - 0.7 * cover);
    // In-scattered haze toward the limb (the atmosphere seen against the disc).
    float fres = pow(1.0 - clamp(dot(N0, V), 0.0, 1.0), 2.2);
    float lit = smoothstep(-0.2, 0.45, ndl0);
    col = mix(col, uAtmo * lit * 1.1, fres * uHaze);
    col += uAtmo * lit * uHaze * 0.035;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
const cloudFragment = /* glsl */ `
  uniform sampler2D uClouds;
  uniform vec3 uSunDir, uSunColor;
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    float a = smoothstep(0.1, 0.85, texture2D(uClouds, vUv).r);
    if (a < 0.01) discard;
    float ndl = dot(normalize(vNormalW), normalize(uSunDir));
    float lit = smoothstep(-0.12, 0.35, ndl);
    vec3 col = uSunColor * (0.004 + 0.996 * lit) * mix(vec3(1.0), vec3(1.0, 0.62, 0.42), exp(-pow(ndl / 0.14, 2.0)) * 0.6);
    gl_FragColor = vec4(col, a * 0.92);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
// Single-scatter limb: along each view ray, density at the ray's closest approach to the planet centre
// (exp falloff with scale height H), lit where that point sees the sun, Rayleigh phase plus a Mie forward peak.
const scatterFragment = /* glsl */ `
  uniform vec3 uCenter, uSunDir, uColor;
  uniform float uR, uH, uGain, uMie;
  varying vec3 vWorldPos;
  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorldPos - ro);
    float tc = dot(uCenter - ro, rd);
    vec3 pc = ro + rd * max(tc, 0.0);
    float b = length(pc - uCenter);
    float dens = exp(-max(b - uR, 0.0) / uH) * step(0.0, tc);
    vec3 up = normalize(pc - uCenter);
    vec3 L = normalize(uSunDir);
    float lit = smoothstep(-0.3, 0.35, dot(up, L));
    float mu = dot(rd, L);
    float phase = 0.75 * (1.0 + mu * mu) + uMie * 3.0 * pow(max(mu, 0.0), 10.0);
    gl_FragColor = vec4(uColor * dens * lit * phase * uGain, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function createPhotorealPlanet({ kind = "earth", radius_u = 40 } = {}) {
  const k = REAL[kind] ?? REAL.earth;
  const R = Math.max(1e-3, radius_u);
  const sun = { value: DEFAULT_SUN.clone() };
  const sunColor = { value: new THREE.Color(1.0, 0.96, 0.9) };
  const object3d = new THREE.Group();
  object3d.name = `planet:${kind}`;
  const black = planetMap("none");
  const bodyMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: planetMap(k.color) },
      uBump: { value: planetMap(k.bump, { srgb: false }) },
      uNight: { value: k.night ? planetMap(k.night) : black },
      uClouds: { value: k.clouds ? planetMap(k.clouds, { srgb: false }) : black },
      uSunDir: sun,
      uSunColor: sunColor,
      uAtmo: { value: new THREE.Color(...(k.atmo?.color ?? [0, 0, 0])) },
      uRelief: { value: k.relief },
      uRadius: { value: R },
      uOcean: { value: k.ocean },
      uHasNight: { value: k.night ? 1 : 0 },
      uHasClouds: { value: k.clouds ? 1 : 0 },
      uCloudU: { value: 0 },
      uHaze: { value: k.atmo?.haze ?? 0 },
    },
    vertexShader: realVertex,
    fragmentShader: realBodyFragment,
    fog: false,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(R, 160, 120), bodyMat);
  body.name = "planet-body";
  body.raycast = () => {};
  object3d.add(body);

  let clouds = null;
  if (k.clouds) {
    clouds = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.008, 128, 96),
      new THREE.ShaderMaterial({ uniforms: { uClouds: bodyMat.uniforms.uClouds, uSunDir: sun, uSunColor: sunColor }, vertexShader: realVertex, fragmentShader: cloudFragment, transparent: true, depthWrite: false, fog: false }),
    );
    clouds.name = "planet-clouds";
    clouds.raycast = () => {};
    object3d.add(clouds);
  }
  let atmo = null;
  if (k.atmo) {
    const H = k.atmo.H * R;
    atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R + 6 * H, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: { uCenter: { value: new THREE.Vector3() }, uSunDir: sun, uColor: { value: new THREE.Color(...k.atmo.color) }, uR: { value: R }, uH: { value: H }, uGain: { value: k.atmo.gain }, uMie: { value: k.atmo.mie } },
        vertexShader: realVertex,
        fragmentShader: scatterFragment,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    atmo.name = "planet-atmosphere";
    atmo.raycast = () => {};
    object3d.add(atmo);
  }
  const CLOUD_DRIFT = 0.004; // rad/s relative to the ground
  const H0 = k.atmo ? k.atmo.H * R : 0;
  return {
    object3d,
    radius_u: R,
    mode: "photoreal",
    // Uniform scale of the whole globe, keeping the shader lengths (relief, scattering radius and scale
    // height) in step; use this instead of object3d.scale.
    setScale(s = 1) {
      object3d.scale.setScalar(s);
      bodyMat.uniforms.uRadius.value = R * s;
      if (atmo) (atmo.material.uniforms.uR.value = R * s), (atmo.material.uniforms.uH.value = H0 * s);
    },
    update(t = 0) {
      body.rotation.y = t * SPIN;
      if (clouds) {
        clouds.rotation.y = t * (SPIN + CLOUD_DRIFT);
        bodyMat.uniforms.uCloudU.value = -((t * CLOUD_DRIFT) / (Math.PI * 2)); // cloud shadows follow the clouds
      }
      if (atmo) object3d.getWorldPosition(atmo.material.uniforms.uCenter.value);
    },
    setSunDir(v) {
      if (v && v.lengthSq() > 0) sun.value.copy(v).normalize();
    },
    dispose() {
      object3d.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      object3d.removeFromParent();
    },
  };
}

// Default look for createPlanet.
export const PLANET_DEFAULT_MODE = "photoreal";
// createPlanet({ kind, radius_u, mode }): mode "photoreal" (NASA maps, clouds, scattering) or "lineart"
// (procedural shading + graticule, for the builder's twin compare). Same API: { object3d, radius_u, mode,
// update(t), setSunDir(v3), setScale(s), dispose() }; setScale scales the globe and its shader lengths
// together. Draws: Earth 3 (body, clouds, atmosphere), Mars 2, Moon 1.
export function createPlanet({ kind = "earth", radius_u = 40, mode = PLANET_DEFAULT_MODE } = {}) {
  return mode === "lineart" ? createLineartPlanet({ kind, radius_u }) : createPhotorealPlanet({ kind, radius_u });
}

// Sky colours by altitude for the ascent / entry background: { zenith, horizon, stars (0..1 visibility) },
// linear THREE.Colors. Brightness follows the air density, exp(-h / scale height) with the scale height from
// atmosphereFor (arrival.js): Earth blue → black with a sunset tint near the horizon, Mars butterscotch with a
// blue sunset, the Moon black. sunDir: world direction to the sun (y up = local vertical). Colours are visual.
export function skyAt(altitude_m = 0, sunDir = DEFAULT_SUN, body = "earth") {
  const up = sunDir.y / Math.max(1e-6, sunDir.length());
  const day = smoothstep(-0.18, 0.2, up);
  const low = Math.exp(-((up / 0.14) ** 2)); // sun near the horizon
  const air = atmosphereFor(body);
  if (!air || air.none || !(air.scaleHeight_m > 0)) return { zenith: new THREE.Color(0, 0, 0), horizon: new THREE.Color(0, 0, 0), stars: 1 };
  const H = air.scaleHeight_m;
  const rho = Math.exp(-Math.max(0, altitude_m) / H);
  const z = rho ** 0.6 * day;
  const h = rho ** 0.35 * day;
  const zenith = body === "mars" ? new THREE.Color(0.42, 0.28, 0.16).multiplyScalar(z) : new THREE.Color(0.06, 0.2, 0.55).multiplyScalar(z);
  const horizon = body === "mars" ? new THREE.Color(0.7, 0.5, 0.32).multiplyScalar(h) : new THREE.Color(0.5, 0.66, 0.9).multiplyScalar(h);
  const tint = body === "mars" ? new THREE.Color(0.3, 0.45, 0.8) : new THREE.Color(1.0, 0.48, 0.2);
  horizon.lerp(tint.multiplyScalar(rho ** 0.3), low * 0.7);
  const lum = 0.2126 * zenith.r + 0.7152 * zenith.g + 0.0722 * zenith.b;
  return { zenith, horizon, stars: Math.max(0, 1 - lum * 6) };
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
