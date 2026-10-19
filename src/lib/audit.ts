import { db } from "./db";
import { logger } from "./logger";

export interface AuditTarget {
  type?: string | null;
  id?: string | null;
}

/** The staff member behind the current (impersonation) session, if any. Outside a request (cron, scripts): null. */
async function currentImpersonator(): Promise<string | null> {
  try {
    const { cookies } = await import("next/headers");
    const token = (await cookies()).get("pp_session")?.value;
    if (!token) return null;
    const { sha256 } = await import("./crypto");
    const s = await db.session.findUnique({ where: { id: sha256(token) }, select: { impersonatorId: true } });
    return s?.impersonatorId ?? null;
  } catch {
    return null;
  }
}

/**
 * Write an AuditLog row (with `data.impersonatorId` when staff acts through an impersonation session). Never throws (audit failure must not break the action).
 *
 *   await audit(admin.id, "provider.update", { type: "Provider", id }, { changed: ["baseUrl"] }, ip)
 *
 * Convention: `action` = "<entity>.<verb>", e.g. "customer.suspend", "settings.update", "auth.login".
 */
export async function audit(
  actorId: string | null | undefined,
  action: string,
  target?: AuditTarget | null,
  data?: Record<string, unknown>,
  ip?: string | null,
): Promise<void> {
  try {
    const impersonatorId = await currentImpersonator();
    await db.auditLog.create({
      data: {
        actorId: actorId ?? null,
        action,
        targetType: target?.type ?? null,
        targetId: target?.id ?? null,
        data: (impersonatorId ? { ...data, impersonatorId } : (data ?? {})) as never,
        ip: ip ?? null,
      },
    });
  } catch (err) {
    logger.error("audit write failed", { action, err });
  }
}
