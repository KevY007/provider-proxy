import { getSlotSnapshot } from "@/gateway/slots";
import { requireAdminForAction } from "@/lib/auth/session";
import { AuthError } from "@/lib/auth/types";

/** Live concurrency-slot usage for the admin console (poll every ~5s). Admin/support session required. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminForAction();
  } catch (e) {
    if (e instanceof AuthError) {
      return Response.json({ error: { code: e.code, message: e.message } }, { status: e.code === "unauthenticated" ? 401 : 403, headers: { "cache-control": "no-store" } });
    }
    throw e;
  }
  const snapshot = await getSlotSnapshot();
  return Response.json(snapshot, { headers: { "cache-control": "no-store" } });
}
