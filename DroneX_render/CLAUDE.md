@AGENTS.md

# DroneX: rules for AI sessions

Read docs/SPEC.md, docs/ARCHITECTURE.md and docs/ROADMAP.md before every task. If code and spec disagree, the spec wins.

1. Never add a dependency without asking the human first. The stack is fixed.
2. Never add a feature that is not in the current phase of docs/ROADMAP.md. Prefer deleting scope over adding it.
3. Real numbers live only in the dataset (prototype/drone-assembly/src/data/drone/). Never put a real-world value in a component.
4. Never invent a real-world number. If a value is unknown, leave `TODO(source)` and tell the human.
5. Never commit secrets. Any API key is read from server environment variables only.
6. Keep functions pure and small, with explicit types in TypeScript. No `any`.
7. Every number shown on screen is a dataset field or a named formula over dataset fields, labelled `est.` or `derived` when it is computed.
8. Before finishing a task run `npm run typecheck && npm run lint && npm test` and `node prototype/drone-assembly/scripts/check-drone-physics.mjs`, and paste the result.

Code decides the verdict: whether a drone flies a mission is computed in code (dronePhysics.js), never by a model.
