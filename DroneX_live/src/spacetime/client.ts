// A Node connection to the shared airspace (the dronex-airspace SpacetimeDB database): connects, subscribes to
// every public table, and resolves once the first subscription is applied, so callers can read the cache and
// call reducers. One connection per process.
import { DbConnection, tables } from "./bindings/index.js";

export interface AirspaceConnection {
  conn: DbConnection;
  identity: string;
  close(): void;
}

/** Connects to SPACETIME_URI / SPACETIME_DB (defaults: ws://127.0.0.1:3100, dronex-airspace). */
export function connectAirspace(opts: { uri?: string; db?: string; token?: string; timeoutMs?: number } = {}): Promise<AirspaceConnection> {
  const uri = opts.uri ?? process.env.SPACETIME_URI ?? "ws://127.0.0.1:3100";
  const db = opts.db ?? process.env.SPACETIME_DB ?? "dronex-airspace";
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
      .onConnect((conn, identity) => {
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
      });
    if (opts.token) builder.withToken(opts.token);
    builder.build();
  });
}
