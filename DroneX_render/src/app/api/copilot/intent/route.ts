// POST /api/copilot/intent {text, vehicleId?}: the pilot's words become a tool call on the simulation engine and
// a short spoken reply. Used by the voice copilot (Cartesia) after transcription and by the Dispatch flight agent
// (Fetch.ai) for mission commands. The model picks the tool; the engine does the work; the receipt is the truth.
import { act } from "@/lib/ai/intent";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function POST(request: Request) {
  let body: { text?: string; vehicleId?: string | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400, headers: CORS });
  }
  const text = (body.text ?? "").trim();
  if (!text) return Response.json({ error: "text is required" }, { status: 400, headers: CORS });
  try {
    return Response.json(await act(text, { vehicleId: body.vehicleId ?? null }), { headers: CORS });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dronex copilot]", message);
    return Response.json({ error: message }, { status: 502, headers: CORS });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
