// A client for the simulation engine's local RPC (the Core daemon's unix socket, newline-delimited JSON-RPC 2.0),
// with notifications: `telemetry/update` and `state/delta` arrive as messages without an id. The same protocol
// as DroneX_render/src/lib/sim/core.ts, kept separate so this process has no build dependency on the Next app.
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import path from "node:path";

export interface DaemonInfo {
  pid: number;
  version: string;
  port: number;
  socket: string;
  uiUrl?: string;
}

export async function readDaemon(dir: string): Promise<DaemonInfo> {
  const file = path.join(dir, "daemon.json");
  const text = await readFile(file, "utf8").catch(() => {
    throw new Error(`The simulation engine is not running: no ${file}. Start it with ./dev.sh at the project root.`);
  });
  const info = JSON.parse(text) as Partial<DaemonInfo>;
  if (typeof info.socket !== "string" || typeof info.port !== "number") throw new Error(`${file} is not a daemon.json`);
  return { pid: info.pid ?? 0, version: info.version ?? "", port: info.port, socket: info.socket, uiUrl: info.uiUrl };
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcFailure extends Error {
  constructor(
    public readonly method: string,
    public readonly rpc: RpcError,
  ) {
    super(`${method}: ${rpc.message}`);
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };
export type Notification = (method: string, params: unknown) => void;

export class Daemon {
  private next = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private closed: Error | null = null;
  private listeners = new Set<Notification>();

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

  static async connect(socketPath: string, name = "dronex-live"): Promise<Daemon> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(socketPath);
      s.once("connect", () => resolve(s));
      s.once("error", (e) => reject(new Error(`cannot reach the simulation engine at ${socketPath}: ${e.message}`)));
    });
    const d = new Daemon(socket);
    await d.call("initialize", { clientInfo: { name, version: "0.1.0", kind: "operator-cli" }, capabilities: { protocolVersion: 1 } });
    return d;
  }

  onNotification(fn: Notification): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: RpcError; method?: string; params?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id !== "number") {
        if (msg.method) for (const l of this.listeners) l(msg.method, msg.params);
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcFailure(p.method, msg.error));
      else p.resolve(msg.result);
    }
  }

  call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close() {
    this.closed ??= new Error("closed");
    this.socket.end();
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
