// The hosted model (core/crates/uxduck-agent/src/provider/hosted.rs): Core
// speaks Anthropic's or OpenAI's own API to /v1/model with the 5-minute signed
// session from /v1/me as its key. We check the session, swap in this server's
// key, stream the vendor's answer back untouched and count the tokens.
//
// Turns whose chat allows it (`x-uxduck-share: conversations`) are kept as a
// preview, so feedback can find them and the account can list or delete them
// (/v1/turns/*). The conversation itself is never stored here unless the
// operator sends it with /v1/turns/send.

import { Hono } from "hono";
import { verifySession, newId } from "../crypto.ts";
import { type Ctx, type Env, refuse, requireSession } from "../session.ts";

export interface ModelKeys {
  anthropic?: string;
  openai?: string;
  /** Tokens (in + out) one account may use a day; 0 or unset is no limit. */
  dailyTokens?: number;
  /** Only for tests. */
  fetch?: typeof fetch;
  anthropicBase?: string;
  openaiBase?: string;
}

/** How long kept turns stay, as the account page says. */
export const KEPT_FOR_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
const PREVIEW_CHARS = 200;
/** Headers Core sets that the vendor needs too. */
const PASSED = ["anthropic-version", "anthropic-beta", "content-type", "accept"];
/** Headers of the vendor's answer worth handing back. */
const RETURNED = ["content-type", "request-id", "x-request-id", "retry-after"];

type Vendor = "anthropic" | "openai";

interface Usage {
  id?: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Core reads `error.message` from a refusal of type `uxduck` as the account's own words. */
const modelRefusal = (message: string) => ({ type: "error", error: { type: "uxduck", message } });

/** What the answer's events say about its id and tokens, read as they pass. */
function meter(vendor: Vendor, usage: Usage, event: unknown) {
  if (typeof event !== "object" || event === null) return;
  const e = event as Record<string, any>;
  if (vendor === "anthropic") {
    const message = e.type === "message_start" ? e.message : e.type === "message" ? e : null;
    const u = message?.usage ?? (e.type === "message_delta" ? e.usage : null);
    if (message?.id) usage.id = message.id;
    if (message?.model) usage.model = message.model;
    if (u) {
      if (typeof u.input_tokens === "number") usage.input = u.input_tokens;
      if (typeof u.output_tokens === "number") usage.output = u.output_tokens;
      if (typeof u.cache_read_input_tokens === "number") usage.cacheRead = u.cache_read_input_tokens;
      if (typeof u.cache_creation_input_tokens === "number") usage.cacheWrite = u.cache_creation_input_tokens;
    }
  } else {
    const response = e.response ?? (e.object === "response" ? e : null);
    if (response?.id) usage.id = response.id;
    if (response?.model) usage.model = response.model;
    const u = response?.usage;
    if (u) {
      usage.input = u.input_tokens ?? usage.input;
      usage.output = u.output_tokens ?? usage.output;
      usage.cacheRead = u.input_tokens_details?.cached_tokens ?? usage.cacheRead;
    }
  }
}

/** The operator's last words in a request, for the account's list of kept turns. */
function preview(vendor: Vendor, body: Record<string, any>): string {
  const turns: any[] = (vendor === "anthropic" ? body.messages : body.input) ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t?.role !== "user") continue;
    const parts = typeof t.content === "string" ? [{ type: "text", text: t.content }] : t.content ?? [];
    const text = parts
      .filter((p: any) => (p?.type === "text" || p?.type === "input_text") && typeof p.text === "string")
      .map((p: any) => p.text)
      .join(" ")
      .trim();
    if (text) return text.slice(0, PREVIEW_CHARS);
  }
  return "";
}

export function modelRoutes(ctx: Ctx, keys: ModelKeys): Hono<Env> {
  const m = new Hono<Env>();
  const send = keys.fetch ?? fetch;
  const day = () => Math.floor(ctx.now() / DAY_MS);

  const usedToday = (userId: string) =>
    (ctx.db
      .prepare("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM model_usage WHERE user_id = ? AND day = ?")
      .get(userId, day()) as { n: number }).n;

  function record(userId: string, thread: string, share: boolean, continues: string, request: Record<string, any>, vendor: Vendor, usage: Usage) {
    ctx.db
      .prepare(
        `INSERT INTO model_usage (user_id, day, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, day) DO UPDATE SET
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`,
      )
      .run(userId, day(), usage.input, usage.output, usage.cacheRead, usage.cacheWrite);
    if (!share || !usage.id) return;
    // A tool round or summary continues an earlier response: the same turn.
    const earlier = continues
      ? (ctx.db
          .prepare("SELECT turn_id FROM model_turns WHERE user_id = ? AND response_id = ?")
          .get(userId, continues) as { turn_id: string } | undefined)
      : undefined;
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO model_turns (user_id, response_id, turn_id, thread, model, preview, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, usage.id, earlier?.turn_id ?? usage.id, thread, usage.model ?? String(request.model ?? ""),
        earlier ? "" : preview(vendor, request), ctx.now());
  }

  const proxy = (vendor: Vendor) => async (c: any) => {
    const header = c.req.header("authorization") ?? c.req.header("x-api-key") ?? "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    const userId = token ? verifySession(ctx.secret, token, ctx.now()) : null;
    if (!userId) return c.json(modelRefusal("Sign in again to use the agent."), 401);

    const key = vendor === "anthropic" ? keys.anthropic : keys.openai;
    if (!key) {
      const which = vendor === "anthropic" ? "Claude" : "OpenAI";
      return c.json(modelRefusal(`This server has no ${which} key. Pick another model or add your own key.`), 503);
    }
    if (keys.dailyTokens && usedToday(userId) >= keys.dailyTokens) {
      return c.json(modelRefusal("You have used today's agent allowance. It resets at midnight UTC."), 429);
    }

    const text = await c.req.text();
    let request: Record<string, any>;
    try {
      request = JSON.parse(text);
    } catch {
      return c.json(modelRefusal("The request was not JSON."), 400);
    }

    const headers = new Headers();
    for (const name of PASSED) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    if (vendor === "anthropic") headers.set("x-api-key", key);
    else headers.set("authorization", `Bearer ${key}`);
    const url =
      vendor === "anthropic"
        ? `${keys.anthropicBase ?? "https://api.anthropic.com"}/v1/messages`
        : `${keys.openaiBase ?? "https://api.openai.com"}/v1/responses`;

    let upstream: Response;
    try {
      upstream = await send(url, { method: "POST", headers, body: text, signal: c.req.raw.signal });
    } catch {
      return c.json(modelRefusal("The model's company could not be reached. Try again."), 502);
    }

    const out = new Headers({ "cache-control": "no-store" });
    for (const name of RETURNED) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    // Failures go back as the vendor said them; Core explains them itself.
    if (!upstream.ok || !upstream.body) return new Response(upstream.body, { status: upstream.status, headers: out });

    const thread = c.req.header("x-uxduck-thread") ?? "";
    const share = c.req.header("x-uxduck-share") === "conversations";
    const continues = c.req.header("x-uxduck-continues") ?? "";
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const streamed = (upstream.headers.get("content-type") ?? "").includes("event-stream");
    const decoder = new TextDecoder();
    let pending = "";
    const read = (chunk: string) => {
      if (!streamed) {
        pending += chunk;
        return;
      }
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          meter(vendor, usage, JSON.parse(line.slice(5)));
        } catch {}
      }
    };
    const counted = upstream.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          read(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
        flush() {
          read(decoder.decode());
          if (!streamed) {
            try {
              meter(vendor, usage, JSON.parse(pending));
            } catch {}
          }
          record(userId, thread, share, continues, request, vendor, usage);
        },
      }),
    );
    return new Response(counted, { status: upstream.status, headers: out });
  };

  m.post("/model/messages", proxy("anthropic"));
  m.post("/model/v1/messages", proxy("anthropic"));
  m.post("/model/responses", proxy("openai"));
  m.post("/model/v1/responses", proxy("openai"));

  // Kept turns, for the account page and feedback.
  m.use("/turns/*", requireSession(ctx));

  const prune = () => ctx.db.prepare("DELETE FROM model_turns WHERE created_at < ?").run(ctx.now() - KEPT_FOR_DAYS * DAY_MS);

  m.post("/turns/feedback", async (c) => {
    const { responseId, rating, comment } = await c.req.json().catch(() => ({}));
    if (typeof responseId !== "string") return c.json(refuse("responseId is missing."), 400);
    prune();
    const turn = ctx.db
      .prepare("SELECT turn_id FROM model_turns WHERE user_id = ? AND response_id = ?")
      .get(c.get("session").user_id, responseId) as { turn_id: string } | undefined;
    if (!turn) return c.json(refuse("That conversation was not kept."), 404);
    ctx.db
      .prepare("UPDATE model_turns SET rating = ?, comment = ? WHERE user_id = ? AND response_id = ?")
      .run(typeof rating === "string" ? rating : null, typeof comment === "string" ? comment.slice(0, 4000) : null,
        c.get("session").user_id, turn.turn_id);
    return c.json({ ok: true });
  });

  m.post("/turns/send", async (c) => {
    const { thread, model, items, rating, comment } = await c.req.json().catch(() => ({}));
    if (!Array.isArray(items) || items.length === 0) return c.json(refuse("There is nothing to send."), 400);
    const first = items.find((i: any) => i?.kind === "userMessage" && typeof i.text === "string");
    const id = newId("tn");
    ctx.db
      .prepare(
        `INSERT INTO model_turns (user_id, response_id, turn_id, thread, model, preview, created_at, rating, comment, items)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.get("session").user_id, id, id, typeof thread === "string" ? thread : "",
        typeof model === "string" ? model : "", (first?.text ?? "").slice(0, PREVIEW_CHARS), ctx.now(),
        typeof rating === "string" ? rating : null, typeof comment === "string" ? comment.slice(0, 4000) : null,
        JSON.stringify(items));
    return c.json({ ok: true });
  });

  m.get("/turns/mine", (c) => {
    prune();
    const rows = ctx.db
      .prepare(
        "SELECT turn_id, model, preview, created_at FROM model_turns WHERE user_id = ? AND response_id = turn_id ORDER BY created_at DESC LIMIT 100",
      )
      .all(c.get("session").user_id) as { turn_id: string; model: string; preview: string; created_at: number }[];
    const { n } = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM model_turns WHERE user_id = ? AND response_id = turn_id")
      .get(c.get("session").user_id) as { n: number };
    return c.json({
      count: n,
      keptForDays: KEPT_FOR_DAYS,
      turns: rows.map((r) => ({
        id: r.turn_id,
        model: r.model,
        preview: r.preview,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  });

  m.delete("/turns/mine", (c) => {
    const { changes } = ctx.db
      .prepare("DELETE FROM model_turns WHERE user_id = ? AND response_id = turn_id")
      .run(c.get("session").user_id);
    ctx.db.prepare("DELETE FROM model_turns WHERE user_id = ?").run(c.get("session").user_id);
    return c.json({ deleted: Number(changes) });
  });

  return m;
}
