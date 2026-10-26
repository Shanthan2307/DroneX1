// The admin dashboard's lock (/admin): a PIN from DRONEX_ADMIN_PIN, checked in constant time and rate-limited per
// visitor (rateLimit.ts "adminPin"), exchanges for a signed HttpOnly cookie that lasts ADMIN_HOURS. The cookie is an
// expiry and its HMAC under a key derived from the PIN, so changing the PIN signs everyone out. Without
// DRONEX_ADMIN_PIN the dashboard is closed. Server-only.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readCookie } from "./ownership";

export const ADMIN_COOKIE = "dronex_admin";
export const ADMIN_HOURS = 12;

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
const keyFor = (pin: string): Buffer => digest(`dronex-admin:${pin}`);
const mac = (key: Buffer, exp: number): string => createHmac("sha256", key).update(String(exp)).digest("base64url");

/** Pure: whether `given` is the PIN (constant time); never true without a configured PIN. */
export function pinMatches(given: string, pin: string | undefined): boolean {
  if (!pin) return false;
  return timingSafeEqual(digest(given.trim()), digest(pin));
}

/** Pure: a session value that expires at `exp` (ms since epoch). */
export const signSession = (pin: string, exp: number): string => `${exp}.${mac(keyFor(pin), exp)}`;

/** Pure: whether `value` is an unexpired session signed for `pin`. */
export function sessionValid(value: string | null, pin: string | undefined, now: number): boolean {
  if (!value || !pin) return false;
  const [expText, sig] = value.split(".");
  const exp = Number(expText);
  if (!Number.isFinite(exp) || exp <= now || !sig) return false;
  const want = Buffer.from(mac(keyFor(pin), exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export const adminPin = (): string | undefined => process.env.DRONEX_ADMIN_PIN?.trim() || undefined;

export const isAdmin = (request: Request): boolean => sessionValid(readCookie(request.headers.get("cookie"), ADMIN_COOKIE), adminPin(), Date.now());

/** The Set-Cookie for a new session, or for signing out (`maxAgeS` 0). */
export function adminCookie(value: string, maxAgeS: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}${secure}`;
}
