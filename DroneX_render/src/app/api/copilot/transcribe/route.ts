// POST /api/copilot/transcribe (multipart, field "audio"): batch speech-to-text through Cartesia Ink, for
// browsers that cannot stream to the Ink WebSocket. Returns {text}. The streaming path on the page is the
// normal one; this is the fallback and the terminal test: curl -F audio=@clip.wav localhost:3000/api/copilot/transcribe
import { CartesiaKeyMissing, cartesiaClient, keyMissingResponse } from "@/lib/copilot/cartesia";

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "expected a multipart form with an audio file" }, { status: 400 });
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) return Response.json({ error: "audio is required" }, { status: 400 });
  if (audio.size > MAX_BYTES) return Response.json({ error: "audio is too large" }, { status: 413 });
  let client;
  try {
    client = cartesiaClient();
  } catch (e) {
    if (e instanceof CartesiaKeyMissing) return keyMissingResponse();
    throw e;
  }
  try {
    const name = audio instanceof File && audio.name ? audio.name : "clip.webm";
    const file = new File([await audio.arrayBuffer()], name, { type: audio.type || "audio/webm" });
    const r = await client.stt.transcribe({ file, model: "ink-whisper", language: "en" });
    return Response.json({ text: r.text, durationS: r.duration ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dronex copilot] transcribe", message);
    return Response.json({ error: `Cartesia could not transcribe: ${message}` }, { status: 502 });
  }
}
