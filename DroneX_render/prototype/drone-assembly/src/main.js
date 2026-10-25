import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
// The drone modules, through one facade (vehicle.js; contract in docs/drone-integration.md).
import {
  presetIds, getPreset, presetToBuild, applyOption, applySlotOption, optionsWithCompat, evaluateBuild, partDetails,
  buildManifest, sceneBounds, missionOf, destinations as destinationsFor, readiness as readinessFor,
} from "./vehicle.js";
import { droneCatalog } from "./data/droneCatalog.js";
import { createDesign, designToBuild, validateDesign } from "./designs.js";
// Fly in simulation: the built drone goes to the simulation engine (simProfile.js, simExport.js; served by the
// Next app's /api/sim routes), and the browser follows it there.
import { simProfile } from "./simProfile.js";
import { exportDroneGlb } from "./simExport.js";
import { createDesignStore } from "./designStore.js";
import { createHangar } from "./ui/hangar.js";
import { createDronePad } from "./dronePad.js";
import { SCALE } from "./scale.js";
import { createMaterials, createPart, createStars, setPropLook, setDetailLevel, registerBuilders } from "./parts.js";
import { DRONE_BUILDERS } from "./droneParts.js";
import { createDroneFlight } from "./droneFlight.js";
import { createChoreographer } from "./choreo.js";
import { createSfx } from "./fx/sfx.js";
import { createSelector } from "./ui/select.js";
import { createCard } from "./ui/card.js";
import { createScrub } from "./ui/scrub.js";
import { ensureShell } from "./ui/shell.js";
import { createLanding } from "./ui/landing.js";
import { mountReadiness } from "./ui/readiness.js";
import { createWorld } from "./world.js";
import * as f from "./ui/format.js";

// The drone part builders, so createPart draws a drone part with the shared toolkit (parts.js KIT).
registerBuilders(DRONE_BUILDERS);

const query = new URLSearchParams(location.search);
const lite = query.get("lite") === "1";
// The host page (the Next app's AssemblyStage or index.html) may lack newer elements: create them.
const shell = ensureShell();

// ---------- origin → build → manifest + physics ----------
// The build on the pad comes from an origin: a real drone (preset), one of the user's saved designs, or a draft (a
// saved design deleted while it was on the pad). It changes through the card's Options (applyOption); `modified`
// says so. Presets and designs load through the same path: both are just a build. The livery is not shown.
const buildKey = (b) => JSON.stringify({ ...b, livery: undefined });
const originOfPreset = (id) => {
  const p = getPreset(id);
  return { kind: "preset", id, name: p.name, build: presetToBuild(p) };
};
const originOfDesign = (d) => ({ kind: "design", id: d.id, name: d.name, build: designToBuild(d) });
const refOf = (origin) => (origin.kind === "draft" ? "draft" : `${origin.kind}:${origin.id}`);
// A mission is a choice, not a part change.
const partsKey = (b) => buildKey({ ...b, missionId: null });
function loadBuild(origin, build = origin.build) {
  const manifest = buildManifest(build);
  return {
    origin,
    build,
    modified: origin.kind === "draft" || partsKey(build) !== partsKey(origin.build),
    manifest,
    bounds: sceneBounds(manifest),
    verdict: evaluateBuild(build),
    details: partDetails(build),
  };
}
const loadPreset = (id) => loadBuild(originOfPreset(id));
// The user's saved drones (localStorage; designs.js). Private mode or a blocked storage just means none.
const designStore = createDesignStore(
  (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })(),
  droneCatalog,
);
let presetIndex = Math.max(0, presetIds.indexOf(query.get("build") ?? presetIds[0]));
const startDesign = query.get("design") ? designStore.get(query.get("design")) : null;
let current = startDesign ? loadBuild(originOfDesign(startDesign)) : loadPreset(presetIds[presetIndex]);

// ---------- renderer / scene ----------
const canvas = shell.canvas;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lite, powerPreference: "high-performance" });
renderer.setPixelRatio(lite ? 1 : Math.min(devicePixelRatio, 1.5)); // 1.5 caps the fill cost on retina screens
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = !lite;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);
scene.fog = new THREE.Fog(0x0b0d12, 45, 130);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 6000); // far: the star shell
camera.position.set(9.5, 6.8, 14.5);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 2.5, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.enablePan = false;
controls.minDistance = 2.5; // close enough to frame a single motor
controls.maxDistance = 70;
controls.maxPolarAngle = Math.PI * 0.49;
controls.update();

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.25;

// Light rig: one warm peach key from upper-left-front of the home view, a cool fill from the opposite side, a
// faint hemisphere. Dark shells read by their rims and edges, not by flat white light.
const KEY_DIR = new THREE.Vector3(-0.34, 1.1, 0.94).normalize(); // from the target toward the key light
const key = new THREE.DirectionalLight(0xffb48a, 2.8);
key.castShadow = !lite;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key, key.target);
const fill = new THREE.DirectionalLight(0x6a7fa8, 0.3);
fill.position.set(0.34, 0.45, -0.94).multiplyScalar(40);
scene.add(fill);
const hemi = new THREE.HemisphereLight(0x8fa6c8, 0x0f1118, 0.08);
scene.add(hemi);
let skyKeyDir = null; // by day the key light is the sun (world.setSky's sunDir)
let keyBase = null; // the recipe's key intensity
let skyFog = null;

const root = new THREE.Group(); // shakes on lock
scene.add(root);
let pad = null;
const skyState = { time: "day", weather: "clear" }; // the user's Day/Night (N) and Clear/Cloudy (W) toggles
// The star field is a 90–130 u shell; pushed out ×30 so no star sits in front of a globe, with the points scaled
// to keep their size on screen.
const stars = createStars();
stars.scale.setScalar(30);
stars.material.size *= 30;
scene.add(stars);

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    for (const m of new Set([].concat(o.material ?? [], Object.values(o.userData.looks ?? {})))) m.dispose(); // both looks of a piece
  });
}

// Key-light shadow box: sized and centred on the vehicle (room for the exploded view). Changes ease over ~0.5 s
// (placeShadow, every frame) and the centre snaps to whole shadow-map texels, so shadows neither jump nor swim.
const shadowBox = { home: new THREE.Vector3(), half: 0, dist: 0, far: 0, goal: { half: 8, dist: 20, far: 45 }, c: new THREE.Vector3(), init: false };
const SHADOW_AXES = (() => {
  const x = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), KEY_DIR).normalize();
  return { x, y: new THREE.Vector3().crossVectors(KEY_DIR, x) };
})();
function placeShadow(dt, snap) {
  const s = shadowBox;
  const k = snap || !s.init ? 1 : 1 - Math.exp(-dt / 0.15);
  s.init = true;
  s.c.lerp(s.home, k);
  const sc = key.shadow.camera;
  if (Math.abs(s.goal.half - s.half) > 1e-4 || Math.abs(s.goal.far - s.far) > 1e-4) {
    s.half += (s.goal.half - s.half) * k;
    s.far += (s.goal.far - s.far) * k;
    sc.left = sc.bottom = -s.half;
    sc.right = sc.top = s.half;
    sc.near = 1;
    sc.far = s.far;
    sc.updateProjectionMatrix();
  }
  s.dist += (s.goal.dist - s.dist) * k;
  const texel = (2 * s.half) / key.shadow.mapSize.x;
  const ax = s.c.dot(SHADOW_AXES.x);
  const ay = s.c.dot(SHADOW_AXES.y);
  key.target.position.copy(s.c).addScaledVector(SHADOW_AXES.x, Math.round(ax / texel) * texel - ax).addScaledVector(SHADOW_AXES.y, Math.round(ay / texel) * texel - ay);
  key.position.copy(key.target.position).addScaledVector(skyKeyDir ?? KEY_DIR, s.dist); // by day, the sun
}

// Contact shadow: a soft dark blob on the deck under the frame, where the key light's shadow map is too coarse
// to ground it. Shown while the bottom part is built, gone once the drone has left the pad. Writes no depth, so
// GTAO and the DoF depth skip it.
function createContactShadow(radius) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(0,0,0,0.9)");
  grd.addColorStop(0.4, "rgba(0,0,0,0.5)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * radius, 2 * radius).rotateX(-Math.PI / 2), mat);
  mesh.name = "contact-shadow";
  mesh.position.y = 0.002;
  mesh.renderOrder = 1;
  mesh.raycast = () => {};
  return mesh;
}
function updateContact(dt) {
  const c = pad?.contact;
  if (!c) return;
  const base = parts[0];
  let goal = base?.built ? 0.6 : 0;
  if (goal && droneFlight.active) goal = 0; // the drone has left the pad: no shadow under an empty deck
  c.material.opacity += (goal - c.material.opacity) * (1 - Math.exp(-dt / 0.12));
  c.visible = c.material.opacity > 0.003;
}

// Everything tuned to the vehicle's size: the key-light shadow box, orbit range, pad.
function applyBounds(b) {
  const H = b.height_u;
  shadowBox.home.set(0, H * 0.45, 0);
  shadowBox.goal = { half: Math.max(8, H * 0.85, b.radius_u * 6), dist: H * 1.5 + 20, far: H * 3.2 + 45 };
  controls.maxDistance = Math.max(70, H * 3.4);
  // (A fixed wing's launch stand follows its propeller, so a new stand height is a new pad too.)
  if (pad?.baseRadius_u === b.baseRadius_u && (pad?.stand_u ?? 0) === (b.stand?.height_u ?? 0)) return;
  if (pad) {
    root.remove(pad.group);
    disposeTree(pad.group);
  }
  // A drone stands on its own landing pad (dronePad.js): flat, sized from its display scale, nothing tall around
  // it. A contact shadow just under the frame body.
  pad = { ...createDronePad({ radius_u: b.radius_u, stand: b.stand }), baseRadius_u: b.baseRadius_u, stand_u: b.stand?.height_u ?? 0 };
  pad.contact = createContactShadow(b.radius_u * 0.75);
  pad.group.add(pad.contact);
  root.add(pad.group);
}
applyBounds(current.bounds);

// ---------- parts ----------
const materials = createMaterials();
const makePart = (spec) => createPart(spec, materials);
let parts = current.manifest.map(makePart);
const sfx = createSfx();
// The far layer (world.js): the Earth, Moon, Mars, stars and sun in scaled space, drawn first with the near scene
// (vehicle, pad) on top, its depth cleared. The far camera follows the near camera from the pad's place on the
// Earth. Off during the landing dive, which draws its own planet and sky.
const world = createWorld({ renderer });
const BG = scene.background;
// The landing dive starts in black space whatever the sky setting; the day recipe applies at the pad.
const SPACE_BG = new THREE.Color(0x0b0d12);
const FOG0 = scene.fog.color.clone();
world.clearColor.copy(BG); // what shows behind the builder while the far layer is off
// The sky (world.setSky): one recipe for the far layer and for the lights, fog and background (colours and
// intensities only; no light is ever added or removed). Day + clear by default.
const asColor = (c, out) => (c?.isColor ? out.copy(c) : Array.isArray(c) ? out.setRGB(c[0], c[1], c[2]) : c != null ? out.set(c) : out);
function applySky() {
  const r = world.setSky?.({ ...skyState });
  if (!r) return;
  asColor(r.key?.color, key.color);
  if (Number.isFinite(r.key?.intensity)) keyBase = key.intensity = r.key.intensity;
  skyKeyDir = r.time === "day" && r.sunDir ? new THREE.Vector3().copy(r.sunDir).normalize() : null;
  asColor(r.fill?.color, fill.color);
  if (Number.isFinite(r.fill?.intensity)) fill.intensity = r.fill.intensity;
  asColor(r.hemi?.sky, hemi.color);
  asColor(r.hemi?.ground, hemi.groundColor);
  if (Number.isFinite(r.hemi?.intensity)) hemi.intensity = r.hemi.intensity;
  if (Number.isFinite(r.environmentIntensity)) scene.environmentIntensity = r.environmentIntensity;
  if (Number.isFinite(r.exposure)) renderer.toneMappingExposure = r.exposure; // clear day 0.92, else 1.0
  asColor(r.fog?.color, FOG0);
  scene.fog.color.copy(FOG0);
  skyFog = r.time === "day" ? r.fog : null; // by day the air is clear: the haze only far off (its suggested band)
  asColor(r.background, BG);
  world.clearColor.copy(BG);
  skyButtons();
}
const PAD_KM = new THREE.Vector3(0, world.bodies.earth.radius_km, 0);
const viewerKm = new THREE.Vector3();
const choreo = createChoreographer({ parts, scene, root, camera, controls, sfx, onChange: syncUi, scale: SCALE, bounds: current.bounds, makePart });
// The take-off (droneFlight.js): it flies the part groups and spins the propellers; update() returns at once
// when no drone is flying.
const droneFlight = createDroneFlight({
  root,
  camera,
  controls,
  sfx,
  onTelemetry: (html) => {
    if (html !== telemetry.html) hudText.innerHTML = telemetry.html = html;
  },
  onEnd: (summary) => {
    Object.assign(telemetry, { final: summary.headline, headline: summary.headline, ok: summary.ok, sentences: summary.sentences, html: null });
    setPhase("result");
    syncUi();
  },
});

// ---------- post ----------
// GTAO skips what writes no depth (holograms, flashes, x-ray shells), so they never darken the vehicle. It runs at
// half resolution (the AO is soft anyway) and is on whenever the scene is at rest: off while something animates
// (build, swap, explode, scrub, the landing dive). The frame-time guard (see luxuryBudget) can drop it.
class SolidGTAOPass extends GTAOPass {
  setSize(width, height) {
    super.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  }
  _overrideVisibility() {
    super._overrideVisibility();
    const cache = this._visibilityCache;
    this.scene.traverse((o) => {
      if (o.isMesh && o.visible && o.material && o.material.depthWrite === false) {
        o.visible = false;
        cache.push(o);
      }
    });
  }
}
// Depth of field: mild, only on a focused part at rest. three's BokehPass with its depth at half resolution,
// skipping what writes no depth (glows, holograms, x-ray shells) and the background (the sky stays "far"). The
// pass is off whenever its aperture has eased to 0 (updateDof); the frame-time guard drops it before GTAO.
class SoftBokehPass extends BokehPass {
  setSize(width, height) {
    super.setSize(width, height);
    this._renderTargetDepth.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  }
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const hidden = [];
    this.scene.traverseVisible((o) => {
      if (o.material && !Array.isArray(o.material) && o.material.depthWrite === false) hidden.push(o);
    });
    for (const o of hidden) o.visible = false;
    const background = this.scene.background;
    this.scene.background = null;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    this.scene.background = background;
    for (const o of hidden) o.visible = true;
  }
}
let composer = null;
let gtao = null;
let dof = null;
let worldPass = null;
let nearPass = null;
if (!lite) {
  composer = new EffectComposer(renderer);
  composer.addPass((worldPass = world.createPass()));
  composer.addPass((nearPass = new RenderPass(scene, camera)));
  nearPass.clearDepth = true;
  const pr = renderer.getPixelRatio();
  gtao = new SolidGTAOPass(scene, camera, innerWidth * pr, innerHeight * pr);
  gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.2, scale: 1, samples: 16 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
  gtao.blendIntensity = 0.55; // dark shells need little AO
  composer.addPass(gtao);
  dof = new SoftBokehPass(scene, camera, { focus: 10, aperture: 0, maxblur: 0.004 });
  dof.enabled = false;
  composer.addPass(dof);
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.36, 0.55, 0.8)); // peach edges glow a touch
  composer.addPass(new OutputPass());
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer?.setSize(innerWidth, innerHeight);
});

// ---------- selection + card ----------
const card = createCard(shell.detail, { onOption: (part, id) => chooseOption(part, id) });
const isComplete = () => parts.length > 0 && parts.every((p) => p.built);
// During a swap the open card still shows the old part, so it keeps the old build's numbers (shown).
let shown = null;
const cardContext = (part = card.part) => {
  const ctx = shown ?? current;
  return {
    ...ctx,
    complete: shown ? shown.complete : isComplete(),
    options: part?.record ? optionsWithCompat(ctx.build, part.kind) : [],
    optionsDisabled: choreo.state.busy > 0,
  };
};

let hovered = null;
const selector = createSelector({
  canvas,
  camera,
  parts,
  onSelect(part) {
    const prev = card.part;
    if (prev && prev !== part) choreo.highlight(prev, false);
    if (!part) {
      card.hide();
      publishState();
      if (prev && !choreo.state.busy) choreo.unfocus(); // Esc / empty click: back to the whole drone
      return;
    }
    choreo.highlight(part, true);
    // Glide to frame the clicked part (x-ray focus); on a phone keep it above the bottom-sheet card.
    choreo.focus(part, matchMedia("(max-width: 760px)").matches ? { frac: 0.4, shift: 0.24 } : {});
    card.show(part, cardContext(part));
    sfx.play("ui", { gain: 0.5 });
    publishState();
  },
  resolve: (part) => (landingOn() ? null : part),
  // Every click on a part flips its look (opaque ↔ clear); empty space only deselects.
  onPick: (part) => choreo.toggleLook(part),
  onGhostClick(part) {
    if (landingOn()) return;
    if (choreo.canBuild(part)) choreo.build(part);
  },
  onHover(hit) {
    const ghost = hit?.ghost ? hit.part : null;
    if (ghost === hovered) return;
    if (hovered) choreo.setGhost(hovered, false);
    hovered = ghost;
    if (ghost) {
      choreo.setGhost(ghost, true);
      sfx.play("ui", { gain: 0.5 });
    }
  },
});

// Scrub the exploded view: vertical drag on empty space, or wheel / two-finger scroll.
createScrub({
  canvas,
  controls,
  isEmpty: (x, y) => !selector.hit(x, y),
  start: () => choreo.scrubStart(),
  by: (d) => choreo.scrubBy(d),
  end: () => choreo.scrubEnd(),
});

// ---------- UI ----------
const { btnVehicles, vehiclesEl, btnTest, btnFly, nowEl, btnBuildAll, btnExplode, btnReset, hudText } = shell;
// The readiness panel (ui/readiness.js): mission picker, Lift / Endurance / Weight / Parts rows and the flight
// result. Off by default (it shows only the flight result); ?panel=1 brings the whole panel back. The mission
// picker is also a row in the Vehicles list.
const PANEL_ON = query.get("panel") === "1";
const readyUi = mountReadiness({ hud: shell.hud, destinations: destinationsFor(), onDestination: (missionId) => setMission(missionId) });
function setPhase(phase) {
  document.body.classList.toggle("rdy-off", !PANEL_ON && phase !== "result");
  readyUi.setPhase(phase);
}
setPhase("pad");
function pushReadiness() {
  readyUi.update({
    build: current.build,
    verdict: current.verdict,
    mission: missionOf(current.build),
    readiness: readinessFor(current.verdict, current.build),
    complete: isComplete(),
    summary: telemetry.final ? { headline: telemetry.headline ?? "", ok: Boolean(telemetry.ok), sentences: telemetry.sentences ?? [] } : null,
  });
}
// The picker: the same build for another mission (no part changes): new verdict and HUD.
function setMission(missionId) {
  if (!missionId || missionId === current.build.missionId || choreo.state.busy) return;
  current = loadBuild(current.origin, { ...current.build, missionId });
  syncUi();
}

// Build all becomes Take off once the drone is complete.
btnBuildAll.addEventListener("click", () => (isComplete() ? takeOff() : choreo.buildAll()));
btnFly.addEventListener("click", () => flyInSim());

// The Hangar (ui/hangar.js): the drone library behind the bar's Hangar button, with About this drone, Test and New
// drone, plus the current-drone chip (name, About, Save). It reads the pad through this host and loads through it.
const hangar = createHangar({
  el: vehiclesEl,
  button: btnVehicles,
  chip: nowEl,
  store: designStore,
  host: {
    current: () => ({
      ref: refOf(current.origin),
      kind: current.origin.kind,
      id: current.origin.kind === "draft" ? null : current.origin.id,
      name: current.origin.name,
      build: current.build,
      modified: current.modified,
      manifest: current.manifest,
      verdict: current.verdict,
    }),
    open: (ref) => openRef(ref),
    selectMission: (id) => setMission(id),
    // The design just saved is what is on the pad now: it becomes the origin, unmodified.
    saveCurrent(design) {
      current = { ...current, origin: originOfDesign(design), modified: false };
      setQuery(current.origin);
      syncUi();
    },
    renamed(design) {
      if (current.origin.kind === "design" && current.origin.id === design.id) current = { ...current, origin: { ...current.origin, name: design.name } };
      syncUi();
    },
    // The drone on the pad stays, as an unsaved draft: "Save as new drone" brings it back.
    deleted(id) {
      if (current.origin.kind === "design" && current.origin.id === id) {
        current = { ...current, origin: { ...current.origin, kind: "draft" }, modified: true };
        setQuery(current.origin);
      }
      syncUi();
    },
  },
});
// One panel at a time: the part card (a bottom sheet on phones) closes when the Hangar opens.
btnVehicles.addEventListener("click", () => {
  selector.clear();
  hangar.toggle();
});
btnTest.addEventListener("click", () => {
  selector.clear();
  if (hangar.isOpen && hangar.view === "test") hangar.close();
  else hangar.show("test");
});
nowEl.addEventListener("click", () => selector.clear(), { capture: true });
addEventListener("pointerdown", (e) => {
  if (hangar.isOpen && !e.target.closest("#vehicles, #btn-vehicles, #btn-test, #dx-now")) hangar.close();
});
function openRef(ref) {
  if (ref === refOf(current.origin) && !current.modified) return;
  if (ref?.startsWith("preset:")) {
    const i = presetIds.indexOf(ref.slice("preset:".length));
    if (i >= 0) switchPreset(i - presetIndex);
  } else if (ref?.startsWith("design:")) {
    const d = designStore.get(ref.slice("design:".length));
    if (d) openOrigin(originOfDesign(d));
  }
}
btnExplode.addEventListener("click", () => choreo.toggleExplode());
btnReset.addEventListener("click", () => reset());
// Day/Night (N) and Clear/Cloudy (W): two small buttons under the key legend.
const skyBar = document.createElement("div");
skyBar.className = "sky-toggles";
skyBar.innerHTML = `<button type="button" data-sky="time"></button><button type="button" data-sky="weather"></button>`;
shell.brand.appendChild(skyBar);
function skyButtons() {
  skyBar.querySelector('[data-sky="time"]').textContent = skyState.time === "day" ? "Day" : "Night";
  skyBar.querySelector('[data-sky="weather"]').textContent = skyState.weather === "clear" ? "Clear" : "Cloudy";
}
function toggleSky(which) {
  if (which === "time") skyState.time = skyState.time === "day" ? "night" : "day";
  else skyState.weather = skyState.weather === "clear" ? "cloudy" : "clear";
  applySky();
}
skyBar.addEventListener("click", (e) => {
  const b = e.target.closest("[data-sky]");
  if (!b) return;
  toggleSky(b.dataset.sky);
  b.blur();
});

// HUD: running tally while building (parts, grams fitted), the verdict line once the drone is complete. The
// numbers that decide whether it flies are its all-up weight in grams, how much lift it has for that weight, and
// how long the pack holds it up. Every one of them is dronePhysics' verdict, so the line and the readiness panel
// can never disagree. "est." because thrust and hover power are modelled.
function hudHtml() {
  const { origin, verdict } = current;
  const built = parts.filter((p) => p.built);
  const name = `<strong>${f.esc(origin.name)}</strong>${current.modified ? " (modified)" : ""}`;
  // Nothing is built yet: the preset is only the plan (starter blueprint) the parts will come from.
  if (built.length === 0) return `Empty pad · blueprint: ${name}`;
  if (built.length < parts.length) {
    const grams = built.reduce((sum, p) => sum + (p.record?.weight_g ?? p.record?.emptyWeight_g ?? 0), 0);
    return `<strong>${built.length}/${parts.length}</strong> parts · <strong>${f.num(grams, 0)} g</strong> fitted${choreo.state.exploded ? " · exploded" : ""}`;
  }
  const g = Number.isFinite(verdict.allUpWeight_g) ? verdict.allUpWeight_g : verdict.totalMass_kg * 1000;
  const bits = [name, `<strong>${f.num(g, 0)} g</strong> all-up`];
  if (Number.isFinite(verdict.hoverTWR)) bits.push(`lift ${f.twr(verdict.hoverTWR)}`);
  // The same endurance figure the readiness panel compares against the mission: the mixed-profile time where
  // there is one, the steady figure otherwise.
  const flight_min = Number.isFinite(verdict.mixedTime_min) ? verdict.mixedTime_min : verdict.hoverTime_min;
  if (Number.isFinite(flight_min)) bits.push(`${f.num(flight_min, 1)} min flight`);
  // Cleared means what the readiness panel means: the build works AND it meets the mission.
  const cleared = readinessFor(verdict, current.build)?.ready ?? verdict.feasible;
  bits.push(
    cleared
      ? `<strong class="go">CLEARED</strong>`
      : `<strong class="nogo">NOT READY</strong>${verdict.warnings.length ? ` · ${verdict.warnings.length} warning${verdict.warnings.length === 1 ? "" : "s"}` : ""}`,
  );
  bits.push("est.");
  return bits.join(" · ");
}

let swapping = false; // the HUD keeps the old verdict until the new part locks
function syncUi() {
  if (parts !== choreo.parts) {
    parts = choreo.parts;
    selector.setParts(parts);
  }
  const { busy, exploded } = choreo.state;
  const built = parts.filter((p) => p.built).length;
  btnExplode.disabled = built === 0 || (busy > 0 && !exploded);
  btnExplode.textContent = exploded ? "Assemble" : "Explode";
  btnExplode.classList.toggle("on", exploded);
  document.body.classList.toggle("pad-empty", built === 0);
  const flying = droneFlight.active;
  btnBuildAll.textContent = built < parts.length ? "Build all" : "Take off";
  btnBuildAll.disabled = busy > 0 || exploded || flying;
  btnExplode.disabled ||= flying;
  // Fly in simulation: only a complete drone at rest can be sent (style.css shows the button via pad-complete).
  document.body.classList.toggle("pad-complete", parts.length > 0 && built === parts.length);
  btnFly.disabled = built < parts.length || busy > 0 || exploded || flying || flyInSim.busy;
  if (flying) {
    if (telemetry.final) hudText.innerHTML = telemetry.final;
  } else if (flyInSim.note) hudText.innerHTML = flyInSim.note;
  else if (!swapping) hudText.innerHTML = hudHtml();
  // L pressed while a drone was still settling (Vehicles list → appears built): take off once it has.
  if (takeOff.queued && busy === 0 && !flying && built === parts.length) {
    takeOff.queued = false;
    takeOff();
  }
  // A selected part that is being removed (or gone after reset) loses its card.
  const sel = selector.selected;
  if (sel && (!sel.built || (sel.busy && !swapping) || !parts.includes(sel))) selector.clear();
  if (card.part) card.refresh(cardContext());
  selector.refresh();
  pushReadiness();
  const hangarKey = `${refOf(current.origin)}|${current.origin.name}|${current.modified}|${buildKey(current.build)}`;
  if (hangarKey !== syncUi.hangarKey) {
    syncUi.hangarKey = hangarKey;
    hangar.refresh();
  }
  publishState();
}

// The build assistant (src/components/assistant, a React panel over this page) and this front end talk through
// window events, so neither imports the other: "dronex:state" says which drone is on the pad, its build and the
// clicked part; "dronex:swap" {slot, partId} and "dronex:mission" {missionId} ask for a change, made exactly as
// the part card's Options and the destination picker make it; "dronex:state-request" asks for a fresh state.
function publishState(force = false) {
  const sel = selector.selected;
  const spec = sel ? current.manifest.find((s) => s.id === sel.id) : null;
  const selected = spec?.slot ? { slot: spec.slot, partId: spec.record?.id ?? null, name: spec.name } : null;
  const detail = { name: current.origin.name, modified: current.modified, build: current.build, selected, busy: Boolean(choreo.state.busy) };
  const key = JSON.stringify(detail);
  // The last key lives on the function: syncUi can run during start-up, before a module-level let would exist.
  if (!force && key === publishState.key) return;
  publishState.key = key;
  window.dispatchEvent(new CustomEvent("dronex:state", { detail }));
}
window.addEventListener("dronex:state-request", () => publishState(true));
window.addEventListener("dronex:swap", (e) => {
  const { slot, partId } = e.detail ?? {};
  if (!slot || !partId || choreo.state.busy) return;
  void swapTo(applySlotOption(current.build, slot, partId));
});
window.addEventListener("dronex:mission", (e) => setMission(e.detail?.missionId));

// Animate the drone to `build` (choreo.applyManifest: lift, unscrew, fly in, settle), then physics, HUD and the
// open card switch to it. Resolves to false if nothing changed or the swap was cancelled.
async function swapTo(build) {
  if (choreo.state.exploded && !(await choreo.assemble())) return false;
  const next = loadBuild(current.origin, build);
  if (buildKey(next.build) === buildKey(current.build)) return false;
  shown = { ...current, complete: isComplete() };
  current = next;
  swapping = true;
  applyBounds(next.bounds);
  choreo.setBounds(next.bounds);
  const res = await choreo.applyManifest(next.manifest);
  swapping = false;
  shown = null;
  syncUi();
  return Boolean(res); // false: cancelled (reset or preset switch mid-swap)
}

// Options: swap one slot for another record.
async function chooseOption(part, recordId) {
  if (choreo.state.busy) return;
  if (!(await swapTo(applyOption(current.build, part.kind, recordId)))) return;
  const swapped = choreo.parts.find((p) => p.id === part.id);
  if (swapped?.built) selector.select(swapped);
}

// Switching drones ([ ], the Hangar) shows the new one built (one snap); reset starts empty.
function switchPreset(step, opts) {
  presetIndex = (presetIndex + step + presetIds.length) % presetIds.length;
  openOrigin(originOfPreset(presetIds[presetIndex]), opts);
}
function openOrigin(origin, { built = true } = {}) {
  setPhase("pad");
  current = loadBuild(origin);
  // A drone that was flying has to be put back on the pad before its parts are replaced under it.
  droneFlight.stop();
  selector.clear();
  hovered = null;
  parts = current.manifest.map(makePart);
  applyBounds(current.bounds);
  choreo.setBounds(current.bounds);
  setPropLook(pad.group, "painted");
  selector.setParts(parts);
  choreo.rebuild(parts);
  if (built) choreo.appearBuilt();
  setQuery(origin);
  syncUi();
}
// ?build=<preset id> or ?design=<saved design id>, so a reload opens the same drone.
function setQuery(origin) {
  const q = new URLSearchParams(location.search);
  if (origin.kind === "preset") {
    q.set("build", origin.id);
    q.delete("design");
  } else if (origin.kind === "design") {
    q.set("design", origin.id);
    q.delete("build");
  } else q.delete("design");
  q.delete("sim"); // a design reopened from the simulator is a draft on the pad from here on
  history.replaceState(history.state, "", `${location.pathname}?${q}${location.hash}`); // keep the host router's state
}

// Reset means reset: back to the empty pad and, if Options changed the build, the pristine preset.
function reset() {
  droneFlight.stop();
  setPhase("pad");
  if (current.modified && current.origin.kind !== "draft") openOrigin(current.origin, { built: false });
  else choreo.reset();
  setPropLook(pad.group, "painted"); // new parts arrive painted; the pad matches them
}

// ---------- take off ----------
// The drone spools its motors up and lifts off where it stands (droneFlight.js); its telemetry and summary come
// from the verdict.
const telemetry = { final: null, html: null };
async function takeOff() {
  if (choreo.state.busy && !choreo.state.exploded) takeOff.queued = true; // after the swap
  if (!isComplete() || choreo.state.busy) return;
  takeOff.queued = false;
  hangar.close();
  if (choreo.state.exploded && !(await choreo.assemble())) return;
  // A part clicked into the clear look stays clear; in flight that showed the battery's insides glaring in the
  // sun. The drone flies as built: every shell opaque again for the flight.
  for (const p of parts) if (p.built) choreo.setLook(p, "opaque");
  droneFlight.start({ parts, verdict: current.verdict, mission: missionOf(current.build), bounds: current.bounds });
}

// ---------- fly in simulation ----------
// The drone on the pad, as built, goes to the simulation engine: its design (record ids), its simulation profile
// (ArduPilot vehicle, frame, footprint, parameters derived from the verdict) and a glTF of the exact parts. The
// server starts the simulation and the browser moves to the simulation page, open on that vehicle.
async function flyInSim() {
  if (!isComplete() || choreo.state.busy || droneFlight.active || flyInSim.busy) return;
  hangar.close();
  selector.clear();
  if (choreo.state.exploded && !(await choreo.assemble())) return;
  for (const p of parts) if (p.built) choreo.setLook(p, "opaque");
  flyInSim.busy = true;
  const say = (html) => {
    flyInSim.note = html;
    syncUi();
  };
  const { origin, build, verdict } = current;
  const name = `${origin.name}${current.modified ? " (modified)" : ""}`;
  try {
    const profile = simProfile({ build, verdict, catalog: droneCatalog, name });
    say(`Packing <strong>${f.esc(name)}</strong> for the simulator…`);
    const model = await exportDroneGlb(parts, { viewK: current.bounds.viewK, bearings: profile.bearings, spinner: profile.spinner });
    const design = createDesign({ name, basedOn: origin.kind === "draft" ? null : origin.id, build });
    say(`Starting the simulation…`);
    const form = new FormData();
    form.set("design", JSON.stringify(design));
    form.set("profile", JSON.stringify({ ...profile, rotors: model.rotors, spinner: model.spinner }));
    form.set("model", new Blob([model.glb], { type: "model/gltf-binary" }), "model.glb");
    const res = await fetch("/api/sim/fly", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `the server answered ${res.status}`);
    say(`Opening the simulator…`);
    location.assign(data.url);
  } catch (err) {
    flyInSim.busy = false;
    say(`<strong class="nogo">Simulation did not start</strong> · ${f.esc(err?.message ?? String(err))}`);
    clearTimeout(flyInSim.timer);
    flyInSim.timer = setTimeout(() => say(null), 9000);
  }
}
flyInSim.busy = false;
flyInSim.note = null;

// ---------- skip: double-click / double-tap on the canvas finishes the running animation ----------
function skipNow() {
  const what = choreo.skip();
  if (what === "settled" && swapping) {
    swapping = false;
    shown = null;
  }
  if (what) syncUi();
}
canvas.addEventListener("dblclick", (e) => {
  if (landingOn()) return;
  e.preventDefault();
  skipNow();
});
let lastTap = null; // double-tap: two touch taps within 320 ms and 30 px
canvas.addEventListener("pointerup", (e) => {
  if (e.pointerType !== "touch" || landingOn()) return;
  const now = performance.now();
  if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
    lastTap = null;
    skipNow();
  } else lastTap = { t: now, x: e.clientX, y: e.clientY };
});

function onPartKey(part) {
  if (part.built) {
    if (choreo.isTopBuilt(part)) choreo.remove(part);
  } else {
    choreo.buildUpTo(part);
  }
}

addEventListener("keydown", (e) => {
  // Keys the host page already handled, or typed into a field, are not ours (on the landing page too).
  if (e.defaultPrevented) return;
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (landingOn()) {
    if (!e.repeat && !["Shift", "Control", "Alt", "Meta", "Tab"].includes(e.key)) {
      e.preventDefault();
      landing.enter(); // any key flies the rest of the way down
    }
    return; // nothing else until the builder has taken over
  }
  if (e.key === "Escape" && hangar.isOpen) return hangar.close();
  const k = e.key.toLowerCase();
  const byKey = parts.find((p) => p.key === k);
  if (byKey) return onPartKey(byKey);
  if (k === " ") {
    if (document.activeElement?.matches?.("button:focus-visible")) return; // Tab-focused: Space presses it
    e.preventDefault();
    if (document.activeElement?.tagName === "BUTTON") document.activeElement.blur();
    choreo.toggleExplode();
  } else if (k === "b") choreo.buildAll();
  else if (k === "r") reset();
  else if (k === "l") takeOff();
  else if (k === "x") setPropLook(pad.group, choreo.toggleLookAll() === "clear" ? "xray" : "painted"); // the pad follows the build
  else if (k === "n") toggleSky("time");
  else if (k === "w") toggleSky("weather");
  else if (k === "[") switchPreset(-1);
  else if (k === "]") switchPreset(1);
});

// ---------- landing page (first load without ?build / ?skip / ?demo) ----------
// The scroll-driven dive from orbit to the pad (ui/landing.js): scroll or drag to descend, click or any key to
// fly the whole way. Once it hands over, the builder runs as usual; scrolling up with nothing built (at rest)
// takes it back up. `landing` stays null when the page opens straight into the builder.
let landing = null;
const landingOn = () => Boolean(landing?.on);
function startLanding() {
  landing = createLanding({
    scene,
    camera,
    controls,
    root,
    stars,
    canvas,
    groundY: () => -pad.layout.plinthH,
    endPose: () => choreo.homePose(choreo.landingView.az),
    view: choreo.landingView,
    onState: (on) => {
      if (on) {
        selector.clear();
        hangar.close();
      } else {
        syncUi();
        inviteToHangar();
      }
    },
  });
}
// The first time the builder takes over in this browser, the Hangar opens to invite browsing the real drones.
function inviteToHangar() {
  try {
    if (localStorage.getItem("dronex.hangarSeen")) return;
    localStorage.setItem("dronex.hangarSeen", "1");
  } catch {
    return;
  }
  hangar.show("list");
}
// Back up to the landing: a scroll up over the canvas while the builder is at rest with nothing built.
const canLeaveBuilder = () =>
  landing && !landing.on && !hangar.isOpen && !choreo.state.busy && !choreo.state.auto && !choreo.state.exploded && !droneFlight.active && parts.every((p) => !p.built);
addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey || e.deltaY >= 0 || e.target !== canvas || !canLeaveBuilder()) return;
    e.preventDefault();
    e.stopPropagation(); // OrbitControls would zoom in
    scene.background = SPACE_BG; // the landing paints its own sky (the world layer is off while it runs)
    landing.resume();
    landing.feed(landing.wheelPx(e));
  },
  { capture: true, passive: false },
);

const unlock = () => {
  sfx.unlock();
  removeEventListener("pointerdown", unlock);
  removeEventListener("keydown", unlock);
};
addEventListener("pointerdown", unlock);
addEventListener("keydown", unlock);

// ---------- loop ----------
applySky();
choreo.prewarm(renderer);
// The planets' maps load after the warm-up: upload them as soon as they arrive, not on the frame they first show.
const loaded = THREE.DefaultLoadingManager.onLoad;
THREE.DefaultLoadingManager.onLoad = () => {
  loaded?.();
  const worldMaps = [];
  world.scene.traverse((o) => {
    for (const u of Object.values(o.material?.uniforms ?? {})) if (u.value?.isTexture) worldMaps.push(u.value);
  });
  choreo.uploadWarmTextures(worldMaps); // spread over frames, one texture each
};
const landingMode = !["build", "design", "sim", "skip", "demo"].some((k) => query.has(k));
if (landingMode) startLanding();
else choreo.home();
syncUi();

// Luxury budget (GTAO, DoF): frame times are averaged over 2 s windows while either is on; a slow window drops
// the DoF for the session if it was on, else GTAO. The first window after load is skipped (shader compiles and
// uploads land there).
const perf = { gtaoOk: true, dofOk: true, sum: 0, n: 0, windows: 0, dofSeen: false };
const animating = () => {
  const s = choreo.state;
  return s.busy > 0 || s.auto || s.scrubbing || landingOn();
};
// Past the luxuries, the guard steps the parts' detail down (setDetailLevel: 2 all, 1 no instanced bolts and
// fewer lines, 0 also the smallest detail pieces) when the frame time stays over 22 ms with DoF and GTAO already
// off; ?lite=1 starts at 0.
let detail = lite ? 0 : 2;
setDetailLevel(detail);
const detailGuard = { sum: 0, n: 0, skip: 1 };
// Dynamic resolution: a 3 s average frame time over 20 ms steps the pixel ratio down (1.5 → 1.25 → 1, the far
// layer's resolution with it) before any detail goes; under 12 ms it steps back up. Never above 1.5.
const PR_MAX = lite ? 1 : Math.min(devicePixelRatio, 1.5);
const PR_STEPS = [PR_MAX, 1.25, 1].filter((v, i, a) => v <= PR_MAX && a.indexOf(v) === i);
const resGuard = { i: 0, sum: 0, n: 0, skip: 1 };
function setPixelRatio(pr) {
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight);
  composer?.setPixelRatio(pr);
  composer?.setSize(innerWidth, innerHeight);
  world.setResolutionScale?.((devicePixelRatio >= 1.5 ? 0.5 : 1) * (pr / PR_MAX));
}
function resolutionBudget(rawDt) {
  if (landingOn() || rawDt > 0.25) return; // (a stall is not a frame rate)
  resGuard.sum += rawDt;
  resGuard.n++;
  if (resGuard.sum < 3) return;
  const avg = resGuard.sum / resGuard.n;
  resGuard.sum = resGuard.n = 0;
  if (resGuard.skip-- > 0) return; // the first window after a change settles
  const next = avg > 0.02 ? Math.min(PR_STEPS.length - 1, resGuard.i + 1) : avg < 0.012 ? Math.max(0, resGuard.i - 1) : resGuard.i;
  if (next === resGuard.i) return;
  resGuard.i = next;
  resGuard.skip = 1;
  setPixelRatio(PR_STEPS[next]);
}
function detailBudget(rawDt) {
  resolutionBudget(rawDt);
  if (resGuard.i < PR_STEPS.length - 1) return void (detailGuard.sum = detailGuard.n = 0); // resolution goes first
  if (detail === 0 || landingOn() || gtao?.enabled || dof?.enabled) return void (detailGuard.sum = detailGuard.n = 0);
  detailGuard.sum += rawDt;
  detailGuard.n++;
  if (detailGuard.sum < 3) return;
  const avg = detailGuard.sum / detailGuard.n;
  detailGuard.sum = detailGuard.n = 0;
  if (detailGuard.skip-- > 0) return; // the first window after a change settles
  if (avg > 0.022) {
    detail--;
    detailGuard.skip = 1;
  }
}
let appliedDetail = detail;
function applyDetail() {
  if (detail !== appliedDetail) setDetailLevel((appliedDetail = detail));
}
function luxuryBudget(rawDt) {
  detailBudget(rawDt);
  applyDetail();
  if (!gtao) return;
  gtao.enabled = perf.gtaoOk && !animating();
  if (!gtao.enabled && !dof?.enabled) {
    perf.sum = perf.n = 0;
    perf.dofSeen = false;
    return;
  }
  perf.sum += rawDt;
  perf.n++;
  perf.dofSeen ||= Boolean(dof?.enabled);
  if (perf.sum < 2) return;
  if (perf.windows++ > 0 && perf.sum / perf.n > 0.022) {
    if (perf.dofSeen) perf.dofOk = false;
    else perf.gtaoOk = false;
  }
  perf.sum = perf.n = 0;
  perf.dofSeen = false;
}
// DoF: in on a part focus at rest (the card open); out everywhere else. Focus at the orbit target; the aperture
// puts the full (small) blur at twice the focus distance.
let dofK = 0;
function updateDof(dt) {
  if (!dof) return;
  const focused = choreo.framing().mode === "focus" && !animating();
  const want = perf.dofOk && !landingOn() && focused;
  dofK += ((want ? 1 : 0) - dofK) * (1 - Math.exp(-dt / 0.15));
  dof.enabled = dofK > 0.01;
  if (!dof.enabled) return;
  const d = camera.position.distanceTo(controls.target);
  const maxblur = 0.004;
  dof.uniforms.focus.value = d;
  dof.uniforms.maxblur.value = maxblur;
  dof.uniforms.aperture.value = (dofK * 0.8 * maxblur) / Math.max(0.5, d);
}

const band = { near: null, far: null }; // fog band widths, eased

const clock = new THREE.Clock();
function frame() {
  // The next frame first: an exception anywhere below loses one frame, never the loop (a frozen, blank page).
  requestAnimationFrame(frame);
  const rawDt = clock.getDelta();
  const dt = rawDt > 1 ? 0 : Math.min(rawDt, 0.05); // a stall over 1 s (tab hidden, GPU blocked) never advances the flight clock
  const t = clock.elapsedTime;
  luxuryBudget(rawDt);
  // The far layer draws the day sky and the ground behind the pad; the landing dive draws its own sky over a
  // cleared near pass.
  const worldOn = !landingOn();
  world.setEnabled(worldOn);
  scene.background = landingOn() ? SPACE_BG : null;
  stars.visible = !worldOn; // the world draws its own
  if (worldPass) worldPass.enabled = !landingOn();
  if (nearPass) nearPass.clear = landingOn();
  choreo.update(dt, t);
  landing?.update(dt, t);
  if (!landingOn()) controls.update(); // its polar/distance clamps would bend the dive's path
  droneFlight.update(dt);
  // Depth cue: fog (background colour) in a band around the orbit target, sized by what is framed, so the far
  // side of the drone fades while the near silhouette stays bright. The band is wide at home and while building
  // and tight on a focus or exploded view. Its widths ease over ~0.5 s when the framing changes (no fog jump).
  const { r: R, mode } = choreo.framing();
  const goalNear = 0.6 * R;
  const goalFar = (mode === "focus" || mode === "exploded" ? 3 : 6) * R;
  const kb = band.near == null ? 1 : 1 - Math.exp(-dt / 0.15);
  band.near = band.near == null ? goalNear : band.near + (goalNear - band.near) * kb;
  band.far = band.far == null ? goalFar : band.far + (goalFar - band.far) * kb;
  const dist = camera.position.distanceTo(controls.target);
  const open = landing?.fogOpen ?? 0; // the landing's dive opens the band wide (cloud deck)
  scene.fog.near = Math.max(0.1, THREE.MathUtils.lerp(dist - band.near, dist * 0.5, open));
  scene.fog.far = THREE.MathUtils.lerp(dist + band.far, dist * 8, open);
  if (skyFog && Number.isFinite(skyFog.near_u)) {
    // Day: the builder's tight depth band (in the bright haze colour) would turn everything past the drone into
    // a uniform grey; by day the air is clear out to the recipe's band.
    scene.fog.near = Math.max(scene.fog.near, skyFog.near_u);
    scene.fog.far = Math.max(scene.fog.far, skyFog.far_u ?? skyFog.near_u * 4);
  }
  placeShadow(dt, false);
  updateContact(dt);
  updateDof(dt);
  if (keyBase != null && key.intensity !== keyBase) key.intensity = keyBase;
  // The day sky behind the builder: a faint dark scrim behind the HUD line and the logo keeps them legible.
  const bright = worldOn && skyState.time === "day";
  if (bright !== document.body.classList.contains("bright-sky")) document.body.classList.toggle("bright-sky", bright);
  if (worldOn) {
    viewerKm.copy(PAD_KM).addScaledVector(camera.position, 1 / (1000 * SCALE));
    world.setViewer({ body: "earth", pos_km: viewerKm, camera });
  }
  if (composer) composer.render();
  else {
    if (worldOn) world.render(renderer);
    renderer.autoClear = !worldOn;
    renderer.render(scene, camera);
    renderer.autoClear = true;
  }
}
frame();

if (query.get("demo") === "1") setTimeout(() => choreo.buildAll(), 700);

// ?sim=<id>: a design sent to the simulator, reopened from its "Open in DroneX" bookmark. It comes from the server
// (/api/sim/designs/<id>), is checked against the datasets like any design, and lands on the pad as a draft.
if (query.get("sim")) {
  fetch(`/api/sim/designs/${encodeURIComponent(query.get("sim"))}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the server answered ${r.status}`))))
    .then(({ design }) => {
      const checked = validateDesign(design, droneCatalog);
      if (!checked.ok) throw new Error(checked.reason);
      openOrigin({ kind: "draft", id: null, name: checked.design.name, build: designToBuild(checked.design) });
    })
    .catch((err) => {
      flyInSim.note = `<strong class="nogo">Could not reopen that drone</strong> · ${f.esc(err.message)}`;
      syncUi();
      setTimeout(() => {
        flyInSim.note = null;
        syncUi();
      }, 9000);
    });
}
