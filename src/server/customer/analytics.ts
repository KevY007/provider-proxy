import "server-only";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { fillSeries, floorBucket, type Granularity } from "./buckets";

/** User-scoped usage analytics over RequestLog. Everything is filtered by userId; no internal/provider data is selected. */

export interface Totals {
  requests: number;
  spend: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  errors: number;
  avgLatencyMs: number;
  /** Sum of officialPrice over requests that recorded one (what they would cost at official prices). */
  official: number;
  /** Sum of price over those same requests; saved = official - comparable. */
  comparable: number;
}

export interface SeriesPoint {
  bucket: Date;
  requests: number;
  spend: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  errors: number;
  official: number;
  comparable: number;
}

export interface BreakdownRow {
  name: string;
  requests: number;
  spend: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  errors: number;
  avgLatencyMs: number;
  official: number;
  comparable: number;
}

const AGG = Prisma.sql`
  count(*)::int AS requests,
  coalesce(sum(r."price"), 0)::float8 AS spend,
  coalesce(sum(r."inputTokens"), 0)::float8 AS "inputTokens",
  coalesce(sum(r."outputTokens"), 0)::float8 AS "outputTokens",
  coalesce(sum(r."cachedTokens"), 0)::float8 AS "cachedTokens",
  (count(*) FILTER (WHERE r."status" IN ('CLIENT_ERROR','UPSTREAM_ERROR','GATEWAY_ERROR')))::int AS errors,
  coalesce(avg(r."latencyMs"), 0)::float8 AS "avgLatencyMs",
  coalesce(sum(r."officialPrice") FILTER (WHERE r."officialPrice" > 0), 0)::float8 AS official,
  coalesce(sum(r."price") FILTER (WHERE r."officialPrice" > 0), 0)::float8 AS comparable`;

export async function getTotals(userId: string, from: Date, to: Date): Promise<Totals> {
  const rows = await db.$queryRaw<Totals[]>(Prisma.sql`
    SELECT ${AGG} FROM "RequestLog" r
    WHERE r."userId" = ${userId} AND r."createdAt" >= ${from} AND r."createdAt" <= ${to}`);
  return rows[0] ?? { requests: 0, spend: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, errors: 0, avgLatencyMs: 0, official: 0, comparable: 0 };
}

export async function getSeries(userId: string, from: Date, to: Date, gran: Granularity): Promise<SeriesPoint[]> {
  const unit = gran === "hour" ? Prisma.sql`'hour'` : Prisma.sql`'day'`;
  const rows = await db.$queryRaw<Array<SeriesPoint>>(Prisma.sql`
    SELECT date_trunc(${unit}, r."createdAt") AS bucket, ${AGG}
    FROM "RequestLog" r
    WHERE r."userId" = ${userId} AND r."createdAt" >= ${from} AND r."createdAt" <= ${to}
    GROUP BY 1 ORDER BY 1`);
  const zero = (bucket: Date): SeriesPoint => ({ bucket, requests: 0, spend: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, errors: 0, official: 0, comparable: 0 });
  return fillSeries(rows, from, to, gran, zero);
}

export type Dimension = "model" | "key" | "endpoint";

export async function getBreakdown(userId: string, from: Date, to: Date, dim: Dimension, limit = 50): Promise<BreakdownRow[]> {
  const col =
    dim === "model"
      ? Prisma.sql`coalesce(r."modelSlug", '(unknown)')`
      : dim === "endpoint"
        ? Prisma.sql`r."endpoint"`
        : Prisma.sql`coalesce(k."name", '(deleted key)')`;
  return db.$queryRaw<BreakdownRow[]>(Prisma.sql`
    SELECT ${col} AS name, ${AGG}
    FROM "RequestLog" r
    LEFT JOIN "ApiKey" k ON k."id" = r."apiKeyId"
    WHERE r."userId" = ${userId} AND r."createdAt" >= ${from} AND r."createdAt" <= ${to}
    GROUP BY 1 ORDER BY spend DESC, requests DESC LIMIT ${limit}`);
}

export interface RecentError {
  id: string;
  createdAt: Date;
  modelSlug: string | null;
  endpoint: string;
  httpStatus: number;
  errorCode: string | null;
  errorMessage: string | null;
}

/** Failed requests of the last `hours` (the overview shows only fresh ones; older errors stay in Logs). */
export async function getRecentErrors(userId: string, take = 8, hours = 24): Promise<RecentError[]> {
  return db.requestLog.findMany({
    where: { userId, status: { in: ["CLIENT_ERROR", "UPSTREAM_ERROR", "GATEWAY_ERROR"] }, createdAt: { gte: new Date(Date.now() - hours * 3_600_000) } },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, createdAt: true, modelSlug: true, endpoint: true, httpStatus: true, errorCode: true, errorMessage: true },
  });
}

export async function getOverview(userId: string) {
  const now = new Date();
  const todayStart = floorBucket(now, "day");
  const weekFrom = new Date(now.getTime() - 7 * 86400_000);
  const seriesFrom = new Date(todayStart.getTime() - 13 * 86400_000);
  const [today, week, series, models, errors, keyCount] = await Promise.all([
    getTotals(userId, todayStart, now),
    getTotals(userId, weekFrom, now),
    getSeries(userId, seriesFrom, now, "day"),
    getBreakdown(userId, weekFrom, now, "model", 8),
    getRecentErrors(userId, 6),
    db.apiKey.count({ where: { userId, isPlayground: false, status: { not: "REVOKED" } } }),
  ]);
  return { now, today, week, series, models, errors, keyCount };
}

export interface UsageData {
  totals: Totals;
  series: SeriesPoint[];
  byModel: BreakdownRow[];
  byKey: BreakdownRow[];
  byEndpoint: BreakdownRow[];
}

export async function getUsage(userId: string, from: Date, to: Date, gran: Granularity): Promise<UsageData> {
  const [totals, series, byModel, byKey, byEndpoint] = await Promise.all([
    getTotals(userId, from, to),
    getSeries(userId, from, to, gran),
    getBreakdown(userId, from, to, "model", 200),
    getBreakdown(userId, from, to, "key", 50),
    getBreakdown(userId, from, to, "endpoint", 50),
  ]);
  return { totals, series, byModel, byKey, byEndpoint };
}
