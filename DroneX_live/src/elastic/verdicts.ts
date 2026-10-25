// The physics verdicts as documents, so fleet statistics exist before the first flight and every flight can be
// compared against its design's estimate. Every preset × mission row from the configurator's /api/catalog goes to
// `${prefix}-verdicts`; a stored design (one sent to the simulator, id s-…) is judged through /api/verdict with its
// own build and indexed under its id when the mirror first sees a vehicle flying it. Numbers come from
// dronePhysics.js through those routes; nothing is computed here.
import type { Client } from "@elastic/elasticsearch";
import { INDEX } from "./client.js";

const RENDER = (): string => (process.env.DRONEX_RENDER_URL ?? "http://localhost:3000").replace(/\/+$/, "");

interface Check {
  key?: string;
  label?: string;
  status: string;
  text?: string;
}
interface MissionRow {
  mission: { id: string; name: string };
  ready: boolean;
  failing: number;
  notJudged: number;
  checks: Check[];
  summary: Record<string, number | boolean | null>;
}
interface Judged {
  build: Record<string, string | null | undefined>;
  summary: Record<string, number | boolean | null>;
  readiness: { ready: boolean; lines: { key: string; ok: boolean; text: string }[] };
  missions: MissionRow[];
  warnings: string[];
}
interface Preset extends Judged {
  id: string;
  name: string;
}

export interface VerdictDoc {
  "@timestamp": string;
  design_id: string;
  design_kind: "preset" | "design";
  design_name: string;
  based_on: string | null;
  mission_id: string;
  mission_name: string;
  ready: boolean;
  failing: number;
  not_judged: number;
  failing_checks: string[];
  checks: { key: string; status: string; text: string }[];
  build: Record<string, string | null>;
  summary: Record<string, number | boolean | null>;
  warnings: string[];
}

const buildOf = (b: Record<string, string | null | undefined>): Record<string, string | null> => ({
  airframeId: b.airframeId ?? null,
  motorId: b.motorId ?? null,
  propellerId: b.propellerId ?? null,
  batteryId: b.batteryId ?? null,
  payloadId: b.payloadId ?? null,
  missionId: b.missionId ?? null,
});

export function verdictDocs(id: string, kind: VerdictDoc["design_kind"], name: string, basedOn: string | null, j: Judged, now = new Date().toISOString()): VerdictDoc[] {
  return j.missions.map((m) => ({
    "@timestamp": now,
    design_id: id,
    design_kind: kind,
    design_name: name,
    based_on: basedOn,
    mission_id: m.mission.id,
    mission_name: m.mission.name,
    ready: m.ready,
    failing: m.failing,
    not_judged: m.notJudged,
    failing_checks: m.checks.filter((c) => c.status === "fail").map((c) => c.label ?? c.key ?? "check"),
    checks: m.checks.map((c) => ({ key: c.key ?? c.label ?? "check", status: c.status, text: c.text ?? "" })),
    build: buildOf(j.build),
    summary: m.summary,
    warnings: j.warnings,
  }));
}

async function bulkIndex(client: Client, index: string, docs: { id: string; doc: VerdictDoc }[]): Promise<number> {
  if (docs.length === 0) return 0;
  const r = await client.bulk({ operations: docs.flatMap((d) => [{ index: { _index: index, _id: d.id } }, d.doc]), refresh: "wait_for" });
  if (r.errors) {
    const bad = r.items.find((i) => i.index?.error);
    throw new Error(`verdict bulk: ${JSON.stringify(bad?.index?.error).slice(0, 300)}`);
  }
  return docs.length;
}

/** Every hangar preset × mission. Returns the number of documents written. */
export async function indexCatalogVerdicts(client: Client, prefix: string): Promise<number> {
  const r = await fetch(`${RENDER()}/api/catalog`);
  if (!r.ok) throw new Error(`/api/catalog answered ${r.status}; is the configurator running on ${RENDER()}?`);
  const { presets } = (await r.json()) as { presets: Preset[] };
  const docs = presets.flatMap((p) => verdictDocs(p.id, "preset", p.name, null, p).map((doc) => ({ id: `${p.id}:${doc.mission_id}`, doc })));
  return bulkIndex(client, INDEX.verdicts(prefix), docs);
}

/**
 * One stored design (s-…): its build from /api/sim/designs/<id>, judged by /api/verdict, indexed per mission.
 * Returns the hover time estimate (minutes) for the design's own mission, which the flight score compares against.
 */
export async function indexDesignVerdict(client: Client, prefix: string, designId: string): Promise<number | null> {
  const d = await fetch(`${RENDER()}/api/sim/designs/${designId}`);
  if (!d.ok) throw new Error(`/api/sim/designs/${designId} answered ${d.status}`);
  const { design } = (await d.json()) as { design: { name: string; basedOn: string | null; build: Record<string, string | null> } };
  const v = await fetch(`${RENDER()}/api/verdict`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ build: design.build }) });
  if (!v.ok) throw new Error(`/api/verdict answered ${v.status}`);
  const judged = (await v.json()) as Judged;
  await bulkIndex(client, INDEX.verdicts(prefix), verdictDocs(designId, "design", design.name, design.basedOn, judged).map((doc) => ({ id: `${designId}:${doc.mission_id}`, doc })));
  const hover = judged.summary.hoverTime_min;
  return typeof hover === "number" ? hover : null;
}
