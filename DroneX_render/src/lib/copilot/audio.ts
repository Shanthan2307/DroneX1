// Browser audio for the copilot: a gapless PCM player for Sonic's chunks (with an instant stop for barge-in) and
// a microphone capture that hands out 16 kHz 16-bit mono frames for Ink. No framework, no globals, no key capture.

/** Plays float32 PCM chunks back to back as they arrive; stop() cuts everything now. */
export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private nextAt = 0;
  private playing = new Set<AudioBufferSourceNode>();
  private generation = 0;

  constructor(private readonly sampleRate: number) {}

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Call from a user gesture once, so later playback is allowed. */
  unlock(): void {
    this.context();
  }

  enqueue(samples: Float32Array): void {
    if (samples.length === 0) return;
    const ctx = this.context();
    const buffer = ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const gen = this.generation;
    const at = Math.max(ctx.currentTime + 0.02, this.nextAt);
    src.start(at);
    this.nextAt = at + buffer.duration;
    this.playing.add(src);
    src.onended = () => {
      this.playing.delete(src);
      if (gen === this.generation && this.playing.size === 0) this.onIdle?.();
    };
  }

  /** Fires when the queue drains (set by the speaker to advance its own queue). */
  onIdle: (() => void) | null = null;

  get busy(): boolean {
    return this.playing.size > 0;
  }

  stop(): void {
    this.generation++;
    for (const s of this.playing) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.playing.clear();
    this.nextAt = 0;
  }

  /** Plays a whole WAV (the server-side speak route's answer) through the same context, so stop() still cuts it. */
  async playWav(bytes: ArrayBuffer): Promise<void> {
    const ctx = this.context();
    const decoded = await ctx.decodeAudioData(bytes.slice(0));
    const data = decoded.getChannelData(0);
    const resampled = decoded.sampleRate === this.sampleRate ? data : resample(data, decoded.sampleRate, this.sampleRate);
    this.enqueue(resampled);
  }
}

export function base64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

/** Linear resampling, good enough for speech. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = x - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Root-mean-square level of a frame, 0 to 1, for the microphone meter. */
export function rms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
  return Math.sqrt(sum / input.length);
}

export const MIC_SAMPLE_RATE = 16_000;
const FRAME_MS = 100;

/**
 * Microphone to 16 kHz 16-bit mono frames of about 100 ms. Uses a ScriptProcessor (available everywhere the
 * microphone is) so no worklet file has to be served; the frames are resampled from the context's rate.
 */
export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private pending: Float32Array[] = [];
  private pendingLength = 0;

  constructor(
    private readonly onFrame: (pcm: Int16Array, level: number) => void,
    private readonly onError: (message: string) => void,
  ) {}

  get active(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this.onError("this browser has no microphone access");
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      this.onError(`microphone refused: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.ctx = new AudioContext();
    const ctx = this.ctx;
    this.source = ctx.createMediaStreamSource(this.stream);
    const frameSamples = Math.round((MIC_SAMPLE_RATE * FRAME_MS) / 1000);
    this.node = ctx.createScriptProcessor(2048, 1, 1);
    this.node.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      const down = resample(input, ctx.sampleRate, MIC_SAMPLE_RATE);
      this.pending.push(down);
      this.pendingLength += down.length;
      while (this.pendingLength >= frameSamples) {
        const frame = new Float32Array(frameSamples);
        let filled = 0;
        while (filled < frameSamples) {
          const head = this.pending[0];
          const take = Math.min(head.length, frameSamples - filled);
          frame.set(head.subarray(0, take), filled);
          filled += take;
          if (take === head.length) this.pending.shift();
          else this.pending[0] = head.subarray(take);
        }
        this.pendingLength -= frameSamples;
        this.onFrame(floatToInt16(frame), rms(frame));
      }
    };
    this.source.connect(this.node);
    // A ScriptProcessor only runs when connected to the destination; a zero-gain node keeps it silent.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(ctx.destination);
  }

  stop(): void {
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.pending = [];
    this.pendingLength = 0;
  }
}
