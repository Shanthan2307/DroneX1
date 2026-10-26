// POST /api/copilot/intent {text, vehicleId?, lockVehicle?}: the pilot's words become a tool call on the simulation
// engine and a short spoken reply. Used by the voice copilot (Cartesia) after transcription and by the Dispatch
// flight agent (Fetch.ai) for mission commands. The model picks the tool; the engine does the work; the receipt is
// the truth. A visitor commands only the vehicles in their ownership cookie; an agent (x-dronex-agent) may send
// `lockVehicle`, and then every command targets that vehicle whatever the model says.
import { isAgent } from "@/lib/agentAuth";
import { act, type VehicleScope } from "@/lib/ai/intent";
import { allowedVehicles } from "@/lib/ownership";
import { limitRequest, spendBudget } from "@/lib/rateLimit";
import { requireSimulator } from "@/lib/mode";

const MAX_TEXT = 500;

export async function POST(request: Request) {
  const off = requireSimulator();
  if (off) return off;
  const limited = limitRequest(request, "intent");
  if (limited) return limited;
  let body: { text?: unknown; vehicleId?: unknown; lockVehicle?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "text is required" }, { status: 400 });
  if (text.length > MAX_TEXT) return Response.json({ error: `text is too long (${MAX_TEXT} characters at most)` }, { status: 400 });
  const lock = typeof body.lockVehicle === "string" && body.lockVehicle && isAgent(request) ? body.lockVehicle : null;
  const scope: VehicleScope = lock ? { lock } : { allowed: allowedVehicles(request) };
  const spent = spendBudget("llm");
  if (spent) return spent;
  try {
    return Response.json(await act(text, { vehicleId: typeof body.vehicleId === "string" ? body.vehicleId : null, scope }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dronex copilot]", message);
    return Response.json({ error: message }, { status: 502 });
  }
}
