// Server-only: the hangar and the physics as data, for the Dispatch agents (DroneX_agents) and anything else
// that needs the same numbers the configurator shows. Every figure comes from the dataset or from dronePhysics.js;
// nothing is computed here, only gathered and labelled.
import { droneCatalog, dronePresetIds, dronePresetToBuild, droneReadiness, getDronePreset } from "../../../prototype/drone-assembly/src/data/droneCatalog.js";
import { evaluateDrone, droneSummary } from "../../../prototype/drone-assembly/src/dronePhysics.js";
import { missionMatrix } from "../../../prototype/drone-assembly/src/droneLibrary.js";
import { createDesign, validateDesign } from "../../../prototype/drone-assembly/src/designs.js";
import { simProfile } from "../../../prototype/drone-assembly/src/simProfile.js";

export interface Build {
  airframeId: string;
  motorId: string;
  propellerId: string;
  batteryId: string;
  payloadId: string | null;
  missionId: string | null;
  cruiseMotorId?: string;
  cruisePropellerId?: string;
}

export interface Summary {
  auw_g: number | null;
  thrustPerMotor_g: number | null;
  hoverTWR: number | null;
  hoverPower_W: number | null;
  hoverTime_min: number | null;
  maxCurrent_A: number | null;
  feasible: boolean;
}

export interface ReadinessLine {
  key: string;
  ok: boolean;
  text: string;
}

export interface Readiness {
  ready: boolean;
  lines: ReadinessLine[];
}

export interface Check {
  key?: string;
  label?: string;
  status: "pass" | "fail" | "not-judged" | string;
  text?: string;
}

export interface MissionRow {
  mission: { id: string; name: string; [k: string]: unknown };
  ready: boolean;
  failing: number;
  notJudged: number;
  checks: Check[];
  summary: Summary;
}

export interface Mission {
  id: string;
  name: string;
  [k: string]: unknown;
}

export interface PresetEntry {
  id: string;
  name: string;
  note?: string;
  source?: string;
  build: Build;
  /** The simulator's view of the design: ArduPilot vehicle class, frame, span, parameters (simProfile.js). */
  sim: { vehicle: string; frame: string; span_m: number; params: { name: string; value: number }[] };
  summary: Summary;
  readiness: Readiness;
  missions: MissionRow[];
  warnings: string[];
}

type Verdict = Record<string, unknown> & { warnings?: string[]; mixedTime_min?: number | null; hoverTime_min?: number | null; range_km?: number | null };

const rows = (build: Build): MissionRow[] =>
  (missionMatrix(build as unknown as Record<string, unknown>, droneCatalog) as { mission: Mission; verdict: Verdict; ready: boolean; checks: Check[]; failing: number; notJudged: number }[]).map((r) => ({
    mission: r.mission,
    ready: r.ready,
    failing: r.failing,
    notJudged: r.notJudged,
    checks: r.checks,
    summary: droneSummary(r.verdict) as Summary,
  }));

/** The verdict of one build: summary, readiness against its own mission, and the whole mission matrix. */
export function judge(build: Build): { verdict: Verdict; summary: Summary; readiness: Readiness; missions: MissionRow[]; warnings: string[] } {
  const verdict = evaluateDrone(build, droneCatalog) as Verdict;
  const readiness = droneReadiness(verdict, build.missionId ?? null) as Readiness;
  return { verdict, summary: droneSummary(verdict) as Summary, readiness, missions: rows(build), warnings: verdict.warnings ?? [] };
}

/** Every hangar drone, judged. */
export function catalogEntries(): PresetEntry[] {
  return (dronePresetIds as string[]).map((id) => {
    const preset = getDronePreset(id) as { name: string; note?: string; source?: string };
    const build = dronePresetToBuild(preset) as Build;
    const { verdict, summary, readiness, missions, warnings } = judge(build);
    const profile = simProfile({ build, verdict, catalog: droneCatalog, name: preset.name }) as PresetEntry["sim"];
    return {
      id,
      name: preset.name,
      note: preset.note,
      source: preset.source,
      build,
      sim: { vehicle: profile.vehicle, frame: profile.frame, span_m: profile.span_m, params: profile.params },
      summary,
      readiness,
      missions,
      warnings,
    };
  });
}

export const missions = (): Mission[] => (droneCatalog as { missions: Mission[] }).missions;

/** A build from a client, checked against the dataset the same way the fly route checks a design. */
export function checkBuild(raw: unknown): { ok: true; build: Build } | { ok: false; reason: string } {
  const r = validateDesign(createDesign({ name: "query", build: raw as Record<string, unknown> }), droneCatalog) as
    | { ok: true; design: { build: Build } }
    | { ok: false; reason: string };
  return r.ok ? { ok: true, build: r.design.build } : r;
}
