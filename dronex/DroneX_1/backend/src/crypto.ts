// Tokens, codes and the short signed session the hosted model takes.

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A random id with a short prefix, like Core's own (`us` + 16 hex). */
export const newId = (prefix: string): string => prefix + randomBytes(8).toString("hex");

/** An opaque bearer token: 32 random bytes, base64url. */
export const newToken = (): string => randomBytes(32).toString("base64url");

/** A 6-digit sign-in code. */
export const newCode = (): string => randomInt(0, 1_000_000).toString().padStart(6, "0");

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The 5-minute signed session `/v1/me` hands out for `/v1/model`:
 * `<payload>.<signature>`, both base64url, HMAC-SHA256 over the payload text.
 */
export function signSession(secret: string, userId: string, now: number, ttlMs = 5 * 60_000): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: now + ttlMs })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/**
 * A signed, expiring token carrying `data`, for URLs that work without a
 * session (storage grants): `<payload>.<signature>`, HMAC-SHA256.
 */
export function signToken(secret: string, purpose: string, data: object, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ ...data, p: purpose, exp: expiresAt })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

/** The data in a token from `signToken`, if it is ours, for `purpose`, and not expired. */
export function verifyToken<T>(secret: string, purpose: string, token: string, now: number): T | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.p === purpose && typeof data.exp === "number" && data.exp > now ? (data as T) : null;
  } catch {
    return null;
  }
}

/** The user a signed session names, if it is ours and not expired. */
export function verifySession(secret: string, token: string, now: number): string | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof sub === "string" && typeof exp === "number" && exp > now ? sub : null;
  } catch {
    return null;
  }
}
