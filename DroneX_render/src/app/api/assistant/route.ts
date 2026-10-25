// POST /api/assistant {messages, build, name?, selected?}: the build assistant's answer about the drone on the
// pad (src/lib/ai/assistant.ts): a short reply to speak, changes offered as buttons, changes the builder asked to
// apply, and the tools that ran. The configurator page speaks the reply through Cartesia Sonic.
import { answer, SLOTS, type AssistantRequest, type AssistantTurn, type Slot } from "@/lib/ai/assistant";
import { checkBuild } from "@/lib/catalog/server";

const isTurn = (t: unknown): t is AssistantTurn =>
  typeof t === "object" && t !== null && ((t as AssistantTurn).role === "user" || (t as AssistantTurn).role === "assistant") && typeof (t as AssistantTurn).content === "string";

export async function POST(request: Request) {
  let body: { messages?: unknown; build?: unknown; name?: unknown; selected?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }
  const messages = Array.isArray(body.messages) ? body.messages.filter(isTurn).map((t) => ({ role: t.role, content: t.content.slice(0, 2000) })) : [];
  if (!messages.length || messages[messages.length - 1].role !== "user") return Response.json({ error: "messages must end with the builder's question" }, { status: 400 });
  const checked = checkBuild(body.build);
  if (!checked.ok) return Response.json({ error: `build: ${checked.reason}` }, { status: 400 });
  const sel = body.selected as { slot?: unknown; partId?: unknown } | null | undefined;
  const selected = sel && typeof sel.slot === "string" && (SLOTS as string[]).includes(sel.slot) ? { slot: sel.slot as Slot, partId: typeof sel.partId === "string" ? sel.partId : null } : null;
  const req: AssistantRequest = { messages, build: checked.build, name: typeof body.name === "string" ? body.name : null, selected };
  try {
    return Response.json(await answer(req), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dronex assistant]", message);
    return Response.json({ error: message }, { status: 502 });
  }
}
