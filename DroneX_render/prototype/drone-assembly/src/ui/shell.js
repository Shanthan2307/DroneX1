// The page shell, made robust: the configurator runs inside a host page (the Next app's AssemblyStage, or
// index.html in dev) whose markup may lag behind it. ensureShell() finds every element the demo uses,
// creates whatever is missing in the expected place, rewrites the hint line from KEYS so it always lists the
// current keys, and returns the elements. Nothing else in the demo looks elements up by id.
//   ensureShell() -> { canvas, brand, hint, detail, hud, hudText, bar, btnVehicles, vehiclesEl, btnTest, btnFly, nowEl,
//                      btnBuildAll, btnExplode, btnReset }

// The shortcut legend under the title (a compact grid): [key(s), what it does].
const KEYS = [
  [["Space"], "explode"],
  [["B"], "build"],
  [["L"], "take off"],
  [["R"], "reset"],
  [["[", "]"], "vehicle"],
  [["X"], "opacity"],
  [["N"], "day/night"],
  [["W"], "weather"],
  [["Esc"], "close"],
];

// The DroneX lockup, light variant (white text): it sits over the 3D scene. new URL(..., import.meta.url) so
// Vite and Next/Turbopack both bundle the file.
const LOGO_URL = new URL("../assets/brand/dronex-logo-light.png", import.meta.url).href;

function make(tag, { id, className, attrs = {}, text } = {}) {
  const el = document.createElement(tag);
  if (id) el.id = id;
  if (className) el.className = className;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

export function ensureShell() {
  const body = document.body;
  const canvas = document.getElementById("scene") ?? body.insertBefore(make("canvas", { id: "scene", attrs: { "aria-label": "3D drone assembly" } }), body.firstChild);

  let brand = document.querySelector("header.brand");
  if (!brand) {
    brand = make("header", { className: "brand" });
    canvas.after(brand);
  }
  // The DroneX logo, top-left (style.css .brand-logo).
  const title = brand.querySelector("h1") ?? brand.insertBefore(make("h1"), brand.firstChild);
  title.replaceChildren(make("img", { className: "brand-logo", attrs: { src: LOGO_URL, alt: "DroneX" } }));
  document.title = "DroneX";
  const hint = brand.querySelector("p") ?? brand.appendChild(make("p"));
  hint.className = "keys";
  hint.replaceChildren(
    ...KEYS.map(([keys, label]) => {
      const item = make("span");
      item.append(...keys.flatMap((k, i) => [i ? " " : "", make("kbd", { text: k })]), ` ${label}`);
      return item;
    }),
  );

  let detail = document.getElementById("detail");
  if (!detail) {
    detail = make("aside", { id: "detail", className: "detail", attrs: { "aria-live": "polite" } });
    brand.after(detail);
  }

  let hud = document.getElementById("hud");
  if (!hud) {
    hud = make("div", { id: "hud", className: "hud" });
    detail.after(hud);
  }
  const hudText = document.getElementById("hud-text") ?? hud.appendChild(make("span", { id: "hud-text", text: "Pad ready" }));

  let bar = document.querySelector("footer.bar");
  if (!bar) {
    bar = make("footer", { className: "bar" });
    body.appendChild(bar);
  }
  const button = (id, label, className, attrs) => document.getElementById(id) ?? make("button", { id, className, text: label, attrs: { type: "button", ...attrs } });
  const btnBuildAll = button("btn-build-all", "Build all");
  const btnExplode = button("btn-explode", "Explode", undefined, { disabled: "" });
  const btnReset = button("btn-reset", "Reset", "quiet");
  for (const b of [btnBuildAll, btnExplode, btnReset]) if (!b.isConnected) bar.appendChild(b);
  // The Hangar (the drone library) keeps the old Vehicles ids, so an older host page still finds its button.
  const btnVehicles = button("btn-vehicles", "Hangar", "quiet", { "aria-expanded": "false", "aria-controls": "vehicles" });
  btnVehicles.textContent = "Hangar";
  if (!btnVehicles.isConnected) bar.insertBefore(btnVehicles, btnBuildAll);
  let vehiclesEl = document.getElementById("vehicles");
  if (!vehiclesEl) {
    vehiclesEl = make("div", { id: "vehicles", className: "vehicles" });
    vehiclesEl.hidden = true;
    btnVehicles.after(vehiclesEl);
  }
  vehiclesEl.setAttribute("role", "dialog");
  vehiclesEl.setAttribute("aria-label", "Hangar");
  const btnTest = button("btn-test", "Test", "quiet", { "aria-controls": "vehicles" });
  if (!btnTest.isConnected) bar.insertBefore(btnTest, btnExplode);
  // Fly in simulation: sends the built drone to the simulation engine and goes there (main.js flyInSim).
  const btnFly = button("btn-fly", "Fly in simulation", "quiet", { disabled: "" });
  if (!btnFly.isConnected) bar.insertBefore(btnFly, btnExplode);
  // The current-drone chip: name, type, About, Save (ui/hangar.js fills it).
  const nowEl = document.getElementById("dx-now") ?? body.appendChild(make("div", { id: "dx-now", className: "dx-now", attrs: { "aria-label": "Current drone" } }));

  return { canvas, brand, hint, detail, hud, hudText, bar, btnVehicles, vehiclesEl, btnTest, btnFly, nowEl, btnBuildAll, btnExplode, btnReset };
}
