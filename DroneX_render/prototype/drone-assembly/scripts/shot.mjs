// Screenshots of the running demo, for looking at a change rather than guessing at it.
// It is scripts/smoke.mjs cut down to its two useful halves — serve a frozen snapshot of the repo with the
// repo's own Vite, and drive a real headless Chrome over the DevTools protocol — with no assertions, so it
// works on a page that is still being built.
//
// Run:  node scripts/shot.mjs "?build=apex-5-freestyle-quad" /tmp/drone/quad --steps=build,wait:2500,shot,explode,wait:3500,shot
//       node scripts/shot.mjs "?build=eclipson-model-a-scout" /tmp/drone/wing
//
// By default it serves a frozen snapshot of this folder with the repo's own Vite, which needs
// prototype/drone-assembly/node_modules (the prototype's own install). Without that, point it at a server
// that is already running — which is also how to shoot the real app rather than the standalone prototype:
//       npm run dev            (in the repo root, serves the Next app on :3000)
//       node scripts/shot.mjs "?build=apex-5-freestyle-quad" /tmp/quad --url=http://localhost:3000/
//
// Steps, comma separated, run in order. Every one takes a screenshot named after its index and the step.
//   wait:<ms>        just wait
//   shot             screenshot now
//   build            click "Build all"
//   launch           click the Take off button (Build all becomes Take off once the drone is complete)
//   explode          click "Explode" (or "Assemble")
//   key:<k>          send that key to the page
//   click:<selector> click the first element matching it
//   part:<n>         click the nth part of the vehicle, by hit-testing the canvas centre outward
//   js:<expr>        evaluate an expression in the page (its result is printed)
//   fill:<selector>=<text>   set an input's / textarea's value (no commas in the text: steps split on them)
//   submit:<selector>        requestSubmit() the matching form
//   storage:<key>=<base64 text>   localStorage.setItem(key, atob(text)) (base64, so the value may hold commas)
//   reload           reload the page (localStorage survives, so saved designs can be checked)
// Default steps: wait:2500,shot,build,wait:9000,shot
//
// Console errors, warnings and uncaught exceptions are printed at the end: that is usually the answer.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
// Split each flag at its FIRST "=" only: a --steps or --js value is code and carries its own "=" signs.
const flags = Object.fromEntries(
  args
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const body = a.slice(2);
      const i = body.indexOf("=");
      return i < 0 ? [body, true] : [body.slice(0, i), body.slice(i + 1)];
    }),
);
const positional = args.filter((a) => !a.startsWith("--"));
const [query = "", prefixArg = "/tmp/shot/out"] = positional;
const prefix = resolve(prefixArg);
mkdirSync(dirname(prefix), { recursive: true });
const [W, H] = (flags.size ?? "1600x900").split("x").map(Number);
// Steps are comma separated, except a "js:" step, which is code and swallows the rest of the line.
function parseSteps(text) {
  const out = [];
  let rest = text;
  while (rest.length) {
    if (rest.startsWith("js:")) {
      out.push(rest);
      break;
    }
    const i = rest.indexOf(",");
    if (i < 0) {
      out.push(rest);
      break;
    }
    out.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  return out.filter(Boolean);
}
const STEPS = parseSteps(flags.steps ?? "wait:2500,shot,build,wait:9000,shot");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDirs = [];
let server = null;

// ---------- a frozen snapshot, served by the repo's Vite ----------
async function serveSnapshot() {
  const dir = mkdtempSync(join(tmpdir(), "shot-snap-"));
  tmpDirs.push(dir);
  for (const f of ["index.html", "vite.config.js", "package.json"]) if (existsSync(join(repo, f))) cpSync(join(repo, f), join(dir, f));
  cpSync(join(repo, "src"), join(dir, "src"), { recursive: true });
  if (existsSync(join(repo, "public"))) cpSync(join(repo, "public"), join(dir, "public"), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(
    join(dir, "vite.shot.config.mjs"),
    `import base from "./vite.config.js";\nexport default { ...base, cacheDir: ${JSON.stringify(join(dir, ".vite-cache"))}, clearScreen: false, server: { ...(base.server ?? {}), hmr: false } };\n`,
  );
  const port = await new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
  const vite = join(repo, "node_modules", "vite", "bin", "vite.js");
  server = spawn(process.execPath, [vite, "--config", "vite.shot.config.mjs", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base)).ok) return base;
    } catch {}
    await sleep(100);
  }
  throw new Error(`snapshot server did not start:\n${log}`);
}

const base = flags.url
  ? flags.url
  : await serveSnapshot().catch((e) => {
      console.error(`harness error: ${e.message}\n(no prototype node_modules? run the app with "npm run dev" in the repo root and pass --url=http://localhost:3000/)`);
      process.exit(2);
    });
const url = new URL(query || "", base).href;

// ---------- Chrome ----------
const CHROME =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(
    existsSync,
  );
if (!CHROME) {
  console.error("Chrome not found; set CHROME=/path/to/chrome");
  process.exit(2);
}
const profile = mkdtempSync(join(tmpdir(), "shot-chrome-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--use-angle=${flags.angle ?? (process.platform === "darwin" ? "metal" : "default")}`,
    "--enable-unsafe-swiftshader",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);
function cleanup() {
  for (const p of [chrome, server]) {
    try {
      p?.kill();
    } catch {}
  }
  for (const d of [profile, ...tmpDirs]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

async function connect() {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 120 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new Error("Chrome did not start");
  const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
  let targets = [];
  for (let i = 0; i < 60 && !targets.some((t) => t.type === "page"); i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {}
    if (!targets.some((t) => t.type === "page")) await sleep(150);
  }
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  return ws;
}

const ws = await connect().catch((e) => {
  console.error("harness error:", e.message);
  process.exit(2);
});
let nextId = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled" && /error|warning/.test(msg.params.type)) {
    logs.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ")}`);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    logs.push(`EXCEPTION: ${d.exception?.description ?? d.text}`);
  }
  if (msg.method === "Log.entryAdded" && /error/.test(msg.params.entry.level)) logs.push(`log: ${msg.params.entry.text}`);
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`${method} timed out`))), 60000);
  });

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};

let shotIndex = 0;
async function shot(label) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const file = `${prefix}-${String(shotIndex++).padStart(2, "0")}-${label}.png`;
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`shot  ${file}`);
}

// Click a button by its visible text, which is how the demo's bar is written.
const clickByText = (text) => `(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim().toLowerCase().startsWith(${JSON.stringify(text.toLowerCase())}));
  if (!b) return "no button: ${text}";
  b.click();
  return "clicked " + b.textContent.trim();
})()`;

// Find a part of the vehicle: walk out from the canvas centre until the cursor turns into a pointer, which
// is how the demo marks something selectable, and return that point; the click itself is a real mouse click
// sent over the protocol (a synthetic pointerdown has no live pointer, and OrbitControls' setPointerCapture
// throws on it). n skips the first n selectable points found.
const findPart = (n) => `(async () => {
  const cv = document.querySelector("canvas");
  const r = cv.getBoundingClientRect();
  // ui/select.js throttles hover (a timeout, then a frame) before it sets the cursor, so wait for it.
  const hit = async (x, y) => {
    cv.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
    await new Promise((res) => setTimeout(res, 180));
    return getComputedStyle(cv).cursor === "pointer";
  };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let seen = 0;
  for (let ring = 0; ring < 20; ring++) {
    const m = ring === 0 ? 1 : 8;
    for (let a = 0; a < m; a++) {
      const t = ((a + (ring % 2) * 0.5) / m) * 2 * Math.PI;
      const x = cx + Math.cos(t) * ring * 20;
      const y = cy + Math.sin(t) * ring * 20;
      if (await hit(x, y)) { if (seen++ < ${n}) continue; return [x, y]; }
    }
  }
  return null;
})()`;

async function clickPart(n) {
  const at = await evaluate(findPart(n));
  if (!at) return "nothing selectable found";
  const [x, y] = at;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return "clicked part at " + at.map(Math.round).join(",");
}

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.navigate", { url });
  await sleep(500);
  console.log(`url   ${url}`);

  for (const step of STEPS) {
    const [name, arg] = step.split(/:(.+)/);
    if (name === "wait") await sleep(Number(arg) || 500);
    else if (name === "shot") await shot("shot");
    else if (name === "build") console.log("step  " + (await evaluate(clickByText("Build all"))));
    else if (name === "launch") {
      console.log("step  " + (await evaluate(clickByText("Take off"))));
    }
    else if (name === "explode") console.log("step  " + (await evaluate(clickByText("Explode"))));
    else if (name === "assemble") console.log("step  " + (await evaluate(clickByText("Assemble"))));
    else if (name === "part") console.log("step  " + (await clickPart(Number(arg) || 0)));
    else if (name === "click") console.log("step  " + (await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(arg)}); if (!e) return "no match"; e.click(); return "clicked"; })()`)));
    else if (name === "fill") {
      const i = arg.indexOf("=");
      const sel = arg.slice(0, i);
      const text = arg.slice(i + 1);
      console.log("step  " + (await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return "no match"; e.value = ${JSON.stringify(text)}; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return "filled"; })()`)));
    } else if (name === "submit") console.log("step  " + (await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(arg)}); if (!e) return "no match"; e.requestSubmit(); return "submitted"; })()`)));
    else if (name === "storage") {
      const i = arg.indexOf("=");
      console.log("step  " + (await evaluate(`(() => { localStorage.setItem(${JSON.stringify(arg.slice(0, i))}, atob(${JSON.stringify(arg.slice(i + 1))})); return "stored"; })()`)));
    } else if (name === "reload") {
      await send("Page.reload");
      await sleep(500);
      console.log("step  reload");
    } else if (name === "key") {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: arg, ...(arg.length === 1 ? { text: arg } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: arg });
      console.log(`step  key ${arg}`);
    } else if (name === "js") console.log("step  js -> " + JSON.stringify(await evaluate(arg)));
    else console.log(`step  unknown "${step}"`);
  }
  await shot("final");
  const hud = await evaluate(`document.getElementById("hud")?.innerText ?? ""`).catch(() => "");
  if (hud) console.log(`hud   ${hud.replace(/\s+/g, " ").trim().slice(0, 300)}`);
} catch (e) {
  console.error("error:", e.message);
  logs.push(`harness: ${e.message}`);
} finally {
  if (logs.length) {
    console.log(`\n--- ${logs.length} console problem(s) ---`);
    for (const l of [...new Set(logs)].slice(0, 25)) console.log(l);
  } else console.log("\nno console errors");
  const bad = logs.some((l) => /EXCEPTION|console.error|^log:/.test(l));
  await sleep(200);
  process.exit(bad ? 1 : 0);
}
