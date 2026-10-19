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
