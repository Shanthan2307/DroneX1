# DroneX on Elastic: search and analytics over the flight data exhaust

The simulation engine produces telemetry, events and verdicts and, until now, searched none of it. The live layer
mirrors every simulated flight into Elastic Cloud Serverless, the ArduPilot manual and the parts datasheets go into
`semantic_text` fields, an Agent Builder agent answers "why did the courier drift on leg 3" from ES|QL, a Workflow
scores every finished flight, and the configurator's mission card shows how a design has done across its runs.

Where Elastic is used (also in the app's "Built with" sidebar):

| Surface | What | Code |
|---|---|---|
| live | Mirror sink: fixes, events, vehicles, flights and scores, bulk-indexed every second | `DroneX_live/src/sinks/elastic.ts` |
| live | Setup: mappings, `semantic_text` knowledge (ArduPilot params, catalog notes, physics formulas), verdicts | `DroneX_live/src/elastic/setup.ts`, `verdicts.ts` |
| live | Query helpers and CLI | `DroneX_live/src/elastic/query.ts` |
| simulator | Agent Builder agent "DroneX Flight Analyst" | `DroneX_live/elastic/agent.md` |
| cluster | Workflow scoring new flights | `DroneX_live/elastic/workflow.yaml` |
| configurator | `/api/analytics` and the fleet line on the mission card | `DroneX_render/src/app/api/analytics/route.ts`, `src/lib/analytics/elastic.ts`, `prototype/drone-assembly/src/ui/readiness.js` |

## Indices (`ELASTIC_INDEX_PREFIX`, default `dronex`)

| Index | One document per | Key fields |
|---|---|---|
| `dronex-telemetry` | position fix (2/s per vehicle) | `@timestamp`, `vehicle_id`, `design_id`, `flight_id`, `location` (geo_point), altitudes, speed, `battery_pct`, `gps_*`, `ekf_*`, `mode`, `armed` |
| `dronex-events` | event | `type` (vehicle-online/offline, armed, mode, battery-threshold, gps-quality, ekf), `detail`, `data.*` |
| `dronex-vehicles` | vehicle (upserted) | name, type, autopilot, presence, mode, `design_id`, `flight_id` |
| `dronex-flights` | flight = one vehicle-online … vehicle-offline span | `flight_id` = `<vehicle id>:<online time µs>`, `started_at`, `ended_at`, `status` |
| `dronex-flight-scores` | finished flight | drain vs estimate, `battery_sag_ratio`, `ekf_variance_peak`, `gps_dropouts`, `brake_events`, `anomalies`, `anomalous`, `scored_by` |
| `dronex-verdicts` | design × mission | `ready`, `failing_checks`, `summary.*`, `build.*` (from the physics code via `/api/catalog` and `/api/verdict`) |
| `dronex-ardupilot-params` | ArduCopter parameter (6,036) | `name`, `documentation`, `range`, `units`, `values`, `text` (semantic_text) |
| `dronex-catalog-notes` | dataset record (53) | `notes`, `source`, `numbers.*`, `text` (semantic_text) |
| `dronex-formulas` | exported physics function with a comment | `function_name`, `comment`, `text` (semantic_text) |

A flight is a vehicle-online to vehicle-offline span because a simulated vehicle appears when the simulator starts
it and goes when it is stopped; arming and disarming are events inside it.

The semantic field uses the configured inference endpoint (`ELASTIC_INFERENCE_ID`), by default
`.jina-embeddings-v5-text-small` on Serverless (Elastic Inference Service) and `.elser-2-elasticsearch` on a stack
deployment with ML nodes; setup falls back from one to the other, then to plain text, and prints which it used.

## Setup (about ten minutes)

1. Create an Elastic Cloud Serverless project (Elasticsearch, "Vector Database" or "General purpose") at
   cloud.elastic.co. Copy the Elasticsearch endpoint URL.
2. In the project: Management → API keys → create a key with write access to `dronex-*`. Copy it once.
3. In `DroneX_render/.env.local` set `ELASTIC_URL=https://….es….elastic.cloud`, `ELASTIC_API_KEY=…`,
   optionally `ELASTIC_INDEX_PREFIX=dronex`.
4. Start the app (`./dev.sh`), then in `DroneX_live`: `npm run elastic:setup` (creates the indices, fills the
   knowledge, indexes the hangar's verdicts; `--recreate` drops and rebuilds).
5. `dev.sh` starts the mirror; or by hand `npm run mirror`. It prints `[elastic] serverless … indices dronex-*`.
6. Fly something (Fly in simulation from the configurator), then `npx tsx src/elastic/query.ts flights`.
7. Kibana → Agents: create the agent from `agent.md` (name, instructions, the ES|QL tools).
8. Kibana → Workflows: new workflow, paste `workflow.yaml`, enable.
9. Kibana → Dashboards: build the panels in `dashboard.md`.
10. Install the agent skills in your coding agent (done for this repo: `npx skills add elastic/agent-skills --skill elasticsearch-esql`).

## Demo

1. Press Fly in simulation on the medical courier, take off, send it across the water, bring it back, stop the
   simulation (that ends the flight and the mirror writes its score).
2. In the configurator the mission card shows the Elastic line: "3 of 4 simulated runs clean; 1× as few as 4 satellites".
3. In Kibana Agents, ask the Flight Analyst: "What happened on the last flight of the courier?", "Why did it lose
   position?", "Is the battery draining as the design predicted?", "What does MOT_THST_HOVER do?"
4. Show the Workflow run history and the dashboard.

## CLI

```
npx tsx src/elastic/query.ts flights [vehicle]     latest flights
npx tsx src/elastic/query.ts flight <flight_id>    one flight summary with events and score
npx tsx src/elastic/query.ts fleet <design id>     fleet statistics (same as /api/analytics)
npx tsx src/elastic/query.ts param "hover throttle" semantic lookup in the ArduPilot manual
npx tsx src/elastic/query.ts note "discharge margin" semantic lookup in catalog notes and formulas
npx tsx src/elastic/query.ts esql "FROM dronex-flights | LIMIT 5"
```

## Tests

`npx vitest run` in `DroneX_live`: parameter XML parsing, note and formula extraction, document shapes, flight
spans, scoring and anomaly rules, verdict documents. No cluster needed.
