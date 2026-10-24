#!/usr/bin/env node
// Teaches the interface's 3D map to draw a vehicle from a DroneX model: a vehicle whose bookmarks hold one named
// "DroneX model" is drawn from that bookmark's URL (a glTF binary served by the DroneX configurator), with the
// query saying how: base=<multicopter|plane|vtol> (which motor outputs spin what), span=<metres across>,
// rotors=<ccw flags, e.g. 0011, one per Propeller1..N node>, spinner=<node turned by the throttle>.
//
// Two files change: the model table (models-*.js) gains the lookup, and the map's motion code (MapView-*.js)
// reads the base type out of the DroneX model key. Idempotent; restore with `git checkout -- interface/`.
// The interface is served as immutable, so hard-reload the simulation page once after patching.
//
//   node scripts/patch-interface-dronex.mjs

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../interface/", import.meta.url).pathname;
const assets = join(root, readFileSync(join(root, "current"), "utf8").trim(), "assets");
const file = (prefix) => {
  const names = readdirSync(assets).filter((n) => n.startsWith(prefix) && n.endsWith(".js"));
  if (names.length !== 1) throw new Error(`expected one ${prefix}*.js, found ${names.length}`);
  return join(assets, names[0]);
};

const MARK = "dronexModel";

function patch(path, edits) {
  let text = readFileSync(path, "utf8");
  if (text.includes(MARK)) {
    console.log(`${path.split("/").pop()}: already patched`);
    return;
  }
  for (const [from, to] of edits) {
    const n = text.split(from).length - 1;
    if (n !== 1) throw new Error(`${path}: expected exactly one match for ${JSON.stringify(from.slice(0, 60))}, found ${n}`);
    text = text.replace(from, to);
  }
  writeFileSync(path, text);
  console.log(`${path.split("/").pop()}: patched`);
}

// models: the lookup. The table `u` is the module's live export, so a new entry is seen by every importer.
const lookup =
  "var dronexModels=new Map;" +
  "function dronexModel(e){let b=e?.bookmarks?.find(b=>b?.name===`DroneX model`);if(!b)return;" +
  "let k=dronexModels.get(b.url);if(k)return k;let url;try{url=new URL(b.url)}catch{return}" +
  "let q=url.searchParams,base=q.get(`base`)||`multicopter`,span=Number(q.get(`span`)),bits=q.get(`rotors`)||``,spinner=q.get(`spinner`)||void 0;" +
  "if(!(span>0))return;k=`${base}@${b.url}`;" +
  "u[k]={url:b.url,spanM:span,unitsAcross:span,...bits.length?{rotors:[...bits].map((c,i)=>({node:`Propeller${i+1}`,ccw:c===`1`}))}:{},...spinner?{spinner}:{}};" +
  "dronexModels.set(b.url,k);return k}";

patch(file("models-"), [
  ["function p(e,t,n){let r=m(e.vehicleType);", `${lookup}function p(e,t,n){let dx=dronexModel(e);if(dx)return dx;let r=m(e.vehicleType);`],
]);

// MapView: motion (which servo outputs drive which propellers) goes by the base type before the `@`.
patch(file("MapView-"), [
  [
    "o=Xn(e,Zn(t)),s=e===`multicopter`?o.motors.reduce",
    "o=Xn(e.split(`@`)[0],Zn(t)),s=e.split(`@`)[0]===`multicopter`?o.motors.reduce/*dronexModel*/",
  ],
]);
