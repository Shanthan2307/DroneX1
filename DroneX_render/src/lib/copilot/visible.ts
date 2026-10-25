// What one events stream may see of the copilot feed: everything for the agents (allowed = null), else only the
// visitor's own vehicles. Pure.
import type { FeedEvent } from "./types";

export function visibleEvent(e: FeedEvent, allowed: readonly string[] | null): FeedEvent | null {
  if (allowed === null) return e;
  const mine = (id: string) => allowed.includes(id);
  switch (e.type) {
    case "hello":
      return { type: "hello", vehicles: e.vehicles.filter((v) => mine(v.id)), snapshots: e.snapshots.filter((s) => mine(s.vehicleId)) };
    case "vehicles":
      return { type: "vehicles", vehicles: e.vehicles.filter((v) => mine(v.id)) };
    case "snapshot":
      return mine(e.snapshot.vehicleId) ? e : null;
    case "callout":
      return mine(e.callout.vehicleId) ? e : null;
  }
}
