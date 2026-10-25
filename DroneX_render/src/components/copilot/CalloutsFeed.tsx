"use client";
// The callouts as they arrive from the events stream: warnings first in colour, each with a replay button so a
// judge can hear one on demand. Derived in code from telemetry (src/lib/copilot/callouts.ts), never by a model.
import type { Callout } from "@/lib/copilot/types";

const time = (us: number) => new Date(us / 1000).toLocaleTimeString(undefined, { hour12: false });

export default function CalloutsFeed({ callouts, onSpeak, canSpeak }: { callouts: Callout[]; onSpeak: (c: Callout) => void; canSpeak: boolean }) {
  return (
    <section aria-label="Callouts" aria-live="polite" style={{ overflow: "auto", padding: "10px 14px" }}>
      <h3 style={{ margin: "0 0 8px", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "#9aa3b2" }}>Callouts</h3>
      {callouts.length === 0 && <p style={{ color: "#9aa3b2", margin: 0 }}>Waiting for the vehicle. Callouts: battery at 50, 30, 20 and 10 percent; altitude bands; mode, arming, GPS, navigation, home, mission legs; the building guard.</p>}
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
        {callouts.map((c) => (
          <li key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderRadius: 6, background: c.priority === "warning" ? "#2a1f12" : "#11141c", border: `1px solid ${c.priority === "warning" ? "#ff8a3d" : "#1c2130"}` }}>
            <span style={{ color: "#9aa3b2", fontSize: 11, minWidth: 58 }}>{time(c.timeUs)}</span>
            <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6, color: c.priority === "warning" ? "#ff8a3d" : "#9aa3b2", minWidth: 52 }}>{c.priority}</span>
            <span style={{ flex: 1 }}>{c.text}</span>
            <button type="button" onClick={() => onSpeak(c)} disabled={!canSpeak} title={canSpeak ? "Say it again" : "Needs the Cartesia key"} style={{ background: "transparent", border: "1px solid #2a3142", color: "#e6e9ef", borderRadius: 6, padding: "2px 6px", fontSize: 11, cursor: canSpeak ? "pointer" : "default" }}>
              ▶
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
