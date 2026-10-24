import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { createApp } from "../src/app.ts";
import { verifySession } from "../src/crypto.ts";
import { openDb } from "../src/db.ts";
import { MemoryMailer } from "../src/mailer.ts";

const SECRET = "test-secret-test-secret-test-secret!";
let clock = 1_800_000_000_000;
let mailer: MemoryMailer;
let app: ReturnType<typeof createApp>;

const call = (method: string, path: string, body?: unknown, token?: string) =>
  app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Signs in as Core does and returns the bearer token. */
async function signIn(email: string): Promise<{ token: string; isNew: boolean }> {
  assert.equal((await call("POST", "/v1/auth/email-otp/send-verification-otp", { email, type: "sign-in" })).status, 200);
  const res = await call("POST", "/v1/auth/sign-in/email-otp", { email, otp: mailer.codeFor(email.toLowerCase()) });
  assert.equal(res.status, 200);
  const token = res.headers.get("set-auth-token");
  assert.ok(token);
  return { token, isNew: (await res.json()).isNew };
}

beforeEach(() => {
  clock = 1_800_000_000_000;
  mailer = new MemoryMailer();
  app = createApp({ db: openDb(":memory:"), mailer, secret: SECRET, now: () => clock });
});

describe("sign-in", () => {
  test("a new email makes an account; the second sign-in does not", async () => {
    assert.equal((await signIn("Pilot@Example.com")).isNew, true);
    assert.equal((await signIn("pilot@example.com")).isNew, false);
  });

  test("/v1/me has the shape Core reads, with a 5-minute signed session", async () => {
    const { token } = await signIn("pilot@example.com");
    const me = await (await call("GET", "/v1/me", undefined, token)).json();
    assert.equal(me.user.email, "pilot@example.com");
    assert.match(me.user.id, /^us[0-9a-f]{16}$/);
    assert.equal(me.productUpdates, false);
    assert.equal(verifySession(SECRET, me.signedSession.token, clock), me.user.id);
    assert.equal(verifySession(SECRET, me.signedSession.token, clock + 5 * 60_000 + 1), null);
  });

  test("a wrong code is refused, and five wrong codes lock it", async () => {
    const email = "pilot@example.com";
    await call("POST", "/v1/auth/email-otp/send-verification-otp", { email });
    const wrong = mailer.codeFor(email) === "000000" ? "111111" : "000000";
    const res = await call("POST", "/v1/auth/sign-in/email-otp", { email, otp: wrong });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).message, "That code is not right.");
    for (let i = 0; i < 4; i++) await call("POST", "/v1/auth/sign-in/email-otp", { email, otp: wrong });
    const locked = await call("POST", "/v1/auth/sign-in/email-otp", { email, otp: mailer.codeFor(email) });
    assert.equal(locked.status, 429);
  });

  test("a code expires after 10 minutes", async () => {
    const email = "pilot@example.com";
    await call("POST", "/v1/auth/email-otp/send-verification-otp", { email });
    clock += 10 * 60_000 + 1;
    const res = await call("POST", "/v1/auth/sign-in/email-otp", { email, otp: mailer.codeFor(email) });
    assert.equal(res.status, 400);
  });

  test("no token, or a signed-out one, is 401", async () => {
    assert.equal((await call("GET", "/v1/me")).status, 401);
    const { token } = await signIn("pilot@example.com");
    assert.equal((await call("POST", "/v1/auth/sign-out", {}, token)).status, 200);
    assert.equal((await call("GET", "/v1/me", undefined, token)).status, 401);
  });
});

describe("account", () => {
  test("username: valid, taken, and invalid", async () => {
    const a = await signIn("a@example.com");
    const b = await signIn("b@example.com");
    assert.equal((await call("PUT", "/v1/me/username", { username: "ace" }, a.token)).status, 200);
    assert.equal((await call("PUT", "/v1/me/username", { username: "ace" }, b.token)).status, 409);
    assert.equal((await call("PUT", "/v1/me/username", { username: "x" }, b.token)).status, 400);
    const me = await (await call("GET", "/v1/me", undefined, a.token)).json();
    assert.equal(me.user.username, "ace");
  });

  test("product updates switch", async () => {
    const { token } = await signIn("pilot@example.com");
    await call("PUT", "/v1/updates/me", { subscribed: true }, token);
    assert.equal((await (await call("GET", "/v1/me", undefined, token)).json()).productUpdates, true);
  });

  test("sessions: named, listed, signed out singly and all others", async () => {
    const one = await signIn("pilot@example.com");
    const two = await signIn("pilot@example.com");
    await call("PUT", "/v1/me/sessions/current", { name: "Field laptop" }, one.token);
    let list = (await (await call("GET", "/v1/me/sessions", undefined, one.token)).json()).sessions;
    assert.equal(list.length, 2);
    const mine = list.find((s: { current: boolean }) => s.current);
    assert.equal(mine.computer, "Field laptop");
    assert.ok(mine.createdAt && mine.lastActiveAt);

    await call("POST", "/v1/me/sessions/sign-out-others", undefined, one.token);
    assert.equal((await call("GET", "/v1/me", undefined, two.token)).status, 401);
    list = (await (await call("GET", "/v1/me/sessions", undefined, one.token)).json()).sessions;
    assert.equal(list.length, 1);

    assert.equal((await call("DELETE", `/v1/me/sessions/${mine.id}`, undefined, one.token)).status, 200);
    assert.equal((await call("GET", "/v1/me", undefined, one.token)).status, 401);
  });

  test("deleting the account needs the emailed code", async () => {
    const { token } = await signIn("pilot@example.com");
    await call("POST", "/v1/me/delete", undefined, token);
    assert.equal((await (await call("GET", "/v1/me/delete/check", undefined, token)).json()).pending, true);
    assert.equal((await call("POST", "/v1/me/delete/confirm", { code: "999999x" }, token)).status, 400);
    const code = mailer.sent.at(-1)?.text.match(/\d{6}/)?.[0];
    assert.equal((await call("POST", "/v1/me/delete/confirm", { code }, token)).status, 200);
    assert.equal((await call("GET", "/v1/me", undefined, token)).status, 401);
    assert.equal((await signIn("pilot@example.com")).isNew, true);
  });
});
