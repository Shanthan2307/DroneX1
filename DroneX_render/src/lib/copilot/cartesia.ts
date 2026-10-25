// Server-only: the Cartesia client and the copilot's voice settings, read from the environment. The API key never
// leaves the server: the browser gets short-lived access tokens (token route) and the server speaks on its behalf
// where that is simpler (speak and transcribe routes).
import Cartesia from "@cartesia/cartesia-js";

export const CARTESIA_VERSION = "2026-08-14";

export interface VoiceSettings {
  ttsModel: string;
  sttModel: string;
  voiceId: string;
  voiceName: string | null;
  version: string;
}

export class CartesiaKeyMissing extends Error {
  constructor() {
    super("Cartesia key missing: add CARTESIA_API_KEY to DroneX_render/.env.local");
  }
}

export function cartesiaClient(): Cartesia {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) throw new CartesiaKeyMissing();
  return new Cartesia({ apiKey });
}

let resolvedVoice: { id: string; name: string | null } | null = null;

/**
 * The voice to speak with: CARTESIA_VOICE_ID when set, else the first English voice in the account's library,
 * looked up once per server process. Nothing is guessed: without a key and without an id there is no voice.
 */
export async function resolveVoice(client: Cartesia): Promise<{ id: string; name: string | null }> {
  const fromEnv = process.env.CARTESIA_VOICE_ID;
  if (fromEnv) return { id: fromEnv, name: null };
  if (resolvedVoice) return resolvedVoice;
  for await (const voice of client.voices.list({ limit: 50 })) {
    const v = voice as { id: string; name?: string; language?: string };
    if (!v.language || v.language.startsWith("en")) {
      resolvedVoice = { id: v.id, name: v.name ?? null };
      return resolvedVoice;
    }
  }
  throw new Error("no voice available: set CARTESIA_VOICE_ID to a voice id from https://play.cartesia.ai");
}

export const voiceSettings = async (client: Cartesia): Promise<VoiceSettings> => {
  const voice = await resolveVoice(client);
  return {
    ttsModel: process.env.CARTESIA_TTS_MODEL ?? "sonic-3.6",
    sttModel: process.env.CARTESIA_STT_MODEL ?? "ink-2",
    voiceId: voice.id,
    voiceName: voice.name,
    version: CARTESIA_VERSION,
  };
};

export const keyMissingResponse = (headers: Record<string, string> = {}) =>
  Response.json({ error: new CartesiaKeyMissing().message, code: "cartesia-key-missing" }, { status: 503, headers });
