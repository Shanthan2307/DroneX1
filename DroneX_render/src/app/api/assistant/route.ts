// POST /api/assistant {messages, build, name?, selected?}: the build assistant's answer about the drone on the
// pad (src/lib/ai/assistant.ts): a short reply to speak, changes offered as buttons, changes the builder asked to
// apply, and the tools that ran. The configurator page speaks the reply through Cartesia Sonic.
import { answer, SLOTS, type AssistantRequest, type AssistantTurn, type Slot } from "@/lib/ai/assistant";
import { checkBuild } from "@/lib/catalog/server";
import { limitRequest, spendBudget } from "@/lib/rateLimit";

// Input caps (cost): each turn is cut to 2,000 characters, the conversation to 20 turns and 12,000 characters.
const MAX_TURN_CHARS = 2000;
const MAX_TURNS = 20;
const MAX_TOTAL_CHARS = 12_000;
const MAX_NAME_CHARS = 80;

const isTurn = (t: unknown): t is AssistantTurn =>
  typeof t === "object" && t !== null && ((t as AssistantTurn).role === "user" || (t as AssistantTurn).role === "assistant") && typeof (t as AssistantTurn).content === "string";

export async function POST(request: Request) {
  const limited = limitRequest(request, "assistant");
  if (limited) return limited;
  let body: { messages?: unknown; build?: unknown; name?: unknown; selected?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }
  if (Array.isArray(body.messages) && body.messages.length > MAX_TURNS) return Response.json({ error: `at most ${MAX_TURNS} messages` }, { status: 400 });
  const messages = Array.isArray(body.messages) ? body.messages.filter(isTurn).map((t) => ({ role: t.role, content: t.content.slice(0, MAX_TURN_CHARS) })) : [];
  if (messages.reduce((n, m) => n + m.content.length, 0) > MAX_TOTAL_CHARS) return Response.json({ error: "the conversation is too long; start a new one" }, { status: 400 });
  if (!messages.length || messages[messages.length - 1].role !== "user") return Response.json({ error: "messages must end with the builder's question" }, { status: 400 });
  const checked = checkBuild(body.build);
  if (!checked.ok) return Response.json({ error: `build: ${checked.reason}` }, { status: 400 });
  const sel = body.selected as { slot?: unknown; partId?: unknown } | null | undefined;
  const selected = sel && typeof sel.slot === "string" && (SLOTS as string[]).includes(sel.slot) ? { slot: sel.slot as Slot, partId: typeof sel.partId === "string" ? sel.partId : null } : null;
  const req: AssistantRequest = { messages, build: checked.build, name: typeof body.name === "string" ? body.name.slice(0, MAX_NAME_CHARS) : null, selected };
  const spent = spendBudget("llm");
  if (spent) return spent;
  try {
    return Response.json(await answer(req), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dronex assistant]", message);
    return Response.json({ error: message }, { status: 502 });
  }
}
