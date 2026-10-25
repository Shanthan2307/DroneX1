"use client";
// The voice copilot panel (Cartesia): push-to-talk or always-listening through Ink, replies and callouts spoken
// through Sonic with barge-in, a log of every turn (what was heard, which tool ran, its receipt), the live
// callouts from the events stream, and a vehicle picker. Works without a key too: typed commands, the same
// intent route, callouts as text, with a clear notice of what the key would add. No global key capture: the
// pilot's keyboard stays with the simulator window.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVoiceToken, InkListener, SonicSpeaker, type ListenMode, type VoiceToken } from "@/lib/copilot/speech";
import type { Callout, FeedEvent, VehicleListed, VehicleSnapshot } from "@/lib/copilot/types";
import CalloutsFeed from "./CalloutsFeed";
import TurnLog, { type Turn } from "./TurnLog";

type VoiceState = { kind: "checking" } | { kind: "ready"; voiceName: string | null; ttsModel: string; sttModel: string } | { kind: "missing"; message: string } | { kind: "error"; message: string };
type ListenStatus = "idle" | "connecting" | "listening" | "error";
type Transport = "websocket" | "http" | "off";

interface IntentResponse {
  reply: string;
  actions: { tool: string; args: Record<string, unknown>; result: string }[];
  vehicleId: string | null;
  model: string;
  error?: string;
}

const MAX_TURNS = 40;
const MAX_CALLOUTS = 60;

/** The latest values the long-lived speaker, listener and event stream need, without re-creating them. */
interface Latest {
  vehicleId: string | null;
  speakCallouts: boolean;
}

// One token per page, cached until it is about to expire. Module state, not a ref: it is read from event
// handlers and the speaker, never during render.
let cachedToken: VoiceToken | null = null;

export default function VoiceCopilot() {
  const [voice, setVoice] = useState<VoiceState>({ kind: "checking" });
  const [listenMode, setListenMode] = useState<ListenMode>("push");
  const [listenStatus, setListenStatus] = useState<ListenStatus>("idle");
  const [listenDetail, setListenDetail] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState("");
  const [holding, setHolding] = useState(false);
  const [speakCallouts, setSpeakCallouts] = useState(true);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [transport, setTransport] = useState<Transport>("off");
  const [vehicles, setVehicles] = useState<VehicleListed[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, VehicleSnapshot>>({});
  const [chosenVehicle, setChosenVehicle] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [callouts, setCallouts] = useState<Callout[]>([]);
  const [feedState, setFeedState] = useState<"connecting" | "live" | "down">("connecting");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  // The vehicle commands go to: the pilot's pick while it exists, else the first online one.
  const online = vehicles.filter((v) => v.presence === "online");
  const vehicleId = chosenVehicle && vehicles.some((v) => v.id === chosenVehicle) ? chosenVehicle : (online[0]?.id ?? vehicles[0]?.id ?? null);

  const latest = useRef<Latest>({ vehicleId: null, speakCallouts: true });
  useEffect(() => {
    latest.current.vehicleId = vehicleId;
    latest.current.speakCallouts = speakCallouts;
  }, [vehicleId, speakCallouts]);

  // ---------- Cartesia token (cached until it is about to expire) ----------
  const getToken = useCallback(async (): Promise<VoiceToken | null> => {
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken;
    const r = await fetchVoiceToken();
    if (!r.ok) {
      cachedToken = null;
      setVoice(r.error.code === "cartesia-key-missing" ? { kind: "missing", message: r.error.message } : { kind: "error", message: r.error.message });
      return null;
    }
    cachedToken = r.token;
    setVoice({ kind: "ready", voiceName: r.token.voiceName, ttsModel: r.token.ttsModel, sttModel: r.token.sttModel });
    return r.token;
  }, []);

  // ---------- the speaker and the listener live as long as the panel ----------
  const actRef = useRef<(text: string, source: Turn["source"]) => Promise<void>>(async () => undefined);
  const [{ speaker, listener }] = useState(() => {
    const sp = new SonicSpeaker(getToken);
    return { speaker: sp, listener: new InkListener(getToken) };
  });

  useEffect(() => {
    listener.setEvents({
      onPartial: (text) => setPartial(text),
      onFinal: (text) => {
        setPartial("");
        void actRef.current(text, "voice");
      },
      onSpeechStart: () => speaker.bargeIn(),
      onLevel: (l) => setLevel(l),
      onStatus: (status, detail) => {
        setListenStatus(status);
        setListenDetail(detail ?? null);
      },
    });
    speaker.setOnState((st) => {
      setSpeaking(st.speaking?.text ?? null);
      setTransport(st.transport);
    });
    const probe = setTimeout(() => void getToken(), 0);
    return () => {
      clearTimeout(probe);
      speaker.setOnState(null);
      speaker.close();
      listener.stop();
    };
  }, [speaker, listener, getToken]);

  // ---------- the events feed ----------
  useEffect(() => {
    const es = new EventSource("/api/copilot/events");
    es.onopen = () => setFeedState("live");
    es.onerror = () => setFeedState("down");
    es.onmessage = (ev) => {
      let e: FeedEvent;
      try {
        e = JSON.parse(ev.data) as FeedEvent;
      } catch {
        return;
      }
      if (e.type === "hello") {
        setVehicles(e.vehicles);
        setSnapshots(Object.fromEntries(e.snapshots.map((s) => [s.vehicleId, s])));
        setFeedState("live");
        return;
      }
      if (e.type === "vehicles") setVehicles(e.vehicles);
      if (e.type === "snapshot") setSnapshots((prev) => ({ ...prev, [e.snapshot.vehicleId]: e.snapshot }));
      if (e.type === "callout") {
        setCallouts((prev) => [e.callout, ...prev].slice(0, MAX_CALLOUTS));
        if (latest.current.speakCallouts) speaker.say(e.callout.text, e.callout.priority);
      }
    };
    return () => es.close();
  }, [speaker]);

  // ---------- intent: words to a tool call to a receipt ----------
  const act = useCallback(
    async (text: string, source: Turn["source"]) => {
      const t = text.trim();
      if (!t) return;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setTurns((prev) => [{ id, at: Date.now(), source, heard: t, reply: null, actions: [], error: null, pending: true }, ...prev].slice(0, MAX_TURNS));
      setBusy(true);
      try {
        const res = await fetch("/api/copilot/intent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t, vehicleId: latest.current.vehicleId }) });
        const body = (await res.json()) as IntentResponse;
        if (!res.ok || body.error) throw new Error(body.error ?? `intent failed (${res.status})`);
        setTurns((prev) => prev.map((x) => (x.id === id ? { ...x, reply: body.reply, actions: body.actions, pending: false } : x)));
        if (body.vehicleId) setChosenVehicle(body.vehicleId);
        speaker.say(body.reply, "status");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setTurns((prev) => prev.map((x) => (x.id === id ? { ...x, error: message, pending: false } : x)));
      } finally {
        setBusy(false);
      }
    },
    [speaker],
  );
  useEffect(() => {
    actRef.current = act;
  }, [act]);

  const toggleListening = useCallback(async () => {
    speaker.unlock();
    if (listener.active) {
      listener.stop();
      return;
    }
    await listener.start(listenMode);
  }, [listener, listenMode, speaker]);

  const switchMode = useCallback(
    (mode: ListenMode) => {
      setListenMode(mode);
      if (listener.active) {
        listener.stop();
        void listener.start(mode);
      }
    },
    [listener],
  );

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

  const current = vehicleId ? snapshots[vehicleId] : undefined;
  const voiceReady = voice.kind === "ready";
  const voiceLabel = voice.kind === "ready" ? (transport === "off" ? "ready" : transport) : voice.kind;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontSize: 13 }}>
      <section style={{ padding: "12px 14px", borderBottom: "1px solid #1c2130" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <strong style={{ fontSize: 14 }}>
            <span style={{ color: "#ff8a3d" }}>Cartesia</span> voice copilot
          </strong>
          <span style={{ fontSize: 11, color: "#9aa3b2" }}>
            feed {feedState} · voice {voiceLabel}
          </span>
        </div>
        {voice.kind === "missing" && (
          <p role="status" style={{ margin: "8px 0 0", padding: 8, borderRadius: 8, background: "#2a1f12", border: "1px solid #ff8a3d", color: "#ffd2b3" }}>
            {voice.message}. Typed commands, the intent route and the callouts below still work; speech in and out need the key.
          </p>
        )}
        {voice.kind === "error" && (
          <p role="status" style={{ margin: "8px 0 0", padding: 8, borderRadius: 8, background: "#2a1212", border: "1px solid #ff5d5d", color: "#ffb3b3" }}>
            Cartesia: {voice.message}
          </p>
        )}
        {voice.kind === "ready" && (
          <p style={{ margin: "6px 0 0", color: "#9aa3b2", fontSize: 11 }}>
            Sonic {voice.ttsModel}
            {voice.voiceName ? ` · voice ${voice.voiceName}` : ""} · Ink {voice.sttModel}
          </p>
        )}
      </section>

      <section style={{ padding: "12px 14px", borderBottom: "1px solid #1c2130", display: "grid", gap: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#9aa3b2", width: 60 }}>Vehicle</span>
          <select value={vehicleId ?? ""} onChange={(e) => setChosenVehicle(e.target.value || null)} style={selectStyle} aria-label="Vehicle">
            {vehicles.length === 0 && <option value="">no vehicles yet</option>}
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} · {v.presence} · {v.mode}
                {v.armed ? " · armed" : ""}
              </option>
            ))}
          </select>
        </label>
        {current && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, fontSize: 11 }}>
            <Stat label="altitude" value={current.altitudeAboveHomeM === null ? "–" : `${current.altitudeAboveHomeM.toFixed(0)} m`} />
            <Stat label="speed" value={current.groundSpeedMps === null ? "–" : `${current.groundSpeedMps.toFixed(1)} m/s`} />
            <Stat label="battery" value={current.batteryPct === null ? "–" : `${current.batteryPct.toFixed(0)} %`} />
            <Stat label="GPS" value={current.gpsSatellites === null ? "–" : `${current.gpsSatellites.toFixed(0)} sats`} />
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              void pressTalk();
            }}
            onPointerUp={releaseTalk}
            onPointerLeave={() => holding && releaseTalk()}
            onPointerCancel={releaseTalk}
            disabled={!voiceReady || listenMode === "always"}
            aria-pressed={holding}
            title={voiceReady ? "Hold to talk" : "Needs the Cartesia key"}
            style={{ ...buttonStyle, flex: 1, background: holding ? "#ff8a3d" : "#1c2130", color: holding ? "#0b0d12" : "#e6e9ef", borderColor: "#ff8a3d", minHeight: 44, fontWeight: 600 }}
          >
            {holding ? "Listening… release to send" : "Hold to talk"}
          </button>
          <button type="button" onClick={() => void toggleListening()} disabled={!voiceReady} style={{ ...buttonStyle, borderColor: listenStatus === "listening" ? "#2bb7a0" : "#2a3142" }} title="Open or close the microphone">
            {listenStatus === "listening" ? "Mic on" : listenStatus === "connecting" ? "Connecting…" : "Mic off"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 11, color: "#9aa3b2", flexWrap: "wrap" }}>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="radio" name="listen" checked={listenMode === "push"} onChange={() => switchMode("push")} /> push to talk
          </label>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="radio" name="listen" checked={listenMode === "always"} onChange={() => switchMode("always")} /> always listening (Ink turn detection, barge-in)
          </label>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={speakCallouts} onChange={(e) => setSpeakCallouts(e.target.checked)} /> speak callouts
          </label>
          <span aria-label="microphone level" style={{ width: 60, height: 6, background: "#1c2130", borderRadius: 3, overflow: "hidden" }}>
            <span style={{ display: "block", height: "100%", width: `${Math.min(100, level * 400)}%`, background: "#2bb7a0", transition: "width 80ms" }} />
          </span>
          {listenDetail && listenStatus === "error" && <span style={{ color: "#ff5d5d" }}>{listenDetail}</span>}
        </div>
        {(partial || speaking) && (
          <div style={{ fontSize: 12, color: "#e6e9ef", minHeight: 18 }}>
            {partial && <span style={{ color: "#9aa3b2" }}>hearing: </span>}
            {partial}
            {speaking && (
              <span style={{ color: "#ff8a3d" }}>
                {partial ? " · " : ""}speaking: {speaking}
              </span>
            )}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            speaker.unlock();
            const t = typed;
            setTyped("");
            void act(t, "typed");
          }}
          style={{ display: "flex", gap: 6 }}
        >
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder='type a command: "take off to twenty metres"' aria-label="Typed command" style={{ ...selectStyle, flex: 1 }} disabled={busy} />
          <button type="submit" style={buttonStyle} disabled={busy || !typed.trim()}>
            Send
          </button>
        </form>
      </section>

      <div style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr) minmax(0, 1fr)", minHeight: 0, flex: 1 }}>
        <TurnLog turns={turns} />
        <CalloutsFeed callouts={callouts} onSpeak={(c) => speaker.say(c.text, c.priority)} canSpeak={voiceReady} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#11141c", border: "1px solid #1c2130", borderRadius: 6, padding: "4px 6px" }}>
      <div style={{ color: "#9aa3b2", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

const selectStyle: React.CSSProperties = { background: "#11141c", color: "#e6e9ef", border: "1px solid #2a3142", borderRadius: 6, padding: "6px 8px", fontSize: 12, flex: 1, minWidth: 0 };
const buttonStyle: React.CSSProperties = { background: "#1c2130", color: "#e6e9ef", border: "1px solid #2a3142", borderRadius: 8, padding: "8px 12px", fontSize: 12, cursor: "pointer" };
