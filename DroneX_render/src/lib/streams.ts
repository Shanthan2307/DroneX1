// How many long-lived event streams (/api/copilot/events) may be open: 3 per visitor address and 200 in total, so
// open tabs cannot pile up connections. One gate per server process, shared through globalThis. Server-only.

export const STREAMS_PER_IP = 3;
export const STREAMS_TOTAL = 200;

export class StreamGate {
  private open = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly perKey = STREAMS_PER_IP,
    private readonly max = STREAMS_TOTAL,
  ) {}

  /** Takes a place for `key`; false when its share or the total is used up. */
  tryOpen(key: string): boolean {
    const n = this.open.get(key) ?? 0;
    if (n >= this.perKey || this.total >= this.max) return false;
    this.open.set(key, n + 1);
    this.total += 1;
    return true;
  }

  /** Gives a place back. */
  close(key: string): void {
    const n = this.open.get(key) ?? 0;
    if (n <= 0) return;
    if (n === 1) this.open.delete(key);
    else this.open.set(key, n - 1);
    this.total -= 1;
  }

  get count(): number {
    return this.total;
  }
}

const g = globalThis as unknown as { __dronexStreams?: StreamGate };
export const streamGate = (): StreamGate => (g.__dronexStreams ??= new StreamGate());
