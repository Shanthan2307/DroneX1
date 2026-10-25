// POST /api/scenarios/<id>: run a track scenario and stream what happens as Server-Sent Events, one `data:` line
// per step (src/lib/scenarios/run.ts). One scenario runs at a time; starting one is rate-limited like a Fly.
import { connection } from "next/server";
import { configuratorOrigin } from "@/lib/publicUrls";
import { limitRequest } from "@/lib/rateLimit";
import { runScenario, type ScenarioEvent } from "@/lib/scenarios/run";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const limited = limitRequest(request, "fly");
  if (limited) return limited;
  const { id } = await params;
  const origin = configuratorOrigin(request);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (e: ScenarioEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...e, at: Date.now() })}\n\n`));
        } catch {
          open = false; // the page went away; the scenario keeps running in the simulator
        }
      };
      await runScenario(id, origin, emit);
      if (open) controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
