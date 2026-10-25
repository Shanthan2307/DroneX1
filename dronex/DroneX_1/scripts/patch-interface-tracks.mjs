#!/usr/bin/env node
// Adds the "Built with" badge to the simulation UI: a rail of sponsor-technology chips on the right edge; a chip
// opens a panel saying what that technology does on this screen and in which file. The list is the configurator's
// registry (DroneX_render/src/lib/tracks.ts) fetched from its /api/tracks, so both screens always agree.
//
// Two files are copied beside index.html (the daemon serves anything in the interface folder, like the theme
// stylesheet) and one <script> line is added to index.html. Idempotent; `git checkout -- interface/` undoes it.
//
//   node scripts/patch-interface-tracks.mjs
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../interface/", import.meta.url).pathname;
const ui = join(root, readFileSync(join(root, "current"), "utf8").trim());
const src = new URL("./interface-tracks/", import.meta.url).pathname;

for (const name of ["dronex-tracks.js", "dronex-tracks.css"]) copyFileSync(join(src, name), join(ui, name));

const index = join(ui, "index.html");
let html = readFileSync(index, "utf8");
const MARK = "dronex-tracks.js";
if (html.includes(MARK)) {
  console.log("index.html: already patched");
} else {
  const line = `    <!-- Built with: the sponsor-technology badge (scripts/patch-interface-tracks.mjs); remove this line and the two files to undo. -->\n    <script defer src="/dronex-tracks.js"></script>\n`;
  const at = html.lastIndexOf("</body>");
  if (at < 0) throw new Error("index.html has no </body>");
  html = html.slice(0, at) + line + html.slice(at);
  writeFileSync(index, html);
  console.log("index.html: patched");
}
console.log("copied dronex-tracks.js and dronex-tracks.css");
