// Choreography: anime.js drives every motion (paths, springs, staggers); three.js only draws.
// Mechanical model (design §4, round 7): pieces are solid from the first frame; constant timings for every kind.
// Build    = pieces fly in from the staging side on gentle arcs in `order`, each turned by `spin` about Y and
//            rolled about its travel axis; the turn unwinds over the last 30 % of the path; spring landing
//            (260/14), a tick per piece; lock = flash + clunk + shake, fired when the body has seated (60 % of the
//            shell pieces landed, or 70 % of all pieces when there are no shells) while details keep ticking in;
//            built/HUD update when the last piece lands. Sub-assemblies (piece.engine) stagger ~70 ms
//            apart and ~25 ms between their own pieces; other parts ~38 ms.
// Remove   = reverse: unscrew (turn winds up over the first 30 %), top-down, back to the staging side.
// Explode  = engineering drawing: parts off the axis slide out along their own direction, parts on the axis
//            rise just enough to clear what they overlap (droneExplodeLayout). Assemble = reverse, bottom-up.
// Swap     = applyManifest(specs) / swap(part, spec): parts above lift (0.5 s) → old part unscrews out
//            (+0.2 s) → new part flies in (+0.7 s) and locks → parts above descend (0.5 s) + clunk.
//            Collateral changes ride along (every arm when the motor changes, every prop with the propeller).
//            restack(manifest) animates group y to slotY.
// Ghost    = the next buildable part shows as a faint hologram at its slot (idle 0.12, hover 0.35); hidden
//            while busy, exploded or auto-building. part.ghostActive marks the clickable one.
// Highlight = soft emissive pulse in COLORS.select on a selected part's (per-mesh cloned) materials.
// Look     = per part, per instance: opaque (shells 0.92) or clear (0.18, interiors visible), toggled by a click
//            on the part or by X for all; exploded parts keep theirs; R / preset / swap-in / rebuild → opaque.
//            Edge lines stay at their base in both looks (the silhouette survives the clear look).
import * as THREE from "three";
import { animate, spring } from "animejs";
import { createHologramMaterial } from "./fx/hologram.js";
import { createBoltFlash } from "./fx/flash.js";
import { COLORS, LOOK, setShellOpacity as setShell } from "./parts.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const D = (ms) => (reduced ? ms * 0.55 : ms);
const rnd = (a, b) => a + Math.random() * (b - a);
const rnd3 = (r) => new THREE.Vector3(rnd(-r, r), rnd(-r, r), rnd(-r, r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const Y = new THREE.Vector3(0, 1, 0);
const tmpQ2 = new THREE.Quaternion();
const tmpC = new THREE.Color();

// Shell opacity per part look: opaque by default, clear (interiors visible) after a click or X.
const SHELL = { opaque: 0.92, clear: 0.18 };
const LINE_BASE = 0.55; // UI4's built edge-line opacity
// Opacity states belong to the x-ray look only; the classic look keeps opaque shells.
const setShellOpacity = LOOK === "xray" ? setShell : () => {};
const GHOST_IDLE = 0.12;
const GHOST_HOVER = 0.35;
// Drones (visual shares of the drone's reach from its axis, stackRadius; a drone is drawn at a display scale, so
// metres mean nothing here): home framing fill, the exploded view's layer gap and how far parts that sit off
// the axis (arms, props, camera, tail, nose motor) move out along their own direction.
const DRONE_FILL = 1; // fitDist adds the reach to the distance, so 1 fills ~60 % of the width
const DRONE_GAP_R = 0.09;
const DRONE_PIECE_K = 0.45;
// (A duct guard rises over the arms it sits on; a quadplane's lift props over their booms; booms slide out
// sideways off the wing.)
const DRONE_OVER = { "drone-propeller": ["drone-arm", "drone-boom", "drone-duct"], "drone-duct": ["drone-arm", "drone-frame"] };
const DRONE_OUT_R = { "drone-arm": 0.42, "drone-propeller": 0.42, "drone-camera": 0.5, "drone-tail": 0.32, "drone-nose-motor": 0.24, "drone-nose-propeller": 0.48, "drone-boom": 0.3 };
const SWAP_CLEAR_M = 3; // swap: how far the parts above lift to make room, metres (visual)
// Timings (ms). Same for every part kind; only piece counts differ.
const T = {
  fly: 520, // one piece's path in
  flyOut: 460, // one piece's path out
  engineStagger: 70,
  subStagger: 25,
  stagger: { shell: 38, interior: 28, detail: 20 }, // by mesh.userData.kind; shells set the pace

  outStaggerMax: 340, // remove: total stagger cap (top-down), so a 100-piece cluster still leaves in ~0.8 s
  swapInStaggerMax: 600, // swap: total arrival stagger cap, keeps the new part at 0.9–1.3 s
  lift: 500,
  outAt: 200,
  inAt: 700,
  descend: 500,
};

export function createChoreographer({ parts, scene, root, camera, controls, sfx, onChange, scale = 0.25, bounds: initialBounds = null, makePart = null }) {
  const flash = createBoltFlash();
  scene.add(flash.object3d);

  const state = { busy: 0, exploded: false, scrubbing: false, auto: false, gen: 0, shake: 0 };
  const live = new Set();
  const selectColor = new THREE.Color(COLORS.select ?? 0xffb020);
  const highlighted = new Set();
  const emissive0 = new WeakMap(); // material -> { color, intensity } before any highlight
  const leaving = new Set(); // old parts still flying out of a swap (not in `parts` any more)
  let bounds = initialBounds;
  let ghostPart = null;
  let warmRenderer = null;

  // anime.js wrapper: returns a promise (with the animation on .anim), remembers the animation so reset()
  // can cancel it.
  function run(targets, params) {
    let anim;
    const promise = new Promise((resolve) => {
      anim = animate(targets, {
        ...params,
        onComplete: (self) => {
          live.delete(anim);
          params.onComplete?.(self);
          resolve();
        },
      });
      live.add(anim);
    });
    promise.anim = anim;
    return promise;
  }
  function cancelAll() {
    for (const a of live) a.cancel();
    live.clear();
  }

  function changed() {
    syncGhost();
    onChange();
  }

  // Hologram scan-band spacing: ~4 units on a 17-unit stack, proportional on others (hologram.js header).
  const bandPeriod = () => (bounds ? Math.max(1.5, bounds.height_u * 0.23) : 4);

  // ---------- per-part setup: ghost preview, arrival order, mechanical fallbacks ----------
  function setupPart(part) {
    part.holoGhost = createHologramMaterial({ color: COLORS.holo, opacity: 1, bandPeriod: bandPeriod() });
    part.holoGhost.material.depthTest = false; // seen (and clickable) even inside the interstage
    part.holoGhost.setOpacity(0);
    part.ghost = new THREE.Group();
    part.ghost.position.y = part.slotY;
    part.ghost.visible = false;
    part.ghost.renderOrder = 3;
    part.ghostFade = { v: 0 };
    part.ghostActive = false;
    part.hl = { v: 0 };
    part.look = "opaque";
    part.shell = { v: SHELL.opaque };
    setShellOpacity(part, SHELL.opaque);
    applyLines(part);
    part.group.position.y = part.slotY;
    const n = part.pieces.length;
    part.arrival = [...part.pieces].sort((a, b) => (a.order ?? a.index) - (b.order ?? b.index) || a.bottomY - b.bottomY);
    const step = Math.min(0.3, (part.height * 1.2) / Math.max(1, n));
    part.arrival.forEach((piece, rank) => {
      piece.rank = rank;
      piece.axis = Number.isFinite(piece.axisOffset) ? piece.axisOffset : (rank - (n - 1) / 2) * step;
      piece.turn = Number.isFinite(piece.spin) ? piece.spin : rank % 2 ? -0.9 : 0.9;
      piece.engineIndex = piece.engine ?? piece.mesh.userData.engine ?? null;
    });
    // Rank of each piece inside its own engine (for the 35 ms sub-stagger).
    const perEngine = new Map();
    for (const piece of part.arrival) {
      if (piece.engineIndex == null) continue;
      const k = perEngine.get(piece.engineIndex) ?? 0;
      piece.subRank = k;
      perEngine.set(piece.engineIndex, k + 1);
    }
    part.group.traverse((o) => {
      if (o.isLine) o.castShadow = o.receiveShadow = false; // edge lines: drawn, never in the shadow pass
    });
    for (const piece of part.pieces) {
      const g = new THREE.Mesh(piece.mesh.geometry, part.holoGhost.material);
      g.position.copy(piece.rest.position);
      g.quaternion.copy(piece.rest.quaternion);
      g.renderOrder = 3;
      g.userData.partId = part.id;
      g.userData.ghost = true;
      part.ghost.add(g);
      piece.mesh.userData.partId ??= part.id;
      piece.mesh.visible = part.built;
    }
    root.add(part.group, part.ghost);
  }

  function retirePart(part) {
    part.ghostAnim?.cancel();
    part.shellAnim?.cancel();
    part.dimAnim?.cancel();
    part.hlAnim?.cancel();
    highlighted.delete(part);
    leaving.delete(part);
    if (ghostPart === part) ghostPart = null;
    root.remove(part.group, part.ghost);
    // Pieces and everything under them (edge-line children carry their own geometry and material; each piece
    // also keeps its inactive look, painted or x-ray, in userData.looks).
    part.group.traverse((o) => {
      o.geometry?.dispose();
      for (const m of new Set([].concat(o.material ?? [], Object.values(o.userData.looks ?? {})))) m.dispose();
    });
    part.holoGhost?.dispose();
  }

  for (const part of parts) setupPart(part);

  const index = (part) => parts.indexOf(part);
  const canBuild = (part) => !part.built && !part.busy && (index(part) === 0 || parts[index(part) - 1].built);
  const isTopBuilt = (part) => part.built && parts.slice(index(part) + 1).every((p) => !p.built);
  const topY = () => parts.reduce((m, p) => (p.built ? Math.max(m, p.slotY + p.height) : m), 0);
  const nextBuildable = () => {
    const p = parts.find((q) => !q.built);
    return p && canBuild(p) ? p : null;
  };

  // Where pieces come from: the left of the view, a little toward the camera, scaled to the current framing.
  function sourcePoint(part) {
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
    const d = camera.position.distanceTo(controls.target);
    const halfW = d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
    return new THREE.Vector3(0, part.slotY + part.height * 0.5 + d * 0.05, 0)
      .addScaledVector(right, -halfW * 0.62)
      .addScaledVector(fwd, -d * 0.1);
  }

  // ---------- camera ----------
  // Framing (design round 10): the stack fills ~85 % of the viewport height; a part flying in is framed at
  // ~60 % with a slight orbit, then the camera eases back to the stack; a clicked part gets the 60 % focus.
  const camDir = new THREE.Vector3();
  const elevation = () => Math.asin(THREE.MathUtils.clamp(camDir.copy(camera.position).sub(controls.target).normalize().y, -1, 1));
  // A drone is wide and flat: seen from a low angle its arms overlap and the props read edge-on, so the home
  // view is a 3/4 view from above, and the build hero angle sits 6° below it.
  const DRONE_PITCH = THREE.MathUtils.degToRad(31);
  const homePitch = () => DRONE_PITCH;
  const heroPitch = () => DRONE_PITCH - THREE.MathUtils.degToRad(6);
  let camAnim = null; // one camera move at a time: a new framing replaces the one in flight
  // pitch: target elevation (radians) or null to keep the current one. tx/tz move the orbit target off the axis
  // (twin compare frames the pair); every other framing brings it back to the axis.
  function frameTo({ ty, dist, tx = 0, tz = 0, orbit = 0, pitch = null, duration = D(1100), ease = "inOutCubic" }) {
    const cur = { tx: controls.target.x, ty: controls.target.y, tz: controls.target.z, d: camera.position.distanceTo(controls.target), az: 0, el: elevation() };
    let az = 0;
    camAnim?.cancel();
    live.delete(camAnim);
    const p = run(cur, {
      tx,
      ty,
      tz,
      d: dist,
      az: orbit,
      el: pitch ?? cur.el,
      duration,
      ease,
      onUpdate: () => {
        camDir.copy(camera.position).sub(controls.target).normalize();
        controls.target.set(cur.tx, cur.ty, cur.tz);
        if (orbit) camDir.applyAxisAngle(Y, cur.az - az);
        az = cur.az;
        if (pitch != null) {
          const h = Math.hypot(camDir.x, camDir.z) || 1;
          const c = Math.cos(cur.el);
          camDir.set((camDir.x / h) * c, Math.sin(cur.el), (camDir.z / h) * c);
        }
        camera.position.copy(controls.target).addScaledVector(camDir, cur.d);
      },
    });
    camAnim = p.anim;
    return p;
  }
  // Distance at which the span [y0, y1] around the axis (radius r) fills `frac` of the viewport height
  // (and fits the width), for the current camera pitch.
  function fitDist(h, r, frac, atPitch = null) {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camDir.copy(camera.position).sub(controls.target).normalize();
    const pitch = Math.abs(atPitch ?? Math.asin(THREE.MathUtils.clamp(camDir.y, -1, 1)));
    const dv = (h * Math.cos(pitch) + 2 * r * Math.sin(pitch)) / (2 * tanHalf * frac);
    const dh = (2 * r) / (2 * tanHalf * camera.aspect * frac);
    return Math.max(dv, dh) + r;
  }
  // The centre sits `shift` of the view (default 2 %) below the span's middle, so the base clears the bar.
  // What the camera frames now (main's fog band): its radius and mode ("stack" | "part" | "focus" | "exploded").
  let framedR = initialBounds?.radius_u ?? 1;
  let framedMode = "stack";
  function spanFraming(y0, y1, r, frac, shift = 0.02, atPitch = null) {
    const dist = Math.max(controls.minDistance, fitDist(Math.max(y1 - y0, 0.05), r, frac, atPitch));
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    return { ty: (y0 + y1) / 2 - shift * 2 * dist * tanHalf, dist };
  }
  function frameSpan(y0, y1, r, frac, { shift = 0.02, mode = "stack", ...opts } = {}) {
    framedR = r;
    framedMode = mode;
    return frameTo({ ...spanFraming(y0, y1, r, frac, shift), ...opts });
  }
  const stackHeight = () => Math.max(bounds?.height_u ?? 0, topY(), 1);
  const stackRadius = () => bounds?.radius_u ?? 1;
  function frameStack(opts = {}) {
    return frameSpan(0, stackHeight(), stackRadius(), DRONE_FILL, { pitch: DRONE_PITCH, ...opts });
  }
  let orbitSign = 1;
  // Incoming part: 60 % of the view, a slight orbit, and the hero angle (8° lower, so rings read as ellipses).
  function framePart(part) {
    orbitSign = -orbitSign;
    return frameSpan(part.slotY, part.slotY + part.height, part.radius, 0.6, { orbit: 0.2 * orbitSign, pitch: heroPitch(), mode: "part" });
  }
  // Click focus: frame the part where it is now (assembled or exploded), from its visible meshes.
  // { frac, shift } let a phone keep the part in the upper half, above the bottom-sheet card.
  const focusBox = new THREE.Box3();
  function focus(part, { frac = 0.6, shift = 0.02 } = {}) {
    if (!part?.pieces?.length) return;
    focusBox.makeEmpty();
    for (const piece of part.pieces) if (piece.mesh.visible) focusBox.expandByObject(piece.mesh);
    if (focusBox.isEmpty()) return;
    // A drone's parts sit off its axis (an arm, a prop, the camera at the nose): orbit the part itself, with a
    // little of the vehicle round it, rather than the vehicle's axis (which would frame the whole drone).
    const c = focusBox.getCenter(new THREE.Vector3());
    const size = focusBox.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z) / 2;
    framedR = r;
    framedMode = "focus";
    return frameTo({ ...spanFraming(focusBox.min.y, focusBox.max.y, r, frac * 0.8, shift, heroPitch()), tx: c.x, tz: c.z, pitch: heroPitch() });
  }
  function unfocus() {
    return state.exploded ? frameExploded() : frameStack();
  }
  let explodedSpan = null; // { top, r } of the current exploded view
  // A fixed wing explodes along its fuselage (motor and prop forward, tail back): seen nose-on that reads as a
  // line. When an explode starts (never on a later re-frame, so a user's own orbit stands) the camera swings to
  // the nearest 3/4 view, WING_X_AZ off the fuselage axis, front or back, where the wing and the spread both show.
  const WING_X_AZ = THREE.MathUtils.degToRad(55);
  function wingOrbit() {
    if (!parts.some((p) => p.kind === "drone-wing")) return 0;
    camDir.copy(camera.position).sub(controls.target);
    const az = Math.atan2(camDir.x, camDir.z);
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const turns = [WING_X_AZ, -WING_X_AZ, Math.PI - WING_X_AZ, WING_X_AZ - Math.PI].map((t) => wrap(t - az));
    return turns.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
  }
  function frameExploded({ start = false } = {}) {
    if (!explodedSpan?.boxes) return frameStack();
    const orbit = start ? wingOrbit() : 0;
    framedR = explodedSpan.r;
    framedMode = "exploded";
    return frameTo({ ...droneFit(explodedSpan.boxes, heroPitch(), camAz(orbit)), pitch: heroPitch(), orbit });
  }
  // The home shot as a pose (no animation), for a camera move that must end exactly where home() would:
  // azimuth az (radians, around +Y from +Z), home pitch.
  function homePose(az = 0.58) {
    const pitch = homePitch();
    const { ty, dist } = spanFraming(0, stackHeight(), stackRadius(), DRONE_FILL, 0.02, pitch);
    const target = new THREE.Vector3(0, ty, 0);
    const c = Math.cos(pitch);
    const position = target.clone().add(new THREE.Vector3(Math.sin(az) * c, Math.sin(pitch), Math.cos(az) * c).multiplyScalar(dist));
    framedR = stackRadius();
    framedMode = "stack";
    return { target, position };
  }
  // Home: the whole stack-to-be at 85 %, the first ghost waiting on the pad.
  function home() {
    return frameStack({ duration: D(900) });
  }
  function setBounds(b) {
    bounds = b;
    for (const part of parts) {
      const u = part.holoGhost?.material.uniforms.uBandPeriod;
      if (u) u.value = bandPeriod();
    }
  }

  // ---------- ghost: always-on faint preview of the next buildable part ----------
  function fadeGhost(part, v) {
    part.ghostAnim?.cancel();
    part.ghostActive = v > 0;
    if (v > 0) part.ghost.visible = true;
    part.ghostAnim = animate(part.ghostFade, {
      v,
      duration: D(v > part.ghostFade.v ? 260 : 180),
      ease: "outQuad",
      onUpdate: () => part.holoGhost.setOpacity(part.ghostFade.v),
      onComplete: () => {
        if (v === 0) part.ghost.visible = false;
      },
    });
  }
  function hideGhostNow(part) {
    part.ghostAnim?.cancel();
    part.ghostFade.v = 0;
    part.ghostActive = false;
    part.holoGhost.setOpacity(0);
    part.ghost.visible = false;
  }
  function syncGhost() {
    if (ghostPart && !parts.includes(ghostPart)) ghostPart = null;
    const want = state.busy || state.exploded || state.auto ? null : nextBuildable();
    if (want === ghostPart) return;
    if (ghostPart) fadeGhost(ghostPart, 0);
    ghostPart = want;
    if (want) fadeGhost(want, GHOST_IDLE);
  }
  // Hover on the ghost (from the selector). Ignored for anything but the current ghost.
  function setGhost(part, on) {
    if (!part || part !== ghostPart) return;
    fadeGhost(part, on ? GHOST_HOVER : GHOST_IDLE);
  }

  // ---------- look: opaque / clear shells per part ----------
  const shellTarget = (part) => (part.look === "clear" ? SHELL.clear : SHELL.opaque);
  function fadeShell(part, v = shellTarget(part), duration = D(420)) {
    part.shellAnim?.cancel();
    if (duration <= 0) {
      part.shell.v = v;
      setShellOpacity(part, v);
      applyLines(part);
      return;
    }
    part.shellAnim = animate(part.shell, {
      v,
      duration,
      ease: "outQuad",
      onUpdate: () => {
        setShellOpacity(part, part.shell.v);
        applyLines(part); // setShellOpacity scales shell lines with the shell; keep them at their base
      },
    });
  }
  function setLook(part, look) {
    if (!part?.pieces || part.look === look) return;
    part.look = look;
    fadeShell(part);
  }
  const toggleLook = (part) => setLook(part, part?.look === "clear" ? "opaque" : "clear");
  // X: every built part at once; any opaque one makes them all clear, else all go back to opaque.
  function toggleLookAll() {
    const built = parts.filter((p) => p.built);
    const look = built.some((p) => p.look !== "clear") ? "clear" : "opaque";
    for (const p of built) setLook(p, look);
    return look;
  }

  // Edge lines: while a part is selected, the OTHER parts' lines dim to 0.3 (from 0.55) so the focused part
  // pops. A line's opacity = its built base (UI4: line.userData.base) × dim, in either look.
  const LINE_DIM = 0.3 / LINE_BASE;
  function applyLines(part) {
    if (LOOK !== "xray") return;
    const dim = part.dim?.v ?? 1;
    part.group.traverse((o) => {
      if (!o.isLine || !o.material) return;
      o.userData.base ??= o.material.opacity;
      o.material.opacity = Math.min(1, o.userData.base * dim);
    });
  }
  function fadeDim(part, v) {
    part.dim ??= { v: 1 };
    part.dimAnim?.cancel();
    part.dimAnim = animate(part.dim, { v, duration: D(320), ease: "outQuad", onUpdate: () => applyLines(part) });
  }

  // ---------- highlight: emissive pulse on the selected part ----------
  const materialsOf = (part) => part.pieces.flatMap((p) => [].concat(p.mesh.material));
  function highlight(part, on) {
    if (!part?.pieces) return;
    part.hlAnim?.cancel();
    if (on) {
      for (const m of materialsOf(part)) {
        if (m.emissive && !emissive0.has(m)) emissive0.set(m, { color: m.emissive.clone(), intensity: m.emissiveIntensity });
      }
      highlighted.add(part);
      fadeDim(part, 1);
      for (const p of parts) if (p !== part) fadeDim(p, LINE_DIM);
    } else if (!highlighted.has(part)) return;
    else {
      for (const p of parts) if (p !== part) fadeDim(p, 1);
    }
    part.hlAnim = animate(part.hl, {
      v: on ? 1 : 0,
      duration: D(on ? 240 : 380),
      ease: "outQuad",
      onComplete: () => {
        if (!on) clearHighlight(part);
      },
    });
  }
  function clearHighlight(part) {
    part.hlAnim?.cancel();
    part.hl.v = 0;
    highlighted.delete(part);
    for (const m of materialsOf(part)) {
      const e0 = emissive0.get(m);
      if (!e0) continue;
      m.emissive.copy(e0.color);
      m.emissiveIntensity = e0.intensity;
    }
  }
  function updateHighlights(t) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.4);
    for (const part of highlighted) {
      const k = part.hl.v * (0.12 + 0.12 * pulse);
      for (const m of materialsOf(part)) {
        const e0 = emissive0.get(m);
        if (!e0) continue;
        m.emissive.copy(e0.color).multiplyScalar(e0.intensity * (1 - k)).add(tmpC.copy(selectColor).multiplyScalar(k));
        m.emissiveIntensity = 1;
      }
    }
  }

  // ---------- mechanical build / remove ----------
  // Arrival delays in part.arrival order: engine clusters go engine by engine with the sub-pieces of one engine
  // close behind each other, then the cluster's shared pieces (mount, heat shield); everything else follows in
  // `order`, each step set by the piece kind (shells 38, interiors 28, details 20 ms). `cap` compresses the
  // whole stagger to at most `cap` ms (swap).
  const kindStep = (p) => T.stagger[p.mesh.userData.kind] ?? T.stagger.shell;
  function arrivalDelays(part, cap = Infinity) {
    const delays = part.arrival.map((p) => (p.engineIndex != null ? p.engineIndex * T.engineStagger + (p.subRank ?? 0) * T.subStagger : null));
    const enginesEnd = delays.reduce((m, d) => (d == null ? m : Math.max(m, d)), -Infinity);
    let t = Number.isFinite(enginesEnd) ? enginesEnd : null;
    part.arrival.forEach((p, i) => {
      if (delays[i] != null) return;
      t = t == null ? 0 : t + kindStep(p);
      delays[i] = t;
    });
    const max = Math.max(0, ...delays);
    const k = max > cap ? cap / max : 1;
    return delays.map((d) => D(d * k));
  }

  // The piece's rest orientation turned by `spin` about Y and rolled about its travel direction, scaled by s.
  function turnedQuat(piece, s, travelAxis, roll, out) {
    out.copy(piece.rest.quaternion);
    if (roll) out.premultiply(tmpQ2.setFromAxisAngle(travelAxis, roll * s));
    return out.premultiply(tmpQ2.setFromAxisAngle(Y, piece.turn * s));
  }

  // onSeated fires once the part's body is in place (see header); the promise resolves when every piece is.
  function flyIn(part, sourceWorld, { cap = Infinity, onSeated } = {}) {
    fadeShell(part, shellTarget(part), 0);
    const source = part.group.worldToLocal(sourceWorld.clone());
    const k = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) / 18, 0.6, 2.2);
    const delays = arrivalDelays(part, cap);
    const isShell = (p) => p.mesh.userData.kind === "shell";
    const shells = part.arrival.filter(isShell).length;
    const need = shells ? Math.ceil(shells * 0.6) : Math.ceil(part.arrival.length * 0.7);
    let landed = 0;
    let seated = false;
    const land = (piece) => {
      if (seated || (shells && !isShell(piece))) return;
      if (++landed >= need) {
        seated = true;
        onSeated?.();
      }
    };
    return Promise.all(
      part.arrival.map((piece, i) => {
        const mesh = piece.mesh;
        const end = piece.rest.position;
        const start = source.clone().add(rnd3(0.7 * k));
        const mid = start
          .clone()
          .lerp(end, 0.5)
          .add(new THREE.Vector3(rnd(-0.4, 0.4) * k, rnd(0.8, 1.6) * k, rnd(-0.4, 0.4) * k)); // gentle arc
        const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
        const over = curve.getTangent(1).normalize().multiplyScalar(0.06 * k); // tiny overshoot, the spring takes it back
        const travel = curve.getTangent(0.5).normalize();
        const roll = (Math.random() < 0.5 ? -1 : 1) * rnd(0.5, 1.1);
        const prog = { t: 0 };
        mesh.visible = false;
        return run(prog, {
          t: 1,
          duration: D(T.fly),
          delay: delays[i],
          ease: "outQuart",
          onBegin: () => {
            mesh.visible = true;
          },
          onUpdate: () => {
            const t = prog.t;
            curve.getPoint(t, mesh.position).addScaledVector(over, t);
            turnedQuat(piece, 1 - smooth((t - 0.7) / 0.3), travel, roll, mesh.quaternion);
          },
          onComplete: () => {
            mesh.quaternion.copy(piece.rest.quaternion);
            sfx.play("tick", { rate: rnd(0.9, 1.12) });
            land(piece);
          },
        }).then(() => run(mesh.position, { x: end.x, y: end.y, z: end.z, ease: spring({ stiffness: 260, damping: 14 }) }));
      }),
    );
  }

  function flyOut(part, sourceWorld) {
    const source = part.group.worldToLocal(sourceWorld.clone());
    const k = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) / 18, 0.6, 2.2);
    const order = [...part.arrival].reverse(); // top-down
    const step = Math.min(T.stagger.shell, T.outStaggerMax / Math.max(1, order.length - 1));
    return Promise.all(
      order.map((piece, i) => {
        const mesh = piece.mesh;
        const start = mesh.position.clone();
        const end = source.clone().add(rnd3(0.8 * k));
        const mid = start
          .clone()
          .lerp(end, 0.5)
          .add(new THREE.Vector3(rnd(-0.4, 0.4) * k, rnd(0.7, 1.4) * k, rnd(-0.4, 0.4) * k));
        const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
        const travel = curve.getTangent(0.5).normalize();
        const roll = (Math.random() < 0.5 ? -1 : 1) * rnd(0.5, 1.1);
        const prog = { t: 0 };
        return run(prog, {
          t: 1,
          duration: D(T.flyOut),
          delay: D(i * step),
          ease: "inQuart",
          onUpdate: () => {
            const t = prog.t;
            curve.getPoint(t, mesh.position);
            turnedQuat(piece, smooth(t / 0.3), travel, roll, mesh.quaternion); // unscrew first, then leave
          },
          onComplete: () => {
            mesh.visible = false;
            mesh.position.copy(piece.rest.position);
            mesh.quaternion.copy(piece.rest.quaternion);
          },
        });
      }),
    );
  }

  function lock(part) {
    flash.fire({ position: new THREE.Vector3(0, part.slotY + 0.02, 0), radius: part.radius * 1.35, color: 0xfff1e0 }); // warm white
    sfx.play("clunk");
    state.shake = 1;
  }

  // One part in: fly-in, lock when its body has seated (onSeated), built when its last detail has landed.
  async function buildPart(part, { onSeated } = {}) {
    const gen = state.gen;
    state.busy++;
    part.busy = true;
    hideGhostNow(part);
    changed();
    sfx.play("whoosh");
    framePart(part);
    let locked = false;
    const seat = () => {
      if (locked || gen !== state.gen) return;
      locked = true;
      lock(part);
      onSeated?.();
    };
    await flyIn(part, sourcePoint(part), { onSeated: seat });
    if (gen !== state.gen) return false;
    part.built = true;
    part.busy = false;
    state.busy--;
    seat();
    if (!state.auto) frameStack(); // Build all keeps following the parts and settles on the stack at the end
    changed();
    return true;
  }

  function build(part) {
    if (state.busy || state.exploded || !canBuild(part)) return Promise.resolve(false);
    return buildPart(part);
  }

  async function remove(part) {
    if (state.busy || state.exploded || !isTopBuilt(part)) return false;
    const gen = state.gen;
    state.busy++;
    part.busy = true;
    part.removing = true;
    if (highlighted.has(part)) clearHighlight(part);
    changed();
    sfx.play("whoosh", { rate: 0.8 });
    await flyOut(part, sourcePoint(part));
    if (gen !== state.gen) return false;
    part.built = false;
    part.busy = false;
    part.removing = false;
    state.busy--;
    frameStack();
    changed();
    return true;
  }

  // ---------- explode / assemble ----------
  // A drone's exploded view is an engineering drawing, not a column: stacking 14 parts one above another sends
  // them hundreds of units up. Instead each part keeps its place and moves a little:
  // parts off the axis slide out along their own direction (DRONE_OUT_R: arms and props radially, the camera
  // forward, the tail back) and stay at their height; parts on the axis rise just enough to clear, by one gap,
  // the on-axis parts already placed whose footprint they overlap (stack over the frame, battery over the
  // stack, a wing over the fuselage); props rise over their motors (DRONE_OVER). Pieces spread inside their
  // part by DRONE_PIECE_K of their own explode distance, so the drawing stays compact. Returns
  // { lifts (part -> lift), top, push (part -> horizontal offset), reach (the exploded reach from the axis), boxes }.
  const xBox = new THREE.Box3();
  const xV = new THREE.Vector3();
  function droneBox(part, k) {
    part.group.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    const base = new THREE.Vector3().setFromMatrixPosition(part.group.matrixWorld);
    for (const piece of part.pieces) {
      xBox.setFromObject(piece.mesh);
      if (xBox.isEmpty()) continue;
      xBox.translate(xV.copy(base).negate());
      xBox.translate(xV.copy(piece.explode.dir).multiplyScalar(piece.explode.dist * k).addScaledVector(Y, piece.axis));
      box.union(xBox);
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.01, 0, -0.01), new THREE.Vector3(0.01, part.height, 0.01));
    return box;
  }
  function droneExplodeLayout(built) {
    const R = stackRadius();
    const gap = DRONE_GAP_R * R;
    const lifts = new Map();
    const push = new Map();
    const placed = [];
    let top = 0;
    let reach = R;
    const overlaps = (a, b) => a.min.x < b.max.x && a.max.x > b.min.x && a.min.z < b.max.z && a.max.z > b.min.z;
    for (const part of built) {
      const box = droneBox(part, DRONE_PIECE_K);
      const c = box.getCenter(new THREE.Vector3()).setY(0);
      const out = DRONE_OUT_R[part.kind] ?? 0;
      const off = c.lengthSq() > 1e-6 && out ? c.normalize().multiplyScalar(out * R) : new THREE.Vector3();
      box.translate(off);
      const over = DRONE_OVER[part.kind];
      let lift = Math.max(0, -box.min.y - part.slotY);
      for (const q of placed) {
        const rises = over ? over.includes(q.part.kind) : !out && !q.out;
        if (rises && overlaps(box, q.box)) lift = Math.max(lift, q.top + gap - (part.slotY + box.min.y));
      }
      lifts.set(part, lift);
      push.set(part, off);
      const t = part.slotY + lift + box.max.y;
      placed.push({ part, box, out, top: t });
      top = Math.max(top, t);
      reach = Math.max(reach, Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z));
    }
    // Every part's exploded box in vehicle coordinates, so the framing can fit what is really there.
    const boxes = placed.map((q) => q.box.clone().translate(new THREE.Vector3(0, q.part.slotY + lifts.get(q.part), 0)));
    return { lifts, top, push, reach, boxes };
  }
  // The exploded drone framing: the distance and target height at which every corner of every exploded part box
  // lands inside DRONE_X_FIT of the view (height and width) from this pitch and azimuth. A span-and-radius fit
  // treats the drone as a cylinder: a tall courier, its battery high over a small axis, then ran
  // off the top of the view. Fitting the real boxes keeps every part in, with margin, whatever the shape.
  const DRONE_X_FIT = { v: 0.74, h: 0.86 }; // shares of the view: room for the HUD above and the bar below
  function droneFit(boxes, pitch, az) {
    const pts = [];
    for (const b of boxes) for (let i = 0; i < 8; i++) pts.push(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const lim = { v: tanV * DRONE_X_FIT.v, h: tanV * camera.aspect * DRONE_X_FIT.h };
    const back = new THREE.Vector3(Math.sin(az) * Math.cos(pitch), Math.sin(pitch), Math.cos(az) * Math.cos(pitch)); // target -> camera
    const fwd = back.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, Y).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd);
    const v = new THREE.Vector3();
    const cam = new THREE.Vector3();
    // [lowest, highest] vertical view slope of the points, or null if one is outside the view at distance d.
    const slopes = (ty, d) => {
      cam.set(0, ty, 0).addScaledVector(back, d);
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of pts) {
        v.subVectors(p, cam);
        const z = v.dot(fwd);
        if (z <= camera.near) return null;
        const sv = v.dot(up) / z;
        if (Math.abs(sv) > lim.v || Math.abs(v.dot(right) / z) > lim.h) return null;
        lo = Math.min(lo, sv);
        hi = Math.max(hi, sv);
      }
      return [lo, hi];
    };
    const ys = pts.map((p) => p.y);
    let ty = (Math.min(...ys) + Math.max(...ys)) / 2;
    let dist = controls.minDistance;
    for (let it = 0; it < 6; it++) {
      let a = controls.minDistance;
      let b = Math.max(a * 2, 1);
      while (!slopes(ty, b) && b < 1e5) b *= 2;
      if (slopes(ty, a)) b = a;
      for (let k = 0; k < 40 && b - a > 1e-3 * b; k++) {
        const m = (a + b) / 2;
        if (slopes(ty, m)) b = m;
        else a = m;
      }
      dist = b;
      const s = slopes(ty, dist);
      if (!s) break;
      // Centre the points vertically: moving the target up by dy shifts every slope by about -dy·cos(pitch)/d.
      ty += (((s[0] + s[1]) / 2) * dist) / Math.max(0.2, Math.cos(pitch));
    }
    // The last centring step can push a point back out: settle the distance for the final height.
    while (!slopes(ty, dist) && dist < 1e5) dist *= 1.05;
    return { ty, dist };
  }
  // The azimuth (around +Y from +Z) the camera sits at now, plus a pending orbit.
  const camAz = (orbit = 0) => {
    camDir.copy(camera.position).sub(controls.target);
    return Math.atan2(camDir.x, camDir.z) + orbit;
  };

  // One exploded progress xs.v, 0 = assembled → 1 = exploded, drives every piece (Space springs it, scrub sets
  // it directly). Each piece follows with an offset (lower parts first, then by arrival rank), so a scrub reads
  // as the lens cascade; the springs may overshoot past 1, never below 0 (pieces would sink into each other).
  const X_PART = 0.22; // offset spread across parts
  const X_PIECE = 0.1; // offset spread inside a part
  const X_WINDOW = 1 - X_PART - X_PIECE;
  const xs = { v: 0 };
  let xAnim = null;
  let xParts = []; // the built parts the current exploded layout was computed for
  let xFrames = null; // { stack, exploded } camera framings the scrub interpolates between
  function prepareExplode() {
    xParts = parts.filter((p) => p.built);
    const { lifts, top, push, reach, boxes } = droneExplodeLayout(xParts);
    explodedSpan = { top, r: reach, boxes };
    const np = xParts.length;
    xParts.forEach((part, pi) => {
      const lift = lifts.get(part);
      const n = part.arrival.length;
      for (const piece of part.arrival) {
        // A drone's pieces keep their heading: a turn about the vehicle's axis would swing an arm off its line.
        const rot = new THREE.Quaternion();
        piece.xTo = piece.rest.position.clone().addScaledVector(piece.explode.dir, piece.explode.dist * DRONE_PIECE_K);
        piece.xTo.add(push.get(part));
        piece.xTo.y += piece.axis + lift;
        piece.xQ = rot.multiply(piece.rest.quaternion);
        piece.xOff = (np > 1 ? pi / (np - 1) : 0) * X_PART + (n > 1 ? piece.rank / (n - 1) : 0) * X_PIECE;
      }
    });
    xFrames = {
      stack: { ...spanFraming(0, stackHeight(), stackRadius(), 0.83), r: stackRadius() },
      exploded: { ...droneFit(boxes, heroPitch(), camAz()), r: explodedSpan.r },
    };
  }
  function applyExplode() {
    const v = xs.v;
    const vc = Math.min(1, Math.max(0, v));
    const over = Math.max(0, v - 1) * 1.5;
    for (const part of xParts) {
      for (const piece of part.pieces) {
        const t = Math.min(1, Math.max(0, (vc - piece.xOff) / X_WINDOW)) + over;
        piece.mesh.position.lerpVectors(piece.rest.position, piece.xTo, t);
        piece.mesh.quaternion.slerpQuaternions(piece.rest.quaternion, piece.xQ, Math.min(1, t));
      }
    }
  }
  // The scrub camera: between the stack framing and the exploded framing, following the progress.
  function scrubCamera() {
    const a = xFrames.stack;
    const b = xFrames.exploded;
    const k = smooth(Math.min(1, Math.max(0, xs.v)));
    camAnim?.cancel();
    controls.target.set(0, a.ty + (b.ty - a.ty) * k, 0);
    camDir.copy(camera.position).sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(camDir, a.dist + (b.dist - a.dist) * k);
    framedR = a.r + (b.r - a.r) * k;
    framedMode = k > 0.5 ? "exploded" : "stack";
  }

  // Spring the progress to 0 or 1 (Space, or a released scrub). Busy while it runs.
  let xTarget = 0;
  async function settleExplode(to) {
    const gen = state.gen;
    xAnim?.cancel();
    live.delete(xAnim);
    xTarget = to;
    state.busy++;
    state.exploded = true;
    changed();
    if (to === 1) {
      sfx.play("explode");
      frameExploded({ start: true });
    } else {
      sfx.play("assemble");
      frameStack();
    }
    controls.autoRotate = false;
    const p = run(xs, { v: to, ease: to === 1 ? spring({ stiffness: 85, damping: 11 }) : spring({ stiffness: 130, damping: 12 }), onUpdate: applyExplode });
    xAnim = p.anim;
    await p;
    if (gen !== state.gen) return false;
    finishExplode(to);
    return true;
  }
  function finishExplode(to) {
    xAnim = null;
    xs.v = to;
    applyExplode();
    state.busy = Math.max(0, state.busy - 1);
    if (to === 1) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.9;
    } else {
      state.exploded = false;
      xParts = [];
      sfx.play("clunk", { gain: 0.7 });
      state.shake = 0.6;
    }
    changed();
    return true;
  }

  function explode() {
    if (state.busy || state.scrubbing || xs.v >= 1 || topY() === 0) return Promise.resolve(false);
    if (xs.v === 0) prepareExplode();
    return settleExplode(1);
  }

  function assemble() {
    if (state.busy || state.scrubbing || !state.exploded) return Promise.resolve(false);
    return settleExplode(0);
  }

  // Scrub (drag / wheel on empty space): scrubStart → scrubBy(delta of progress)… → scrubEnd (snaps past 0.5).
  function scrubStart() {
    if (state.scrubbing) return true;
    if ((state.busy && !xAnim) || state.auto || topY() === 0) return false; // builds and swaps own the stack
    if (xAnim) {
      xAnim.cancel();
      live.delete(xAnim);
      xAnim = null;
      state.busy--;
    }
    if (xs.v <= 0) prepareExplode();
    state.scrubbing = true;
    state.exploded = true;
    controls.autoRotate = false;
    changed();
    return true;
  }
  function scrubBy(delta) {
    if (!state.scrubbing) return;
    xs.v = Math.min(1, Math.max(0, xs.v + delta));
    applyExplode();
    scrubCamera();
  }
  function scrubEnd() {
    if (!state.scrubbing) return;
    state.scrubbing = false;
    settleExplode(xs.v > 0.5 ? 1 : 0);
  }

  const toggleExplode = () => (state.exploded ? assemble() : explode());

  // ---------- swap / restack ----------
  // Shape identity: a part whose record, count, size and geometry are unchanged is kept (and only restacked).
  const shapeKey = (p) => JSON.stringify([p.kind, p.record?.id ?? null, p.count, +p.height.toFixed(5), +p.radius.toFixed(5), p.geom ?? null]);
  const RUNTIME = new Set(["group", "pieces", "built", "busy", "ghost", "holoGhost", "ghostFade", "ghostActive", "ghostAnim", "hl", "hlAnim", "arrival"]);
  const specFields = (spec) => Object.fromEntries(Object.entries(spec).filter(([k]) => !RUNTIME.has(k)));

  function moveGroup(part, y, { duration, ease = "inOutCubic" }) {
    const g = { y: part.group.position.y };
    return run(g, {
      y,
      duration,
      ease,
      onUpdate: () => {
        part.group.position.y = g.y;
      },
    });
  }

  // restack(manifest): animate every part's group to its spec's slotY (matched by id).
  function restack(manifest, { duration = D(T.descend) } = {}) {
    const jobs = [];
    for (const spec of manifest) {
      const part = parts.find((p) => p.id === spec.id);
      if (!part) continue;
      part.slotY = spec.slotY;
      part.ghost.position.y = spec.slotY;
      if (Math.abs(part.group.position.y - spec.slotY) > 1e-6) jobs.push(moveGroup(part, spec.slotY, { duration }));
    }
    return Promise.all(jobs);
  }

  // The option animation for a whole new manifest: one changed slot plus whatever it drags along. Kept parts
  // (same shape) are restacked; changed ones are replaced (old unscrews out, new flies in at its new slot).
  // Resolves to { parts, replaced: Map(oldPart -> newPart) }, or false if it could not run / was cancelled.
  async function applyManifest(specs) {
    if (state.busy || state.exploded || !makePart) return false;
    const gen = state.gen;
    state.busy++;
    const wasComplete = parts.length > 0 && parts.every((p) => p.built);
    const oldById = new Map(parts.map((p) => [p.id, p]));
    const next = [];
    const incoming = []; // new parts to fly in
    const outgoing = []; // built old parts to fly out
    const kept = [];
    const replaced = new Map();
    for (const spec of specs) {
      const old = oldById.get(spec.id);
      if (old && (old === spec || shapeKey(old) === shapeKey(spec))) {
        oldById.delete(spec.id);
        const y = old.group.position.y;
        Object.assign(old, specFields(spec));
        old.group.position.y = y; // restack moves it
        kept.push(old);
        next.push(old);
        continue;
      }
      const part = makePart(spec);
      part.built = false;
      part.busy = false;
      setupPart(part);
      if (old) {
        oldById.delete(spec.id);
        replaced.set(old, part);
        if (old.built) outgoing.push(old);
        else retirePart(old);
      }
      if (old ? old.built : wasComplete) {
        part.busy = true;
        incoming.push(part);
      }
      next.push(part);
    }
    for (const old of oldById.values()) {
      if (old.built) outgoing.push(old);
      else retirePart(old);
    }
    for (const old of outgoing) {
      old.busy = true;
      leaving.add(old);
      if (highlighted.has(old)) clearHighlight(old);
    }
    parts = next;
    changed();

    // Parts above the lowest change lift out of the way, then settle on their new slots.
    const changedY = Math.min(Infinity, ...incoming.map((p) => p.slotY), ...outgoing.map((p) => p.slotY));
    const above = kept.filter((p) => p.built && p.slotY >= changedY - 1e-6);
    const clear = SWAP_CLEAR_M * scale + Math.max(0, ...incoming.map((p) => p.height * 0.15));
    const liftY = (p) => Math.max(p.group.position.y, p.slotY) + clear;
    frameSpan(0, Math.max(stackHeight(), ...above.map((p) => liftY(p) + p.height)), stackRadius(), 0.85);
    const t0 = performance.now();
    const at = (ms) => wait(Math.max(0, D(ms) - (performance.now() - t0)));
    const lifting = Promise.all(above.map((p) => moveGroup(p, liftY(p), { duration: D(T.lift) })));
    if (above.length) sfx.play("whoosh", { rate: 1.2, gain: 0.6 });

    await at(T.outAt);
    if (gen !== state.gen) return false;
    if (outgoing.length) sfx.play("whoosh", { rate: 0.8 });
    const departing = Promise.all(outgoing.map((p) => flyOut(p, sourcePoint(p))));

    await at(T.inAt);
    if (gen !== state.gen) return false;
    if (incoming.length) sfx.play("whoosh");
    const arriving = incoming.map(async (p) => {
      let locked = false;
      const seat = () => {
        if (gen !== state.gen) return;
        locked = true;
        lock(p);
      };
      await flyIn(p, sourcePoint(p), { cap: T.swapInStaggerMax, onSeated: seat });
      if (gen !== state.gen) return;
      p.built = true;
      p.busy = false;
      if (!locked) lock(p);
    });
    await Promise.all([lifting, departing, ...arriving]);
    if (gen !== state.gen) return false;
    for (const old of outgoing) retirePart(old);

    await restack(specs, { duration: D(T.descend) });
    if (gen !== state.gen) return false;
    if (above.length) {
      sfx.play("clunk", { gain: 0.8 });
      state.shake = 0.7;
    }
    state.busy--;
    frameStack();
    changed();
    return { parts, replaced };
  }

  // swap(part, newSpec): one slot changes and nothing else moves (applyManifest when sizes shift).
  const swap = (part, newSpec) => applyManifest(parts.map((p) => (p === part ? newSpec : p)));

  // The landing page's opening shot (ui/landing.js): camera 0.62 R up and 2.05 R out from the globe's centre at
  // azimuth 0.58, aimed 1.02 R up, sun from `sun`. The dive ends on homePose(landingView.az).
  const landingView = { up: 0.62, back: 2.05, aim: 1.02, az: 0.58, sun: new THREE.Vector3(-0.85, 0.35, -0.2).normalize() };

  // ---------- build all / build up to / reset ----------
  // Pipelined: the next part starts flying the moment the previous part's body has seated, while that part's
  // details are still landing. The camera follows each part and settles on the stack once, at the end.
  async function buildUpTo(target, { onLastSeat } = {}) {
    if (state.busy || state.exploded || target.built) return false;
    const gen = state.gen;
    state.auto = true;
    const running = [];
    try {
      for (const part of parts.slice(0, index(target) + 1)) {
        if (part.built) continue;
        let seated;
        const seatedP = new Promise((r) => (seated = r));
        const last = part === target;
        const done = buildPart(part, {
          onSeated: () => {
            seated();
            if (last) onLastSeat?.();
          },
        });
        running.push(done);
        const ok = await Promise.race([seatedP.then(() => true), done]);
        if (!ok || gen !== state.gen) return false;
      }
      const results = await Promise.all(running);
      if (gen !== state.gen || results.includes(false)) return false;
    } finally {
      if (gen === state.gen) {
        state.auto = false;
        if (!state.busy) frameStack();
        changed();
      }
    }
    return true;
  }

  async function buildAll() {
    if (state.busy || state.exploded || !parts.length || parts.every((p) => p.built)) return;
    const gen = state.gen;
    sfx.play("assemble-cue"); // UI 2's music cue; the sting lands on the last lock
    const ok = await buildUpTo(parts[parts.length - 1], { onLastSeat: () => sfx.play("assemble-sting") });
    if (!ok || gen !== state.gen) return;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.1;
    setTimeout(() => {
      if (gen === state.gen && !state.exploded) controls.autoRotate = false;
    }, 6500);
  }

  // Back to the empty pad (camera untouched).
  function clear() {
    sfx.stopMusic?.(0.3);
    state.gen++;
    cancelAll();
    controls.autoRotate = false;
    state.busy = 0;
    state.exploded = false;
    state.scrubbing = false;
    state.auto = false;
    xs.v = 0;
    xAnim = null;
    xParts = [];
    state.shake = 0;
    for (const part of [...highlighted]) clearHighlight(part);
    for (const part of [...leaving]) retirePart(part); // still flying out of an interrupted swap
    for (const part of parts) {
      part.dimAnim?.cancel();
      if (part.dim) {
        part.dim.v = 1;
        applyLines(part);
      }
    }
    for (const part of parts) {
      part.built = false;
      part.busy = false;
      hideGhostNow(part);
      part.look = "opaque";
      fadeShell(part, SHELL.opaque, 0);
      part.group.position.y = part.slotY;
      for (const piece of part.pieces) {
        piece.mesh.visible = false;
        piece.mesh.position.copy(piece.rest.position);
        piece.mesh.quaternion.copy(piece.rest.quaternion);
      }
    }
    ghostPart = null;
  }

  function reset() {
    clear();
    home();
    changed();
  }

  // A switched-to drone appears built: every part at rest, then one snap from a small axial spread (all parts
  // at once, spring 130/12, one clunk). No part-by-part build.
  function appearBuilt() {
    const gap = 1.2 * scale;
    parts.forEach((part, i) => {
      part.built = true;
      part.busy = false;
      hideGhostNow(part);
      for (const piece of part.pieces) {
        piece.mesh.visible = true;
        piece.mesh.position.copy(piece.rest.position);
        piece.mesh.quaternion.copy(piece.rest.quaternion);
      }
      part.group.position.y = part.slotY + (i + 1) * gap;
    });
    const gen = state.gen;
    state.busy++;
    const k = { v: 1 };
    run(k, {
      v: 0,
      ease: spring({ stiffness: 130, damping: 12 }),
      onUpdate: () => parts.forEach((p, i) => (p.group.position.y = p.slotY + (i + 1) * gap * k.v)),
    }).then(() => {
      if (gen !== state.gen) return;
      state.busy--;
      sfx.play("clunk", { gain: 0.8 });
      state.shake = 0.6;
      changed();
    });
    frameStack({ duration: D(700) });
    changed();
  }

  // ---------- skip (double-click / double-tap) ----------
  // Finish whatever is animating, at once: an explode/assemble lands, a build / Build all / swap / remove / switch
  // snap settles with every part at rest (in-flight parts built, a part being removed gone). Returns what it did.
  function skip() {
    if (xAnim) {
      xAnim.cancel();
      live.delete(xAnim);
      finishExplode(xTarget);
      return "explode";
    }
    if (!state.busy && !state.auto) return null;
    const all = state.auto;
    state.gen++; // pending build/swap continuations bail out
    cancelAll();
    for (const part of [...leaving]) retirePart(part);
    for (const part of parts) {
      const built = part.removing ? false : all || part.built || part.busy;
      part.built = built;
      part.busy = false;
      part.removing = false;
      part.group.position.y = part.slotY;
      hideGhostNow(part);
      for (const piece of part.pieces) {
        piece.mesh.visible = built;
        piece.mesh.position.copy(piece.rest.position);
        piece.mesh.quaternion.copy(piece.rest.quaternion);
      }
      if (built) fadeShell(part, shellTarget(part), 0);
    }
    state.busy = 0;
    state.auto = false;
    frameStack();
    changed();
    return "settled";
  }

  // Preset switch: cancel everything, dispose the old stack, set up the new one.
  function rebuild(next) {
    clear();
    for (const part of parts) retirePart(part);
    parts = next;
    for (const part of parts) setupPart(part);
    if (warmRenderer) prewarm(warmRenderer);
    home();
    changed();
  }

  // Warm-up so the first build has no hitch: compile every program and upload every geometry (one offscreen
  // render with culling off; a 200-piece stack otherwise stalls ~2 s on the frame its pieces first appear).
  // The far layer's textures (planet maps) arrive after the warm-up; main calls this when loading finishes.
  // One texture per frame (update): a 2k map uploads in a few ms; all at once they make a visible freeze.
  const uploadQueue = new Set();
  function uploadWarmTextures(extra = []) {
    if (!warmRenderer) return;
    for (const t of extra) uploadQueue.add(t);
  }
  function uploadNext() {
    const t = uploadQueue.values().next().value;
    if (!t) return;
    uploadQueue.delete(t);
    if (t.image) warmRenderer.initTexture(t);
  }
  const warmTarget = new THREE.WebGLRenderTarget(4, 4);
  function prewarm(renderer) {
    warmRenderer = renderer;
    const meshes = parts.flatMap((p) => p.pieces.map((q) => q.mesh));
    for (const part of parts) part.ghost.visible = true;
    for (const m of meshes) {
      m.visible = true;
      m.frustumCulled = false;
    }
    const prevTarget = renderer.getRenderTarget();
    // Both looks of every piece (UI4's painted and x-ray materials): the first clear click or X compiles nothing.
    const swaps = meshes.filter((m) => m.userData.looks).map((m) => [m, m.material]);
    for (let pass = 0; pass < 2; pass++) {
      renderer.compile(scene, camera);
      renderer.setRenderTarget(warmTarget);
      renderer.render(scene, camera);
      renderer.setRenderTarget(prevTarget);
      for (const [m] of swaps) {
        const { painted, xray } = m.userData.looks;
        m.material = m.material === painted ? xray : painted;
      }
    }
    // (two swaps: every mesh is back on its own material)
    for (const m of meshes) m.frustumCulled = true;
    for (const part of parts) {
      part.ghost.visible = part.ghostActive || part.ghostFade.v > 0;
      for (const piece of part.pieces) piece.mesh.visible = part.built;
    }
  }

  function update(dt, t) {
    if (uploadQueue.size) uploadNext();
    for (const part of parts) {
      part.holoGhost.update(t);
      if (part.ghost.visible) part.ghost.position.y = part.slotY + Math.sin(t * 2.6) * 0.05;
    }
    if (highlighted.size) updateHighlights(t);
    flash.update(dt);
    if (state.shake > 0.002) {
      state.shake *= Math.exp(-dt * 8);
      root.position.set((Math.random() - 0.5) * 0.09 * state.shake, 0, (Math.random() - 0.5) * 0.09 * state.shake);
    } else if (root.position.x !== 0) {
      root.position.set(0, 0, 0);
    }
  }

  // The always-on ghost starts with the first part.
  syncGhost();

  return {
    state,
    get parts() {
      return parts;
    },
    canBuild,
    isTopBuilt,
    topY,
    setGhost,
    ghostPart: () => ghostPart,
    highlight,
    focus,
    unfocus,
    framedRadius: () => framedR,
    framing: () => ({ r: framedR, mode: framedMode }),
    build,
    buildUpTo,
    remove,
    explode,
    assemble,
    toggleExplode,
    scrubStart,
    scrubBy,
    scrubEnd,
    toggleLook,
    toggleLookAll,
    setLook,
    frameStack: () => frameStack(),
    homePose,
    swap,
    applyManifest,
    restack,
    buildAll,
    reset,
    rebuild,
    appearBuilt,
    skip,
    setBounds,
    prewarm,
    uploadWarmTextures,
    update,
    landingView,
    home,
  };
}
