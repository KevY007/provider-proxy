import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { parseRangeParams } from "@/lib/date-range";

export const AUDIT_PAGE_SIZE = 50;

export interface AuditRow {
  id: string;
  createdAt: string;
  action: string;
  actorId: string | null;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  data: unknown;
}

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

/** Cursor-paginated audit log (newest first). The cursor is the id of the last row of the previous page. */
export async function listAudit(sp: SP) {
  const range = parseRangeParams({ range: one(sp.range), from: one(sp.from), to: one(sp.to) }, "30d");
  const action = one(sp.action);
  const actor = one(sp.actor);
  const targetType = one(sp.targetType);
  const cursor = one(sp.cursor);

  const where: Prisma.AuditLogWhereInput = { createdAt: { gte: range.from, lte: range.to } };
  if (action) where.action = { contains: action, mode: "insensitive" };
  if (targetType) where.targetType = targetType;
  if (actor) {
    const users = await db.user.findMany({
      where: { OR: [{ email: { contains: actor, mode: "insensitive" } }, { id: actor }] },
      select: { id: true },
      take: 50,
    });
    where.actorId = { in: [...users.map((u) => u.id), actor] };
  }

  const rows = await db.auditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: AUDIT_PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > AUDIT_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, AUDIT_PAGE_SIZE) : rows;

  const actorIds = [...new Set(page.map((r) => r.actorId).filter((x): x is string => !!x))];
  const actors = actorIds.length ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } }) : [];
  const emailById = new Map(actors.map((a) => [a.id, a.email]));

  const out: AuditRow[] = page.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    action: r.action,
    actorId: r.actorId,
    actorEmail: r.actorId ? (emailById.get(r.actorId) ?? null) : null,
    targetType: r.targetType,
    targetId: r.targetId,
    ip: r.ip,
    data: r.data,
  }));
  return {
    rows: out,
    nextCursor: hasMore ? page[page.length - 1].id : null,
    range: { preset: range.preset, from: range.from.toISOString(), to: range.to.toISOString() },
  };
}
