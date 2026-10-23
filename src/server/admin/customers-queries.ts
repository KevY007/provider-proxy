import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { dstr, dstr0, iso, num } from "./serialize";
import type { CustomerListParams } from "./customers-calc";

export interface CustomerRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  role: string;
  emailVerified: boolean;
  groupName: string | null;
  balance: string;
  creditLimit: string;
  billingMode: string;
  spend30d: number;
  requests30d: number;
  lastActive: string | null;
  createdAt: string;
}

const DAY30 = 30 * 24 * 3600_000;

function whereSql(p: CustomerListParams): Prisma.Sql {
  const c: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (p.q) {
    const like = `%${p.q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    c.push(Prisma.sql`(u."email" ILIKE ${like} OR u."name" ILIKE ${like} OR u."id" = ${p.q})`);
  }
  if (p.status) c.push(Prisma.sql`u."status" = ${p.status}::"UserStatus"`);
  if (p.role) c.push(Prisma.sql`u."role" = ${p.role}::"Role"`);
  if (p.group === "none") c.push(Prisma.sql`u."groupId" IS NULL`);
  else if (p.group) c.push(Prisma.sql`u."groupId" = ${p.group}`);
  return Prisma.join(c, " AND ");
}

function whereInput(p: CustomerListParams): Prisma.UserWhereInput {
  const and: Prisma.UserWhereInput[] = [];
  if (p.q) and.push({ OR: [{ email: { contains: p.q, mode: "insensitive" } }, { name: { contains: p.q, mode: "insensitive" } }, { id: p.q }] });
  if (p.status) and.push({ status: p.status });
  if (p.role) and.push({ role: p.role });
  if (p.group === "none") and.push({ groupId: null });
  else if (p.group) and.push({ groupId: p.group });
  return and.length ? { AND: and } : {};
}

export async function listCustomers(p: CustomerListParams): Promise<{ rows: CustomerRow[]; total: number }> {
  const since = new Date(Date.now() - DAY30);
  const total = await db.user.count({ where: whereInput(p) });
  let ids: string[];

  if (p.sort === "spend" || p.sort === "active") {
    const col = p.sort === "spend" ? Prisma.raw("coalesce(a.spend, 0)") : Prisma.raw("a.last");
    const dir = Prisma.raw(p.dir === "asc" ? "ASC NULLS LAST" : "DESC NULLS LAST");
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT u."id" FROM "User" u
      LEFT JOIN (
        SELECT "userId", sum("price") AS spend, max("createdAt") AS last
        FROM "RequestLog" WHERE "createdAt" >= ${since} AND "userId" IS NOT NULL GROUP BY 1
      ) a ON a."userId" = u."id"
      WHERE ${whereSql(p)}
      ORDER BY ${col} ${dir}, u."createdAt" DESC
      LIMIT ${p.pageSize} OFFSET ${p.page * p.pageSize}`;
    ids = rows.map((r) => r.id);
  } else {
    const rows = await db.user.findMany({
      where: whereInput(p),
      orderBy: p.sort === "balance" ? [{ balance: p.dir }, { createdAt: "desc" }] : [{ createdAt: p.dir }],
      skip: p.page * p.pageSize,
      take: p.pageSize,
      select: { id: true },
    });
    ids = rows.map((r) => r.id);
  }
  if (!ids.length) return { rows: [], total };

  const [users, agg] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids } }, include: { group: { select: { name: true } } }, omit: { passwordHash: true, totpSecret: true } }),
    db.$queryRaw<Array<{ id: string; spend: number; requests: number; last: Date | null }>>`
      SELECT "userId" AS id, coalesce(sum("price"), 0)::float8 AS spend, count(*)::float8 AS requests, max("createdAt") AS last
      FROM "RequestLog"
      WHERE "createdAt" >= ${since} AND "userId" IN (${Prisma.join(ids)})
      GROUP BY 1`,
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const aggBy = new Map(agg.map((a) => [a.id, a]));
  const rows: CustomerRow[] = ids
    .map((id) => byId.get(id))
    .filter((u): u is NonNullable<typeof u> => !!u)
    .map((u) => {
      const a = aggBy.get(u.id);
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        status: u.status,
        role: u.role,
        emailVerified: !!u.emailVerifiedAt,
        groupName: u.group?.name ?? null,
        balance: dstr0(u.balance),
        creditLimit: dstr0(u.creditLimit),
        billingMode: u.billingMode,
        spend30d: num(a?.spend),
        requests30d: num(a?.requests),
        lastActive: iso(a?.last ?? u.lastLoginAt),
        createdAt: u.createdAt.toISOString(),
      };
    });
  return { rows, total };
}

/** For CSV export: up to `limit` customers using the same filters (no pagination). */
export async function exportCustomers(p: CustomerListParams, limit = 20000): Promise<CustomerRow[]> {
  const out: CustomerRow[] = [];
  const pageSize = 500;
  for (let page = 0; out.length < limit; page++) {
    const { rows } = await listCustomers({ ...p, page, pageSize });
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

export async function listGroupOptions() {
  const groups = await db.group.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, slug: true, isDefault: true, isPublic: true, priceMultiplier: true } });
  return groups.map((g) => ({ ...g, priceMultiplier: g.priceMultiplier.toString() }));
}

export async function getCustomerDetail(id: string) {
  const user = await db.user.findUnique({
    where: { id },
    omit: { passwordHash: true, totpSecret: true },
    include: { group: { select: { id: true, name: true, slug: true } } },
  });
  if (!user) return null;
  const [keys, payments, ledger, sessions, logs] = await Promise.all([
    db.apiKey.findMany({
      where: { userId: id },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { group: { select: { name: true } } },
    }),
    db.payment.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.ledgerEntry.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.session.findMany({ where: { userId: id, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.requestLog.findMany({
      where: { userId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true, createdAt: true, modelSlug: true, endpoint: true, status: true, httpStatus: true, errorCode: true,
        inputTokens: true, outputTokens: true, price: true, latencyMs: true,
      },
    }),
  ]);
  const adminIds = [...new Set(ledger.map((l) => l.createdById).filter((x): x is string => !!x))];
  const admins = adminIds.length ? await db.user.findMany({ where: { id: { in: adminIds } }, select: { id: true, email: true } }) : [];
  const adminEmail = new Map(admins.map((a) => [a.id, a.email]));

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      emailVerifiedAt: iso(user.emailVerifiedAt),
      totpEnabled: user.totpEnabled,
      groupId: user.groupId,
      groupName: user.group?.name ?? null,
      extraGroupIds: user.extraGroupIds,
      priceMultiplier: dstr(user.priceMultiplier),
      balance: dstr0(user.balance),
      creditLimit: dstr0(user.creditLimit),
      billingMode: user.billingMode,
      monthlySpendLimit: dstr(user.monthlySpendLimit),
      maxConcurrency: user.maxConcurrency,
      stripeCustomerId: user.stripeCustomerId,
      autoRechargeEnabled: user.autoRechargeEnabled,
      signupIp: user.signupIp,
      lastLoginAt: iso(user.lastLoginAt),
      createdAt: user.createdAt.toISOString(),
    },
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      status: k.status,
      groupName: k.group?.name ?? null,
      spent: dstr0(k.spent),
      spendLimit: dstr(k.spendLimit),
      rpmLimit: k.rpmLimit,
      lastUsedAt: iso(k.lastUsedAt),
      expiresAt: iso(k.expiresAt),
      createdAt: k.createdAt.toISOString(),
      isPlayground: k.isPlayground,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      createdAt: p.createdAt.toISOString(),
      amount: dstr0(p.amount),
      currency: p.currency,
      status: p.status,
      kind: p.kind,
      failureReason: p.failureReason,
      receiptUrl: p.receiptUrl,
    })),
    ledger: ledger.map((l) => ({
      id: l.id,
      createdAt: l.createdAt.toISOString(),
      type: l.type,
      amount: dstr0(l.amount),
      balanceAfter: dstr0(l.balanceAfter),
      description: l.description,
      createdBy: l.createdById ? (adminEmail.get(l.createdById) ?? l.createdById) : null,
    })),
    sessions: sessions.map((s) => ({
      id: s.id.slice(0, 10),
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      impersonated: !!s.impersonatorId,
    })),
    logs: logs.map((l) => ({
      id: l.id,
      createdAt: l.createdAt.toISOString(),
      modelSlug: l.modelSlug,
      endpoint: l.endpoint,
      status: l.status,
      httpStatus: l.httpStatus,
      errorCode: l.errorCode,
      tokens: l.inputTokens + l.outputTokens,
      price: dstr0(l.price),
      latencyMs: l.latencyMs,
    })),
  };
}

export type CustomerDetail = NonNullable<Awaited<ReturnType<typeof getCustomerDetail>>>;
