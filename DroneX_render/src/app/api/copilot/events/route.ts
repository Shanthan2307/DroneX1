// GET /api/copilot/events: Server-Sent Events from the copilot feed (src/lib/copilot/feed.ts): a `hello` with
// every vehicle and its latest snapshot, then `vehicles`, `snapshot` (rate-limited) and `callout` messages as the
// simulation engine reports changes. The callouts are derived in code from telemetry; the page speaks them
// through Cartesia. One daemon connection serves every open stream. A visitor sees only the vehicles in their
// ownership cookie (read when the stream opens); 3 open streams per address and 200 in all.
import { connection } from "next/server";
import { copilotFeed } from "@/lib/copilot/feed";
import { visibleEvent } from "@/lib/copilot/visible";
import { isAgent } from "@/lib/agentAuth";
import { allowedVehicles } from "@/lib/ownership";
import { clientIp, limitRequest } from "@/lib/rateLimit";
import { streamGate } from "@/lib/streams";

export async function GET(request: Request) {
  await connection();
  const limited = limitRequest(request, "events");
  if (limited) return limited;
  const gateKey = isAgent(request) ? "agent" : clientIp(request.headers);
  const gate = streamGate();
  if (!gate.tryOpen(gateKey)) return Response.json({ error: "too many open copilot streams" }, { status: 429, headers: { "Retry-After": "30" } });
  const allowed = allowedVehicles(request);
  const feed = copilotFeed();
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let released = false;
  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (!released) {
      released = true;
      gate.close(gateKey);
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: Parameters<typeof visibleEvent>[0]) => {
        const shown = visibleEvent(data, allowed);
        if (!shown) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(shown)}\n\n`));
        } catch {
          cleanup();
        }
      };
      unsubscribe = feed.subscribe(send);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping ${feed.lastError ? "error" : "ok"}\n\n`));
        } catch {
          cleanup();
        }
      }, 15_000);
      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
