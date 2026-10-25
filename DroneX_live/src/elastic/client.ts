// The Elasticsearch client for the live layer, from the shared env file: ELASTIC_URL (the Serverless project's
// Elasticsearch endpoint), ELASTIC_API_KEY, ELASTIC_INDEX_PREFIX (default "dronex"). Serverless mode is detected
// from the URL; ELASTIC_SERVER_MODE overrides. Server-side only; the key never reaches a browser.
import { Client } from "@elastic/elasticsearch";
import { has, loadEnv } from "../env.js";

export interface ElasticConfig {
  url: string;
  apiKey: string;
  prefix: string;
  serverMode: "serverless" | "stack";
  /** The inference endpoint for semantic_text fields; see setup.ts for the fallback order. */
  inferenceId: string;
}

export const INDEX = {
  telemetry: (p: string) => `${p}-telemetry`,
  events: (p: string) => `${p}-events`,
  vehicles: (p: string) => `${p}-vehicles`,
  flights: (p: string) => `${p}-flights`,
  scores: (p: string) => `${p}-flight-scores`,
  verdicts: (p: string) => `${p}-verdicts`,
  params: (p: string) => `${p}-ardupilot-params`,
  notes: (p: string) => `${p}-catalog-notes`,
  formulas: (p: string) => `${p}-formulas`,
} as const;

export function readConfig(): ElasticConfig | null {
  loadEnv();
  if (!has("ELASTIC_URL")) return null;
  const url = process.env.ELASTIC_URL as string;
  const apiKey = process.env.ELASTIC_API_KEY ?? "";
  if (!apiKey) throw new Error("ELASTIC_URL is set but ELASTIC_API_KEY is empty (DroneX_render/.env.local)");
  const serverless = /elastic\.cloud|elastic-cloud\.com|serverless/i.test(url);
  const mode = process.env.ELASTIC_SERVER_MODE === "stack" || process.env.ELASTIC_SERVER_MODE === "serverless" ? process.env.ELASTIC_SERVER_MODE : serverless ? "serverless" : "stack";
  // On Serverless the cluster is authorised for the Elastic Inference Service, whose default text-embedding endpoint
  // is .jina-embeddings-v5-text-small; a stack deployment with ML nodes has .elser-2-elasticsearch. setup.ts
  // tries the configured id first and falls back (see KNOWLEDGE_INFERENCE_FALLBACK there).
  const inferenceId = process.env.ELASTIC_INFERENCE_ID ?? (mode === "serverless" ? ".jina-embeddings-v5-text-small" : ".elser-2-elasticsearch");
  return { url, apiKey, prefix: process.env.ELASTIC_INDEX_PREFIX ?? "dronex", serverMode: mode, inferenceId };
}

export function makeClient(cfg: ElasticConfig): Client {
  return new Client({ node: cfg.url, auth: { apiKey: cfg.apiKey }, serverMode: cfg.serverMode, requestTimeout: 30_000, maxRetries: 3, compression: true });
}

/** The client, or a clear error when Elastic is not configured. */
export function requireClient(): { client: Client; cfg: ElasticConfig } {
  const cfg = readConfig();
  if (!cfg) throw new Error("Elastic is not configured: set ELASTIC_URL and ELASTIC_API_KEY in DroneX_render/.env.local (an Elastic Cloud Serverless project's Elasticsearch endpoint and an API key)");
  return { client: makeClient(cfg), cfg };
}
