// POST /api/copilot/token: a short-lived Cartesia access token (TTS and STT grants, ten minutes) for the browser,
// plus the voice settings the page needs to open the Sonic and Ink WebSockets itself. The API key stays here.
// Only for this configurator's own pages (Origin must be DRONEX_PUBLIC_URL), 6 per hour per visitor, and a daily
// cap on mints overall (DRONEX_DAILY_CARTESIA_TOKENS).
import { CartesiaKeyMissing, cartesiaClient, keyMissingResponse, voiceSettings } from "@/lib/copilot/cartesia";
import { configuratorOrigin } from "@/lib/publicUrls";
import { limitRequest, spendBudget } from "@/lib/rateLimit";

// Kept at ten minutes on purpose. docs/DEPLOY.md item 15 suggests 120 s, but whether an open Sonic/Ink socket
// survives its token expiring is untested; a shorter token could cut a pilot off mid-flight. Lower it only after
// testing that, together with the page's refresh margin (expiresAt below).
const TOKEN_SECONDS = 600;

export async function POST(request: Request) {
  // Deployed (DRONEX_PUBLIC_URL set; production refuses to start without it) the Origin must match; on a laptop
  // the page may be opened as localhost or 127.0.0.1, so there is no check.
  const publicOrigin = process.env.DRONEX_PUBLIC_URL?.trim() ? configuratorOrigin(request) : null;
  if (publicOrigin && request.headers.get("origin") !== publicOrigin) return Response.json({ error: "tokens are for this site's own pages" }, { status: 403 });
  const limited = limitRequest(request, "token");
  if (limited) return limited;
  let client;
  try {
    client = cartesiaClient();
  } catch (e) {
    if (e instanceof CartesiaKeyMissing) return keyMissingResponse();
    throw e;
  }
  const spent = spendBudget("cartesiaToken");
  if (spent) return spent;
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
