# DroneX: working spec

DroneX is a drone configurator. Users browse real drones, learn what each part is and does, swap parts, test
the result against missions, and build new drones. Whether a drone can fly a mission is decided by physics in
code, from sourced part data. A complete drone can then be flown in the simulation engine (the sibling
`../dronex/DroneX_1`, UXDuck Core + ArduPilot SITL): one press sends it there and opens the simulation page,
where a miniature of the exact drone flies over real-world 3D tiles.

The detailed front-end contract (build state, part manifest, display scale, verdict shape, readiness) is
[`prototype/drone-assembly/docs/drone-integration.md`](../prototype/drone-assembly/docs/drone-integration.md).
This file is the product-level summary; if the two disagree, fix whichever is wrong and say so.

## What the user can do

1. **Browse.** Open the Hangar and pick a real drone preset (the page opens on the Apex 5" freestyle
   quad; `?build=<preset-id>` opens another).
2. **Learn.** Build it part by part or all at once, explode it, click any part for a card with its sourced
   numbers. Every number opens a drawer with its source or its formula.
3. **Modify.** A part's card lists the alternatives for its slot (airframe, motor, propeller, battery,
   payload) with compatibility (ok / unusual / incompatible and why). Picking one swaps the part in 3D.
4. **Test.** Pick a mission. The HUD and the readiness panel show all-up weight, lift (hover thrust-to-weight),
   endurance and the mission checks; Take off flies the drone (a hover loop for a multirotor, a circuit for a
   fixed wing) and ends with a result.
5. **Create.** Save a modified build as a new drone.
6. **Fly in simulation.** On a complete drone, **Fly in simulation** sends it to the simulation engine and the
   browser follows: the exact parts on the pad become a glTF miniature in true metres, the design's battery,
   hover throttle and airspeeds become ArduPilot parameters (`simProfile.js`, every number from the datasets or
   the verdict, labelled est.), and the simulation UI opens on the new vehicle. No file, no import step. The
   vehicle keeps an "Open in DroneX" bookmark that reopens the design here.

## Data

- Datasets: `prototype/drone-assembly/src/data/drone/*.json` plus `presets.json`, the single source of truth,
  hand-edited and validated by `scripts/check-drone-physics.mjs`; sources in `SOURCES.md` beside them.
- Record kinds: airframes, motors, propellers, batteries, payloads, missions. Every record carries a source.
- Build: `{ airframeId, motorId, propellerId, batteryId, payloadId, missionId, livery }`.
- Unknown real-world values stay `TODO(source)`; they are never filled in with a guess.

## Physics (prototype/drone-assembly/src/dronePhysics.js)

Standard formulas over dataset fields only, every output labelled `est.` in the UI:

- All-up weight = sum of the part weights plus a documented electronics allowance (`DRONE_RULES`).
- Thrust per motor from the motor and propeller records (power, KV, diameter, pitch, blade count).
- Hover thrust-to-weight, hover / mixed-profile power and current, endurance from usable pack energy, range,
  discharge check, wing loading for fixed wings, the 250 g registration threshold.
- `DRONE_RULES` holds every threshold with a one-line source comment (e.g. hover TWR ≥ 2.0 to be cleared,
  ≥ 1.3 to hold altitude, 80 % usable pack).
- Mission checks: weight, endurance, lift, speed, payload. Cleared = the build works and meets the mission.

The verdict is computed in code. No model decides or adjusts it.
