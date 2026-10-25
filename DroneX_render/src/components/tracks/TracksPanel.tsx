"use client";
// The "Built with" sidebar: one chip per sponsor technology on the left edge; a chip opens a panel that says, for
// this screen, exactly what the technology does and which file does it. Data: src/lib/tracks.ts. Shown on the
// configurator and the Copilot page; the simulation UI gets the same list through /api/tracks.
import { useState } from "react";
import { TRACKS, type Surface, type Track } from "@/lib/tracks";

export default function TracksPanel({ surface }: { surface: Surface }) {
  const [open, setOpen] = useState<Track["id"] | null>(null);
  const shown = TRACKS.filter((t) => t.uses.some((u) => u.surface === surface || u.surface === "live" || u.surface === "agents"));
  const current = shown.find((t) => t.id === open) ?? null;

  return (
    <aside
      aria-label="Built with"
      style={{ position: "fixed", left: 12, top: "50%", transform: "translateY(-50%)", zIndex: 40, display: "flex", gap: 10, alignItems: "flex-start", pointerEvents: "none" }}
    >
      <nav style={{ display: "flex", flexDirection: "column", gap: 8, pointerEvents: "auto" }}>
        <span style={{ fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", color: "#9aa3b2", textAlign: "center" }}>Built with</span>
        {shown.map((t) => {
          const active = t.id === open;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setOpen(active ? null : t.id)}
              aria-expanded={active}
              title={`${t.name}: ${t.role}`}
              style={{
                border: `1px solid ${t.color}`,
                background: active ? t.color : "rgba(10,12,18,0.72)",
                color: active ? "#0b0d12" : t.color,
                borderRadius: 999,
                padding: "6px 10px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                backdropFilter: "blur(6px)",
                whiteSpace: "nowrap",
              }}
            >
              {t.chip}
            </button>
          );
        })}
      </nav>
      {current && (
        <section
          role="dialog"
          aria-label={`${current.name} in DroneX`}
          style={{
            pointerEvents: "auto",
            width: 360,
            maxHeight: "70vh",
            overflow: "auto",
            background: "rgba(10,12,18,0.92)",
            border: `1px solid ${current.color}`,
            borderRadius: 12,
            padding: 14,
            color: "#e6e9ef",
            fontSize: 13,
            lineHeight: 1.45,
            backdropFilter: "blur(8px)",
          }}
        >
          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <strong style={{ color: current.color, fontSize: 15 }}>{current.name}</strong>
            <a href={current.docs} target="_blank" rel="noreferrer" style={{ color: "#9aa3b2", fontSize: 12 }}>
              docs
            </a>
          </header>
          <p style={{ margin: "6px 0 2px", color: "#9aa3b2" }}>{current.product}</p>
          <p style={{ margin: "8px 0" }}>{current.role}</p>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {current.uses.map((u) => (
              <li key={u.where} style={{ marginBottom: 8, opacity: u.surface === surface || u.surface === "live" || u.surface === "agents" ? 1 : 0.6 }}>
                <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: current.color }}>{u.surface}</span>
                <div>{u.what}</div>
                <code style={{ fontSize: 11, color: "#9aa3b2" }}>{u.where}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
