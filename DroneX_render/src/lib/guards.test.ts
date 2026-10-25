import { describe, expect, it } from "vitest";
import { StreamGate } from "./streams";
import { simOrigin } from "./cors";
import { deployProblems } from "./deployEnv";
import { visibleEvent } from "./copilot/visible";
import type { Callout, FeedEvent, VehicleListed } from "./copilot/types";

describe("StreamGate", () => {
  it("caps streams per key and in total, and gives places back", () => {
    const g = new StreamGate(2, 3);
    expect(g.tryOpen("a")).toBe(true);
    expect(g.tryOpen("a")).toBe(true);
    expect(g.tryOpen("a")).toBe(false);
    expect(g.tryOpen("b")).toBe(true);
    expect(g.tryOpen("c")).toBe(false);
    g.close("a");
    expect(g.tryOpen("c")).toBe(true);
    g.close("zzz");
    expect(g.count).toBe(3);
  });
});

describe("simOrigin", () => {
  it("is the simulator's origin, * on a laptop, nothing in production without it", () => {
    expect(simOrigin({ DRONEX_SIM_UI_URL: "https://sim.example.com/" })).toBe("https://sim.example.com");
    expect(simOrigin({ NODE_ENV: "development" })).toBe("*");
    expect(simOrigin({ NODE_ENV: "production" })).toBeNull();
  });
});

describe("deployProblems", () => {
  it("names every missing production setting", () => {
    expect(deployProblems({}).length).toBe(4);
    expect(
      deployProblems({ DRONEX_PUBLIC_URL: "https://dronex.x", DRONEX_SIM_UI_URL: "https://sim.x", NEXT_PUBLIC_SPACETIME_URI: "wss://maincloud.spacetimedb.com", DRONEX_COOKIE_SECRET: "s" }),
    ).toEqual([]);
    expect(deployProblems({ NEXT_PUBLIC_SPACETIME_URI: "ws://127.0.0.1:3100" }).some((p) => p.includes("wss://"))).toBe(true);
  });
});

describe("visibleEvent", () => {
  const v = (id: string): VehicleListed => ({ id, name: id, presence: "online", armed: false, mode: "GUIDED", vehicleType: "copter" });
  const callout = (vehicleId: string): Callout => ({ id: "c", vehicleId, vehicleName: vehicleId, kind: "k", priority: "status", text: "t", timeUs: 0 });
  it("shows agents everything and visitors only their vehicles", () => {
    const e: FeedEvent = { type: "vehicles", vehicles: [v("mine"), v("theirs")] };
    expect(visibleEvent(e, null)).toBe(e);
    expect(visibleEvent(e, ["mine"])).toEqual({ type: "vehicles", vehicles: [v("mine")] });
    expect(visibleEvent({ type: "callout", callout: callout("theirs") }, ["mine"])).toBeNull();
    expect(visibleEvent({ type: "callout", callout: callout("mine") }, ["mine"])).not.toBeNull();
  });
});
