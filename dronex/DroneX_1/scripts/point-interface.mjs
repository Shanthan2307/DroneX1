#!/usr/bin/env node
// Points the interface's built-in account server address (`https://api.uxduck.com`,
// compiled into the bundle) at our backend, so the page's own requests (map keys,
// places, feedback) reach it. Serve the result with --ui-dir, which does not
// check the manifest's file hashes. To change the address again, restore the
// files first: git checkout -- interface/
//
// Core serves assets as immutable, so a browser that loaded the original files
// at the same address keeps them; open the app at another origin (localhost
// instead of 127.0.0.1) or clear that browser's cache.
//
//   node scripts/point-interface.mjs [api-url]     default http://localhost:45103

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ORIGINAL = "`https://api.uxduck.com`";
const root = new URL("../interface/", import.meta.url).pathname;
const assets = join(root, readFileSync(join(root, "current"), "utf8").trim(), "assets");
const target = (process.argv[2] ?? "http://localhost:45103").replace(/\/+$/, "");

let changed = 0;
for (const name of readdirSync(assets).filter((n) => n.endsWith(".js"))) {
  const path = join(assets, name);
  const text = readFileSync(path, "utf8");
  if (!text.includes(ORIGINAL)) continue;
  writeFileSync(path, text.replaceAll(ORIGINAL, `\`${target}\``));
  changed++;
  console.log(`${name}: account server -> ${target}`);
}
if (changed === 0) console.log("nothing to change: already pointed elsewhere");
