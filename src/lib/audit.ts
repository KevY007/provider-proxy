import { db } from "./db";
import { logger } from "./logger";

export interface AuditTarget {
  type?: string | null;
  id?: string | null;
}

/**
 * Write an AuditLog row. Never throws (audit failure must not break the action).
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
    await db.auditLog.create({
      data: {
        actorId: actorId ?? null,
        action,
        targetType: target?.type ?? null,
        targetId: target?.id ?? null,
        data: (data ?? {}) as never,
        ip: ip ?? null,
      },
    });
  } catch (err) {
    logger.error("audit write failed", { action, err });
  }
}
