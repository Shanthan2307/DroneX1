// Elastic sink: the flight index. Built by the Elastic track; until then it is absent.
// Contract: export function elasticSink(): Promise<Sink | null>  (null when ELASTIC_URL is not set).
import type { Sink } from "./types.js";

export async function elasticSink(): Promise<Sink | null> {
  return null;
}
