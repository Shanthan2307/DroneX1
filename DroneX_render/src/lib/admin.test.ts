import { describe, expect, it } from "vitest";
import { pinMatches, sessionValid, signSession } from "./admin";
import { DailyBudget } from "./rateLimit";

describe("admin PIN and session", () => {
  it("matches only the configured PIN", () => {
    expect(pinMatches("12345678", "12345678")).toBe(true);
    expect(pinMatches(" 12345678 ", "12345678")).toBe(true);
    expect(pinMatches("12345679", "12345678")).toBe(false);
    expect(pinMatches("12345678", undefined)).toBe(false);
  });

  it("accepts an unexpired session for the same PIN only", () => {
    const now = 1_000_000;
    const value = signSession("1111", now + 60_000);
    expect(sessionValid(value, "1111", now)).toBe(true);
    expect(sessionValid(value, "2222", now)).toBe(false);
    expect(sessionValid(value, "1111", now + 61_000)).toBe(false);
    expect(sessionValid(`${now + 60_000}.forged`, "1111", now)).toBe(false);
    expect(sessionValid(null, "1111", now)).toBe(false);
  });
});

describe("daily budget use", () => {
  it("reports today's use and resets on a new day", () => {
    let t = Date.UTC(2026, 9, 26, 10);
    const b = new DailyBudget(() => t);
    b.take("llm", 5);
    b.take("llm", 5);
    expect(b.usedToday("llm")).toBe(2);
    t += 24 * 3_600_000;
    expect(b.usedToday("llm")).toBe(0);
  });
});
