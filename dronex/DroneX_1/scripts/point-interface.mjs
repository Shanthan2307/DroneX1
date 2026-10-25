#!/usr/bin/env node
// Points the interface's built-in account server address at our backend, so the page's own requests (map keys,
// places, feedback) reach it. The committed bundle has `http://localhost:45103` compiled in (shell-*.js,
// daemon.worker-*.js); older bundles had `https://api.uxduck.com`. Serve the result with --ui-dir, which does not
// check the manifest's file hashes.
//
// Every file of the current interface version is rewritten from each --from address (default: both of the
// above) to the target, then checked: the script fails if any --from address is still in the bundle. Running it
// again is a no-op. To repoint a bundle that already points somewhere else, pass that address as --from, or
// restore the files first: git checkout -- interface/
//
// In production (deploy/deploy.sh) the target is https://sim.DOMAIN: Caddy routes /v1/maps/* and /v1/places* on
// that host to the backend, so the calls are same-origin.
//
// Core serves assets as immutable, so a browser that loaded the original files at the same address keeps them;
// open the app at another origin (localhost instead of 127.0.0.1) or clear that browser's cache.
//
//   node scripts/point-interface.mjs [--from URL]... [target]     default target http://localhost:45103
//   node scripts/point-interface.mjs --from http://localhost:45103 https://sim.example.com

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const DEFAULT_FROM = ["http://localhost:45103", "https://api.uxduck.com"];
const TEXT = /\.(js|mjs|html|css|json|webmanifest|txt|svg)$/;

function usage(message) {
  if (message) console.error(`point-interface: ${message}`);
  console.error("usage: node scripts/point-interface.mjs [--from URL]... [target]");
  process.exit(2);
}

const origin = (value, what) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    usage(`${what} is not a URL: ${value}`);
  }
  if (!/^https?:$/.test(url.protocol) || url.pathname.replace(/\/+$/, "") || url.search || url.hash)
    usage(`${what} must be a bare http(s) origin like https://sim.example.com: ${value}`);
  return value.replace(/\/+$/, "");
};

const froms = [];
let target;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--from") froms.push(origin(args[++i] ?? usage("--from needs a value"), "--from"));
  else if (a.startsWith("--from=")) froms.push(origin(a.slice(7), "--from"));
  else if (a === "-h" || a === "--help") usage();
  else if (a.startsWith("-")) usage(`unknown option ${a}`);
  else if (target === undefined) target = origin(a, "target");
  else usage("more than one target");
}
target ??= "http://localhost:45103";
const sources = (froms.length ? froms : DEFAULT_FROM).filter((f) => f !== target);

const root = new URL("../interface/", import.meta.url).pathname;
const ui = join(root, readFileSync(join(root, "current"), "utf8").trim());

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (TEXT.test(name)) yield path;
  }
}

// A source address ends where the origin ends: `http://localhost:45103` but not `http://localhost:451030`, and not
// `https://api.uxduck.com.evil`. A path after it (`.../v1/maps`) is part of the same base and is rewritten too.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = (from) => new RegExp(`${escape(from)}(?![0-9A-Za-z.:-])`, "g");

let changed = 0;
let targetSeen = 0;
for (const path of files(ui)) {
  const text = readFileSync(path, "utf8");
  let next = text;
  for (const from of sources) next = next.replace(pattern(from), target);
  if (next.includes(target)) targetSeen++;
  if (next === text) continue;
  writeFileSync(path, next);
  changed++;
  console.log(`${relative(root, path)}: account server -> ${target}`);
}

const left = [];
for (const path of files(ui)) {
  const text = readFileSync(path, "utf8");
  for (const from of sources) if (pattern(from).test(text)) left.push(`${relative(root, path)} (${from})`);
}
if (left.length) {
  console.error(`point-interface: old address still in the bundle:\n  ${left.join("\n  ")}`);
  process.exit(1);
}
if (changed === 0) {
  if (targetSeen === 0)
    console.log(`nothing to change: none of ${sources.join(", ") || "(no sources)"} is in the bundle, and neither is ${target}; pass the current address with --from`);
  else console.log(`nothing to change: already pointed at ${target}`);
}
