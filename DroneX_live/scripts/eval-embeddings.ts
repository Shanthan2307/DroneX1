// Retrieval eval for the ArduPilot parameter knowledge (dronex-ardupilot-params): which embedding / ranking setup
// finds the right parameter for a builder's or pilot's question. Gold set below; every answer name exists in the
// index (the script checks). Builds temporary copies of the index with other inference endpoints by _reindex,
// measures hit@1, hit@3, MRR@10 and median server latency, prints a table, then deletes the copies.
//
//   cd DroneX_live && npx tsx scripts/eval-embeddings.ts            # all setups
//   KEEP_EVAL=1 npx tsx scripts/eval-embeddings.ts                 # keep the eval indices afterwards
//
// Reads ELASTIC_URL / ELASTIC_API_KEY from DroneX_render/.env.local (never printed).
import type { estypes } from "@elastic/elasticsearch";
import { INDEX, requireClient } from "../src/elastic/client.js";

type Kind = "en" | "multilingual" | "no-overlap";
const GOLD: { q: string; answers: string[]; kind: Kind }[] = [
  { q: "What altitude does the drone climb to before it flies back home?", answers: ["RTL_ALT_M"], kind: "en" },
  { q: "What happens when the battery gets low?", answers: ["BATT_FS_LOW_ACT"], kind: "en" },
  { q: "What is the maximum lean angle the copter is allowed to tilt?", answers: ["ATC_ANGLE_MAX"], kind: "en" },
  { q: "What throttle does the drone need to hover?", answers: ["MOT_THST_HOVER"], kind: "en" },
  { q: "What should the drone do if it loses the radio signal from my transmitter?", answers: ["FS_THR_ENABLE"], kind: "en" },
  { q: "What is the maximum altitude the geofence allows?", answers: ["FENCE_ALT_MAX"], kind: "en" },
  { q: "How fast does the drone fly between waypoints in auto mode?", answers: ["WP_SPD"], kind: "en" },
  { q: "How fast does it descend when landing?", answers: ["LAND_SPD_MS"], kind: "en" },
  { q: "Where do I set my battery's capacity in mAh?", answers: ["BATT_CAPACITY"], kind: "en" },
  { q: "What does the copter do when the EKF position estimate goes bad?", answers: ["FS_EKF_ACTION"], kind: "en" },
  { q: "At what voltage is the battery considered critical?", answers: ["BATT_CRT_VOLT"], kind: "en" },
  { q: "How long does it wait above home before landing during return to launch?", answers: ["RTL_LOIT_TIME"], kind: "en" },
  { q: "How fast does the drone travel when returning to launch?", answers: ["RTL_SPEED_MS"], kind: "en" },
  { q: "Where do I tell the autopilot my frame is a hexacopter?", answers: ["FRAME_CLASS"], kind: "en" },
  { q: "¿Qué hace el dron cuando la batería está baja?", answers: ["BATT_FS_LOW_ACT", "BATT_LOW_VOLT"], kind: "multilingual" },
  { q: "Wie hoch steigt die Drohne, bevor sie nach Hause zurückkehrt?", answers: ["RTL_ALT_M"], kind: "multilingual" },
  { q: "जीपीएस रिसीवर का प्रकार कहाँ सेट करें?", answers: ["GPS_TYPE"], kind: "multilingual" },
  { q: "地理围栏的半径是多少?", answers: ["FENCE_RADIUS"], kind: "multilingual" },
  { q: "My quad sinks when I let go of the sticks; which value tells the autopilot how much power keeps it up?", answers: ["MOT_THST_HOVER"], kind: "no-overlap" },
  { q: "The props start turning as soon as I arm, how do I change how fast they idle?", answers: ["MOT_SPIN_ARM"], kind: "no-overlap" },
  { q: "My laptop's link dropped mid-flight; which setting decides what the aircraft does?", answers: ["FS_GCS_ENABLE"], kind: "no-overlap" },
];

const { client, cfg } = requireClient();
const SRC = INDEX.params(cfg.prefix);
const KEEP = process.env.KEEP_EVAL === "1";

const semanticQ = (q: string): estypes.QueryDslQueryContainer => ({ semantic: { field: "text", query: q } });
const bm25Q = (q: string): estypes.QueryDslQueryContainer => ({ multi_match: { query: q, fields: ["human_name^2", "documentation", "values"] } });

interface Setup {
  name: string;
  index: string;
  inference?: string; // a copy is built with this endpoint when set
  retriever: (q: string) => estypes.RetrieverContainer;
}

const SETUPS: Setup[] = [
  { name: "BM25 (no embeddings)", index: SRC, retriever: (q) => ({ standard: { query: bm25Q(q) } }) },
  { name: "Jina v5 text-small (current)", index: SRC, retriever: (q) => ({ standard: { query: semanticQ(q) } }) },
  { name: "Jina v5 text-nano", index: `${cfg.prefix}-eval-jina-nano`, inference: ".jina-embeddings-v5-text-nano", retriever: (q) => ({ standard: { query: semanticQ(q) } }) },
  { name: "ELSER v2 (sparse)", index: `${cfg.prefix}-eval-elser`, inference: ".elser-2-elastic", retriever: (q) => ({ standard: { query: semanticQ(q) } }) },
  {
    name: "Jina v5 small + BM25 (RRF)",
    index: SRC,
    retriever: (q) => ({ rrf: { retrievers: [{ standard: { query: bm25Q(q) } }, { standard: { query: semanticQ(q) } }], rank_window_size: 50 } }),
  },
  {
    name: "Jina v5 small + Jina reranker v3",
    index: SRC,
    retriever: (q) => ({ text_similarity_reranker: { retriever: { standard: { query: semanticQ(q) } }, field: "text", inference_id: ".jina-reranker-v3", inference_text: q, rank_window_size: 20 } }),
  },
];

async function buildCopy(s: Setup): Promise<number> {
  if (await client.indices.exists({ index: s.index })) await client.indices.delete({ index: s.index });
  const kw = { type: "keyword" } as const;
  const text = { type: "text" } as const;
  await client.indices.create({
    index: s.index,
    mappings: { properties: { name: kw, human_name: text, documentation: text, group: kw, vehicle: kw, range: kw, units: kw, values: text, user: kw, text: { type: "semantic_text", inference_id: s.inference as string } } },
  });
  const t0 = Date.now();
  const r = await client.reindex({ source: { index: SRC, size: 100 }, dest: { index: s.index }, wait_for_completion: false });
  const task = String(r.task);
  for (;;) {
    await new Promise((res) => setTimeout(res, 5000));
    try {
      const t = await client.tasks.get({ task_id: task });
      if (t.completed) {
        const failures = (t.response as { failures?: unknown[] } | undefined)?.failures ?? [];
        if (failures.length) console.error(`  ${s.name}: ${failures.length} reindex failures, first:`, JSON.stringify(failures[0]).slice(0, 300));
        break;
      }
    } catch {
      // tasks API not available: fall back to the document count
      await client.indices.refresh({ index: s.index });
      const { count } = await client.count({ index: s.index });
      if (count >= (await client.count({ index: SRC })).count) break;
    }
  }
  await client.indices.refresh({ index: s.index });
  return (Date.now() - t0) / 1000;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};

async function evaluate(s: Setup) {
  const per: { kind: Kind; rank: number | null; took: number }[] = [];
  for (const g of GOLD) {
    const tooks: number[] = [];
    let names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await client.search({ index: s.index, size: 10, _source: ["name"], retriever: s.retriever(g.q) });
      tooks.push(r.took);
      names = r.hits.hits.map((h) => (h._source as { name: string }).name);
    }
    const idx = names.findIndex((n) => g.answers.includes(n));
    per.push({ kind: g.kind, rank: idx >= 0 ? idx + 1 : null, took: median(tooks) });
  }
  const m = (rows: typeof per) => ({
    hit1: rows.filter((r) => r.rank === 1).length / rows.length,
    hit3: rows.filter((r) => r.rank !== null && r.rank <= 3).length / rows.length,
    mrr: rows.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / rows.length,
  });
  return { all: m(per), en: m(per.filter((r) => r.kind === "en")), ml: m(per.filter((r) => r.kind === "multilingual")), no: m(per.filter((r) => r.kind === "no-overlap")), took: median(per.map((r) => r.took)), misses: GOLD.filter((_, i) => per[i].rank === null || (per[i].rank as number) > 3).map((g, i) => `${g.answers[0]}${per[i] ? "" : ""}`) };
}

async function sizeOf(index: string): Promise<string> {
  try {
    const rows = await client.cat.indices({ index, format: "json", h: ["store.size"] });
    return String((rows[0] as Record<string, unknown>)?.["store.size"] ?? "?");
  } catch {
    return "n/a";
  }
}

async function main() {
  for (const g of GOLD)
    for (const a of g.answers) {
      const r = await client.exists({ index: SRC, id: a });
      if (!r) throw new Error(`gold answer ${a} is not in ${SRC}`);
    }
  console.log(`${GOLD.length} questions, every answer present in ${SRC}`);
  const ingest: Record<string, number> = {};
  for (const s of SETUPS.filter((x) => x.inference)) {
    console.log(`building ${s.index} (${s.inference})…`);
    ingest[s.name] = await buildCopy(s);
    console.log(`  ${ingest[s.name].toFixed(0)} s`);
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
  console.log("\nsetup                               hit@1 hit@3  MRR   | EN h@3 ML h@3 NoOv h@3 | p50 took | size    | ingest");
  for (const s of SETUPS) {
    const r = await evaluate(s);
    console.log(
      `${s.name.padEnd(35)} ${pct(r.all.hit1)}  ${pct(r.all.hit3)}  ${r.all.mrr.toFixed(2)} | ${pct(r.en.hit3)}   ${pct(r.ml.hit3)}   ${pct(r.no.hit3)}     | ${String(r.took).padStart(5)} ms | ${(await sizeOf(s.index)).padEnd(7)} | ${ingest[s.name] ? `${ingest[s.name].toFixed(0)} s` : "-"}`,
    );
  }
  if (!KEEP) for (const s of SETUPS.filter((x) => x.inference)) await client.indices.delete({ index: s.index, ignore_unavailable: true });
  console.log(KEEP ? "eval indices kept" : "eval indices deleted");
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  if (!KEEP) for (const s of SETUPS.filter((x) => x.inference)) await client.indices.delete({ index: s.index, ignore_unavailable: true }).catch(() => undefined);
  process.exit(1);
});
