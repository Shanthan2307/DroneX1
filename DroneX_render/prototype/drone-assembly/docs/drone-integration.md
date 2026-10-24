# DroneX configurator — integration contract

**Goal.** One configurator for drones: the Hangar and the `[` / `]` keys walk the drone presets, and the
whole experience — assembly choreography, part cards with swap options, HUD, readiness panel, explode view, take
off — renders and reasons about the chosen drone. Same canvas, same choreographer, same card.

`main.js` reaches the drone modules through `src/vehicle.js`, a thin facade (presets, manifest, verdict, options,
missions, readiness).

## 1. Build state

A drone build is a flat object, distinguished by having `airframeId`:

```js
{ airframeId, motorId, propellerId, batteryId, payloadId, missionId, livery }
```

`isDroneBuild(b) === Boolean(b?.airframeId)`.

## 2. Display scale (`viewK`) — read this before writing geometry

Scene units are `metres × SCALE` (`SCALE = 0.25`). A 225 mm quad at true
scale is 0.056 units: invisible, and inside `controls.minDistance`. So a drone is drawn at a **display
scale**: every linear size is multiplied by `viewK` before it becomes geometry.

`viewK = DISPLAY_FOOTPRINT_U / (footprint_m × SCALE)`, with `DISPLAY_FOOTPRINT_U = 10` **scene units**
and `footprint_m` the vehicle's widest horizontal extent (multirotor: wheelbase + prop diameter; fixed
wing: wingspan). Every drone is therefore drawn exactly 10 scene units across, whatever the real thing
measures: **viewK ≈ 113 for a 225 mm quad on 5-inch
props**, ≈ 33 for the 1.2 m fixed wing.

Consequences, and they are strict:

- `spec.geom` carries **true metres** plus `geom.viewK`.
- `spec.slotY`, `spec.height`, `spec.radius` are **scene units at display scale**:
  `true_m × viewK × SCALE`.
- `spec.height_m`, `spec.diameter_m` are **true metres** — the card shows these as facts. Never
  display a `viewK`-multiplied number anywhere in the UI.
- A drone part builder starts with `const K = spec.geom.viewK` and `const d = (m) => m * K`, then
  authors every dimension as `d(trueMetres)`. `piece()` / `toUnits()` then apply `SCALE` as usual.
- A propeller part's pieces must be authored **centred on their own hub axis at the origin** and placed
  at the arm end with `piece()`'s `x` / `z`. The take-off sequence spins each propeller piece about the local
  axis named by `mesh.userData.spinAxis` (`"y"` on a quad, `"z"` on a nose prop) through the mesh's origin, and a
  propeller sits off the vehicle's axis: if the arm-end offset is baked into the
  geometry the propeller orbits the drone instead of spinning. A `ry` blade phase is fine — it composes.

## 3. Modules and ownership

| File | What it holds |
|---|---|
| `src/data/drone/*.json` | the six sourced datasets, the single source of truth |
| `src/data/drone/presets.json` | buildable drones (the Hangar's Real drones, in `dronePresetIds` order) |
| `src/data/droneCatalog.js` | `droneCatalog`, `dronePresetIds`, `getDronePreset`, `dronePresetToBuild`, `droneOptionsFor`, `applyDroneOption`, `droneDestinations`, `droneReadiness` |
| `src/droneLayout.js` | `isDroneBuild`, `droneBuildManifest`, `droneSceneBounds`, `DRONE_KINDS` |
| `src/dronePhysics.js` | `evaluateDrone`, `droneDetails`, `DRONE_RULES` |
| `src/droneCompat.js` | `droneOptionsWithCompat`, `checkDroneOption` |
| `src/droneParts.js` | `DRONE_BUILDERS` — one builder per drone kind, the look work |
| `src/ui/droneCard.js` | `droneCardBody(part, ctx, P)` — the card for a drone part |
| `src/vehicle.js` | the facade `main.js` uses |
| `src/droneFlight.js` | the take-off: spool, lift, the mission leg out and back, land; spins the propellers |
| `src/simProfile.js` | pure: `simKind`, `simProfile`, `simParams`, `assignMotors`, `bearingOf` — the ArduPilot vehicle, frame, footprint and parameters a build becomes in the simulation engine |
| `src/simExport.js` | `exportDroneGlb(parts, { viewK, bearings, spinner })`: the built parts as a glTF binary in true metres, nose at −Z, propellers as nodes `Propeller1..N` in ArduPilot motor order |
| `scripts/shot.mjs` | screenshots the running app over the DevTools protocol, for looking rather than guessing |
| `src/parts.js` | `createPart`, the materials and looks, and `KIT` (the geometry toolkit); `registerBuilders(DRONE_BUILDERS)` |
| `src/dronePad.js` | `createDronePad({ radius_u, stand })`: the landing pad and a fixed wing's launch stand |
| `src/scale.js` | `SCALE` (scene units per metre) |
| `src/main.js`, `src/choreo.js`, `src/ui/card.js` | the screen, the motion and camera, the card frame |

## 4. PartSpec — what `droneBuildManifest` emits

`choreo.js`, `parts.js`, `ui/card.js` and `ui/select.js` take it as is:

```js
{
  id,            // stable, unique: "drone-frame", "drone-arm-0", "drone-prop-2", …
  kind,          // one of DRONE_KINDS (§5)
  name,          // record name, shown as the card title
  sub,           // one line under the title
  stageIndex,    // always null for drones (there are no stages)
  record,        // the dataset record, or null for derived structure
  count: 1,
  slotY,         // scene units, display scale: the part group's y
  height,        // scene units, display scale: used for framing and the explode layout
  radius,        // scene units, display scale: how far the part reaches from the vehicle's axis (so a
                 // propeller's is armR + propR, not its own radius: this drives framing and the pad size)
  height_m,      // TRUE metres (card)
  diameter_m,    // TRUE metres (card)
  derived,       // true = no dataset record behind it
  note, icon,    // icon: "ring" | "tank" | "engine" | "nose"
  key,           // keyboard shortcut "1".."9" in build order, or null
  geom,          // §5, true metres + viewK
  slot,          // the configurator slot this part can be swapped in: "airframe" | "motor" |
                 // "propeller" | "battery" | "payload", or null for derived parts
}
```

`manifest.warnings` is an array of plain-words strings.

Build order is array order, bottom-up in spirit: **frame → arms+motors → electronics → battery →
camera → propellers**. Propellers last: they are the last thing a real build bolts on and the best
reveal. Fixed wing: **fuselage → wing → tail → motor → battery → camera → propeller**.

## 5. Kinds and their `geom` (all lengths TRUE metres)

Multirotor (`airframe.type === "multirotor"`):

| kind | id | record | geom |
|---|---|---|---|
| `drone-frame` | `drone-frame` | airframe | `{ viewK, type, wheelbase_m, armR_m, armThick_m, armWidth_m, standoffH_m, topPlateThick_m, botPlateThick_m, armCount, bodyW_m, bodyL_m, stackMount_m }` |
| `drone-arm` | `drone-arm-{i}` | motor | `{ viewK, index, armAngle, armR_m, armThick_m, armWidth_m, motorOuterR_m, motorH_m, statorR_m, statorH_m, shaftR_m, mountCircle_m, standoffH_m }` |
| `drone-electronics` | `drone-stack` | null | `{ viewK, boardSize_m, boardThick_m, stackH_m, standoffH_m, vtxW_m, antennaLen_m }` |
| `drone-battery` | `drone-battery` | battery | `{ viewK, L_m, W_m, H_m, cells, chemistry, strapW_m }` |
| `drone-camera` | `drone-camera` | payload | `{ viewK, type, W_m, H_m, L_m, lensR_m, tilt_deg }` |
| `drone-propeller` | `drone-prop-{i}` | propeller | `{ viewK, index, armAngle, armR_m, propR_m, hubR_m, hubH_m, bladeCount, pitch_in, spinDir, motorTopY_m }` |

Fixed wing (`airframe.type === "fixed_wing_3dprint"`):

| kind | id | record | geom |
|---|---|---|---|
| `drone-fuselage` | `drone-fuselage` | airframe | `{ viewK, fuseL_m, fuseR_m, tailR_m, noseL_m, printMaterial }` |
| `drone-wing` | `drone-wing` | airframe | `{ viewK, span_m, chord_m, thick_m, airfoil, ribCount, dihedral_deg }` |
| `drone-tail` | `drone-tail` | null | `{ viewK, hSpan_m, hChord_m, vHeight_m, vChord_m, boomL_m }` |
| `drone-nose-motor` | `drone-motor` | motor | `{ viewK, motorOuterR_m, motorH_m, statorR_m, statorH_m, shaftR_m, fuseL_m }` |
| `drone-nose-propeller` | `drone-prop-0` | propeller | `{ viewK, propR_m, hubR_m, hubH_m, bladeCount, pitch_in, fuseL_m }` |
| `drone-battery` | `drone-battery` | battery | as above, `geom.bayW_m` added |
| `drone-camera` | `drone-camera` | payload | as above |

`DRONE_KINDS` is the exported list of these strings.

## 6. The geometry toolkit (`parts.js` → `export const KIT`)

`droneParts.js` must import **only** `three`, `KIT` and `SCALE`. `KIT` exposes the geometry
helpers:

```
piece(geo, material, opts)   the only way to make a piece. opts: { x, y, z, ry, order, dir, dist,
                             side, ax, sym, kind: "shell"|"interior"|"detail", engine, edges,
                             lineGeo, fineGeo, deploy, follow }
                             x/y/z are METRES (piece multiplies by SCALE); geo is authored in metres.
box(w,h,d,x,y,z)             centred box, translated
cyl(rTop,rBot,h,seg,x,y,z,open)   cylinder whose BOTTOM sits at y
tube(a,c,b,r,seg) rod(a,b,r,seg)  quadratic tube / straight rod between Vector3s
strut(a,b,w,d,out)           box spanning a→b, thin face toward `out`
lathe(pts,seg,phiStart,phiLength)  pts = [[r,y],…]
latheUV(geo,{phiStart,phiLength,H,R,y0})
machinedRing(rIn,rOut,h,y0,seg)   bright machined flange profile
ogivePoints(R,L,y0,n) domePoints(R,h,up,n)
boltRing(r,y,n,w,h,d,phase)  real bolt-head geometry (not instanced)
merge(geos)                  merge into one geometry (always prefer this over many pieces)
paint(geo,rgb) colorLathe(geo,nPts,colorOf)   per-vertex colour for vertexColors materials
addDetail(pc,type,list,{lookOnly,color})  instanced fine detail on a piece.
                             type: "bolt" | "rivet" | "clamp" | "strap"
boltCircle(r,y,n,size,{face,h,phase,cx,cz})   Matrix4[] for addDetail
rivetRow(a,b,pitch,size) rivetArc(r,y,phi0,phi1,pitch,size) clampsAlong(curve,r,n,t0,t1)
peachLineMaterial(opacity)   the peach edge-line material
v3(x,y,z) radial(a,y) radialPhi(phi,y) TAU UP DOWN DS clamp lerp
COLORS LOOK
```

A builder's signature is `(spec, mats) => piece[]`. Materials available on `mats` (role names, both
looks handled for you): `body roll foam bronze silver composite raceway skirt heatShield metal
darkMetal interior machined engine chamber powerhead valve pump pipe actuator gimbal gridFin gold
mliSilver mirror ablative foil panel trim leg copv steelDark accent dark`.

For drones the useful ones are `composite` (carbon weave — frame plates, arms, prop blades),
`darkMetal` / `machined` / `metal` (motor bells, screws, standoffs), `pump` (bright anodised),
`panel` (PCB — the FC/ESC board, use with a per-vertex green/black tint or just as is), `foil` /
`mliSilver` (battery shrink wrap), `trim`, `body`.

**`kind` on a piece** means draw role, not vehicle part: `"shell"` = outer skin (gets edge lines,
shadows, the clear/opaque toggle), `"interior"` = seen through a clear shell, `"detail"` = small
hardware. Use all three: a drone arm's shell is the carbon arm and the motor
bell; its interior is the stator, windings and magnets; its detail is the screws and the wire.

## 7. Physics (`dronePhysics.js`)

`evaluateDrone(build, droneCatalog)` returns the verdict. The first block of fields is a legacy shape kept
for compatibility (the HUD reads `feasible`, `warnings` and `totalMass_kg`); the drone fields follow:

```js
{
  // legacy shape
  stages: [], totalDeltaV_ms: 0, requiredDeltaV_ms: 0, marginDeltaV_ms: 0,
  liftoffTWR,          // = hoverTWR
  liftoffThrust_kN,    // total static thrust in kN (tiny, but true)
  totalMass_kg, deltaVOk, twrOk, feasible, closestRocketId: null, warnings: [],
  // drone
  vehicle: "drone",
  allUpWeight_g, thrustPerMotor_g, totalThrust_g, hoverTWR, punchOutTWR,
  hoverPower_W, hoverCurrent_A, maxCurrent_A, hoverTime_min, mixedTime_min,
  range_km, cruiseSpeed_ms, maxSpeed_ms, discharge_C, dischargeOk,
  wingLoading_g_dm2,   // fixed wing only, else null
  sub250,              // AUW < 250 g
  massBreakdown: [{ label, grams }],
  mission,             // the mission record, or null
  missionOk: { weight, endurance, twr, speed, payload }   // booleans per requirement
}
```

Every number must be a standard formula over dataset fields, labelled `est.` in the UI. No invented
real-world constants without a `TODO(source)` note in `DRONE_RULES`. Thrust must come from the motor
and propeller records (motor `maxPower_W`, `kv`, propeller diameter/pitch/blade count), not a magic
number per motor.

`DRONE_RULES` holds the thresholds, each with a one-line comment saying where it comes from:
`HOVER_TWR_OK = 2.0` (hover at ~50 % throttle: standard multirotor sizing practice),
`HOVER_TWR_MIN = 1.3` (below this it cannot hold altitude), `USABLE_PACK_SHARE = 0.8`
(LiPo reserve), `SUB_250_G = 250` (FAA/EASA registration threshold).

## 8. Readiness and HUD

`droneReadiness(verdict, mission)` returns `{ ready, title, to, lines, toFix }`, which `ui/readiness.js` renders:

- `Lift: 2.4× weight` / `Lift: 1.1× · need 2.0×`
- `Endurance: 18 min · needs 14 min` / `Endurance: 6 min · 8 min short`
- `Weight: 246 g · under 250 g` / `Weight: 410 g · over the 249 g limit`
- `Parts: all good` / `Parts: 1 problem: pack can't supply the current`

`title` is `CLEARED TO FLY` / `NOT READY YET`.

## 9. Rules carried over from the repo

- Real numbers live only in the datasets. A component never hard-codes one.
- Never invent a real-world number: leave `TODO(source)` and say so.
- No new dependencies.
- Pure, small functions with explicit shapes. Comments say *why*, in plain words.
- The verdict is computed in code. A model never decides it.
