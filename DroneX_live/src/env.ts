// The live layer shares the configurator's server-side env file (DroneX_render/.env.local): one place for every
// key. Values already in the process environment win, so dev.sh and CI can override.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");

export function loadEnv(file = path.join(ROOT, "DroneX_render", ".env.local")): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const env = (key: string, fallback?: string): string => {
  const v = process.env[key];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${key} is not set (DroneX_render/.env.local)`);
};

export const has = (key: string): boolean => (process.env[key] ?? "") !== "";

/** The simulation engine's data folder: DRONEX_CORE_DATA_DIR, else the sibling checkout's dev folder. */
export const coreDataDir = (): string => process.env.DRONEX_CORE_DATA_DIR ?? path.join(ROOT, "dronex", "DroneX_1", ".dev", "core-data");
