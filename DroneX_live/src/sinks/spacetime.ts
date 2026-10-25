// SpacetimeDB sink: the shared airspace. Built by the SpacetimeDB track; until then it is absent.
// Contract: export function spacetimeSink(): Promise<Sink | null>  (null when SPACETIME_URI is not set).
import type { Sink } from "./types.js";

export async function spacetimeSink(): Promise<Sink | null> {
  return null;
}
