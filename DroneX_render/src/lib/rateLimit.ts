// In-process rate limits and daily budgets for the public configurator. Visitors are keyed on the X-Forwarded-For
// that Caddy sets (it replaces the header with the peer address, so the last entry is the real one); a request
// with the agent token counts against one shared "agent" bucket with larger limits instead (the Dispatch share).
// Paid providers also have a global daily budget that answers 503 "demo budget used up today" once spent. The
// counters live in this process, so exactly one `next start` runs. Server-only.
import { isAgent } from "./agentAuth";

export interface Window {
  limit: number;
  windowMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Per-IP limits per route (docs/DEPLOY.md item 14). */
export const LIMITS = {
  assistant: [
    { limit: 10, windowMs: MIN },
    { limit: 100, windowMs: DAY },
  ],
  intent: [
    { limit: 15, windowMs: MIN },
    { limit: 150, windowMs: DAY },
  ],
  token: [{ limit: 6, windowMs: HOUR }],
  speak: [
    { limit: 30, windowMs: MIN },
    { limit: 300, windowMs: DAY },
  ],
  transcribe: [{ limit: 10, windowMs: MIN }],
  fly: [
    { limit: 3, windowMs: 10 * MIN },
    { limit: 20, windowMs: DAY },
  ],
  analytics: [{ limit: 30, windowMs: MIN }],
  airspaceWrite: [{ limit: 20, windowMs: MIN }],
  airspaceRead: [{ limit: 60, windowMs: MIN }],
  dispatch: [{ limit: 30, windowMs: MIN }],
  dataset: [{ limit: 120, windowMs: MIN }],
  events: [{ limit: 20, windowMs: MIN }],
} satisfies Record<string, Window[]>;

export type RouteName = keyof typeof LIMITS;

/** The agents' shared bucket gets this many times a visitor's limit. */
export const AGENT_SHARE = 20;

export type Verdict = { ok: true } | { ok: false; retryAfterS: number };

/** Fixed-window counters, one per key and window length. Pure apart from the clock, which is injectable. */
export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one request for `key` unless any window is already full; then says how long to wait. */
  hit(key: string, windows: readonly Window[]): Verdict {
    const t = this.now();
    const current = windows.map((w) => {
      const id = `${key}|${w.windowMs}`;
      let b = this.buckets.get(id);
      if (!b || b.resetAt <= t) {
        b = { count: 0, resetAt: t + w.windowMs };
        this.buckets.set(id, b);
      }
      return { w, b };
    });
    const full = current.filter(({ w, b }) => b.count >= w.limit);
    if (full.length) return { ok: false, retryAfterS: Math.max(1, Math.ceil(Math.max(...full.map(({ b }) => b.resetAt - t)) / 1000)) };
    for (const { b } of current) b.count += 1;
    if (this.buckets.size > 50_000) this.sweep();
    return { ok: true };
  }

  /** Drops expired buckets. */
  sweep(): void {
    const t = this.now();
    for (const [k, b] of this.buckets) if (b.resetAt <= t) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** A global count per provider per UTC day. */
export class DailyBudget {
  private used = new Map<string, number>();
  private day = "";

  constructor(private readonly now: () => number = Date.now) {}

  /** Takes one unit of `provider`'s budget; false when today's `limit` is spent. */
  take(provider: string, limit: number): boolean {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used.clear();
    }
    const n = this.used.get(provider) ?? 0;
    if (n >= limit) return false;
    this.used.set(provider, n + 1);
    return true;
  }
}

/** The visitor's address: the last X-Forwarded-For entry (Caddy's), else "local" (a loopback caller). */
export function clientIp(headers: Headers): string {
  const parts = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts[parts.length - 1] ?? "local";
}

// One limiter and one budget per server process: route modules are bundled separately, so they share state
// through globalThis rather than module scope.
const g = globalThis as unknown as { __dronexLimiter?: RateLimiter; __dronexBudget?: DailyBudget };
const limiter = (): RateLimiter => (g.__dronexLimiter ??= new RateLimiter());
const budget = (): DailyBudget => (g.__dronexBudget ??= new DailyBudget());

const scaled = (windows: readonly Window[], k: number): Window[] => windows.map((w) => ({ limit: w.limit * k, windowMs: w.windowMs }));

/** Null when the request may go on, else the 429 with Retry-After. */
export function limitRequest(request: Request, route: RouteName): Response | null {
  const agent = isAgent(request);
  const key = agent ? `agent:${route}` : `${clientIp(request.headers)}:${route}`;
  const v = limiter().hit(key, agent ? scaled(LIMITS[route], AGENT_SHARE) : LIMITS[route]);
  if (v.ok) return null;
  return Response.json({ error: "too many requests, slow down a little" }, { status: 429, headers: { "Retry-After": String(v.retryAfterS) } });
}

export type Provider = "llm" | "cartesia" | "cartesiaToken";

// Defaults are deliberately small for a free demo; each can be raised with its env variable.
const BUDGET_ENV: Record<Provider, [string, number]> = {
  llm: ["DRONEX_DAILY_LLM", 2000],
  cartesia: ["DRONEX_DAILY_CARTESIA", 2000],
  cartesiaToken: ["DRONEX_DAILY_CARTESIA_TOKENS", 300],
};

export function dailyLimit(provider: Provider, env: Record<string, string | undefined> = process.env): number {
  const [name, fallback] = BUDGET_ENV[provider];
  const v = Number(env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Null when the provider still has budget today (and takes one unit), else the 503. */
export function spendBudget(provider: Provider): Response | null {
  if (budget().take(provider, dailyLimit(provider))) return null;
  return Response.json({ error: "demo budget used up today, try again tomorrow" }, { status: 503 });
}
