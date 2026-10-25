// POST /api/copilot/speak {text}: the text as speech from Cartesia Sonic, server-side, as a WAV
// (16-bit, 24 kHz). The page's fallback when it has no WebSocket to Sonic, and the easy way to hear a callout
// from a terminal: curl -s -X POST localhost:3000/api/copilot/speak -H 'content-type: application/json' \
//   -d '{"text":"battery thirty percent, head home"}' -o callout.wav
// POST only: a GET would let any link or <img> on the web spend the Cartesia budget.
import { CartesiaKeyMissing, cartesiaClient, keyMissingResponse, voiceSettings } from "@/lib/copilot/cartesia";
import { limitRequest, spendBudget } from "@/lib/rateLimit";

const MAX_CHARS = 600;

async function speak(text: string): Promise<Response> {
  const t = text.trim().slice(0, MAX_CHARS);
  if (!t) return Response.json({ error: "text is required" }, { status: 400 });
  const spent = spendBudget("cartesia");
  if (spent) return spent;
  let client;
  try {
    client = cartesiaClient();
  } catch (e) {
    if (e instanceof CartesiaKeyMissing) return keyMissingResponse();
    throw e;
  }
  try {
    const { ttsModel, voiceId } = await voiceSettings(client);
    const res = await client.tts.generate({
      model_id: ttsModel,
      transcript: t,
      voice: { id: voiceId },
      language: "en",
      output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: 24000 },
    });
    const bytes = await res.arrayBuffer();
    return new Response(bytes, { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Spoken-Chars": String(t.length) } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dronex copilot] speak", message);
    return Response.json({ error: `Cartesia could not speak: ${message}` }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const limited = limitRequest(request, "speak");
  if (limited) return limited;
  let body: { text?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected JSON {text}" }, { status: 400 });
  }
  return speak(body.text ?? "");
}

