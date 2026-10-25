// GET /api/copilot/events: Server-Sent Events from the copilot feed (src/lib/copilot/feed.ts): a `hello` with
// every vehicle and its latest snapshot, then `vehicles`, `snapshot` (rate-limited) and `callout` messages as the
// simulation engine reports changes. The callouts are derived in code from telemetry; the page speaks them
// through Cartesia. One daemon connection serves every open stream.
import { connection } from "next/server";
import { copilotFeed } from "@/lib/copilot/feed";

export async function GET(request: Request) {
  await connection();
  const feed = copilotFeed();
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const cleanup = () => {
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
      };
      unsubscribe = feed.subscribe(send);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping ${feed.lastError ? `error=${JSON.stringify(feed.lastError)}` : "ok"}\n\n`));
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
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
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
