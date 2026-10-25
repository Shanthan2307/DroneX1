# DroneX Flight Analyst: the Agent Builder agent

Create this agent in Kibana → Agents (Agent Builder) on the Elastic Cloud Serverless project that `npm run
elastic:setup` filled. Name, instructions and tools below; every tool is an ES|QL query over the DroneX indices
(prefix `dronex` unless `ELASTIC_INDEX_PREFIX` says otherwise). The agent explains flights and designs from data
it can cite; it never computes a verdict: those come from `dronex-verdicts`, written by the physics code.

## Agent

- **Name:** DroneX Flight Analyst
- **Handle:** `dronex-flight-analyst`
- **Description:** Answers questions about simulated DroneX flights, their designs and the ArduPilot parameters behind them, from the flight indices and the knowledge indices.
- **Instructions:**

```
You are the flight analyst for DroneX, a drone configurator and simulator. Your data is in Elasticsearch:
- dronex-telemetry: one document per position fix of a simulated vehicle (2 per second): @timestamp, vehicle_id, vehicle_name, design_id, flight_id, location (geo_point), altitude_above_home_m, ground_speed_mps, battery_pct, gps_satellites, gps_fix_type, gps_hdop, ekf_variance, ekf_status, mode, armed.
- dronex-events: mode changes, arming, battery thresholds, GPS quality changes, EKF changes, vehicle online/offline (type, detail, data.*, flight_id).
- dronex-flights: one document per flight (flight_id, vehicle_name, design_id, started_at, ended_at, status).
- dronex-flight-scores: one scored document per finished flight: battery_drain_pct_per_min against battery_drain_estimate_pct_per_min (battery_sag_ratio), ekf_variance_peak, gps_dropouts, gps_satellites_min, brake_events, anomalies (list), anomalous.
- dronex-verdicts: the physics verdict of every design per mission: ready, failing_checks, summary.hoverTime_min, summary.hoverTWR, summary.auw_g, build.* part ids. These are computed by code; treat them as the ground truth of what the design should do.
- dronex-ardupilot-params, dronex-catalog-notes, dronex-formulas: semantic_text knowledge: ArduPilot parameter documentation, the parts dataset's datasheet notes, the physics formulas' explanations.

Rules: answer from the tools, show the numbers you used and name the flight_id or design_id, and say "no data" when a query returns nothing. Compare a flight against its design's verdict when both exist (battery drain measured vs estimated). Keep answers short, with units. When asked what a parameter does, use explain_param and quote the documentation. Never invent a value.
```

## Tools (ES|QL)

Add each as an ES|QL tool. `{{ }}` marks a parameter.

### flight_summary
What one flight did: duration, battery used, altitude, speed, GPS and EKF extremes.
Parameters: `flight_id` (keyword).
```esql
FROM dronex-telemetry
| WHERE flight_id == ?flight_id
| STATS fixes = COUNT(*), started = MIN(@timestamp), ended = MAX(@timestamp),
        battery_max = MAX(battery_pct), battery_min = MIN(battery_pct),
        alt_max_m = MAX(altitude_above_home_m), speed_max_mps = MAX(ground_speed_mps),
        sats_min = MIN(gps_satellites), hdop_max = MAX(gps_hdop), ekf_peak = MAX(ekf_variance),
        vehicle = VALUES(vehicle_name), design = VALUES(design_id)
```

### latest_flights
The most recent flights, to find a flight_id.
Parameters: `vehicle` (keyword, optional; use `*` for all).
```esql
FROM dronex-flights
| WHERE vehicle_name LIKE ?vehicle
| SORT @timestamp DESC
| KEEP flight_id, vehicle_name, design_id, started_at, ended_at, status
| LIMIT 10
```

### flight_events
The events of a flight in order: modes, arming, battery thresholds, GPS and EKF changes, brakes.
Parameters: `flight_id` (keyword).
```esql
FROM dronex-events
| WHERE flight_id == ?flight_id
| SORT @timestamp ASC
| KEEP @timestamp, type, detail
| LIMIT 200
```

### gps_dropouts
Where and when GPS quality degraded in a flight (fix type below 3D or fewer than 6 satellites), with the position.
Parameters: `flight_id` (keyword).
```esql
FROM dronex-telemetry
| WHERE flight_id == ?flight_id AND (gps_fix_type < 3 OR gps_satellites < 6)
| SORT @timestamp ASC
| KEEP @timestamp, location, altitude_above_home_m, gps_satellites, gps_fix_type, gps_hdop, mode
| LIMIT 100
```

### battery_sag_vs_estimate
Measured battery drain per minute against the design's estimate from the physics verdict.
Parameters: `flight_id` (keyword).
```esql
FROM dronex-flight-scores
| WHERE flight_id == ?flight_id
| KEEP flight_id, design_id, duration_min, battery_drain_pct_per_min, battery_drain_estimate_pct_per_min, battery_sag_ratio, anomalies, anomalous
```

### design_outcomes
How a design has done across every simulated run: scored flights, anomalies, and its physics verdict per mission.
Parameters: `design_id` (keyword; a preset id like `apex-5-medical-courier` or a stored design id `s-…`).
```esql
FROM dronex-flight-scores
| WHERE design_id == ?design_id
| STATS flights = COUNT(*), anomalous = COUNT(*) WHERE anomalous == true,
        sag_avg = AVG(battery_sag_ratio), ekf_peak_max = MAX(ekf_variance_peak),
        gps_dropouts = SUM(gps_dropouts), brakes = SUM(brake_events)
```
and the verdict side:
```esql
FROM dronex-verdicts
| WHERE design_id == ?design_id OR based_on == ?design_id
| KEEP design_id, mission_id, ready, failing_checks, summary.hoverTime_min, summary.hoverTWR, summary.auw_g
| LIMIT 50
```

### anomaly_reasons
What goes wrong most across the fleet.
Parameters: none.
```esql
FROM dronex-flight-scores
| WHERE anomalous == true
| MV_EXPAND anomalies
| STATS n = COUNT(*) BY anomalies
| SORT n DESC
| LIMIT 10
```

### explain_param
What an ArduPilot parameter does (semantic search over the parameter documentation).
Parameters: `question` (text).
```esql
FROM dronex-ardupilot-params METADATA _score
| WHERE text : ?question
| SORT _score DESC
| KEEP name, human_name, documentation, units, range, values
| LIMIT 3
```

### explain_verdict_line
The dataset note or physics formula behind a verdict line (semantic search over the catalog notes and formulas).
Parameters: `question` (text).
```esql
FROM dronex-catalog-notes, dronex-formulas METADATA _score
| WHERE text : ?question
| SORT _score DESC
| KEEP name, function_name, notes, comment, source
| LIMIT 4
```

## Demo questions

- "What happened on the last flight of the Apex courier?" → latest_flights, flight_summary, flight_events.
- "Why did it lose position on leg 3?" → gps_dropouts, explain_param ("EKF GPS glitch").
- "Is the battery draining as the design predicted?" → battery_sag_vs_estimate, design_outcomes.
- "What does MOT_THST_HOVER do and what did we set it to?" → explain_param; the set value is in dronex-verdicts (summary) and the flight's events.
- "Which designs keep braking for buildings?" → anomaly_reasons, design_outcomes.
