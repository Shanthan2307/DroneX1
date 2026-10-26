// GET /api/admin/status: the admin dashboard's numbers (lib/adminStatus.ts), for a signed-in admin only.
import { connection } from "next/server";
import { isAdmin } from "@/lib/admin";
import { adminStatus } from "@/lib/adminStatus";

export async function GET(request: Request) {
  await connection();
  if (!isAdmin(request)) return Response.json({ error: "enter the admin PIN first" }, { status: 401 });
  return Response.json(await adminStatus(), { headers: { "Cache-Control": "no-store" } });
}
