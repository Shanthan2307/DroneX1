"use client";
// Every turn with the copilot: what was heard (or typed), the tool that ran with its arguments, the engine's
// receipt, and the spoken reply. The receipt is the truth; the reply is phrased from it.

export interface Turn {
  id: string;
  at: number;
  source: "voice" | "typed";
  heard: string;
  reply: string | null;
  actions: { tool: string; args: Record<string, unknown>; result: string }[];
  error: string | null;
  pending: boolean;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false });

export default function TurnLog({ turns }: { turns: Turn[] }) {
  return (
    <section aria-label="Turns" style={{ overflow: "auto", padding: "10px 14px", borderBottom: "1px solid #1c2130" }}>
      <h3 style={{ margin: "0 0 8px", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "#9aa3b2" }}>Turns</h3>
      {turns.length === 0 && <p style={{ color: "#9aa3b2", margin: 0 }}>Nothing yet. Hold to talk, or type a command.</p>}
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {turns.map((t) => (
          <li key={t.id} style={{ background: "#11141c", border: "1px solid #1c2130", borderRadius: 8, padding: "8px 10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "#9aa3b2", fontSize: 11 }}>
              <span>{t.source === "voice" ? "heard" : "typed"}</span>
              <span>{time(t.at)}</span>
            </div>
            <div style={{ margin: "2px 0 6px" }}>“{t.heard}”</div>
            {t.actions.map((a, i) => (
              <div key={i} style={{ fontSize: 12, marginBottom: 4 }}>
                <code style={{ color: "#2bb7a0" }}>
                  {a.tool}
                  {Object.keys(a.args).length ? `(${Object.entries(a.args).map(([k, v]) => `${k}=${String(v)}`).join(", ")})` : "()"}
                </code>
                <div style={{ color: "#c9d0db" }}>→ {a.result}</div>
              </div>
            ))}
            {t.pending && <div style={{ color: "#9aa3b2", fontSize: 12 }}>working…</div>}
            {t.reply && <div style={{ color: "#ff8a3d" }}>{t.reply}</div>}
            {t.error && <div style={{ color: "#ff5d5d", fontSize: 12 }}>{t.error}</div>}
          </li>
        ))}
      </ol>
    </section>
  );
}
