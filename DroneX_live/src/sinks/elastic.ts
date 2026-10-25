// Elastic sink: every fix, event and vehicle change the mirror sees goes into the flight indices, batched. One
// bulk request per second from flush() (plus one when the queue grows large), retried with backoff, never
// blocking the mirror: a failed batch is kept and retried, and after too many failures it is dropped with a log
// line rather than letting memory grow. Flights are cut out of the stream by FlightTracker (shape.ts); when a
// flight ends, the flight is scored here too, so the configurator's fleet statistics do not have to wait for the
// Workflow in the cluster. Returns null when ELASTIC_URL is not set.
import type { Client } from "@elastic/elasticsearch";
import { INDEX, makeClient, readConfig } from "../elastic/client.js";
import { indexDesignVerdict } from "../elastic/verdicts.js";
import { eventDoc, FlightTracker, scoreFlight, telemetryDoc, vehicleDoc, type EventDoc, type TelemetryDoc } from "../elastic/shape.js";
import type { FlightEvent, Fix, Sink, VehicleInfo } from "./types.js";

type Op = { index: string; id?: string; doc: object };

const MAX_QUEUE = 20_000;
const FLUSH_AT = 500;
const MAX_FAILURES = 8;

export async function elasticSink(): Promise<Sink | null> {
  const cfg = readConfig();
  if (!cfg) return null;
  const client = makeClient(cfg);
  const p = cfg.prefix;
  const tracker = new FlightTracker();
  const queue: Op[] = [];
  let failures = 0;
  let inFlight = false;
  let backoffUntil = 0;
  // Per flight, what the score needs: a thinned copy of the fixes and the events, bounded.
  const perFlight = new Map<string, { fixes: TelemetryDoc[]; events: EventDoc[]; vehicle: VehicleInfo }>();
  const hoverByDesign = new Map<string, number | null>();

  const push = (op: Op) => {
    if (queue.length >= MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE + 1);
    queue.push(op);
    if (queue.length >= FLUSH_AT) void flush();
  };

  async function flush(): Promise<void> {
    if (inFlight || queue.length === 0 || Date.now() < backoffUntil) return;
    inFlight = true;
    const batch = queue.splice(0, 2000);
    try {
      const body = batch.flatMap((op) => [op.id ? { index: { _index: op.index, _id: op.id } } : { index: { _index: op.index } }, op.doc]);
      const r = await client.bulk({ operations: body, refresh: false });
      if (r.errors) {
        const bad = r.items.filter((i) => i.index?.error);
        console.error(`[elastic] ${bad.length} of ${batch.length} documents rejected: ${JSON.stringify(bad[0]?.index?.error).slice(0, 300)}`);
      }
      failures = 0;
    } catch (e) {
      failures++;
      backoffUntil = Date.now() + Math.min(30_000, 1000 * 2 ** failures);
      if (failures <= MAX_FAILURES) {
        queue.unshift(...batch);
        console.error(`[elastic] bulk failed (${failures}): ${e instanceof Error ? e.message : String(e)}; retrying in ${Math.round((backoffUntil - Date.now()) / 1000)} s`);
      } else {
        console.error(`[elastic] bulk failed ${failures} times; dropping ${batch.length} documents`);
      }
    } finally {
      inFlight = false;
    }
  }

  async function hoverTimeFor(designId: string | null): Promise<number | null> {
    if (!designId) return null;
    if (hoverByDesign.has(designId)) return hoverByDesign.get(designId) ?? null;
    const hover = await indexDesignVerdict(client, p, designId).catch((e: unknown) => {
      console.error(`[elastic] verdict for ${designId}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    hoverByDesign.set(designId, hover);
    return hover;
  }

  function remember(flightId: string, v: VehicleInfo, fix?: TelemetryDoc, event?: EventDoc) {
    const f = perFlight.get(flightId) ?? { fixes: [], events: [], vehicle: v };
    if (fix) {
      f.fixes.push(fix);
      if (f.fixes.length > 20_000) f.fixes.splice(0, f.fixes.length - 20_000);
    }
    if (event) f.events.push(event);
    perFlight.set(flightId, f);
  }

  async function closeFlight(flightId: string, v: VehicleInfo | null) {
    const f = perFlight.get(flightId);
    perFlight.delete(flightId);
    if (!f) return;
    const [vehicleId] = flightId.split(":");
    const score = scoreFlight({ flightId, vehicleId, designId: f.vehicle.designId, fixes: f.fixes, events: f.events, hoverTimeMin: await hoverTimeFor(f.vehicle.designId) });
    push({ index: INDEX.scores(p), id: flightId, doc: { ...score, vehicle_name: (v ?? f.vehicle).name, scored_by: "mirror" } });
  }

  return {
    name: "elastic",
    async start() {
      const info = await client.info();
      console.log(`[elastic] ${info.version.build_flavor ?? "stack"} ${info.version.number} at ${cfg.url}, indices ${p}-*`);
    },
    async onVehicle(v: VehicleInfo) {
      const nowUs = Date.now() * 1000;
      const flightId = v.presence === "online" ? tracker.ensure(v, nowUs) : tracker.flightOf(v.id);
      push({ index: INDEX.vehicles(p), id: v.id, doc: vehicleDoc(v, nowUs, flightId) });
      if (v.designId) void hoverTimeFor(v.designId);
    },
    async onFix(f: Fix, v: VehicleInfo) {
      const flightId = tracker.ensure(v, f.timeUs);
      const doc = telemetryDoc(f, v, flightId);
      push({ index: INDEX.telemetry(p), doc });
      remember(flightId, v, doc);
    },
    async onEvent(e: FlightEvent, v: VehicleInfo | null) {
      const flightDoc = tracker.apply(e, v);
      const flightId = tracker.flightOf(e.vehicleId) ?? (flightDoc?.flight_id ?? null);
      const doc = eventDoc(e, v, flightId);
      push({ index: INDEX.events(p), doc });
      if (flightDoc) push({ index: INDEX.flights(p), id: flightDoc.flight_id, doc: flightDoc });
      if (flightId && v) remember(flightId, v, undefined, doc);
      if (e.type === "vehicle-offline" && flightDoc) await closeFlight(flightDoc.flight_id, v);
    },
    flush,
    async stop() {
      await flush();
    },
  };
}

/** For tests and the CLI: the bulk body shape this sink sends. */
export const bulkBody = (ops: Op[]): unknown[] => ops.flatMap((op) => [op.id ? { index: { _index: op.index, _id: op.id } } : { index: { _index: op.index } }, op.doc]);

export type { Client };
