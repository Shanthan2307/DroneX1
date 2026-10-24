// The signed-in account: its profile, its sessions (one per computer) and
// deleting it. Shapes follow core/crates/uxduck-contracts/src/dto/account.rs.

import { Hono } from "hono";
import { type Ctx, type Env, type SessionRow, refuse, requireSession } from "../session.ts";
import { newCode, sameHash, sha256, signSession } from "../crypto.ts";

const USERNAME = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const DELETE_TTL_MS = 30 * 60_000;

interface UserRow {
  id: string;
  email: string;
  name: string;
  username: string | null;
  product_updates: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function meRoutes(ctx: Ctx): Hono<Env> {
  const me = new Hono<Env>();
  for (const path of ["/me", "/me/*", "/updates/*"]) me.use(path, requireSession(ctx));

  const user = (id: string) =>
    ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;

  me.get("/me", (c) => {
    const u = user(c.get("session").user_id);
    if (!u) return c.json(refuse("Sign in again."), 401);
    return c.json({
      user: { id: u.id, email: u.email, name: u.name, username: u.username },
      productUpdates: u.product_updates === 1,
      analyticsExcluded: false,
      signedSession: { token: signSession(ctx.secret, u.id, ctx.now()) },
    });
  });

  me.put("/me/username", async (c) => {
    const { username } = await c.req.json().catch(() => ({}));
    const wanted = typeof username === "string" ? username.trim().toLowerCase() : "";
    if (!USERNAME.test(wanted)) {
      return c.json(
        refuse("Use 3 to 32 letters, digits, - or _, starting with a letter or digit."),
        400,
      );
    }
    const id = c.get("session").user_id;
    const taken = ctx.db
      .prepare("SELECT 1 FROM users WHERE username = ? AND id != ?")
      .get(wanted, id);
    if (taken) return c.json(refuse("That username is taken."), 409);
    ctx.db.prepare("UPDATE users SET username = ? WHERE id = ?").run(wanted, id);
    return c.json({ username: wanted });
  });

  me.put("/updates/me", async (c) => {
    const { subscribed } = await c.req.json().catch(() => ({}));
    if (typeof subscribed !== "boolean") return c.json(refuse("subscribed must be true or false."), 400);
    ctx.db
      .prepare("UPDATE users SET product_updates = ? WHERE id = ?")
      .run(subscribed ? 1 : 0, c.get("session").user_id);
    return c.json({ subscribed });
  });

  me.get("/me/sessions", (c) => {
    const current = c.get("session");
    const rows = ctx.db
      .prepare(
        "SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_active_at DESC",
      )
      .all(current.user_id, ctx.now()) as unknown as SessionRow[];
    return c.json({
      sessions: rows.map((s) => ({
        id: s.id,
        current: s.id === current.id,
        computer: s.computer,
        userAgent: s.user_agent,
        createdAt: iso(s.created_at),
        lastActiveAt: iso(s.last_active_at),
      })),
    });
  });

  // Core names its session after the computer right after signing in.
  me.put("/me/sessions/current", async (c) => {
    const { name } = await c.req.json().catch(() => ({}));
    if (typeof name !== "string" || name.length === 0 || name.length > 64) {
      return c.json(refuse("A computer name is 1 to 64 characters."), 400);
    }
    ctx.db.prepare("UPDATE sessions SET computer = ? WHERE id = ?").run(name, c.get("session").id);
    return c.json({});
  });

  me.delete("/me/sessions/:id", (c) => {
    const result = ctx.db
      .prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?")
      .run(c.req.param("id"), c.get("session").user_id);
    if (result.changes === 0) return c.json(refuse("No such session."), 404);
    return c.json({});
  });

  me.post("/me/sessions/sign-out-others", (c) => {
    const s = c.get("session");
    ctx.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(s.user_id, s.id);
    return c.json({});
  });

  // Deleting the account: a code goes to its email, and confirm takes it.
  me.post("/me/delete", async (c) => {
    const u = user(c.get("session").user_id);
    if (!u) return c.json(refuse("Sign in again."), 401);
    const code = newCode();
    ctx.db
      .prepare(
        `INSERT INTO deletions (user_id, code_hash, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`,
      )
      .run(u.id, sha256(code), ctx.now() + DELETE_TTL_MS);
    await ctx.mailer.send(
      u.email,
      "Confirm deleting your account",
      `To delete your account and everything in it, use code ${code} within 30 minutes.`,
    );
    return c.json({});
  });

  me.get("/me/delete/check", (c) => {
    const pending = ctx.db
      .prepare("SELECT expires_at FROM deletions WHERE user_id = ? AND expires_at > ?")
      .get(c.get("session").user_id, ctx.now());
    return c.json({ pending: Boolean(pending) });
  });

  me.post("/me/delete/confirm", async (c) => {
    const { code } = await c.req.json().catch(() => ({}));
    const id = c.get("session").user_id;
    const pending = ctx.db
      .prepare("SELECT code_hash FROM deletions WHERE user_id = ? AND expires_at > ?")
      .get(id, ctx.now()) as { code_hash: string } | undefined;
    if (!pending || typeof code !== "string" || !sameHash(pending.code_hash, sha256(code.trim()))) {
      return c.json(refuse("That code is not right or has expired."), 400);
    }
    // Sessions and the pending deletion go with the user (ON DELETE CASCADE).
    ctx.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return c.json({ deleted: true });
  });

  return me;
}
