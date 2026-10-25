// `npm run elastic:setup`: creates the flight indices with explicit mappings, the three knowledge indices with a
// semantic_text field (ArduPilot parameters, catalog notes, physics formulas), fills the knowledge, and indexes the
// hangar's verdicts. Idempotent: existing indices are kept (pass --recreate to drop and rebuild them). Needs the
// configurator running for the verdicts (DRONEX_RENDER_URL); skips them with a warning otherwise.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@elastic/elasticsearch";
import type { MappingProperty } from "@elastic/elasticsearch/lib/api/types";
import { ROOT } from "../env.js";
import { INDEX, requireClient, type ElasticConfig } from "./client.js";
import { catalogNoteDocs, parseFormulaComments, parseParamDefs } from "./shape.js";
import { indexCatalogVerdicts } from "./verdicts.js";

type Props = Record<string, MappingProperty>;

const kw: MappingProperty = { type: "keyword" };
const dbl: MappingProperty = { type: "double" };
const int: MappingProperty = { type: "integer" };
const bool: MappingProperty = { type: "boolean" };
const date: MappingProperty = { type: "date" };
const text: MappingProperty = { type: "text" };

const telemetryProps: Props = {
  "@timestamp": date,
  vehicle_id: kw,
  vehicle_name: kw,
  design_id: kw,
  flight_id: kw,
  simulated: bool,
  location: { type: "geo_point" },
  altitude_amsl_m: dbl,
  altitude_above_home_m: dbl,
  altitude_above_ground_m: dbl,
  heading_deg: dbl,
  ground_speed_mps: dbl,
  climb_mps: dbl,
  battery_pct: dbl,
  battery_v: dbl,
  gps_satellites: int,
  gps_fix_type: int,
  gps_hdop: dbl,
  ekf_variance: dbl,
  ekf_status: kw,
  mode: kw,
  armed: bool,
};

const eventProps: Props = {
  "@timestamp": date,
  vehicle_id: kw,
  vehicle_name: kw,
  design_id: kw,
  flight_id: kw,
  type: kw,
  detail: text,
  data: { type: "object", dynamic: true },
};

const vehicleProps: Props = {
  "@timestamp": date,
  vehicle_id: kw,
  vehicle_name: kw,
  link_id: kw,
  vehicle_type: kw,
  autopilot: kw,
  firmware: kw,
  presence: kw,
  armed: bool,
  mode: kw,
  design_id: kw,
  size_cm: int,
  simulated: bool,
  flight_id: kw,
};

const flightProps: Props = { "@timestamp": date, flight_id: kw, vehicle_id: kw, vehicle_name: kw, design_id: kw, started_at: date, ended_at: date, status: kw };

const scoreProps: Props = {
  "@timestamp": date,
  flight_id: kw,
  vehicle_id: kw,
  vehicle_name: kw,
  design_id: kw,
  fixes: int,
  duration_min: dbl,
  battery_drain_pct_per_min: dbl,
  battery_drain_estimate_pct_per_min: dbl,
  battery_sag_ratio: dbl,
  ekf_variance_peak: dbl,
  gps_dropouts: int,
  gps_satellites_min: int,
  brake_events: int,
  mode_changes: int,
  max_altitude_above_home_m: dbl,
  max_ground_speed_mps: dbl,
  anomalies: kw,
  anomalous: bool,
  scored_by: kw,
};

const verdictProps: Props = {
  "@timestamp": date,
  design_id: kw,
  design_kind: kw,
  design_name: kw,
  based_on: kw,
  mission_id: kw,
  mission_name: kw,
  ready: bool,
  failing: int,
  not_judged: int,
  failing_checks: kw,
  checks: { type: "object", properties: { key: kw, status: kw, text: text } },
  build: { type: "object", properties: { airframeId: kw, motorId: kw, propellerId: kw, batteryId: kw, payloadId: kw, missionId: kw } },
  summary: { type: "object", dynamic: true },
  warnings: text,
};

// The semantic field: the configured inference endpoint first, then the two Elastic-managed defaults, then none
// (a plain text field, so the setup still completes on a cluster without inference).
const KNOWLEDGE_INFERENCE_FALLBACK = [".jina-embeddings-v5-text-small", ".elser-2-elasticsearch"] as const;

const semantic = (inferenceId: string | null): MappingProperty => (inferenceId ? { type: "semantic_text", inference_id: inferenceId } : { type: "text" });

const paramProps = (inf: string | null): Props => ({ name: kw, human_name: text, documentation: text, group: kw, vehicle: kw, range: kw, units: kw, values: text, user: kw, text: semantic(inf) });
const noteProps = (inf: string | null): Props => ({ record_id: kw, record_kind: kw, name: text, manufacturer: kw, source: kw, notes: text, numbers: { type: "object", dynamic: true }, text: semantic(inf) });
const formulaProps = (inf: string | null): Props => ({ function_name: kw, comment: text, signature: kw, text: semantic(inf) });

async function ensureIndex(client: Client, index: string, properties: Props, recreate: boolean): Promise<"created" | "kept"> {
  const exists = await client.indices.exists({ index });
  if (exists && !recreate) return "kept";
  if (exists) await client.indices.delete({ index });
  await client.indices.create({ index, mappings: { properties } });
  return "created";
}

/** A knowledge index: tries the inference endpoints in order; the one that works is reported. */
async function ensureKnowledgeIndex(client: Client, index: string, props: (inf: string | null) => Props, cfg: ElasticConfig, recreate: boolean): Promise<string> {
  const exists = await client.indices.exists({ index });
  if (exists && !recreate) return "kept";
  if (exists) await client.indices.delete({ index });
  const candidates = [cfg.inferenceId, ...KNOWLEDGE_INFERENCE_FALLBACK.filter((x) => x !== cfg.inferenceId), null];
  let last = "";
  for (const inf of candidates) {
    try {
      await client.indices.create({ index, mappings: { properties: props(inf) } });
      return inf ? `created with semantic_text on ${inf}` : "created WITHOUT semantic_text (no inference endpoint accepted; plain text)";
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      console.warn(`  ${index}: inference ${inf ?? "none"} refused: ${last.slice(0, 160)}`);
    }
  }
  throw new Error(`${index}: could not create (${last})`);
}

async function bulkAll(client: Client, index: string, docs: { id: string; doc: object }[], batch = 200): Promise<number> {
  let n = 0;
  for (let i = 0; i < docs.length; i += batch) {
    const slice = docs.slice(i, i + batch);
    const r = await client.bulk({ operations: slice.flatMap((d) => [{ index: { _index: index, _id: d.id } }, d.doc]), refresh: i + batch >= docs.length ? "wait_for" : false });
    if (r.errors) {
      const bad = r.items.find((x) => x.index?.error);
      throw new Error(`${index}: ${JSON.stringify(bad?.index?.error).slice(0, 300)}`);
    }
    n += slice.length;
    process.stdout.write(`\r  ${index}: ${n}/${docs.length}`);
  }
  process.stdout.write("\n");
  return n;
}

const PARAM_XML = process.env.ARDUPILOT_PARAM_XML ?? "/tmp/dronex-data/apm.pdef.xml";
const DATA_DIR = path.join(ROOT, "DroneX_render", "prototype", "drone-assembly", "src", "data", "drone");
const PHYSICS = path.join(ROOT, "DroneX_render", "prototype", "drone-assembly", "src", "dronePhysics.js");

export async function setup(opts: { recreate: boolean; knowledge: boolean; verdicts: boolean }): Promise<void> {
  const { client, cfg } = requireClient();
  const p = cfg.prefix;
  const info = await client.info();
  console.log(`Elastic ${info.version.build_flavor ?? "stack"} ${info.version.number} at ${cfg.url} (${cfg.serverMode}), prefix ${p}`);

  console.log("Flight indices:");
  for (const [index, props] of [
    [INDEX.telemetry(p), telemetryProps],
    [INDEX.events(p), eventProps],
    [INDEX.vehicles(p), vehicleProps],
    [INDEX.flights(p), flightProps],
    [INDEX.scores(p), scoreProps],
    [INDEX.verdicts(p), verdictProps],
  ] as const) {
    console.log(`  ${index}: ${await ensureIndex(client, index, props, opts.recreate)}`);
  }

  if (opts.knowledge) {
    console.log("Knowledge indices (semantic_text):");
    const paramsState = await ensureKnowledgeIndex(client, INDEX.params(p), paramProps, cfg, opts.recreate);
    console.log(`  ${INDEX.params(p)}: ${paramsState}`);
    if (paramsState !== "kept") {
      let xml: string;
      try {
        xml = readFileSync(PARAM_XML, "utf8");
      } catch {
        throw new Error(`ArduPilot parameter definitions not found at ${PARAM_XML}; download https://autotest.ardupilot.org/Parameters/ArduCopter/apm.pdef.xml there or set ARDUPILOT_PARAM_XML`);
      }
      const params = parseParamDefs(xml, "ArduCopter");
      await bulkAll(client, INDEX.params(p), params.map((d) => ({ id: d.name, doc: d })), 100);
    }

    const notesState = await ensureKnowledgeIndex(client, INDEX.notes(p), noteProps, cfg, opts.recreate);
    console.log(`  ${INDEX.notes(p)}: ${notesState}`);
    if (notesState !== "kept") {
      const docs = readdirSync(DATA_DIR)
        .filter((f) => f.endsWith(".json"))
        .flatMap((f) => {
          const raw = JSON.parse(readFileSync(path.join(DATA_DIR, f), "utf8")) as unknown;
          const records = (Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>)) as Record<string, unknown>[];
          return catalogNoteDocs(f.replace(/\.json$/, "").replace(/s$/, ""), records);
        });
      await bulkAll(client, INDEX.notes(p), docs.map((d) => ({ id: `${d.record_kind}:${d.record_id}`, doc: d })), 50);
    }

    const formulasState = await ensureKnowledgeIndex(client, INDEX.formulas(p), formulaProps, cfg, opts.recreate);
    console.log(`  ${INDEX.formulas(p)}: ${formulasState}`);
    if (formulasState !== "kept") {
      const docs = parseFormulaComments(readFileSync(PHYSICS, "utf8"));
      await bulkAll(client, INDEX.formulas(p), docs.map((d) => ({ id: d.function_name, doc: d })), 50);
    }
  }

  if (opts.verdicts) {
    try {
      const n = await indexCatalogVerdicts(client, p);
      console.log(`Verdicts: ${n} preset × mission rows indexed into ${INDEX.verdicts(p)}`);
    } catch (e) {
      console.warn(`Verdicts skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log("Done.");
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = new Set(process.argv.slice(2));
  setup({ recreate: args.has("--recreate"), knowledge: !args.has("--no-knowledge"), verdicts: !args.has("--no-verdicts") }).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
