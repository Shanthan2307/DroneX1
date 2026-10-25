// Typed questions over the flight indices, the same ES|QL the Agent Builder agent runs (elastic/agent.md), plus a
// small CLI for demos:
//   npx tsx src/elastic/query.ts flights [vehicleName]      the latest flights and their scores
//   npx tsx src/elastic/query.ts flight <flight_id>          one flight's summary
//   npx tsx src/elastic/query.ts fleet <design or preset id> fleet statistics for a design
//   npx tsx src/elastic/query.ts param "<question>"          the ArduPilot parameter the question is about
//   npx tsx src/elastic/query.ts note "<question>"           the catalog note or formula the question is about
//   npx tsx src/elastic/query.ts esql "<query>"              any ES|QL
import type { Client } from "@elastic/elasticsearch";
import { INDEX, requireClient } from "./client.js";

type Row = Record<string, string | number | boolean | null>;

/** ES|QL through the client; rows as objects keyed by column name. */
export async function esql(client: Client, query: string): Promise<Row[]> {
  const r = (await client.esql.query({ query, format: "json" })) as unknown as { columns: { name: string }[]; values: (string | number | boolean | null)[][] };
  return r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c.name, v[i]])));
}

export interface FlightSummary {
  flight_id: string;
  vehicle_name: string | null;
  design_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  fixes: number;
  duration_min: number | null;
  battery_start_pct: number | null;
  battery_end_pct: number | null;
  max_altitude_above_home_m: number | null;
  max_ground_speed_mps: number | null;
  gps_satellites_min: number | null;
  ekf_variance_peak: number | null;
  events: { type: string; detail: string; at: string }[];
  score: Row | null;
}

export async function flightSummary(client: Client, prefix: string, flightId: string): Promise<FlightSummary | null> {
  const q = (s: string) => s.replace(/'/g, "\\'");
  const stats = await esql(
    client,
    `FROM ${INDEX.telemetry(prefix)} | WHERE flight_id == '${q(flightId)}' | STATS fixes = COUNT(*), started = MIN(@timestamp), ended = MAX(@timestamp), alt_max = MAX(altitude_above_home_m), speed_max = MAX(ground_speed_mps), sats_min = MIN(gps_satellites), ekf_peak = MAX(ekf_variance), vehicle = VALUES(vehicle_name), design = VALUES(design_id)`,
  );
  const s = stats[0];
  if (!s || Number(s.fixes) === 0) return null;
  const ends = await esql(client, `FROM ${INDEX.telemetry(prefix)} | WHERE flight_id == '${q(flightId)}' AND battery_pct IS NOT NULL | SORT @timestamp ASC | KEEP @timestamp, battery_pct | LIMIT 1`);
  const endsLast = await esql(client, `FROM ${INDEX.telemetry(prefix)} | WHERE flight_id == '${q(flightId)}' AND battery_pct IS NOT NULL | SORT @timestamp DESC | KEEP @timestamp, battery_pct | LIMIT 1`);
  const events = await esql(client, `FROM ${INDEX.events(prefix)} | WHERE flight_id == '${q(flightId)}' | SORT @timestamp ASC | KEEP @timestamp, type, detail | LIMIT 200`);
  const score = await esql(client, `FROM ${INDEX.scores(prefix)} | WHERE flight_id == '${q(flightId)}' | LIMIT 1`);
  const started = typeof s.started === "string" ? s.started : null;
  const ended = typeof s.ended === "string" ? s.ended : null;
  return {
    flight_id: flightId,
    vehicle_name: typeof s.vehicle === "string" ? s.vehicle : null,
    design_id: typeof s.design === "string" ? s.design : null,
    started_at: started,
    ended_at: ended,
    fixes: Number(s.fixes),
    duration_min: started && ended ? Math.round(((Date.parse(ended) - Date.parse(started)) / 60_000) * 100) / 100 : null,
    battery_start_pct: typeof ends[0]?.battery_pct === "number" ? ends[0].battery_pct : null,
    battery_end_pct: typeof endsLast[0]?.battery_pct === "number" ? endsLast[0].battery_pct : null,
    max_altitude_above_home_m: typeof s.alt_max === "number" ? s.alt_max : null,
    max_ground_speed_mps: typeof s.speed_max === "number" ? s.speed_max : null,
    gps_satellites_min: typeof s.sats_min === "number" ? s.sats_min : null,
    ekf_variance_peak: typeof s.ekf_peak === "number" ? s.ekf_peak : null,
    events: events.map((e) => ({ type: String(e.type), detail: String(e.detail), at: String(e["@timestamp"]) })),
    score: score[0] ?? null,
  };
}

export interface FleetStats {
  design_ids: string[];
  /** Physics verdict rows for these designs: how many missions pass on paper. */
  verdict_missions: { mission_id: string; ready: boolean; failing_checks: string[] }[];
  flights: number;
  scored: number;
  anomalous: number;
  anomalies: Record<string, number>;
  last_flight: FlightSummary | null;
  /** One line for the mission card. */
  line: string;
}

/** The designs that share a build (the same five parts) with the one asked about, by id or by parts. */
export async function fleetStats(client: Client, prefix: string, key: { designId?: string; build?: Record<string, string | null>; missionId?: string | null }): Promise<FleetStats> {
  const q = (s: string) => s.replace(/'/g, "\\'");
  let where: string;
  if (key.build) {
    const parts = ["airframeId", "motorId", "propellerId", "batteryId", "payloadId"] as const;
    where = parts.map((k) => (key.build?.[k] ? `build.${k} == '${q(key.build[k] as string)}'` : `build.${k} IS NULL`)).join(" AND ");
  } else if (key.designId) {
    where = `design_id == '${q(key.designId)}' OR based_on == '${q(key.designId)}'`;
  } else {
    throw new Error("designId or build is required");
  }
  const verdictRows = await esql(client, `FROM ${INDEX.verdicts(prefix)} | WHERE ${where} | KEEP design_id, mission_id, ready, failing_checks | LIMIT 500`);
  const designIds = [...new Set(verdictRows.map((r) => String(r.design_id)))];
  if (key.designId && !designIds.includes(key.designId)) designIds.push(key.designId);
  const mission = key.missionId ?? null;
  const verdictMissions = verdictRows
    .filter((r) => !mission || r.mission_id === mission)
    .map((r) => ({ mission_id: String(r.mission_id), ready: r.ready === true, failing_checks: Array.isArray(r.failing_checks) ? (r.failing_checks as string[]) : typeof r.failing_checks === "string" ? [r.failing_checks] : [] }));
  const empty: FleetStats = { design_ids: designIds, verdict_missions: verdictMissions, flights: 0, scored: 0, anomalous: 0, anomalies: {}, last_flight: null, line: "" };
  if (designIds.length === 0) return { ...empty, line: "no simulated runs yet" };
  const inList = designIds.map((d) => `'${q(d)}'`).join(", ");
  const flights = await esql(client, `FROM ${INDEX.flights(prefix)} | WHERE design_id IN (${inList}) | STATS n = COUNT_DISTINCT(flight_id)`);
  const scores = await esql(client, `FROM ${INDEX.scores(prefix)} | WHERE design_id IN (${inList}) | STATS scored = COUNT(*), anomalous = COUNT(*) WHERE anomalous == true`);
  const reasons = await esql(client, `FROM ${INDEX.scores(prefix)} | WHERE design_id IN (${inList}) AND anomalous == true | MV_EXPAND anomalies | STATS n = COUNT(*) BY anomalies | SORT n DESC | LIMIT 10`);
  const last = await esql(client, `FROM ${INDEX.flights(prefix)} | WHERE design_id IN (${inList}) | SORT @timestamp DESC | KEEP flight_id | LIMIT 1`);
  const n = Number(flights[0]?.n ?? 0);
  const scored = Number(scores[0]?.scored ?? 0);
  const anomalous = Number(scores[0]?.anomalous ?? 0);
  const anomalies: Record<string, number> = {};
  for (const r of reasons) anomalies[String(r.anomalies)] = Number(r.n);
  const lastFlight = last[0]?.flight_id ? await flightSummary(client, prefix, String(last[0].flight_id)) : null;
  const clean = scored - anomalous;
  const top = Object.entries(anomalies)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  const line = n === 0 ? "no simulated runs yet" : scored === 0 ? `${n} simulated run${n === 1 ? "" : "s"}, none finished yet` : `${clean} of ${scored} simulated runs clean${anomalous ? `; ${top}` : ""}`;
  return { design_ids: designIds, verdict_missions: verdictMissions, flights: n, scored, anomalous, anomalies, last_flight: lastFlight, line };
}

/** Semantic lookup in a knowledge index: the top hits with their text. */
export async function semanticLookup(client: Client, index: string, question: string, size = 3): Promise<{ score: number; doc: Record<string, unknown> }[]> {
  const r = await client.search<Record<string, unknown>>({ index, size, query: { match: { text: { query: question } } } });
  return r.hits.hits.map((h) => ({ score: h._score ?? 0, doc: h._source ?? {} }));
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { client, cfg } = requireClient();
  const p = cfg.prefix;
  const run = async () => {
    switch (cmd) {
      case "flights": {
        const name = rest[0];
        const rows = await esql(client, `FROM ${INDEX.flights(p)} ${name ? `| WHERE vehicle_name LIKE "*${name.replace(/"/g, "")}*"` : ""} | SORT @timestamp DESC | KEEP flight_id, vehicle_name, design_id, started_at, ended_at, status | LIMIT 20`);
        console.table(rows);
        return;
      }
      case "flight":
        console.log(JSON.stringify(await flightSummary(client, p, rest[0]), null, 2));
        return;
      case "fleet":
        console.log(JSON.stringify(await fleetStats(client, p, { designId: rest[0] }), null, 2));
        return;
      case "param":
        for (const h of await semanticLookup(client, INDEX.params(p), rest.join(" "))) console.log(`${h.score.toFixed(2)}  ${String(h.doc.name)}: ${String(h.doc.documentation)}`);
        return;
      case "note":
        for (const h of await semanticLookup(client, INDEX.notes(p), rest.join(" "))) console.log(`${h.score.toFixed(2)}  ${String(h.doc.name)}: ${String(h.doc.notes ?? "").slice(0, 200)}`);
        for (const h of await semanticLookup(client, INDEX.formulas(p), rest.join(" "), 2)) console.log(`${h.score.toFixed(2)}  ${String(h.doc.function_name)}: ${String(h.doc.comment).slice(0, 200)}`);
        return;
      case "esql":
        console.table(await esql(client, rest.join(" ")));
        return;
      default:
        console.log("usage: flights [name] | flight <id> | fleet <design id> | param <question> | note <question> | esql <query>");
    }
  };
  run().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
