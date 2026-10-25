# DroneX flight dashboard (Kibana)

Build it once in Kibana → Dashboards → Create, with ES|QL panels (Visualize → ES|QL). One dashboard per project,
filtered by `design_id` with a control. Each panel's query is below; the dashboard export (`.ndjson`) is written by
Kibana itself after you save it, so it is not checked in.

| Panel | Type | ES|QL |
|---|---|---|
| Flights per design | Bar | `FROM dronex-flights \| STATS flights = COUNT_DISTINCT(flight_id) BY design_id \| SORT flights DESC` |
| Clean vs anomalous | Donut | `FROM dronex-flight-scores \| STATS n = COUNT(*) BY anomalous` |
| Anomaly reasons | Bar (horizontal) | `FROM dronex-flight-scores \| WHERE anomalous == true \| MV_EXPAND anomalies \| STATS n = COUNT(*) BY anomalies \| SORT n DESC` |
| Battery: measured vs estimate | Scatter | `FROM dronex-flight-scores \| KEEP flight_id, battery_drain_pct_per_min, battery_drain_estimate_pct_per_min, design_id` |
| Altitude over time (one flight) | Line | `FROM dronex-telemetry \| WHERE flight_id == "<id>" \| KEEP @timestamp, altitude_above_home_m, ground_speed_mps` |
| GPS satellites over time | Line | `FROM dronex-telemetry \| WHERE flight_id == "<id>" \| KEEP @timestamp, gps_satellites, gps_hdop` |
| EKF variance over time | Line | `FROM dronex-telemetry \| WHERE flight_id == "<id>" \| KEEP @timestamp, ekf_variance` |
| Track on the map | Maps layer (ES|QL) | `FROM dronex-telemetry \| WHERE flight_id == "<id>" \| KEEP location, altitude_above_home_m, gps_satellites` |
| Where brakes fire | Maps layer | `FROM dronex-events \| WHERE type == "mode" AND data.to == "BRAKE" \| LOOKUP JOIN dronex-telemetry ON flight_id \| KEEP location` (or join by nearest fix in a Lens layer) |
| Mode timeline | Bar (stacked) | `FROM dronex-events \| WHERE type == "mode" \| STATS n = COUNT(*) BY data.to, flight_id` |
| Verdict pass rate per mission | Table | `FROM dronex-verdicts \| STATS designs = COUNT_DISTINCT(design_id), passing = COUNT(*) WHERE ready == true BY mission_name` |

Controls: `design_id` (options list from `dronex-flights`), `vehicle_name`, time range.
