#!/usr/bin/env node
// Tells the simulation UI where the DroneX configurator is: writes
//   <script>window.DRONEX_RENDER_URL='https://dronex.example.com'</script>
// into interface/<version>/index.html, right before the dronex-tracks.js line (patch-interface-tracks.mjs adds
// that line; run it first). Without it, dronex-tracks.js falls back to http://localhost:3000.
//
// The line carries its own marker, so this is separate from patch-interface-tracks.mjs (which skips index.html
// once dronex-tracks.js is in it). Running it again with the same URL is a no-op; with another URL it replaces the
// line. `git checkout -- interface/` undoes it.
//
//   node scripts/set-render-url.mjs https://dronex.example.com

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARK = "<!-- dronex-render-url (scripts/set-render-url.mjs) -->";
const TRACKS = '<script defer src="/dronex-tracks.js"></script>';

const arg = process.argv[2];
if (!arg || process.argv.length > 3) {
  console.error("usage: node scripts/set-render-url.mjs <configurator-url>");
  process.exit(2);
}
let url;
try {
  url = new URL(arg);
} catch {
  console.error(`set-render-url: not a URL: ${arg}`);
  process.exit(2);
}
const value = arg.replace(/\/+$/, "");
// The value goes inside a single-quoted JS string in HTML: allow only plain URL characters.
if (!/^https?:$/.test(url.protocol) || !/^[A-Za-z0-9:/._~%-]+$/.test(value)) {
  console.error(`set-render-url: expected a plain http(s) URL: ${arg}`);
  process.exit(2);
}

const root = new URL("../interface/", import.meta.url).pathname;
const index = join(root, readFileSync(join(root, "current"), "utf8").trim(), "index.html");
const html = readFileSync(index, "utf8");
const line = `${MARK}<script>window.DRONEX_RENDER_URL='${value}'</script>`;

const lines = html.split("\n");
const at = lines.findIndex((l) => l.includes(MARK));
let next;
if (at >= 0) {
  const indent = lines[at].match(/^\s*/)[0];
  if (lines[at] === indent + line) {
    console.log(`index.html: DRONEX_RENDER_URL already ${value}`);
    process.exit(0);
  }
  lines[at] = indent + line;
  next = lines.join("\n");
} else {
  const t = lines.findIndex((l) => l.includes(TRACKS));
  if (t < 0) {
    console.error("set-render-url: index.html has no dronex-tracks.js line; run scripts/patch-interface-tracks.mjs first");
    process.exit(1);
  }
  const indent = lines[t].match(/^\s*/)[0];
  lines.splice(t, 0, indent + line);
  next = lines.join("\n");
}
writeFileSync(index, next);

const check = readFileSync(index, "utf8");
const marks = check.split(MARK).length - 1;
if (marks !== 1 || check.indexOf(MARK) > check.indexOf(TRACKS)) {
  console.error(`set-render-url: index.html check failed (${marks} marker lines)`);
  process.exit(1);
}
console.log(`index.html: DRONEX_RENDER_URL = ${value}`);
