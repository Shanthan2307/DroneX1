// Drones sent to the simulator, kept on disk so the simulation engine's map can fetch the 3D model and the
// configurator can reopen the design: .dronex/sim/<id>/{design.json, profile.json, model.glb} in the repo
// (gitignored). Server-only. Ids are the server's own, so a client cannot pick a path.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

export const ID_RE = /^s-[a-f0-9]{12}$/;

const root = () => path.join(process.cwd(), ".dronex", "sim");

export function newId(): string {
  return `s-${randomBytes(6).toString("hex")}`;
}

export async function saveFlight(id: string, { design, profile, model }: { design: unknown; profile: unknown; model: Uint8Array }): Promise<void> {
  if (!ID_RE.test(id)) throw new Error("bad id");
  const dir = path.join(root(), id);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(path.join(dir, "design.json"), JSON.stringify(design, null, 2)),
    writeFile(path.join(dir, "profile.json"), JSON.stringify(profile, null, 2)),
    writeFile(path.join(dir, "model.glb"), model),
  ]);
}

async function readIn(id: string, name: string): Promise<Buffer | null> {
  if (!ID_RE.test(id)) return null;
  try {
    return await readFile(path.join(root(), id, name));
  } catch {
    return null;
  }
}

export async function readFlight(id: string): Promise<{ design: unknown; profile: unknown } | null> {
  const [design, profile] = await Promise.all([readIn(id, "design.json"), readIn(id, "profile.json")]);
  if (!design || !profile) return null;
  return { design: JSON.parse(design.toString("utf8")), profile: JSON.parse(profile.toString("utf8")) };
}

export const readModel = (id: string) => readIn(id, "model.glb");

export interface StoredFlight {
  id: string;
  name: string;
  basedOn: string | null;
  createdAt: string;
  profile: { vehicle: string; frame: string; span_m: number };
}

/** Every stored design, newest first; a folder without both files is skipped. */
export async function listFlights(): Promise<StoredFlight[]> {
  let ids: string[];
  try {
    ids = (await readdir(root())).filter((d) => ID_RE.test(d));
  } catch {
    return [];
  }
  const out: StoredFlight[] = [];
  for (const id of ids) {
    const f = await readFlight(id);
    if (!f) continue;
    const design = f.design as { name?: string; basedOn?: string | null; createdAt?: string };
    const profile = f.profile as { vehicle: string; frame: string; span_m: number };
    out.push({ id, name: design.name ?? id, basedOn: design.basedOn ?? null, createdAt: design.createdAt ?? "", profile: { vehicle: profile.vehicle, frame: profile.frame, span_m: profile.span_m } });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
