import { describe, expect, it } from "vitest";
import { deployProblems } from "./deployEnv";
import { simulatorInMode, simulatorOffText } from "./mode";

describe("deployment mode", () => {
  it("includes the simulator unless DRONEX_MODE is configurator", () => {
    expect(simulatorInMode(undefined)).toBe(true);
    expect(simulatorInMode("")).toBe(true);
    expect(simulatorInMode("full")).toBe(true);
    expect(simulatorInMode("configurator")).toBe(false);
    expect(simulatorInMode(" Configurator ")).toBe(false);
  });

  it("points visitors at the contact email when there is one", () => {
    expect(simulatorOffText("me@example.com")).toContain("email me@example.com");
    expect(simulatorOffText(null)).toContain("./dev.sh");
  });

  it("asks nothing of a website-only deployment, everything of a full one", () => {
    expect(deployProblems({ DRONEX_MODE: "configurator" })).toEqual([]);
    expect(deployProblems({}).length).toBeGreaterThan(0);
  });
});
