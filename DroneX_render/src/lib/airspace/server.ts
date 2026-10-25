// Server-side connections to the shared airspace for the /api/airspace routes. The Next server connects with a
// persisted SpacetimeDB token so it has one stable identity, the one the module's writer allow-list registers
// (docs/DEPLOY.md item 18): SPACETIME_TOKEN, else the file at SPACETIME_TOKEN_FILE. When the file is named but
// does not exist yet, the token SpacetimeDB issues on the first connection is saved there (mode 600) and the
// identity logged, so the operator can register it with `add_writer`. Browsers never get a token: they stay
// read-only subscribers (client.ts). Server-only.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectAirspace, type Airspace } from "./client";

const g = globalThis as unknown as { __dronexSpacetimeToken?: string | null };

async function readToken(): Promise<string | undefined> {
  const inline = process.env.SPACETIME_TOKEN?.trim();
  if (inline) return inline;
  if (g.__dronexSpacetimeToken) return g.__dronexSpacetimeToken;
  if (g.__dronexSpacetimeToken === null) return undefined; // no file yet: the first connection creates it
  const file = process.env.SPACETIME_TOKEN_FILE?.trim();
  if (!file) return undefined;
  try {
    g.__dronexSpacetimeToken = (await readFile(file, "utf8")).trim() || null;
  } catch {
    g.__dronexSpacetimeToken = null;
  }
  return g.__dronexSpacetimeToken ?? undefined;
}

async function saveToken(token: string, identity: string): Promise<void> {
  const file = process.env.SPACETIME_TOKEN_FILE?.trim();
  if (!file || process.env.SPACETIME_TOKEN?.trim() || g.__dronexSpacetimeToken) return;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, token, { mode: 0o600, flag: "wx" }); // never overwrites: a parallel first request may win
    g.__dronexSpacetimeToken = token;
    console.log(`[dronex airspace] saved the server's SpacetimeDB token; register identity ${identity} with add_writer`);
  } catch (e) {
    g.__dronexSpacetimeToken = undefined; // read whatever the file holds next time
    console.warn(`[dronex airspace] could not save the SpacetimeDB token: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** One connection for the duration of `fn`, closed afterwards, as the server's own identity. */
export async function withAirspace<T>(fn: (air: Airspace) => Promise<T>): Promise<T> {
  const air = await connectAirspace({ token: await readToken(), onToken: (token, identity) => void saveToken(token, identity) });
  try {
    return await fn(air);
  } finally {
    air.close();
  }
}
