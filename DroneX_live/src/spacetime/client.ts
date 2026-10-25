// A Node connection to the shared airspace (the dronex-airspace SpacetimeDB database): connects, subscribes to
// every public table, and resolves once the first subscription is applied, so callers can read the cache and
// call reducers. One connection per process.
//
// Writing needs a registered identity: the module refuses every mutating reducer from identities that are not in
// its writer allow-list. DroneX's server processes (this mirror and the configurator's server) connect with one
// shared, persisted token so their identity stays the same across restarts and is registered once with
// scripts/spacetime-add-writer.sh. Without a token the connection is anonymous: it can read, not write.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DbConnection, tables } from "./bindings/index.js";

export interface AirspaceConnection {
  conn: DbConnection;
  identity: string;
  close(): void;
}

/**
 * The token to connect with: SPACETIME_TOKEN, else the contents of SPACETIME_TOKEN_FILE (when it exists), else none
 * (a fresh anonymous identity, read-only).
 */
export function airspaceToken(): string | undefined {
  const direct = process.env.SPACETIME_TOKEN?.trim();
  if (direct) return direct;
  const file = process.env.SPACETIME_TOKEN_FILE;
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Saves the server-issued token to SPACETIME_TOKEN_FILE (mode 0600) when that file is set and has no token yet. */
function persistToken(token: string): void {
  const file = process.env.SPACETIME_TOKEN_FILE;
  if (!file || process.env.SPACETIME_TOKEN?.trim()) return;
  try {
    if (readFileSync(file, "utf8").trim()) return;
  } catch {
    // not there yet
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(`[spacetime] saved this process's token to ${file}; register its identity with scripts/spacetime-add-writer.sh`);
  } catch (e) {
    console.error(`[spacetime] could not save the token to ${file}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Connects to SPACETIME_URI / SPACETIME_DB (defaults: ws://127.0.0.1:3100, dronex-airspace). */
export function connectAirspace(
  opts: { uri?: string; db?: string; token?: string; timeoutMs?: number; onDisconnect?: (error?: Error) => void } = {},
): Promise<AirspaceConnection> {
  const uri = opts.uri ?? process.env.SPACETIME_URI ?? "ws://127.0.0.1:3100";
  const db = opts.db ?? process.env.SPACETIME_DB ?? "dronex-airspace";
  const token = opts.token ?? airspaceToken();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise<AirspaceConnection>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`no answer from the airspace at ${uri} (${db}) in ${timeoutMs} ms; is \`spacetime start\` running and the module published?`));
      }
    }, timeoutMs);
    const builder = DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(db)
      .onConnect((conn, identity, issued) => {
        if (!token) persistToken(issued);
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ conn, identity: identity.toHexString(), close: () => conn.disconnect() });
          })
          .onError((ctx) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(ctx.event ?? new Error("subscription failed"));
          })
          .subscribe([tables.vehicle, tables.position, tables.corridor, tables.incident, tables.missionAssignment]);
      })
      .onConnectError((_ctx, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      })
      .onDisconnect((_ctx, error) => {
        opts.onDisconnect?.(error);
      });
    if (token) builder.withToken(token);
    builder.build();
  });
}
