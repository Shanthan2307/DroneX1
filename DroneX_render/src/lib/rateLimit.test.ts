import { describe, expect, it } from "vitest";
import { clientIp, DailyBudget, dailyLimit, LIMITS, RateLimiter } from "./rateLimit";

describe("RateLimiter", () => {
  it("allows up to the limit, then refuses with Retry-After until the window resets", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    const w = [{ limit: 3, windowMs: 60_000 }];
    expect([1, 2, 3].map(() => rl.hit("a", w).ok)).toEqual([true, true, true]);
    const refused = rl.hit("a", w);
    expect(refused).toEqual({ ok: false, retryAfterS: 60 });
    t = 30_000;
    expect(rl.hit("a", w)).toEqual({ ok: false, retryAfterS: 30 });
    t = 60_000;
    expect(rl.hit("a", w).ok).toBe(true);
  });

  it("keeps keys apart", () => {
    const rl = new RateLimiter(() => 0);
    const w = [{ limit: 1, windowMs: 1000 }];
    expect(rl.hit("a", w).ok).toBe(true);
    expect(rl.hit("b", w).ok).toBe(true);
    expect(rl.hit("a", w).ok).toBe(false);
  });

  it("checks every window and counts nothing when one is full", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    const w = [
      { limit: 2, windowMs: 1000 },
      { limit: 3, windowMs: 10_000 },
    ];
    expect(rl.hit("k", w).ok).toBe(true);
    expect(rl.hit("k", w).ok).toBe(true);
    expect(rl.hit("k", w).ok).toBe(false); // the short window is full; the long one must not count this
    t = 1000;
    expect(rl.hit("k", w).ok).toBe(true); // third in the long window
    expect(rl.hit("k", w)).toEqual({ ok: false, retryAfterS: 9 });
  });

  it("sweeps expired buckets", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    rl.hit("a", [{ limit: 1, windowMs: 100 }]);
    t = 200;
    rl.sweep();
    expect(rl.size).toBe(0);
  });

  it("has the limits from the deployment plan", () => {
    expect(LIMITS.token).toEqual([{ limit: 6, windowMs: 3_600_000 }]);
    expect(LIMITS.fly[0]).toEqual({ limit: 3, windowMs: 600_000 });
  });
});

describe("DailyBudget", () => {
  it("spends per provider and starts over on a new UTC day", () => {
    let t = Date.UTC(2026, 9, 25, 23, 59);
    const b = new DailyBudget(() => t);
    expect(b.take("llm", 2)).toBe(true);
    expect(b.take("llm", 2)).toBe(true);
    expect(b.take("llm", 2)).toBe(false);
    expect(b.take("cartesia", 1)).toBe(true);
    t = Date.UTC(2026, 9, 26, 0, 1);
    expect(b.take("llm", 2)).toBe(true);
  });

  it("reads limits from the environment with defaults", () => {
    expect(dailyLimit("llm", {})).toBe(2000);
    expect(dailyLimit("llm", { DRONEX_DAILY_LLM: "50" })).toBe(50);
    expect(dailyLimit("cartesiaToken", { DRONEX_DAILY_CARTESIA_TOKENS: "nope" })).toBe(300);
  });
});

describe("clientIp", () => {
  it("takes the last X-Forwarded-For entry, else local", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9, 5.6.7.8" }))).toBe("5.6.7.8");
    expect(clientIp(new Headers())).toBe("local");
  });
});
