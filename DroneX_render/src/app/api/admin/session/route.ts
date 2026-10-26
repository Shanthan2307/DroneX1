// POST /api/admin/session {pin}: open the admin dashboard (lib/admin.ts) for ADMIN_HOURS; DELETE: sign out.
// PIN attempts are rate-limited per visitor.
import { connection } from "next/server";
import { ADMIN_HOURS, adminCookie, adminPin, pinMatches, signSession } from "@/lib/admin";
import { limitRequest } from "@/lib/rateLimit";

export async function POST(request: Request) {
  await connection();
  const limited = limitRequest(request, "adminPin");
  if (limited) return limited;
  const pin = adminPin();
  if (!pin) return Response.json({ error: "the admin dashboard is not set up (DRONEX_ADMIN_PIN)" }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as { pin?: unknown };
  const given = typeof body.pin === "string" ? body.pin.slice(0, 64) : "";
  if (!pinMatches(given, pin)) return Response.json({ error: "wrong PIN" }, { status: 401 });
  const value = signSession(pin, Date.now() + ADMIN_HOURS * 3_600_000);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": adminCookie(value, ADMIN_HOURS * 3600) } });
}

export async function DELETE() {
  await connection();
  return Response.json({ ok: true }, { headers: { "Set-Cookie": adminCookie("", 0) } });
}
