"use client";
// DroneX Dispatch at a glance: the three engines, the agents with their addresses and whether each is running,
// where the dispatcher stands on Agentverse (local only, mailbox not connected, listed), the way into ASI:One, and
// sentences to try. Polls /api/dispatch every five seconds; every fact on it comes from that route.
import { useEffect, useState } from "react";
import type { DispatchStatus } from "@/lib/dispatch/types";

const C = { dim: "#9aa3b2", line: "#1c2130", card: "#11151d", ok: "#3ecf8e", warn: "#f5a524", bad: "#f04d5d", accent: "#2bb7a0" };

const TRY = [
  "I need to run a 160 km/h aerobatic FPV sprint over 2 km to Coit Tower, back in 5 minutes",
  "Fly a 10 km ridge run to Twin Peaks within 15 minutes",
  "Deliver 500 g of blood samples 6 km to UCSF within 20 minutes",
];

type Tone = "ok" | "warn" | "bad";

function Dot({ tone }: { tone: Tone }) {
  return <span aria-hidden style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: C[tone], marginRight: 8, flexShrink: 0 }} />;
}

function Row({ tone, label, detail }: { tone: Tone; label: string; detail?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "6px 0", borderTop: `1px solid ${C.line}` }}>
      <Dot tone={tone} />
      <span style={{ minWidth: 190, flexShrink: 0 }}>{label}</span>
      {detail ? <span style={{ color: C.dim, fontSize: 13, overflowWrap: "anywhere" }}>{detail}</span> : null}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: "14px 16px" }}>
      <h2 style={{ fontSize: 13, letterSpacing: 1, textTransform: "uppercase", color: C.dim, margin: "0 0 8px" }}>{title}</h2>
      {children}
    </section>
  );
}

/** Where the dispatcher stands between "runs on this laptop" and "ASI:One can find it". */
function agentverseState(s: DispatchStatus): { tone: Tone; label: string; next: string } {
  const a = s.agents;
  if (!a || !s.live.dispatcher) return { tone: "bad", label: "Dispatcher not running", next: "Start the agents: DroneX_agents/dev.sh" };
  if (!a.dispatcher.mailbox) return { tone: "warn", label: "Local only (mailbox off)", next: "Restart without DRONEX_MAILBOX=0 so ASI:One can reach it" };
  if (s.almanac?.type !== "mailbox") return { tone: "warn", label: "Registering…", next: "The Almanac has not picked up the mailbox endpoint yet" };
  if (!s.listing?.name) return { tone: "warn", label: "Mailbox not connected", next: "Run DroneX_agents/scripts/connect_agentverse.py (AGENTVERSE_API_KEY), or the inspector's Connect → Mailbox" };
  return { tone: "ok", label: `Listed on Agentverse as ${s.listing.name}`, next: `${s.listing.interactions} interaction(s) so far` };
}

const short = (addr: string): string => `${addr.slice(0, 14)}…${addr.slice(-6)}`;

export default function DispatchPanel() {
  const [s, setS] = useState<DispatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/dispatch", { cache: "no-store" });
        const d = (await r.json()) as DispatchStatus;
        if (alive) {
          setS(d);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  };

  if (!s) return <p style={{ color: C.dim, padding: 24 }}>{error ? `Status unavailable: ${error}` : "Checking the agents…"}</p>;
  const a = s.agents;
  const av = agentverseState(s);
  const fleet = a ? Object.entries(a.fleet.agents) : [];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 16, padding: 20, alignContent: "start" }}>
      <Card title="Three engines">
        <Row tone="ok" label="Rendering engine" detail="this configurator: parts, physics verdict, JSON routes" />
        <Row tone={s.simulator ? "ok" : "bad"} label="Simulation engine" detail={s.simulator ? "Core daemon and ArduPilot SITL up" : "not running: ./dev.sh at the project root"} />
        <Row tone={s.live.dispatcher && s.live.flight && s.live.fleet ? "ok" : s.live.dispatcher || s.live.flight || s.live.fleet ? "warn" : "bad"} label="Agents (Fetch.ai)" detail={a ? `dispatcher ${s.live.dispatcher ? "up" : "down"} · fleet ${s.live.fleet ? "up" : "down"} · flight ${s.live.flight ? "up" : "down"}` : "never started: DroneX_agents/dev.sh"} />
      </Card>

      <Card title="ASI:One">
        <Row tone={av.tone} label={av.label} detail={av.next} />
        {a ? (
          <>
            <Row tone={s.almanac ? "ok" : "warn"} label="Almanac" detail={s.almanac ? `${s.almanac.status} · ${s.almanac.type} · ${s.almanac.endpoint ?? "no endpoint"}` : "not listed yet"} />
            <Row tone={a.model ? "ok" : "warn"} label="Intent model" detail={a.model ? `${a.model} (ASI:One)` : "no INTENT_API_KEY: the rule parser handles the demo sentences"} />
            <Row tone={a.flight.payments ? "ok" : "warn"} label="Payment Protocol" detail={a.flight.payments ? `${a.flight.priceFet} FET per flight · ${a.flight.ledger ? "paid and verified on Dorado (testnet)" : "committed by reference, no FET moved"}` : "off (DRONEX_PAYMENTS=1)"} />
            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <a href="https://asi1.ai/" target="_blank" rel="noreferrer" style={{ background: C.accent, color: "#04110e", padding: "8px 14px", borderRadius: 8, fontWeight: 600, textDecoration: "none" }}>
                Chat in ASI:One
              </a>
              <a href={`https://agentverse.ai/agents/details/${a.dispatcher.address}/profile`} target="_blank" rel="noreferrer" style={{ border: `1px solid ${C.accent}`, color: C.accent, padding: "8px 14px", borderRadius: 8, textDecoration: "none" }}>
                Agentverse profile
              </a>
              <button type="button" onClick={() => copy(`@${a.dispatcher.handle}`)} style={{ background: "transparent", border: `1px solid ${C.line}`, color: "#e6e9ef", padding: "8px 14px", borderRadius: 8, cursor: "pointer" }}>
                {copied === `@${a.dispatcher.handle}` ? "Copied" : `Copy @${a.dispatcher.handle}`}
              </button>
            </div>
          </>
        ) : null}
      </Card>

      {a ? (
        <Card title="Agents">
          <Row tone={s.live.dispatcher ? "ok" : "bad"} label={`${a.dispatcher.name} :${a.dispatcher.port}`} detail={a.dispatcher.address} />
          <Row tone={s.live.flight ? "ok" : "bad"} label={`Flight agent :${a.flight.port}`} detail={a.flight.address} />
          {fleet.map(([pid, addr]) => (
            <Row key={pid} tone={s.live.fleet ? "ok" : "bad"} label={pid} detail={short(addr)} />
          ))}
          <p style={{ color: C.dim, fontSize: 12, margin: "10px 0 0" }}>Started {new Date(a.startedAt).toLocaleString()}. Fleet agents run in one Bureau on :{a.fleet.port}; they and the flight agent talk to the dispatcher locally.</p>
        </Card>
      ) : null}

      <Card title="Try it in ASI:One">
        {TRY.map((t) => (
          <div key={t} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 0", borderTop: `1px solid ${C.line}` }}>
            <span>{t}</span>
            <button type="button" onClick={() => copy(t)} style={{ background: "transparent", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap", padding: "4px 10px", alignSelf: "center" }}>
              {copied === t ? "Copied" : "Copy"}
            </button>
          </div>
        ))}
        <p style={{ color: C.dim, fontSize: 12, margin: "10px 0 0" }}>
          The dispatcher asks the fleet, shows candidates with the physics verdict, and on approval the flight agent packs the drone into the simulator, waits for GPS, takes off, reserves a corridor in the shared airspace and flies. When nothing passes it names the failing check and searches for a one-part swap.
        </p>
      </Card>
    </div>
  );
}
