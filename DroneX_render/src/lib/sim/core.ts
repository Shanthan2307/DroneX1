// A client for the simulation engine's local RPC: the Core daemon (dronex/DroneX_1) listens on a unix socket in its
// data folder, newline-delimited JSON-RPC 2.0, trusted for the same user with no pairing. `daemon.json` beside the
// socket says where it is and where its web UI is served. Server-only.
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { simulatorUrl } from "../publicUrls";

export interface DaemonInfo {
  pid: number;
  version: string;
  port: number;
  socket: string;
  uiUrl?: string;
}

/** The Core data folder: DRONEX_CORE_DATA_DIR, else the sibling checkout's dev folder (dronex/DroneX_1/.dev/core-data). */
export function coreDataDir(): string {
  return process.env.DRONEX_CORE_DATA_DIR ?? path.resolve(process.cwd(), "../dronex/DroneX_1/.dev/core-data");
}

export async function readDaemon(dir = coreDataDir()): Promise<DaemonInfo> {
  const file = path.join(dir, "daemon.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    // The path stays in the server log; visitors get the plain sentence.
    console.error(`[dronex sim] no ${file}: start the engine with ./dev.sh at the project root`);
    throw new Error("The simulation engine is not running.");
  }
  const info = JSON.parse(text) as Partial<DaemonInfo>;
  if (typeof info.socket !== "string" || typeof info.port !== "number") {
    console.error(`[dronex sim] ${file} is not a daemon.json`);
    throw new Error("The simulation engine is not running.");
  }
  return { pid: info.pid ?? 0, version: info.version ?? "", port: info.port, socket: info.socket, uiUrl: info.uiUrl };
}

/** Where the simulation UI is: DRONEX_SIM_UI_URL when deployed, else the daemon's own answer, else its loopback port. */
export const uiUrlOf = (d: DaemonInfo): string => simulatorUrl(d.uiUrl ?? `http://127.0.0.1:${d.port}`);

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class CoreRpcError extends Error {
  constructor(
    public readonly method: string,
    public readonly rpc: RpcError,
  ) {
    super(`${method}: ${rpc.message}`);
  }
}

const CALL_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 5_000;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };

export class CoreClient {
  private next = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private closed: Error | null = null;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    const fail = (err: Error) => {
      this.closed = err;
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    socket.on("error", fail);
    socket.on("close", () => fail(this.closed ?? new Error("the simulation engine closed the connection")));
  }

  /** Connects and initializes as a local operator (full rights, like the CLI). */
  static async connect(socketPath: string): Promise<CoreClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(socketPath);
      s.once("connect", () => {
        s.setTimeout(0);
        resolve(s);
      });
      s.setTimeout(CONNECT_TIMEOUT_MS, () => s.destroy(new Error("connect timed out")));
      s.once("error", (e) => {
        console.error(`[dronex sim] cannot reach ${socketPath}: ${e.message}`);
        reject(new Error("cannot reach the simulation engine"));
      });
    });
    const client = new CoreClient(socket);
    await client.call("initialize", {
      clientInfo: { name: "dronex-render", version: "0.1.0", kind: "operator-cli" },
      capabilities: { protocolVersion: 1 },
    });
    return client;
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: RpcError; method?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id !== "number") continue; // a notification (state/delta, telemetry/update): not ours
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CoreRpcError(p.method, msg.error));
      else p.resolve(msg.result);
    }
  }

  /** One RPC; rejects after `timeoutMs` (15 s by default; sim/start passes a longer one). */
  call<T = unknown>(method: string, params: unknown = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: the simulation engine did not answer in time`));
      }, timeoutMs);
      const settle = <A>(fn: (a: A) => void) => (a: A) => {
        clearTimeout(timer);
        fn(a);
      };
      this.pending.set(id, { resolve: settle(resolve as (v: unknown) => void), reject: settle(reject), method });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close() {
    this.closed ??= new Error("closed");
    this.socket.end();
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
