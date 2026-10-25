// Which simulated vehicles a browser started: a signed HttpOnly cookie listing their Core vehicle ids, set by
// /api/sim/fly. The copilot (intent and events) and the airspace write routes act only on those vehicles for a
// visitor, so nobody can arm, land or steer someone else's drone. HMAC-SHA256 with DRONEX_COOKIE_SECRET; in
// development without it, a random secret for this process. Server-only.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isAgent } from "./agentAuth";

export const OWN_COOKIE = "dronex_own";
export const MAX_OWNED = 8;
const MAX_AGE_S = 24 * 60 * 60;
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

const mac = (payload: string, secret: string): string => createHmac("sha256", secret).update(payload).digest("base64url");

/** `<base64url(JSON ids)>.<hmac>` */
export function signIds(ids: readonly string[], secret: string): string {
  const payload = Buffer.from(JSON.stringify(ids.filter((id) => ID.test(id)).slice(-MAX_OWNED))).toString("base64url");
  return `${payload}.${mac(payload, secret)}`;
}

/** The ids in a cookie value, or null when it is malformed or the signature does not match. */
export function verifyIds(value: string | null | undefined, secret: string): string[] | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(mac(payload, secret));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const ids: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string" && ID.test(x)).slice(-MAX_OWNED) : null;
  } catch {
    return null;
  }
}

/** One cookie's value from a Cookie header. */
export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** The list with `id` added last (once), keeping the newest MAX_OWNED. */
export const withOwned = (ids: readonly string[], id: string): string[] => [...ids.filter((x) => x !== id), id].slice(-MAX_OWNED);

const g = globalThis as unknown as { __dronexDevCookieSecret?: string };

/** DRONEX_COOKIE_SECRET; in development a per-process random one; in production without it, an error. */
export function cookieSecret(): string {
  const s = process.env.DRONEX_COOKIE_SECRET?.trim();
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("DRONEX_COOKIE_SECRET is not set");
  return (g.__dronexDevCookieSecret ??= randomBytes(32).toString("hex"));
}

/** The vehicle ids this browser owns (empty without a valid cookie). */
export function ownedIds(request: Request): string[] {
  return verifyIds(readCookie(request.headers.get("cookie"), OWN_COOKIE), cookieSecret()) ?? [];
}

/** The Set-Cookie value that adds `vehicleId` to this browser's list. */
export function ownershipCookie(request: Request, vehicleId: string): string {
  const value = signIds(withOwned(ownedIds(request), vehicleId), cookieSecret());
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${OWN_COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; SameSite=Lax${secure}`;
}

/** The vehicles this caller may act on: null (all) for the agents, else the ones in its cookie. */
export function allowedVehicles(request: Request): string[] | null {
  return isAgent(request) ? null : ownedIds(request);
}

/** True when the caller may act on `vehicleId`. */
export function mayActOn(request: Request, vehicleId: string): boolean {
  const allowed = allowedVehicles(request);
  return allowed === null || allowed.includes(vehicleId);
}
