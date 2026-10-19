import "server-only";
/**
 * Latency from REAL traffic only (RequestLog). The proxy never pings an upstream on a timer for these numbers: every
 * figure here is a customer's own call, so a provider nobody calls simply has no recent latency.
 *
 *  - total  = `latencyMs`: request received -> response finished (what the caller waited)
 *  - ttft   = `ttftMs`: request received -> first token / byte from the upstream (streaming calls)
 *  - queue  = `queueMs`: time spent waiting for a free upstream slot (part of total)
 *
 * Percentiles are over successful, non-batch calls (batch rows carry no latency).
 */
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { num } from "@/server/admin/serialize";
import { fillTimeBuckets, normalizeGranularity, type AnalyticsFilter, type Granularity } from "./params";

export type LatencyDim = "provider" | "providerKey" | "model";

export interface LatencySummary {
  calls: number;
  p50Ms: number | null;
  p95Ms: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  queueP95Ms: number | null;
  lastAt: string | null;
}

export interface LatencyRow extends LatencySummary {
  key: string;
  label: string;
  /** Latest successful call's total latency ("last ping" taken from real traffic). */
  lastMs: number | null;
  errors: number;
}

export interface LatencyPoint {
  t: string;
  calls: number;
  p50Ms: number | null;
  p95Ms: number | null;
  ttftP50Ms: number | null;
}

const GRAN_SQL: Record<Granularity, Prisma.Sql> = {
  hour: Prisma.raw(`'hour'`),
  day: Prisma.raw(`'day'`),
  week: Prisma.raw(`'week'`),
  month: Prisma.raw(`'month'`),
};

function where(f: AnalyticsFilter, extra: Prisma.Sql[] = []): Prisma.Sql {
  const c: Prisma.Sql[] = [Prisma.sql`r."createdAt" >= ${f.from}`, Prisma.sql`r."createdAt" <= ${f.to}`, Prisma.sql`r."batchId" IS NULL`];
  if (f.userId) c.push(Prisma.sql`r."userId" = ${f.userId}`);
  if (f.modelSlug) c.push(Prisma.sql`r."modelSlug" = ${f.modelSlug}`);
  if (f.providerId) c.push(Prisma.sql`r."providerId" = ${f.providerId}`);
  if (f.providerKeyId) c.push(Prisma.sql`r."providerKeyId" = ${f.providerKeyId}`);
  if (f.apiKeyId) c.push(Prisma.sql`r."apiKeyId" = ${f.apiKeyId}`);
  if (f.endpoint) c.push(Prisma.sql`r."endpoint" = ${f.endpoint}`);
  c.push(...extra);
  return Prisma.sql`WHERE ${Prisma.join(c, " AND ")}`;
}

const OK = Prisma.raw(`r."status" = 'SUCCESS' AND r."latencyMs" > 0`);
const ERR = Prisma.raw(`r."status" IN ('UPSTREAM_ERROR','GATEWAY_ERROR')`);
const AGG = Prisma.sql`
  (count(*) FILTER (WHERE ${OK}))::float8 AS calls,
  (count(*) FILTER (WHERE ${ERR}))::float8 AS errors,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY r."latencyMs") FILTER (WHERE ${OK}) AS p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY r."latencyMs") FILTER (WHERE ${OK}) AS p95,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY r."ttftMs") FILTER (WHERE ${OK} AND r."ttftMs" IS NOT NULL) AS ttft50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY r."ttftMs") FILTER (WHERE ${OK} AND r."ttftMs" IS NOT NULL) AS ttft95,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY r."queueMs") FILTER (WHERE ${OK}) AS q95,
  max(r."createdAt") FILTER (WHERE ${OK}) AS "lastAt"`;

const ms = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(num(v)));
const at = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : null);

function summary(r: Record<string, unknown> | undefined): LatencySummary {
  return {
    calls: r ? num(r.calls) : 0,
    p50Ms: ms(r?.p50),
    p95Ms: ms(r?.p95),
    ttftP50Ms: ms(r?.ttft50),
    ttftP95Ms: ms(r?.ttft95),
    queueP95Ms: ms(r?.q95),
    lastAt: at(r?.lastAt),
  };
}

export async function getLatencySummary(f: AnalyticsFilter): Promise<LatencySummary> {
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>`SELECT ${AGG} FROM "RequestLog" r ${where(f)}`;
  return summary(rows[0]);
}

const DIM_SQL: Record<LatencyDim, { key: string; label: string; join: string; notNull: string }> = {
  provider: { key: `r."providerId"`, label: `coalesce(pv."name", r."providerId")`, join: `LEFT JOIN "Provider" pv ON pv."id" = r."providerId"`, notNull: `r."providerId" IS NOT NULL` },
  providerKey: {
    key: `r."providerKeyId"`,
    label: `coalesce(pv."name" || ' / ' || pk."label", r."providerKeyId")`,
    join: `LEFT JOIN "ProviderKey" pk ON pk."id" = r."providerKeyId" LEFT JOIN "Provider" pv ON pv."id" = pk."providerId"`,
    notNull: `r."providerKeyId" IS NOT NULL`,
  },
  model: { key: `r."modelSlug"`, label: `r."modelSlug"`, join: ``, notNull: `r."modelSlug" IS NOT NULL` },
};

/** p50 / p95 / time to first token per provider, provider key or model, plus the latest call ("last ping"). */
export async function getLatencyBreakdown(dim: LatencyDim, f: AnalyticsFilter, limit = 200): Promise<LatencyRow[]> {
  const d = DIM_SQL[dim];
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>`
    SELECT ${Prisma.raw(d.key)} AS key, min(${Prisma.raw(d.label)}) AS label, ${AGG},
      (array_agg(r."latencyMs" ORDER BY r."createdAt" DESC) FILTER (WHERE ${OK}))[1] AS last
    FROM "RequestLog" r ${Prisma.raw(d.join)}
    ${where(f, [Prisma.raw(d.notNull)])}
    GROUP BY 1
    ORDER BY calls DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({ key: String(r.key), label: String(r.label ?? r.key), errors: num(r.errors), lastMs: ms(r.last), ...summary(r) }));
}

/** Latency history (zero-filled buckets; buckets without calls carry nulls). */
export async function getLatencyHistory(f: AnalyticsFilter, gran?: Granularity): Promise<LatencyPoint[]> {
  const g = normalizeGranularity(f, gran);
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>`
    SELECT to_char(date_trunc(${GRAN_SQL[g]}, r."createdAt"), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t, ${AGG}
    FROM "RequestLog" r ${where(f)}
    GROUP BY 1 ORDER BY 1`;
  const points: LatencyPoint[] = rows.map((r) => ({ t: String(r.t), calls: num(r.calls), p50Ms: ms(r.p50), p95Ms: ms(r.p95), ttftP50Ms: ms(r.ttft50) }));
  return fillTimeBuckets(points, f.from, f.to, g, (t) => ({ t, calls: 0, p50Ms: null, p95Ms: null, ttftP50Ms: null }));
}
