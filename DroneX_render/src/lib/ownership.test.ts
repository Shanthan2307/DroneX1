import { describe, expect, it } from "vitest";
import { MAX_OWNED, readCookie, signIds, verifyIds, withOwned } from "./ownership";
import { agentTokenValid } from "./agentAuth";

const SECRET = "test-secret";

describe("ownership cookie", () => {
  it("round-trips the ids", () => {
    expect(verifyIds(signIds(["v-1", "v-2"], SECRET), SECRET)).toEqual(["v-1", "v-2"]);
  });

  it("rejects a tampered payload, a wrong secret and junk", () => {
    const value = signIds(["v-1"], SECRET);
    const [, sig] = value.split(".");
    const forged = `${Buffer.from(JSON.stringify(["v-1", "someone-else"])).toString("base64url")}.${sig}`;
    expect(verifyIds(forged, SECRET)).toBeNull();
    expect(verifyIds(value, "other-secret")).toBeNull();
    expect(verifyIds("nonsense", SECRET)).toBeNull();
    expect(verifyIds("", SECRET)).toBeNull();
    expect(verifyIds(null, SECRET)).toBeNull();
  });

  it("drops malformed ids and keeps the newest few", () => {
    const ids = Array.from({ length: MAX_OWNED + 3 }, (_, i) => `v${i}`);
    const out = verifyIds(signIds([...ids, "bad id;"], SECRET), SECRET);
    expect(out).toEqual(ids.slice(-MAX_OWNED));
  });

  it("adds an id once, last", () => {
    expect(withOwned(["a", "b"], "a")).toEqual(["b", "a"]);
    expect(withOwned([], "x")).toEqual(["x"]);
  });

  it("reads one cookie from the header", () => {
    expect(readCookie("a=1; dronex_own=xyz.abc; b=2", "dronex_own")).toBe("xyz.abc");
    expect(readCookie(null, "dronex_own")).toBeNull();
    expect(readCookie("dronex_owner=1", "dronex_own")).toBeNull();
  });
});

describe("agent token", () => {
  it("matches only the configured token", () => {
    expect(agentTokenValid("t0k", "t0k", false)).toBe(true);
    expect(agentTokenValid("nope", "t0k", false)).toBe(false);
    expect(agentTokenValid(null, "t0k", true)).toBe(false);
  });

  it("without a configured token, allows only in development", () => {
    expect(agentTokenValid(null, undefined, true)).toBe(true);
    expect(agentTokenValid("anything", undefined, false)).toBe(false);
  });
});
