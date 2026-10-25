// Server-only: the configurator's own small client for the flight analytics in Elastic (the live layer,
// DroneX_live, writes them). Plain fetch against the Elasticsearch REST API with the API key, so the app has no
// Elastic SDK and the key never leaves the server. Reads ELASTIC_URL / ELASTIC_API_KEY / ELASTIC_INDEX_PREFIX.

export interface ElasticEnv {
  url: string;
  apiKey: string;
  prefix: string;
}

export function elasticEnv(): ElasticEnv | null {
  const url = process.env.ELASTIC_URL;
  const apiKey = process.env.ELASTIC_API_KEY;
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ""), apiKey, prefix: process.env.ELASTIC_INDEX_PREFIX ?? "dronex" };
}

type Cell = string | number | boolean | null | string[];
export type Row = Record<string, Cell>;

/** One ES|QL query; rows keyed by column name. */
export async function esql(env: ElasticEnv, query: string, timeoutMs = 8000): Promise<Row[]> {
  const r = await fetch(`${env.url}/_query?format=json`, {
    method: "POST",
    headers: { authorization: `ApiKey ${env.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Elastic answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { columns: { name: string }[]; values: Cell[][] };
  return j.values.map((v) => Object.fromEntries(j.columns.map((c, i) => [c.name, v[i]])));
}

// ES|QL string literals are double-quoted.
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export interface Build {
  airframeId: string | null;
  motorId: string | null;
  propellerId: string | null;
  batteryId: string | null;
  payloadId: string | null;
}

export interface FleetStats {
  design_ids: string[];
  verdict: { mission_id: string; ready: boolean; failing_checks: string[] }[];
  flights: number;
  scored: number;
  anomalous: number;
  anomalies: Record<string, number>;
  last_flight: { flight_id: string; vehicle_name: string | null; started_at: string | null; anomalies: string[] } | null;
  line: string;
}

/** The same statistics the live layer's query.ts computes, for the mission card: by stored design id or by build. */
export async function fleetStats(env: ElasticEnv, key: { designId?: string | null; build?: Build | null; missionId?: string | null }): Promise<FleetStats> {
  const p = env.prefix;
  let where: string;
  if (key.build) {
    const parts = ["airframeId", "motorId", "propellerId", "batteryId", "payloadId"] as const;
    where = parts.map((k) => (key.build?.[k] ? `build.${k} == ${quote(key.build[k] as string)}` : `build.${k} IS NULL`)).join(" AND ");
  } else if (key.designId) {
    where = `design_id == ${quote(key.designId)} OR based_on == ${quote(key.designId)}`;
  } else {
    throw new Error("designId or build is required");
  }
  const verdictRows = await esql(env, `FROM ${p}-verdicts | WHERE ${where} | KEEP design_id, mission_id, ready, failing_checks | LIMIT 500`);
  const designIds = [...new Set(verdictRows.map((r) => String(r.design_id)))];
  if (key.designId && !designIds.includes(key.designId)) designIds.push(key.designId);
  const verdict = verdictRows
    .filter((r) => !key.missionId || r.mission_id === key.missionId)
    .map((r) => ({ mission_id: String(r.mission_id), ready: r.ready === true, failing_checks: Array.isArray(r.failing_checks) ? r.failing_checks : typeof r.failing_checks === "string" ? [r.failing_checks] : [] }));
  if (designIds.length === 0) return { design_ids: [], verdict, flights: 0, scored: 0, anomalous: 0, anomalies: {}, last_flight: null, line: "no simulated runs yet" };
  const inList = designIds.map(quote).join(", ");
  const [flights, scores, reasons, last] = await Promise.all([
    esql(env, `FROM ${p}-flights | WHERE design_id IN (${inList}) | STATS n = COUNT_DISTINCT(flight_id)`),
    esql(env, `FROM ${p}-flight-scores | WHERE design_id IN (${inList}) | STATS scored = COUNT(*), anomalous = COUNT(*) WHERE anomalous == true`),
    esql(env, `FROM ${p}-flight-scores | WHERE design_id IN (${inList}) AND anomalous == true | MV_EXPAND anomalies | STATS n = COUNT(*) BY anomalies | SORT n DESC | LIMIT 10`),
    esql(env, `FROM ${p}-flight-scores | WHERE design_id IN (${inList}) | SORT @timestamp DESC | KEEP flight_id, vehicle_name, @timestamp, anomalies | LIMIT 1`),
  ]);
  const n = Number(flights[0]?.n ?? 0);
  const scored = Number(scores[0]?.scored ?? 0);
  const anomalous = Number(scores[0]?.anomalous ?? 0);
  const anomalies: Record<string, number> = {};
  for (const r of reasons) anomalies[String(r.anomalies)] = Number(r.n);
  const l = last[0];
  const lastFlight = l
    ? { flight_id: String(l.flight_id), vehicle_name: typeof l.vehicle_name === "string" ? l.vehicle_name : null, started_at: typeof l["@timestamp"] === "string" ? l["@timestamp"] : null, anomalies: Array.isArray(l.anomalies) ? l.anomalies : typeof l.anomalies === "string" ? [l.anomalies] : [] }
    : null;
  const clean = scored - anomalous;
  const top = Object.entries(anomalies)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, v]) => `${v}× ${k}`)
    .join(", ");
  const line = n === 0 ? "no simulated runs yet" : scored === 0 ? `${n} simulated run${n === 1 ? "" : "s"}, none finished yet` : `${clean} of ${scored} simulated runs clean${anomalous ? `; ${top}` : ""}`;
  return { design_ids: designIds, verdict, flights: n, scored, anomalous, anomalies, last_flight: lastFlight, line };
}

export interface SemanticHit {
  id: string;
  score: number;
  source: Record<string, unknown>;
}

/**
 * A plain-language question against an index's semantic_text field (`text`, embedded by the index's inference
 * endpoint: Jina v5 on the DroneX cluster). `index` is the name after the prefix, e.g. "ardupilot-params".
 */
export async function semanticSearch(env: ElasticEnv, index: string, question: string, size = 3, fields: string[] = [], timeoutMs = 10_000): Promise<SemanticHit[]> {
  const r = await fetch(`${env.url}/${env.prefix}-${index}/_search`, {
    method: "POST",
    headers: { authorization: `ApiKey ${env.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ size, query: { semantic: { field: "text", query: question } }, ...(fields.length ? { _source: fields } : {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Elastic answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { hits: { hits: { _id: string; _score: number; _source: Record<string, unknown> }[] } };
  return j.hits.hits.map((h) => ({ id: h._id, score: h._score, source: h._source }));
}

export { quote as esqlString };
