// What every route shares: its dependencies, the bearer-session check and
// the refusal shape Core reads.

import type { MiddlewareHandler } from "hono";
import type { Db } from "./db.ts";
import type { Mailer } from "./mailer.ts";
import { sha256 } from "./crypto.ts";

export interface Ctx {
  db: Db;
  mailer: Mailer;
  /** Signs the short sessions for the hosted model. */
  secret: string;
  now: () => number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  computer: string | null;
  user_agent: string | null;
  created_at: number;
  last_active_at: number;
  expires_at: number;
}

export type Env = { Variables: { session: SessionRow } };

/** Sessions last 90 days from their last use. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60_000;

/** Core reads `message` from any refusal. */
export const refuse = (message: string) => ({ message });

/** Requires `Authorization: Bearer <token>` for a live session. */
export function requireSession(ctx: Ctx): MiddlewareHandler<Env> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const now = ctx.now();
    const session = token
      ? (ctx.db
          .prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?")
          .get(sha256(token), now) as SessionRow | undefined)
      : undefined;
    if (!session) return c.json(refuse("Sign in again."), 401);
    // Sliding expiry, written at most once a minute.
    if (now - session.last_active_at > 60_000) {
      ctx.db
        .prepare("UPDATE sessions SET last_active_at = ?, expires_at = ? WHERE id = ?")
        .run(now, now + SESSION_TTL_MS, session.id);
    }
    c.set("session", session);
    await next();
  };
}
