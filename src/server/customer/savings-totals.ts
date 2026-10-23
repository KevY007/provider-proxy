import "server-only";
import { db } from "@/lib/db";
import { summarizeSavings, type SavingsSummary } from "./savings";

export interface SavingsTotals {
  month: SavingsSummary & { hasData: boolean };
  allTime: SavingsSummary & { hasData: boolean };
}

/** Start of the current calendar month (UTC). */
export function startOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Official total vs what was paid, only over requests that recorded an official price (so savings are comparable).
 * Both numbers are snapshots written once by the gateway when the request ran (src/gateway/metering.ts), so later
 * price changes never rewrite past savings - totals just add up what each request actually saved at the time.
 */
async function sumSince(userId: string, since?: Date) {
  const agg = await db.requestLog.aggregate({
    where: { userId, officialPrice: { gt: 0 }, ...(since ? { createdAt: { gte: since } } : {}) },
    _sum: { officialPrice: true, price: true },
  });
  const official = agg._sum.officialPrice?.toString() ?? "0";
  const paid = agg._sum.price?.toString() ?? "0";
  return { ...summarizeSavings(official, paid), hasData: official !== "0" };
}

/** This month's and all-time savings vs official prices for one customer. */
export async function getSavingsTotals(userId: string): Promise<SavingsTotals> {
  const [month, allTime] = await Promise.all([sumSince(userId, startOfMonthUtc()), sumSince(userId)]);
  return { month, allTime };
}

export interface PoolSpendRow {
  slug: string | null;
  name: string;
  /** billed requests */
  requests: number;
  /** USD charged */
  spent: number;
  /** USD the comparable requests would have cost at official list prices */
  listPrice: number;
  /** USD charged for those comparable requests */
  comparablePaid: number;
}

/**
 * All-time spend per pool (the pool that served and billed each request) next to the same usage at official list
 * prices. Like the totals above, both figures are what each request recorded when it ran.
 */
export async function getSpendByPool(userId: string): Promise<PoolSpendRow[]> {
  const [billed, listed] = await Promise.all([
    db.requestLog.groupBy({ by: ["groupSlug"], where: { userId, price: { gt: 0 } }, _sum: { price: true }, _count: { _all: true } }),
    db.requestLog.groupBy({ by: ["groupSlug"], where: { userId, officialPrice: { gt: 0 } }, _sum: { officialPrice: true, price: true } }),
  ]);
  const slugs = [...new Set([...billed, ...listed].map((r) => r.groupSlug).filter((s): s is string => !!s))];
  const groups = slugs.length ? await db.group.findMany({ where: { slug: { in: slugs } }, select: { slug: true, name: true } }) : [];
  const nameOf = new Map(groups.map((g) => [g.slug, g.name]));
  const listOf = new Map(listed.map((r) => [r.groupSlug, r._sum]));
  return billed
    .map((r) => ({
      slug: r.groupSlug,
      name: r.groupSlug ? (nameOf.get(r.groupSlug) ?? r.groupSlug) : "No pool",
      requests: r._count._all,
      spent: Number(r._sum.price ?? 0),
      listPrice: Number(listOf.get(r.groupSlug)?.officialPrice ?? 0),
      comparablePaid: Number(listOf.get(r.groupSlug)?.price ?? 0),
    }))
    .sort((a, b) => b.spent - a.spent);
}
