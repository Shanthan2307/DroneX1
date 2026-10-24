// Guards the live page: every element id the front end looks up must exist in the markup the page renders.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assemblyMarkup, extractBodyMarkup } from "./markup";

const SRC = path.join(process.cwd(), "prototype/drone-assembly/src");

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? jsFiles(full) : full.endsWith(".js") ? [full] : [];
  });
}

describe("assembly markup", () => {
  const markup = assemblyMarkup();

  it("contains every element id the front end looks up with getElementById", () => {
    const ids = new Set<string>();
    for (const file of jsFiles(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) ids.add(m[1]);
    }
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) expect(markup, `#${id}`).toMatch(new RegExp(`id="${id}"`));
  });

  it("drops the prototype's own script tag (the page starts main.js itself)", () => {
    expect(markup).not.toMatch(/<script/i);
    expect(extractBodyMarkup('<html><body class="x"><p>hi</p><script src="a.js"></script></body></html>')).toBe("<p>hi</p>");
  });
});
