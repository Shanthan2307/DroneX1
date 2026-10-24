// Email sign-in with a 6-digit code, at the paths Core calls (better-auth's
// email-OTP and bearer plugin paths): the token comes back in
// `set-auth-token`, and every later call sends it as a bearer token.

import { Hono } from "hono";
import { type Ctx, type Env, SESSION_TTL_MS, refuse, requireSession } from "../session.ts";
import { newCode, newId, newToken, sameHash, sha256 } from "../crypto.ts";

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const normalize = (email: unknown): string | null =>
  typeof email === "string" && EMAIL.test(email.trim()) ? email.trim().toLowerCase() : null;

export function authRoutes(ctx: Ctx): Hono<Env> {
  const auth = new Hono<Env>();

  auth.post("/email-otp/send-verification-otp", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const email = normalize(body.email);
    if (!email) return c.json(refuse("Enter a valid email address."), 400);
    const code = newCode();
    ctx.db
      .prepare(
        `INSERT INTO otps (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
         ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash,
           expires_at = excluded.expires_at, attempts = 0`,
      )
      .run(email, sha256(code), ctx.now() + CODE_TTL_MS);
    await ctx.mailer.send(
      email,
      "Your sign-in code",
      `Your code is ${code}. It expires in 10 minutes.`,
    );
    return c.json({ success: true });
  });

  auth.post("/sign-in/email-otp", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const email = normalize(body.email);
    const otp = typeof body.otp === "string" ? body.otp.trim() : "";
    if (!email || !/^\d{6}$/.test(otp)) return c.json(refuse("Enter the 6-digit code."), 400);

    const now = ctx.now();
    const pending = ctx.db.prepare("SELECT * FROM otps WHERE email = ?").get(email) as
      | { code_hash: string; expires_at: number; attempts: number }
      | undefined;
    if (!pending || pending.expires_at <= now) {
      return c.json(refuse("That code has expired. Ask for a new one."), 400);
    }
    if (pending.attempts >= MAX_ATTEMPTS) {
      return c.json(refuse("Too many tries. Ask for a new code."), 429);
    }
    if (!sameHash(pending.code_hash, sha256(otp))) {
      ctx.db.prepare("UPDATE otps SET attempts = attempts + 1 WHERE email = ?").run(email);
      return c.json(refuse("That code is not right."), 400);
    }
    ctx.db.prepare("DELETE FROM otps WHERE email = ?").run(email);

    let user = ctx.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
      | { id: string; email: string; name: string }
      | undefined;
    const isNew = !user;
    if (!user) {
      user = { id: newId("us"), email, name: "" };
      ctx.db
        .prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, '', ?)")
        .run(user.id, email, now);
    }

    const token = newToken();
    ctx.db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, last_active_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("se"),
        user.id,
        sha256(token),
        c.req.header("user-agent")?.slice(0, 200) ?? null,
        now,
        now,
        now + SESSION_TTL_MS,
      );
    c.header("set-auth-token", token);
    c.header("access-control-expose-headers", "set-auth-token");
    return c.json({ isNew, token, user: { id: user.id, email: user.email, name: user.name } });
  });

  auth.post("/sign-out", requireSession(ctx), (c) => {
    ctx.db.prepare("DELETE FROM sessions WHERE id = ?").run(c.get("session").id);
    return c.json({ success: true });
  });

  return auth;
}
