// Cartesia in the browser: Sonic (text to speech) and Ink (speech to text) over their WebSockets, authenticated
// with a short-lived access token from /api/copilot/token. The speaker keeps a priority queue: a warning cuts
// whatever is playing and jumps the queue; status lines wait their turn; the pilot's own voice (barge-in) stops
// everything. The listener runs in push-to-talk (manual finalize) or always-on (Ink's turn detection) mode.
import { base64ToFloat32, MicCapture, PcmPlayer } from "./audio";
import type { Priority } from "./types";

export interface VoiceToken {
  token: string;
  expiresAt: number;
  ttsModel: string;
  sttModel: string;
  voiceId: string;
  voiceName: string | null;
  version: string;
}

export type TokenError = { code: "cartesia-key-missing" | "token-failed"; message: string };

/** Fetches a token; distinguishes "no key configured" from other failures so the UI can say the right thing. */
export async function fetchVoiceToken(): Promise<{ ok: true; token: VoiceToken } | { ok: false; error: TokenError }> {
  try {
    const res = await fetch("/api/copilot/token", { method: "POST" });
    const body = (await res.json()) as Partial<VoiceToken> & { error?: string; code?: string };
    if (!res.ok || !body.token) {
      return { ok: false, error: { code: body.code === "cartesia-key-missing" ? "cartesia-key-missing" : "token-failed", message: body.error ?? `token request failed (${res.status})` } };
    }
    return { ok: true, token: body as VoiceToken };
  } catch (e) {
    return { ok: false, error: { code: "token-failed", message: e instanceof Error ? e.message : String(e) } };
  }
}

const TTS_SAMPLE_RATE = 24_000;
const STT_SAMPLE_RATE = 16_000;
const WS_BASE = "wss://api.cartesia.ai";

type QueueItem = { id: number; text: string; priority: Priority };
type SonicMessage =
  | { type: "chunk"; context_id: string; data: string; done?: boolean }
  | { type: "done"; context_id: string }
  | { type: "error"; context_id?: string; message: string }
  | { type: string; context_id?: string };

/**
 * Speaks lines through Sonic with a priority queue. Falls back to the server-side speak route (WAV) when the
 * WebSocket cannot be opened, so the copilot still talks.
 */
export class SonicSpeaker {
  private ws: WebSocket | null = null;
  private queue: QueueItem[] = [];
  private current: { item: QueueItem; contextId: string } | null = null;
  private nextId = 1;
  private player = new PcmPlayer(TTS_SAMPLE_RATE);
  private tokenProvider: () => Promise<VoiceToken | null>;
  private opening: Promise<WebSocket | null> | null = null;
  private onState: ((s: { speaking: QueueItem | null; queued: number; transport: "websocket" | "http" | "off" }) => void) | null = null;

  /** Who to tell when the queue or the transport changes (the panel). */
  setOnState(fn: ((s: { speaking: QueueItem | null; queued: number; transport: "websocket" | "http" | "off" }) => void) | null): void {
    this.onState = fn;
  }
  private transport: "websocket" | "http" | "off" = "off";

  constructor(tokenProvider: () => Promise<VoiceToken | null>) {
    this.tokenProvider = tokenProvider;
    this.player.onIdle = () => {
      if (this.current && this.doneReceived.has(this.current.contextId)) this.finishCurrent();
    };
  }

  private doneReceived = new Set<string>();

  unlock(): void {
    this.player.unlock();
  }

  private notify() {
    this.onState?.({ speaking: this.current?.item ?? null, queued: this.queue.length, transport: this.transport });
  }

  /** Queue a line. A warning interrupts what is playing and goes first; status lines queue (at most three kept). */
  say(text: string, priority: Priority): void {
    const t = text.trim();
    if (!t) return;
    const item: QueueItem = { id: this.nextId++, text: t, priority };
    if (priority === "warning") {
      this.cutCurrent();
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
      const statuses = this.queue.filter((q) => q.priority === "status");
      while (statuses.length > 3) {
        const drop = statuses.shift();
        if (drop) this.queue = this.queue.filter((q) => q !== drop);
      }
    }
    this.notify();
    void this.pump();
  }

  /** The pilot is speaking: stop everything now and forget the queue. */
  bargeIn(): void {
    this.queue = [];
    this.cutCurrent();
    this.notify();
  }

  private cutCurrent() {
    if (this.current && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ context_id: this.current.contextId, cancel: true }));
      } catch {
        // socket going away
      }
    }
    this.player.stop();
    this.current = null;
  }

  private finishCurrent() {
    if (this.current) this.doneReceived.delete(this.current.contextId);
    this.current = null;
    this.notify();
    void this.pump();
  }

  private async open(): Promise<WebSocket | null> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const token = await this.tokenProvider();
      if (!token) return null;
      const url = `${WS_BASE}/tts/websocket?access_token=${encodeURIComponent(token.token)}&cartesia_version=${token.version}`;
      return new Promise<WebSocket | null>((resolve) => {
        let settled = false;
        const ws = new WebSocket(url);
        ws.onopen = () => {
          settled = true;
          this.ws = ws;
          this.transport = "websocket";
          this.notify();
          resolve(ws);
        };
        ws.onerror = () => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        };
        ws.onclose = () => {
          if (this.ws === ws) this.ws = null;
          if (!settled) {
            settled = true;
            resolve(null);
          }
        };
        ws.onmessage = (ev) => this.onMessage(ev);
      });
    })().finally(() => (this.opening = null));
    return this.opening;
  }

  private onMessage(ev: MessageEvent) {
    let msg: SonicMessage;
    try {
      msg = JSON.parse(String(ev.data)) as SonicMessage;
    } catch {
      return;
    }
    if (!this.current || msg.context_id !== this.current.contextId) return;
    if (msg.type === "chunk" && "data" in msg) this.player.enqueue(base64ToFloat32(msg.data));
    if (msg.type === "done") {
      this.doneReceived.add(this.current.contextId);
      if (!this.player.busy) this.finishCurrent();
    }
    if (msg.type === "error") {
      console.warn("[copilot] sonic:", "message" in msg ? msg.message : msg);
      this.finishCurrent();
    }
  }

  private async pump(): Promise<void> {
    if (this.current) return;
    const item = this.queue.shift();
    if (!item) {
      this.notify();
      return;
    }
    const token = await this.tokenProvider();
    if (!token) {
      this.transport = "off";
      this.queue = [];
      this.notify();
      return;
    }
    const contextId = `dx-${item.id}-${Date.now().toString(36)}`;
    this.current = { item, contextId };
    this.notify();
    const ws = await this.open();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          model_id: token.ttsModel,
          transcript: item.text,
          voice: { id: token.voiceId },
          language: "en",
          context_id: contextId,
          output_format: { container: "raw", encoding: "pcm_f32le", sample_rate: TTS_SAMPLE_RATE },
          generation_config: item.priority === "warning" ? { speed: 1.05 } : { speed: 1.0 },
        }),
      );
      return;
    }
    // No WebSocket: the server speaks and we play the WAV.
    this.transport = "http";
    this.notify();
    try {
      const res = await fetch("/api/copilot/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: item.text }) });
      if (res.ok) {
        this.doneReceived.add(contextId);
        await this.player.playWav(await res.arrayBuffer());
        return;
      }
    } catch {
      // fall through
    }
    this.finishCurrent();
  }

  close(): void {
    this.bargeIn();
    this.ws?.close();
    this.ws = null;
  }
}

export type ListenMode = "push" | "always";

const FLIGHT_KEYTERMS = ["take off", "return to launch", "guided", "loiter", "brake", "land", "metres", "Ferry Building", "pier", "battery"];

type InkMessage =
  | { type: "transcript"; text: string; is_final: boolean }
  | { type: "flush_done" }
  | { type: "done" }
  | { type: "turn.start" }
  | { type: "turn.update"; transcript: string }
  | { type: "turn.eager_end"; transcript: string }
  | { type: "turn.end"; transcript: string }
  | { type: "error"; message: string }
  | { type: string };

export interface ListenerEvents {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onSpeechStart: () => void;
  onLevel: (level: number) => void;
  onStatus: (status: "idle" | "connecting" | "listening" | "error", detail?: string) => void;
}

/**
 * Streams the microphone to Ink. Push-to-talk uses the manual endpoint (frames while held, "finalize" on
 * release, final transcript chunks concatenated). Always-on uses Ink's turn detection endpoint, which says when
 * a turn starts (barge-in) and ends (the sentence to act on).
 */
export class InkListener {
  private ws: WebSocket | null = null;
  private mic: MicCapture | null = null;
  private manualText = "";
  private mode: ListenMode = "push";
  private holding = false;

  private events: ListenerEvents = { onPartial: () => undefined, onFinal: () => undefined, onSpeechStart: () => undefined, onLevel: () => undefined, onStatus: () => undefined };

  constructor(
    private readonly tokenProvider: () => Promise<VoiceToken | null>,
    events?: ListenerEvents,
    /** Words Ink should expect (flight terms by default; the build assistant passes part and mission words). */
    private readonly keyterms: string[] = FLIGHT_KEYTERMS,
  ) {
    if (events) this.events = events;
  }

  /** Who hears the transcripts and status (the panel sets this once mounted). */
  setEvents(events: ListenerEvents): void {
    this.events = events;
  }

  get active(): boolean {
    return this.ws !== null;
  }

  private url(token: VoiceToken, mode: ListenMode): string {
    const q = new URLSearchParams({ model: token.sttModel, encoding: "pcm_s16le", sample_rate: String(STT_SAMPLE_RATE), cartesia_version: token.version, access_token: token.token });
    for (const k of this.keyterms) q.append("keyterm", k);
    return `${WS_BASE}${mode === "always" ? "/stt/turns/websocket" : "/stt/websocket"}?${q}`;
  }

  async start(mode: ListenMode): Promise<void> {
    if (this.ws) return;
    this.mode = mode;
    this.manualText = "";
    this.events.onStatus("connecting");
    const token = await this.tokenProvider();
    if (!token) {
      this.events.onStatus("error", "no Cartesia token");
      return;
    }
    const ws = new WebSocket(this.url(token, mode));
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
      ws.onerror = () => resolve();
    });
    if (ws.readyState !== WebSocket.OPEN) {
      this.events.onStatus("error", "could not reach Ink (speech to text)");
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
        this.events.onStatus("idle");
      }
    };
    this.mic = new MicCapture(
      (pcm, level) => {
        this.events.onLevel(level);
        if (this.ws && this.ws.readyState === WebSocket.OPEN && (this.mode === "always" || this.holding)) this.ws.send(pcm.buffer);
      },
      (message) => this.events.onStatus("error", message),
    );
    await this.mic.start();
    if (!this.mic.active) {
      this.stop();
      return;
    }
    this.events.onStatus("listening");
  }

  /** Push-to-talk: frames flow while held; release asks Ink to finalize. */
  hold(): void {
    if (this.mode !== "push") return;
    this.manualText = "";
    this.holding = true;
    this.events.onSpeechStart();
  }

  release(): void {
    if (this.mode !== "push" || !this.holding) return;
    this.holding = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send("finalize");
  }

  private onMessage(ev: MessageEvent) {
    let msg: InkMessage;
    try {
      msg = JSON.parse(String(ev.data)) as InkMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "transcript":
        if ("is_final" in msg && msg.is_final) {
          this.manualText += msg.text;
          this.events.onPartial(this.manualText);
        } else if ("text" in msg) this.events.onPartial(this.manualText + msg.text);
        break;
      case "flush_done": {
        const text = this.manualText.trim();
        this.manualText = "";
        if (text) this.events.onFinal(text);
        break;
      }
      case "turn.start":
        this.events.onSpeechStart();
        break;
      case "turn.update":
      case "turn.eager_end":
        if ("transcript" in msg) this.events.onPartial(msg.transcript);
        break;
      case "turn.end":
        if ("transcript" in msg && msg.transcript.trim()) this.events.onFinal(msg.transcript.trim());
        break;
      case "error":
        this.events.onStatus("error", "message" in msg ? msg.message : "Ink error");
        break;
      default:
        break;
    }
  }

  stop(): void {
    this.holding = false;
    this.mic?.stop();
    this.mic = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(this.mode === "always" ? JSON.stringify({ type: "close" }) : "close");
      } catch {
        // closing anyway
      }
      ws.close();
    }
    this.events.onStatus("idle");
  }
}
