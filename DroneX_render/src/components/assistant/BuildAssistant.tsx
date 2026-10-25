"use client";
// The build assistant on the configurator: ask about the drone on the pad by voice (Cartesia Ink, hold to talk)
// or by typing, hear the answer (Cartesia Sonic), and get part swaps as buttons. It knows the drone and the
// clicked part from the front end's "dronex:state" event and asks for changes with "dronex:swap" /
// "dronex:mission" (prototype/drone-assembly/src/main.js), so a swap animates exactly like the part card's.
// The answers come from /api/assistant, whose tools read the dataset and run the physics.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVoiceToken, InkListener, SonicSpeaker, type VoiceToken } from "@/lib/copilot/speech";

type Slot = "airframe" | "motor" | "propeller" | "battery" | "payload";
type Change = { kind: "swap"; slot: Slot; partId: string; partName: string; why: string } | { kind: "mission"; missionId: string; missionName: string; why: string };

interface PadState {
  name: string;
  modified: boolean;
  build: Record<string, unknown> & { missionId?: string | null };
  selected: { slot: Slot; partId: string | null; name: string } | null;
  busy: boolean;
}

interface Turn {
  id: number;
  role: "user" | "assistant";
  content: string;
  suggestions?: Change[];
  applied?: Change[];
  error?: boolean;
}

const C = { bg: "rgba(14,17,24,0.92)", line: "#262c3a", dim: "#9aa3b2", text: "#e6e9ef", accent: "#ff8a3d", ok: "#3ecf8e" };

// Words Ink should expect in this conversation: the part and mission vocabulary, not flight commands.
const KEYTERMS = ["battery", "motor", "propeller", "airframe", "payload", "LiPo", "KV", "mAh", "thrust-to-weight", "endurance", "sub-250", "T-Motor", "Tattu", "CNHL", "Chimera", "Apex", "medical", "mission"];

const QUICK = (s: PadState | null): string[] => [
  s?.selected ? `What does the ${s.selected.slot} do, and is it a good choice here?` : "Explain this drone's parts to me.",
  "Can it fly its mission? Why or why not?",
  "What should I change to pass the mission?",
  "What does this mission require?",
];

let cachedToken: VoiceToken | null = null;

const changeLabel = (c: Change): string => (c.kind === "swap" ? `Use ${c.partName} (${c.slot})` : `Switch to ${c.missionName}`);

export default function BuildAssistant() {
  const [open, setOpen] = useState(false);
  const [pad, setPad] = useState<PadState | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [speak, setSpeak] = useState(true);
  const [voice, setVoice] = useState<"unknown" | "ready" | "missing" | "error">("unknown");
  const [holding, setHolding] = useState(false);
  const [partial, setPartial] = useState("");
  const [level, setLevel] = useState(0);
  const [listenStatus, setListenStatus] = useState<string>("idle");
  const nextId = useRef(1);
  const latest = useRef<{ pad: PadState | null; turns: Turn[]; speak: boolean }>({ pad: null, turns: [], speak: true });
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    latest.current = { pad, turns, speak };
  }, [pad, turns, speak]);

  // ---------- the drone on the pad ----------
  useEffect(() => {
    const onState = (e: Event) => setPad((e as CustomEvent<PadState>).detail);
    window.addEventListener("dronex:state", onState);
    window.dispatchEvent(new Event("dronex:state-request"));
    return () => window.removeEventListener("dronex:state", onState);
  }, []);

  // ---------- Cartesia ----------
  const getToken = useCallback(async (): Promise<VoiceToken | null> => {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 5000) return cachedToken;
    const r = await fetchVoiceToken();
    if (!r.ok) {
      cachedToken = null;
      setVoice(r.error.code === "cartesia-key-missing" ? "missing" : "error");
      return null;
    }
    cachedToken = r.token;
    setVoice("ready");
    return r.token;
  }, []);

  const askRef = useRef<(text: string) => Promise<void>>(async () => undefined);
  const [{ speaker, listener }] = useState(() => ({ speaker: new SonicSpeaker(getToken), listener: new InkListener(getToken, undefined, KEYTERMS) }));

  useEffect(() => {
    listener.setEvents({
      onPartial: (t) => setPartial(t),
      onFinal: (t) => {
        setPartial("");
        if (t.trim()) void askRef.current(t.trim());
      },
      onSpeechStart: () => speaker.bargeIn(),
      onLevel: (l) => setLevel(l),
      onStatus: (s) => setListenStatus(s),
    });
    return () => {
      speaker.close();
      listener.stop();
    };
  }, [speaker, listener]);

  useEffect(() => {
    if (open && voice === "unknown") void getToken();
  }, [open, voice, getToken]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [turns, thinking]);

  // ---------- changes on the pad ----------
  const applyChange = useCallback((c: Change) => {
    if (c.kind === "swap") window.dispatchEvent(new CustomEvent("dronex:swap", { detail: { slot: c.slot, partId: c.partId } }));
    else window.dispatchEvent(new CustomEvent("dronex:mission", { detail: { missionId: c.missionId } }));
  }, []);

  // ---------- one question ----------
  const ask = useCallback(
    async (text: string) => {
      const { pad: p, turns: history, speak: talk } = latest.current;
      if (!p) {
        setTurns((t) => [...t, { id: nextId.current++, role: "assistant", content: "Put a drone on the pad first (Hangar), then ask me about it.", error: true }]);
        return;
      }
      const user: Turn = { id: nextId.current++, role: "user", content: text };
      setTurns((t) => [...t, user]);
      setThinking(true);
      speaker.bargeIn();
      try {
        const messages = [...history, user].filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content }));
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages, build: p.build, name: p.name, selected: p.selected ? { slot: p.selected.slot, partId: p.selected.partId } : null }),
        });
        const body = (await res.json()) as { reply?: string; suggestions?: Change[]; apply?: Change[]; error?: string };
        if (!res.ok || !body.reply) throw new Error(body.error ?? `assistant failed (${res.status})`);
        for (const c of body.apply ?? []) applyChange(c);
        setTurns((t) => [...t, { id: nextId.current++, role: "assistant", content: body.reply ?? "", suggestions: body.suggestions ?? [], applied: body.apply ?? [] }]);
        if (talk) speaker.say(body.reply, "status");
      } catch (e) {
        setTurns((t) => [...t, { id: nextId.current++, role: "assistant", content: e instanceof Error ? e.message : String(e), error: true }]);
      } finally {
        setThinking(false);
      }
    },
    [speaker, applyChange],
  );
  useEffect(() => {
    askRef.current = ask;
  }, [ask]);

  const pressTalk = useCallback(async () => {
    speaker.unlock();
    speaker.bargeIn();
    if (!listener.active) await listener.start("push");
    setHolding(true);
    listener.hold();
  }, [listener, speaker]);
  const releaseTalk = useCallback(() => {
    setHolding(false);
    listener.release();
  }, [listener]);

  const send = () => {
    const t = input.trim();
    if (!t || thinking) return;
    setInput("");
    speaker.unlock();
    void ask(t);
  };

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{ position: "fixed", right: 24, top: 76, zIndex: 60, background: C.bg, color: C.text, border: `1px solid ${C.accent}`, borderRadius: 999, padding: "9px 16px", fontSize: 14, cursor: "pointer", backdropFilter: "blur(8px)" }}
        title="Ask about the parts, the missions and what to change (voice by Cartesia)"
      >
        <span style={{ color: C.accent, marginRight: 8 }}>●</span>Ask DroneX
      </button>
    );

  const voiceReady = voice === "ready";
  return (
    <aside
      aria-label="Build assistant"
      style={{ position: "fixed", right: 20, top: 76, bottom: 100, width: 380, zIndex: 60, display: "flex", flexDirection: "column", background: C.bg, color: C.text, border: `1px solid ${C.line}`, borderRadius: 14, backdropFilter: "blur(10px)", fontSize: 14 }}
    >
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: `1px solid ${C.line}` }}>
        <div>
          <strong>Ask DroneX</strong>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 2 }}>
            {pad ? `${pad.name}${pad.modified ? " (modified)" : ""}${pad.selected ? ` · ${pad.selected.slot}: ${pad.selected.name}` : ""}` : "waiting for the pad…"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" onClick={() => setSpeak((v) => !v)} title="Speak answers aloud (Cartesia Sonic)" style={{ background: "transparent", color: speak ? C.accent : C.dim, border: `1px solid ${C.line}`, borderRadius: 8, padding: "4px 8px", cursor: "pointer" }}>
            {speak ? "Voice on" : "Voice off"}
          </button>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" style={{ background: "transparent", color: C.dim, border: `1px solid ${C.line}`, borderRadius: 8, padding: "4px 9px", cursor: "pointer" }}>
            ×
          </button>
        </div>
      </header>

      <div ref={scroller} style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        {turns.length === 0 ? (
          <div style={{ color: C.dim, lineHeight: 1.5 }}>
            Ask anything about this drone: what a part does, why it passes or fails a mission, what a mission needs, or what to swap. Click a part first to ask about that part. Every number comes from the parts dataset and the physics.
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
              {QUICK(pad).map((q) => (
                <button key={q} type="button" onClick={() => (speaker.unlock(), void ask(q))} disabled={thinking} style={{ textAlign: "left", background: "transparent", color: C.text, border: `1px solid ${C.line}`, borderRadius: 8, padding: "7px 10px", cursor: "pointer" }}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {turns.map((t) => (
          <div key={t.id} style={{ alignSelf: t.role === "user" ? "flex-end" : "flex-start", maxWidth: "92%" }}>
            <div style={{ background: t.role === "user" ? "#1d2433" : "transparent", border: t.role === "user" ? "none" : `1px solid ${t.error ? "#5a2a30" : C.line}`, color: t.error ? "#ff9aa5" : C.text, borderRadius: 10, padding: "8px 11px", lineHeight: 1.45 }}>
              {t.content}
            </div>
            {t.applied?.length ? <div style={{ color: C.ok, fontSize: 12, marginTop: 4 }}>Done on the pad: {t.applied.map(changeLabel).join(", ")}</div> : null}
            {t.suggestions?.filter((s) => !t.applied?.some((a) => changeLabel(a) === changeLabel(s))).map((s) => (
              <button key={changeLabel(s)} type="button" onClick={() => applyChange(s)} disabled={pad?.busy} style={{ display: "block", marginTop: 6, background: "transparent", color: C.accent, border: `1px solid ${C.accent}`, borderRadius: 8, padding: "6px 10px", cursor: "pointer", textAlign: "left" }}>
                {changeLabel(s)}
                {s.why ? <span style={{ color: C.dim }}> · {s.why}</span> : null}
              </button>
            ))}
          </div>
        ))}
        {thinking ? <div style={{ color: C.dim }}>Checking the parts and the physics…</div> : null}
        {partial ? <div style={{ color: C.dim, fontStyle: "italic", alignSelf: "flex-end" }}>{partial}</div> : null}
      </div>

      <footer style={{ borderTop: `1px solid ${C.line}`, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation(); // the configurator's keyboard shortcuts must not fire while typing
              if (e.key === "Enter") send();
            }}
            placeholder="Ask about a part, a mission, a swap…"
            style={{ flex: 1, background: "#0b0e14", color: C.text, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 10px" }}
          />
          <button type="button" onClick={send} disabled={thinking || !input.trim()} style={{ background: C.accent, color: "#160b02", border: "none", borderRadius: 8, padding: "8px 12px", fontWeight: 600, cursor: "pointer" }}>
            Ask
          </button>
        </div>
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            void pressTalk();
          }}
          onPointerUp={releaseTalk}
          onPointerLeave={() => holding && releaseTalk()}
          onPointerCancel={releaseTalk}
          disabled={!voiceReady || thinking}
          aria-pressed={holding}
          style={{ background: holding ? C.accent : "transparent", color: holding ? "#160b02" : C.text, border: `1px solid ${voiceReady ? C.accent : C.line}`, borderRadius: 8, padding: "9px 10px", cursor: voiceReady ? "pointer" : "not-allowed", position: "relative", overflow: "hidden" }}
        >
          <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, level * 400)}%`, background: "rgba(255,138,61,0.18)" }} />
          <span style={{ position: "relative" }}>{voice === "missing" ? "Voice needs CARTESIA_API_KEY" : voice === "error" ? "Voice unavailable" : holding ? "Listening… release to ask" : listenStatus === "connecting" ? "Connecting…" : "Hold to talk"}</span>
        </button>
        <div style={{ color: C.dim, fontSize: 11, textAlign: "center" }}>Voice by Cartesia (Ink listens, Sonic speaks) · answers from the dataset and dronePhysics.js</div>
      </footer>
    </aside>
  );
}
