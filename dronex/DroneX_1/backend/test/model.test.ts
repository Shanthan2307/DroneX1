import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { MemoryMailer } from "../src/mailer.ts";
import type { ModelKeys } from "../src/routes/model.ts";

let clock: number;
let mailer: MemoryMailer;
let app: ReturnType<typeof createApp>;
let sent: { url: string; headers: Headers; body: any }[];

/** Anthropic's streamed answer, as Core reads it. */
function stream(id: string, input: number, output: number) {
  const events = [
    { type: "message_start", message: { id, model: "claude-haiku-5-5", usage: { input_tokens: input, output_tokens: 1 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } },
    { type: "message_stop" },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

let answers: Response[];
const fakeFetch = (async (url: string, init: RequestInit) => {
  sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
  return answers.shift()!;
}) as typeof fetch;

function make(model: ModelKeys = {}) {
  clock = Date.UTC(2026, 9, 24, 12);
  mailer = new MemoryMailer();
  sent = [];
  answers = [];
  app = createApp({
    db: openDb(":memory:"),
    mailer,
    secret: "s".repeat(40),
    now: () => clock,
    model: { anthropic: "server-key", fetch: fakeFetch, ...model },
  });
}
beforeEach(() => make());

async function signIn(email = "pilot@example.com") {
  const json = { "content-type": "application/json" };
  await app.request("/v1/auth/email-otp/send-verification-otp", { method: "POST", headers: json, body: JSON.stringify({ email }) });
  const res = await app.request("/v1/auth/sign-in/email-otp", {
    method: "POST", headers: json, body: JSON.stringify({ email, otp: mailer.codeFor(email) }),
  });
  const token = res.headers.get("set-auth-token")!;
  const me = await (await app.request("/v1/me", { headers: { authorization: `Bearer ${token}` } })).json();
  return { token, signed: me.signedSession.token as string };
}

const ask = (signed: string, text: string, extra: Record<string, string> = {}) =>
  app.request("/v1/model/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${signed}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-uxduck-thread": "chat1",
      ...extra,
    },
    body: JSON.stringify({ model: "claude-haiku-5-5", stream: true, messages: [{ role: "user", content: [{ type: "text", text }] }] }),
  });

const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });

test("a signed session reaches Anthropic with the server's key, and the stream comes back whole", async () => {
  const { signed } = await signIn();
  const body = stream("msg_1", 10, 5);
  answers.push(sse(body));
  const res = await ask(signed, "Where is Copter 1?");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), body);
  assert.equal(sent[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent[0].headers.get("x-api-key"), "server-key");
  assert.equal(sent[0].headers.get("anthropic-version"), "2023-06-01");
  assert.equal(sent[0].headers.get("authorization"), null);
  assert.equal(sent[0].headers.get("x-uxduck-thread"), null);
});

test("without a valid signed session the model refuses in Core's words", async () => {
  await signIn();
  const res = await ask("forged.token", "hi");
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.type, "uxduck");
  assert.equal(sent.length, 0);
});

test("an expired signed session is refused", async () => {
  const { signed } = await signIn();
  clock += 6 * 60_000;
  assert.equal((await ask(signed, "hi")).status, 401);
});

test("with no key the server says so", async () => {
  make({ anthropic: undefined });
  const { signed } = await signIn();
  const res = await ask(signed, "hi");
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /no Claude key/);
});

test("the vendor's refusals pass through for Core to explain", async () => {
  const { signed } = await signIn();
  answers.push(Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 }));
  const res = await ask(signed, "hi");
  assert.equal(res.status, 529);
  assert.equal((await res.json()).error.type, "overloaded_error");
});

test("the daily allowance stops an account once its tokens are used", async () => {
  make({ dailyTokens: 20 });
  const { token, signed } = await signIn();
  answers.push(sse(stream("msg_1", 15, 10)));
  await (await ask(signed, "one")).text();
  const res = await ask(signed, "two");
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.type, "uxduck");
  clock += 24 * 60 * 60_000;
  const me = await (await app.request("/v1/me", { headers: { authorization: `Bearer ${token}` } })).json();
  answers.push(sse(stream("msg_2", 1, 1)));
  assert.equal((await ask(me.signedSession.token, "three")).status, 200);
});

test("shared turns are kept as a preview, tool rounds join their turn, and feedback finds them", async () => {
  const { token, signed } = await signIn();
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  answers.push(sse(stream("msg_a", 1, 1)), sse(stream("msg_b", 1, 1)), sse(stream("msg_c", 1, 1)));
  await (await ask(signed, "Take off to 10 m", { "x-uxduck-share": "conversations" })).text();
  await (await ask(signed, "", { "x-uxduck-share": "conversations", "x-uxduck-continues": "msg_a" })).text();
  await (await ask(signed, "Private", { "x-uxduck-share": "none" })).text();

  const mine = await (await app.request("/v1/turns/mine", { headers: auth })).json();
  assert.equal(mine.count, 1);
  assert.equal(mine.keptForDays, 30);
  assert.deepEqual(mine.turns.map((t: any) => [t.id, t.preview]), [["msg_a", "Take off to 10 m"]]);

  const rate = (responseId: string) =>
    app.request("/v1/turns/feedback", { method: "POST", headers: auth, body: JSON.stringify({ responseId, rating: "down", comment: "slow" }) });
  assert.equal((await rate("msg_b")).status, 200);
  assert.equal((await rate("msg_c")).status, 404);

  const del = await (await app.request("/v1/turns/mine", { method: "DELETE", headers: auth })).json();
  assert.deepEqual(del, { deleted: 1 });
  assert.equal((await (await app.request("/v1/turns/mine", { headers: auth })).json()).count, 0);
});

test("a sent conversation is kept and listed", async () => {
  const { token } = await signIn();
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const items = [{ kind: "userMessage", text: "Why did it land?" }, { kind: "agentMessage", text: "Battery." }];
  const res = await app.request("/v1/turns/send", {
    method: "POST", headers: auth, body: JSON.stringify({ thread: "chat1", model: "claude-opus-5-5", items, rating: "up" }),
  });
  assert.equal(res.status, 200);
  const mine = await (await app.request("/v1/turns/mine", { headers: auth })).json();
  assert.equal(mine.turns[0].preview, "Why did it land?");
  assert.equal(mine.turns[0].model, "claude-opus-5-5");
});

test("turns need a session", async () => {
  assert.equal((await app.request("/v1/turns/mine")).status, 401);
});

test("OpenAI models are refused without an OpenAI key", async () => {
  const { signed } = await signIn();
  const res = await app.request("/v1/model/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${signed}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6", input: [] }),
  });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /no OpenAI key/);
});
