// POST /api/copilot/token: a short-lived Cartesia access token (TTS and STT grants, ten minutes) for the browser,
// plus the voice settings the page needs to open the Sonic and Ink WebSockets itself. The API key stays here.
import { CartesiaKeyMissing, cartesiaClient, keyMissingResponse, voiceSettings } from "@/lib/copilot/cartesia";

const TOKEN_SECONDS = 600;

export async function POST() {
  let client;
  try {
    client = cartesiaClient();
  } catch (e) {
    if (e instanceof CartesiaKeyMissing) return keyMissingResponse();
    throw e;
  }
  try {
    const settings = await voiceSettings(client);
    const { token } = await client.accessToken.create({ grants: { tts: true, stt: true }, expires_in: TOKEN_SECONDS });
    return Response.json({ token, expiresAt: Date.now() + (TOKEN_SECONDS - 30) * 1000, ...settings }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dronex copilot] token", message);
    return Response.json({ error: `Cartesia refused an access token: ${message}` }, { status: 502 });
  }
}
