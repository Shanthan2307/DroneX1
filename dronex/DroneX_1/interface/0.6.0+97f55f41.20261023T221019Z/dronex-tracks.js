// The "Built with" badge on the simulation UI: chips for the sponsor technologies, each opening a panel that says
// what the technology does here and in which file. The list comes from the configurator's /api/tracks (the
// registry in DroneX_render/src/lib/tracks.ts) so both screens agree; if the configurator is not running, the
// badge stays hidden. Plain DOM, no framework, nothing of the UI's own is touched.
(function () {
  var RENDER = window.DRONEX_RENDER_URL || "http://localhost:3000";
  var SURFACE = "simulator";

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render(tracks) {
    if (document.querySelector(".dx-tracks")) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/dronex-tracks.css";
    document.head.appendChild(link);

    var host = el("aside", "dx-tracks");
    host.setAttribute("aria-label", "Built with");
    var rail = el("nav", "dx-tracks__rail");
    rail.appendChild(el("span", "dx-tracks__label", "Built with"));
    var panelSlot = el("div");
    var open = null;

    function show(t) {
      panelSlot.innerHTML = "";
      rail.querySelectorAll(".dx-tracks__chip").forEach(function (c) { c.setAttribute("aria-expanded", c.dataset.id === (t && t.id) ? "true" : "false"); });
      open = t ? t.id : null;
      if (!t) return;
      var panel = el("section", "dx-tracks__panel");
      panel.style.setProperty("--dx-c", t.color);
      panel.setAttribute("role", "dialog");
      var h = el("h3", null, t.name);
      var a = el("a", null, "docs");
      a.href = t.docs; a.target = "_blank"; a.rel = "noreferrer";
      h.appendChild(a);
      panel.appendChild(h);
      panel.appendChild(el("p", "dx-tracks__product", t.product));
      panel.appendChild(el("p", null, t.role));
      var ul = el("ul");
      t.uses.forEach(function (u) {
        var li = el("li", u.surface === SURFACE || u.surface === "live" || u.surface === "agents" ? "" : "dx-tracks__off");
        li.appendChild(el("span", "dx-tracks__surface", u.surface));
        li.appendChild(el("div", null, u.what));
        li.appendChild(el("code", "dx-tracks__where", u.where));
        ul.appendChild(li);
      });
      panel.appendChild(ul);
      panelSlot.appendChild(panel);
    }

    tracks.forEach(function (t) {
      var chip = el("button", "dx-tracks__chip", t.chip);
      chip.type = "button";
      chip.dataset.id = t.id;
      chip.title = t.name + ": " + t.role;
      chip.style.setProperty("--dx-c", t.color);
      chip.setAttribute("aria-expanded", "false");
      chip.addEventListener("click", function () { show(open === t.id ? null : t); });
      rail.appendChild(chip);
    });
    host.appendChild(rail);
    host.appendChild(panelSlot);
    document.body.appendChild(host);
  }

  function load() {
    fetch(RENDER + "/api/tracks", { mode: "cors" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.tracks && j.tracks.length) render(j.tracks); })
      .catch(function () { /* the configurator is not running: no badge */ });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
