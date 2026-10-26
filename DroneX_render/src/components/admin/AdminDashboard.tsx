"use client";
// The admin dashboard: asks for the PIN (POST /api/admin/session), then shows each technology's budget and today's
// use from GET /api/admin/status, refreshed every 30 s. Every number comes from that route.
import { useCallback, useEffect, useState } from "react";
import type { AdminStatus, TechStatus } from "@/lib/adminStatus";

type View = { kind: "loading" } | { kind: "locked"; error: string | null } | { kind: "open"; status: AdminStatus };

const card: React.CSSProperties = { background: "#121621", border: "1px solid #1c2130", borderRadius: 10, padding: 16 };
const muted: React.CSSProperties = { color: "#9aa3b2", fontSize: 13 };

function Bar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
  const color = pct >= 90 ? "#ff6b6b" : pct >= 60 ? "#ffb347" : "#4ea3ff";
  return (
    <div style={{ height: 6, background: "#1c2130", borderRadius: 3, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color }} />
    </div>
  );
}

function Tech({ t }: { t: TechStatus }) {
  return (
    <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <strong>{t.name}</strong>
        <span style={{ ...muted, color: t.configured ? "#5fd38d" : "#9aa3b2" }}>{t.configured ? "configured" : "off"}</span>
      </div>
      <p style={{ ...muted, margin: "4px 0 12px" }}>{t.role}</p>
      {t.budgets.map((b) => (
        <div key={b.provider} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
            <span>{b.provider === "cartesiaToken" ? "voice tokens minted" : b.provider === "llm" ? "model calls" : "voice calls"}</span>
            <span>
              {b.used} / {b.limit} today · {Math.max(0, b.limit - b.used)} left
            </span>
          </div>
          <Bar used={b.used} limit={b.limit} />
          <div style={{ ...muted, fontSize: 11, marginTop: 2 }}>limit: {b.env}</div>
        </div>
      ))}
      {t.provider ? (
        t.provider.ok ? (
          <pre style={{ ...muted, fontSize: 11, whiteSpace: "pre-wrap", background: "#0b0d12", padding: 8, borderRadius: 6, maxHeight: 180, overflow: "auto" }}>
            {JSON.stringify(t.provider.data, null, 2)}
          </pre>
        ) : (
          <p style={{ ...muted, color: "#ffb347" }}>Provider usage: {t.provider.error}</p>
        )
      ) : null}
      {t.note ? <p style={{ ...muted, margin: "8px 0" }}>{t.note}</p> : null}
      <a href={t.dashboard} target="_blank" rel="noreferrer" style={{ color: "#4ea3ff", fontSize: 13 }}>
        Open {t.name.split(",")[0]} dashboard
      </a>
    </section>
  );
}

export default function AdminDashboard() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [pin, setPin] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/status", { cache: "no-store" });
    if (r.status === 401) return setView({ kind: "locked", error: null });
    if (!r.ok) return setView({ kind: "locked", error: `the server answered ${r.status}` });
    setView({ kind: "open", status: (await r.json()) as AdminStatus });
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await fetch("/api/admin/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
    setPin("");
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      return setView({ kind: "locked", error: j.error ?? `the server answered ${r.status}` });
    }
    await load();
  };

  const lock = async () => {
    await fetch("/api/admin/session", { method: "DELETE" });
    setView({ kind: "locked", error: null });
  };

  return (
    <main style={{ minHeight: "100vh", background: "#0b0d12", color: "#e6e9ef", padding: "32px 20px" }}>
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>DroneX admin</h1>
        {view.kind === "loading" ? <p style={muted}>Loading…</p> : null}
        {view.kind === "locked" ? (
          <form onSubmit={unlock} style={{ ...card, maxWidth: 320, marginTop: 20 }}>
            <label style={{ display: "block", fontSize: 13, marginBottom: 8 }}>Admin PIN</label>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              style={{ width: "100%", padding: 8, background: "#0b0d12", color: "#e6e9ef", border: "1px solid #2a3142", borderRadius: 6 }}
            />
            {view.error ? <p style={{ ...muted, color: "#ff6b6b" }}>{view.error}</p> : null}
            <button type="submit" style={{ marginTop: 12, padding: "8px 14px", background: "#4ea3ff", color: "#0b0d12", border: 0, borderRadius: 6, fontWeight: 600 }}>
              Open dashboard
            </button>
          </form>
        ) : null}
        {view.kind === "open" ? (
          <>
            <p style={muted}>
              {view.status.mode === "configurator" ? "Website-only deployment" : "Full deployment"} · contact {view.status.contact ?? "not set"} · checked{" "}
              {new Date(view.status.checkedAt).toLocaleTimeString()} ·{" "}
              <button onClick={() => void load()} style={{ background: "none", border: 0, color: "#4ea3ff", cursor: "pointer", padding: 0 }}>
                refresh
              </button>{" "}
              ·{" "}
              <button onClick={() => void lock()} style={{ background: "none", border: 0, color: "#4ea3ff", cursor: "pointer", padding: 0 }}>
                sign out
              </button>
            </p>
            <p style={{ ...muted, fontSize: 12 }}>
              Daily budgets reset at 00:00 UTC. Use is counted by this server instance since it started {Math.round(view.status.uptimeS / 60)} min ago; the host may
              run more than one instance, so treat it as approximate and check each provider&apos;s dashboard for billing.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14, marginTop: 16 }}>
              {view.status.techs.map((t) => (
                <Tech key={t.name} t={t} />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
