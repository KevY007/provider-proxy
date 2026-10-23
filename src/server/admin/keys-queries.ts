import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { dstr, dstr0, iso } from "./serialize";

export const KEY_PAGE_SIZE = 25;
export const KEY_STATUSES = ["ACTIVE", "DISABLED", "REVOKED"] as const;

export interface KeyListParams {
  q: string; // owner email / key name
  prefix: string;
  status: (typeof KEY_STATUSES)[number] | "";
  group: string;
  page: number;
  /** "revoked" = the bin (revoked keys only); otherwise revoked keys are left out */
  view: "active" | "revoked";
}

type SP = Record<string, string | string[] | undefined>;
const one = (sp: SP, k: string) => {
  const v = sp[k];
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim().slice(0, 120);
};

export function parseKeyListParams(sp: SP): KeyListParams {
  const status = one(sp, "status");
  const page = Number.parseInt(one(sp, "page"), 10);
  return {
    q: one(sp, "q"),
    prefix: one(sp, "prefix"),
    status: (KEY_STATUSES as readonly string[]).includes(status) ? (status as KeyListParams["status"]) : "",
    group: one(sp, "group"),
    page: Number.isFinite(page) && page > 0 ? page : 0,
    view: one(sp, "view") === "revoked" ? "revoked" : "active",
  };
}

export async function listApiKeys(p: KeyListParams) {
  const and: Prisma.ApiKeyWhereInput[] = [];
  if (p.q) and.push({ OR: [{ user: { email: { contains: p.q, mode: "insensitive" } } }, { name: { contains: p.q, mode: "insensitive" } }] });
  if (p.prefix) and.push({ prefix: { startsWith: p.prefix } });
  if (p.view === "revoked") and.push({ status: "REVOKED" });
  else and.push(p.status && p.status !== "REVOKED" ? { status: p.status } : { status: { not: "REVOKED" } });
  if (p.group) and.push(p.group === "none" ? { groupId: null } : { groupId: p.group });
  const where: Prisma.ApiKeyWhereInput = and.length ? { AND: and } : {};
  const [total, rows] = await Promise.all([
    db.apiKey.count({ where }),
    db.apiKey.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: p.page * KEY_PAGE_SIZE,
      take: KEY_PAGE_SIZE,
      include: { user: { select: { id: true, email: true } }, group: { select: { name: true } } },
    }),
  ]);
  // the same usage at official list prices, for the keys on this page
  const listed = rows.length
    ? await db.requestLog.groupBy({ by: ["apiKeyId"], where: { apiKeyId: { in: rows.map((k) => k.id) }, officialPrice: { gt: 0 } }, _sum: { officialPrice: true } })
    : [];
  const listOf = new Map(listed.map((r) => [r.apiKeyId, r._sum.officialPrice]));
  return {
    total,
    rows: rows.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      userId: k.user.id,
      email: k.user.email,
      status: k.status as string,
      groupName: k.group?.name ?? null,
      spent: dstr0(k.spent),
      listPrice: dstr(listOf.get(k.id) ?? null),
      spendLimit: dstr(k.spendLimit),
      rpmLimit: k.rpmLimit,
      lastUsedAt: iso(k.lastUsedAt),
      expiresAt: iso(k.expiresAt),
      createdAt: k.createdAt.toISOString(),
      isPlayground: k.isPlayground,
    })),
  };
}

export async function countRevokedApiKeys(): Promise<number> {
  return db.apiKey.count({ where: { status: "REVOKED" } });
}

export type ApiKeyRow = Awaited<ReturnType<typeof listApiKeys>>["rows"][number];
