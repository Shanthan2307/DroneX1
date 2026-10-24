# DroneX configurator (front end)

The drone configurator the Next app mounts (`src/components/assembly/AssemblyStage.tsx`): real dataset records
become 3D parts, parts fly in and lock, the drone can be exploded and reassembled, every part can be clicked for
its sourced numbers and swap options, and the verdict comes from `src/dronePhysics.js`.

Vanilla three.js 0.180 + anime.js 4. No React. The contract is [`docs/drone-integration.md`](docs/drone-integration.md).

## Run it

Normally through the app: `npm run dev` in the repo root, then http://localhost:3000.

Standalone (its own Vite, needs `npm install` in this folder):

```
cd prototype/drone-assembly
npm install
npm run dev        # http://localhost:5173
```

URL flags: `?build=<preset-id>` (`apex-5-freestyle-quad`, `apex-5-urban-light`, `apex-5-medical-courier`,
`eclipson-model-a-scout`), `?demo=1` auto-builds, `?panel=1` shows the full readiness panel, `?lite=1` drops
post-processing and shadows.

## Scripts

- `node scripts/check-drone-physics.mjs`: physics and compatibility checks over the datasets (no deps).
- `node scripts/shot.mjs "?build=<id>" /tmp/out --url=http://localhost:3000/ --steps=...`: screenshots of the
  running app over the DevTools protocol (steps documented at the top of the file).
