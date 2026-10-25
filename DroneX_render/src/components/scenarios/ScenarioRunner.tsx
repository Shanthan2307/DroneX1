"use client";
// The track scenarios: one card per sponsor technology with the story, why it matters to the people who build
// that technology, what to watch, and a Run button that streams the run (POST /api/scenarios/<id>). For the
// Cartesia scenario the page also plays the voice: each spoken line through Sonic (the speak route) and the
// copilot's callouts for that drone as they fire (/api/copilot/events).
import { useCallback, useEffect, useRef, useState } from "react";
import type { Scenario } from "@/lib/scenarios/catalog";
import type { ScenarioEvent } from "@/lib/scenarios/run";
import { TRACKS } from "@/lib/tracks";

type Logged = ScenarioEvent & { at: number };

const C = { dim: "#9aa3b2", line: "#1c2130", card: "#11151d", ok: "#3ecf8e", warn: "#f5a524", fail: "#f04d5d", text: "#e6e9ef" };
const colorOf = (track: string): string => TRACKS.find((t) => t.id === track)?.color ?? "#888";

const KIND_STYLE: Record<ScenarioEvent["kind"], { mark: string; color: string }> = {
  step: { mark: "·", color: C.dim },
  ok: { mark: "✓", color: C.ok },
  warn: { mark: "!", color: C.warn },
  fail: { mark: "✗", color: C.fail },
  say: { mark: "🔊", color: C.text },
  heard: { mark: "👂", color: "#9ecbff" },
  chat: { mark: "◀", color: C.text },
  report: { mark: "▸", color: "#d6c6ff" },
  link: { mark: "→", color: C.dim },
  vehicle: { mark: "✈", color: C.text },
  done: { mark: "■", color: C.dim },
};

/** Plays lines one after another through the speak route (Cartesia Sonic, WAV). */
function useSpeech() {
  const queue = useRef<string[]>([]);
  const busy = useRef(false);
  const [on, setOn] = useState(true);
  const onRef = useRef(on);
  useEffect(() => {
    onRef.current = on;
  }, [on]);
  const pump = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    while (queue.current.length) {
      const text = queue.current.shift() as string;
      if (!onRef.current) continue;
      try {
        const audio = new Audio(`/api/copilot/speak?text=${encodeURIComponent(text)}`);
        await new Promise<void>((resolve) => {
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
          void audio.play().catch(() => resolve());
        });
      } catch {
        // a line that cannot play is skipped
      }
    }
    busy.current = false;
  }, []);
  const say = useCallback(
    (text: string) => {
      queue.current.push(text);
      void pump();
    },
    [pump],
  );
  return { say, on, setOn };
}

export default function ScenarioRunner() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [log, setLog] = useState<Record<string, Logged[]>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [calloutVehicle, setCalloutVehicle] = useState<string | null>(null);
  const { say, on, setOn } = useSpeech();
  const ends = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    void fetch("/api/scenarios")
      .then((r) => r.json())
      .then((d: { scenarios: Scenario[] }) => setScenarios(d.scenarios));
  }, []);

  // The Cartesia scenario's callouts, spoken as the copilot derives them from telemetry.
  useEffect(() => {
    if (!calloutVehicle) return;
    const es = new EventSource("/api/copilot/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as { type: string; callout?: { vehicleId: string; text: string; priority: string } };
      if (e.type === "callout" && e.callout?.vehicleId === calloutVehicle) {
        setLog((l) => ({ ...l, "cartesia-hands-on-the-sticks": [...(l["cartesia-hands-on-the-sticks"] ?? []), { kind: "say", text: `callout: ${e.callout?.text}`, at: Date.now() }] }));
        say(e.callout.text);
      }
    };
    return () => es.close();
  }, [calloutVehicle, say]);

  const run = useCallback(
    async (s: Scenario) => {
      setRunning(s.id);
      setLog((l) => ({ ...l, [s.id]: [] }));
      try {
        const res = await fetch(`/api/scenarios/${s.id}`, { method: "POST" });
        const reader = res.body?.getReader();
        if (!reader) throw new Error(`HTTP ${res.status}`);
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i).replace(/^data: /, "");
            buf = buf.slice(i + 2);
            if (!chunk.trim()) continue;
            const e = JSON.parse(chunk) as Logged;
            setLog((l) => ({ ...l, [s.id]: [...(l[s.id] ?? []), e] }));
            if (s.track === "cartesia" && e.kind === "say") say(e.text);
            if (s.track === "cartesia" && e.kind === "link" && typeof e.data?.callouts === "string") setCalloutVehicle(e.data.callouts);
            setTimeout(() => ends.current[s.id]?.scrollIntoView({ block: "nearest" }), 0);
          }
        }
      } catch (e) {
        setLog((l) => ({ ...l, [s.id]: [...(l[s.id] ?? []), { kind: "fail", text: e instanceof Error ? e.message : String(e), at: Date.now() }] }));
      } finally {
        setRunning(null);
        if (s.track === "cartesia") setTimeout(() => setCalloutVehicle(null), 30_000);
      }
    },
    [say],
  );

  const install = async () => {
    const r = await fetch("/api/scenarios/install", { method: "POST" });
    const d = (await r.json()) as { plans?: { name: string; action: string }[]; error?: string };
    setNote(d.plans ? `${d.plans.length} missions are in the simulator's plan library (Plans page): ${d.plans.map((p) => p.name).join("; ")}` : `Could not install: ${d.error}`);
  };
  const stop = async () => {
    const r = await fetch("/api/scenarios/stop", { method: "POST" });
    const d = (await r.json()) as { stopped?: number; error?: string };
    setNote(d.stopped !== undefined ? `Stopped ${d.stopped} scenario drone(s).` : `Could not stop: ${d.error}`);
  };

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" onClick={install} style={btn(C.text)}>
          Put the missions in the simulator
        </button>
        <button type="button" onClick={stop} style={btn(C.dim)}>
          Stop scenario drones
        </button>
        <button type="button" onClick={() => setOn(!on)} style={btn(on ? "#ff8a3d" : C.dim)}>
          Voice {on ? "on" : "off"}
        </button>
        <a href="http://127.0.0.1:45010/" target="_blank" rel="noreferrer" style={{ ...btn(C.dim), textDecoration: "none" }}>
          Open the simulator
        </a>
        <a href="/copilot" target="_blank" rel="noreferrer" style={{ ...btn(C.dim), textDecoration: "none" }}>
          Open the airspace map
        </a>
        {note ? <span style={{ color: C.dim, fontSize: 13 }}>{note}</span> : null}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(560px, 1fr))", gap: 16 }}>
        {scenarios.map((s) => {
          const color = colorOf(s.track);
          const lines = log[s.id] ?? [];
          return (
            <section key={s.id} style={{ background: C.card, border: `1px solid ${C.line}`, borderTop: `3px solid ${color}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                <div>
                  <span style={{ color, fontSize: 12, letterSpacing: 1, textTransform: "uppercase" }}>{s.trackName}</span>
                  <h2 style={{ margin: "2px 0 0", fontSize: 19 }}>{s.title}</h2>
                </div>
                <button type="button" disabled={running !== null} onClick={() => void run(s)} style={{ ...btn("#04110e"), background: running ? "#2a2f3a" : color, border: "none", fontWeight: 600, whiteSpace: "nowrap" }}>
                  {running === s.id ? "Running…" : `Run (~${s.minutes} min)`}
                </button>
              </div>
              <p style={{ margin: 0, lineHeight: 1.5 }}>{s.summary}</p>
              <p style={{ margin: 0, lineHeight: 1.5, color: C.dim }}>
                <strong style={{ color: C.text }}>Why it matters: </strong>
                {s.whyItMatters}
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, color: C.dim, lineHeight: 1.5 }}>
                {s.watch.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              {lines.length ? (
                <div style={{ background: "#0b0e14", border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, maxHeight: 340, overflowY: "auto", fontSize: 13, lineHeight: 1.5, fontFamily: "ui-monospace, Menlo, monospace" }}>
                  {lines.map((e, i) => {
                    const st = KIND_STYLE[e.kind];
                    const href = typeof e.data?.href === "string" ? e.data.href : typeof e.data?.url === "string" ? e.data.url : null;
                    return (
                      <div key={i} style={{ color: st.color, display: "flex", gap: 8 }}>
                        <span style={{ width: 18, flexShrink: 0, textAlign: "center" }}>{st.mark}</span>
                        <span>
                          {e.kind === "say" && e.data?.who ? <strong>{String(e.data.who)}: </strong> : null}
                          {e.kind === "heard" ? <strong>Ink heard: </strong> : null}
                          {e.text}
                          {href ? (
                            <>
                              {" "}
                              <a href={href} target="_blank" rel="noreferrer" style={{ color }}>
                                open
                              </a>
                            </>
                          ) : null}
                        </span>
                      </div>
                    );
                  })}
                  <div ref={(el) => void (ends.current[s.id] = el)} />
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

const btn = (color: string): React.CSSProperties => ({ background: "transparent", color, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 14 });
