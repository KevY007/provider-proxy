import "server-only";
/**
 * Shared aggregate analytics over RequestLog (admin console + customer portal).
 *
 * Every query takes an `AnalyticsFilter` ({ from, to, userId?, modelSlug?, providerId?, providerKeyId?,
 * groupSlug?, apiKeyId?, endpoint?, status? }). Pass `userId` to scope to a single customer (portal).
 * Money fields are plain JS numbers in USD (aggregated in Postgres as float8 - for display/charts only).
 * All queries are range-bounded and use the (createdAt) / (userId, createdAt) indexes.
 *
 * Exported signatures:
 *   getTotals(f: AnalyticsFilter): Promise<Totals>
 *   getTimeSeries(f: AnalyticsFilter, gran?: Granularity): Promise<TimePoint[]>              // zero-filled for hour/day
 *   getBreakdown(dim: BreakdownDim, f: AnalyticsFilter, opts?: { limit?: number; orderBy?: BreakdownOrder }): Promise<BreakdownRow[]>
 *       dims: model | provider | providerKey | customer | group | endpoint | status | errorCode | apiKey
 *   getRecentErrors(f: AnalyticsFilter, limit?: number, opts?: { includeInternal?: boolean }): Promise<RecentError[]>
 *   getProviderWindowStats(from: Date, to?: Date): Promise<Map<providerId, { requests, errors, cost, revenue }>>
 *   getProviderKeyWindowStats(from: Date, to?: Date): Promise<Map<providerKeyId, { requests, errors, cost }>>
 * Pure helpers (no DB) live in ./params: parseAnalyticsParams, normalizeGranularity, previousRange, marginPct, trendPct.
 */
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { num } from "@/server/admin/serialize";
import { fillTimeBuckets, marginPct, normalizeGranularity, type AnalyticsFilter, type BreakdownDim, type Granularity } from "./params";

export type { AnalyticsFilter, BreakdownDim, Granularity } from "./params";

export interface Totals {
  requests: number;
  successRequests: number;
  errorRequests: number;
  /** errors / requests, 0..1 (CLIENT_ERROR counts as error; CANCELLED does not). */
  errorRate: number;
  revenue: number;
  cost: number;
  profit: number;
  /** (revenue - cost) / revenue * 100 */
  marginPct: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  /** Over successful requests. */
  p50LatencyMs: number;
  p95LatencyMs: number;
  activeCustomers: number;
}

export interface TimePoint {
  /** ISO timestamp (UTC) of the bucket start. */
  t: string;
  requests: number;
  errors: number;
  revenue: number;
  cost: number;
  profit: number;
  tokens: number;
}

export type BreakdownOrder = "revenue" | "cost" | "profit" | "requests" | "tokens" | "errors" | "latency";

export interface BreakdownRow {
  key: string;
  label: string;
  requests: number;
  errors: number;
  errorRate: number;
  revenue: number;
  cost: number;
  profit: number;
  marginPct: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface RecentError {
  id: string;
  createdAt: string;
  modelSlug: string | null;
  endpoint: string;
  status: string;
  httpStatus: number;
  errorCode: string | null;
  errorMessage: string | null;
  internalError: string | null;
  providerId: string | null;
  userId: string | null;
}

/** WHERE conditions for alias `r` (RequestLog). */
function where(f: AnalyticsFilter, extra: Prisma.Sql[] = []): Prisma.Sql {
  const c: Prisma.Sql[] = [Prisma.sql`r."createdAt" >= ${f.from}`, Prisma.sql`r."createdAt" <= ${f.to}`];
  if (f.userId) c.push(Prisma.sql`r."userId" = ${f.userId}`);
  if (f.modelSlug) c.push(Prisma.sql`r."modelSlug" = ${f.modelSlug}`);
  if (f.providerId) c.push(Prisma.sql`r."providerId" = ${f.providerId}`);
  if (f.providerKeyId) c.push(Prisma.sql`r."providerKeyId" = ${f.providerKeyId}`);
  if (f.groupSlug) c.push(Prisma.sql`r."groupSlug" = ${f.groupSlug}`);
  if (f.apiKeyId) c.push(Prisma.sql`r."apiKeyId" = ${f.apiKeyId}`);
  if (f.endpoint) c.push(Prisma.sql`r."endpoint" = ${f.endpoint}`);
  if (f.status) c.push(Prisma.sql`r."status" = ${f.status}::"RequestStatus"`);
  c.push(...extra);
  return Prisma.sql`WHERE ${Prisma.join(c, " AND ")}`;
}

const ERR = Prisma.raw(`r."status" IN ('CLIENT_ERROR','UPSTREAM_ERROR','GATEWAY_ERROR')`);

export async function getTotals(f: AnalyticsFilter): Promise<Totals> {
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>`
    SELECT
      count(*)::float8 AS requests,
      (count(*) FILTER (WHERE r."status" = 'SUCCESS'))::float8 AS success,
      (count(*) FILTER (WHERE ${ERR}))::float8 AS errors,
      coalesce(sum(r."price"), 0)::float8 AS revenue,
      coalesce(sum(r."cost"), 0)::float8 AS cost,
      coalesce(sum(r."profit"), 0)::float8 AS profit,
      coalesce(sum(r."inputTokens"), 0)::float8 AS input_tokens,
      coalesce(sum(r."outputTokens"), 0)::float8 AS output_tokens,
      coalesce(sum(r."cachedTokens"), 0)::float8 AS cached_tokens,
      coalesce(avg(r."latencyMs"), 0)::float8 AS avg_latency,
      coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY r."latencyMs") FILTER (WHERE r."status" = 'SUCCESS'), 0)::float8 AS p50,
      coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY r."latencyMs") FILTER (WHERE r."status" = 'SUCCESS'), 0)::float8 AS p95,
      (count(DISTINCT r."userId"))::float8 AS customers
    FROM "RequestLog" r
    ${where(f)}
  `;
  const r = rows[0] ?? {};
  const requests = num(r.requests);
  const revenue = num(r.revenue);
  const cost = num(r.cost);
  const errors = num(r.errors);
  const inputTokens = num(r.input_tokens);
  const outputTokens = num(r.output_tokens);
  return {
    requests,
    successRequests: num(r.success),
    errorRequests: errors,
    errorRate: requests ? errors / requests : 0,
    revenue,
    cost,
    profit: num(r.profit),
    marginPct: marginPct(revenue, cost),
    inputTokens,
    outputTokens,
    cachedTokens: num(r.cached_tokens),
    totalTokens: inputTokens + outputTokens,
    avgLatencyMs: num(r.avg_latency),
    p50LatencyMs: num(r.p50),
    p95LatencyMs: num(r.p95),
    activeCustomers: num(r.customers),
  };
}

const GRAN_SQL: Record<Granularity, Prisma.Sql> = {
  hour: Prisma.raw(`'hour'`),
  day: Prisma.raw(`'day'`),
  week: Prisma.raw(`'week'`),
  month: Prisma.raw(`'month'`),
};

export async function getTimeSeries(f: AnalyticsFilter, gran?: Granularity): Promise<TimePoint[]> {
  const g = normalizeGranularity(f, gran);
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>`
    SELECT
      to_char(date_trunc(${GRAN_SQL[g]}, r."createdAt"), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
      count(*)::float8 AS requests,
      (count(*) FILTER (WHERE ${ERR}))::float8 AS errors,
      coalesce(sum(r."price"), 0)::float8 AS revenue,
      coalesce(sum(r."cost"), 0)::float8 AS cost,
      coalesce(sum(r."profit"), 0)::float8 AS profit,
      coalesce(sum(r."inputTokens" + r."outputTokens"), 0)::float8 AS tokens
    FROM "RequestLog" r
    ${where(f)}
    GROUP BY 1
    ORDER BY 1
  `;
  const points: TimePoint[] = rows.map((r) => ({
    t: String(r.t),
    requests: num(r.requests),
    errors: num(r.errors),
    revenue: num(r.revenue),
    cost: num(r.cost),
    profit: num(r.profit),
    tokens: num(r.tokens),
  }));
  return fillTimeBuckets(points, f.from, f.to, g, (t) => ({ t, requests: 0, errors: 0, revenue: 0, cost: 0, profit: 0, tokens: 0 }));
}

interface DimDef {
  key: string;
  label: string;
  join?: string;
  /** extra static WHERE (e.g. only rows with an error code) */
  where?: string;
}

const DIMS: Record<BreakdownDim, DimDef> = {
  model: { key: `coalesce(r."modelSlug", '(none)')`, label: `coalesce(r."modelSlug", '(none)')` },
  provider: {
    key: `coalesce(r."providerId", '(none)')`,
    label: `coalesce(pv."name", '(none)')`,
    join: `LEFT JOIN "Provider" pv ON pv."id" = r."providerId"`,
  },
  providerKey: {
    key: `coalesce(r."providerKeyId", '(none)')`,
    label: `coalesce(pv."name" || ' / ' || pk."label", '(none)')`,
    join: `LEFT JOIN "ProviderKey" pk ON pk."id" = r."providerKeyId" LEFT JOIN "Provider" pv ON pv."id" = pk."providerId"`,
  },
  customer: {
    key: `coalesce(r."userId", '(none)')`,
    label: `coalesce(u."email", '(deleted)')`,
    join: `LEFT JOIN "User" u ON u."id" = r."userId"`,
  },
  group: { key: `coalesce(r."groupSlug", '(none)')`, label: `coalesce(r."groupSlug", '(none)')` },
  endpoint: { key: `r."endpoint"`, label: `r."endpoint"` },
  status: { key: `r."status"::text`, label: `r."status"::text` },
  errorCode: { key: `r."errorCode"`, label: `r."errorCode"`, where: `r."errorCode" IS NOT NULL` },
  apiKey: {
    key: `coalesce(r."apiKeyId", '(none)')`,
    label: `coalesce(ak."name" || ' (' || ak."prefix" || ')', '(none)')`,
    join: `LEFT JOIN "ApiKey" ak ON ak."id" = r."apiKeyId"`,
  },
};

const ORDER_SQL: Record<BreakdownOrder, string> = {
  revenue: "revenue",
  cost: "cost",
  profit: "profit",
  requests: "requests",
  tokens: "tokens",
  errors: "errors",
  latency: "avg_latency",
};

export async function getBreakdown(
  dim: BreakdownDim,
  f: AnalyticsFilter,
  opts: { limit?: number; orderBy?: BreakdownOrder } = {},
): Promise<BreakdownRow[]> {
  const d = DIMS[dim];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
  const order = ORDER_SQL[opts.orderBy ?? "revenue"] ?? "revenue";
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>`
    SELECT
      ${Prisma.raw(d.key)} AS key,
      ${Prisma.raw(d.label)} AS label,
      count(*)::float8 AS requests,
      (count(*) FILTER (WHERE ${ERR}))::float8 AS errors,
      coalesce(sum(r."price"), 0)::float8 AS revenue,
      coalesce(sum(r."cost"), 0)::float8 AS cost,
      coalesce(sum(r."profit"), 0)::float8 AS profit,
      coalesce(sum(r."inputTokens"), 0)::float8 AS input_tokens,
      coalesce(sum(r."outputTokens"), 0)::float8 AS output_tokens,
      coalesce(sum(r."inputTokens" + r."outputTokens"), 0)::float8 AS tokens,
      coalesce(avg(r."latencyMs"), 0)::float8 AS avg_latency,
      coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY r."latencyMs"), 0)::float8 AS p95
    FROM "RequestLog" r
    ${Prisma.raw(d.join ?? "")}
    ${where(f, d.where ? [Prisma.raw(d.where)] : [])}
    GROUP BY 1, 2
    ORDER BY ${Prisma.raw(order)} DESC, requests DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => {
    const requests = num(r.requests);
    const revenue = num(r.revenue);
    const cost = num(r.cost);
    const errors = num(r.errors);
    return {
      key: String(r.key ?? ""),
      label: String(r.label ?? r.key ?? ""),
      requests,
      errors,
      errorRate: requests ? errors / requests : 0,
      revenue,
      cost,
      profit: num(r.profit),
      marginPct: marginPct(revenue, cost),
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      tokens: num(r.tokens),
      avgLatencyMs: num(r.avg_latency),
      p95LatencyMs: num(r.p95),
    };
  });
}

export async function getRecentErrors(f: AnalyticsFilter, limit = 10, opts: { includeInternal?: boolean; maxAgeHours?: number } = {}): Promise<RecentError[]> {
  const from = opts.maxAgeHours ? new Date(Math.max(f.from.getTime(), Date.now() - opts.maxAgeHours * 3_600_000)) : f.from;
  const rows = await db.requestLog.findMany({
    where: {
      createdAt: { gte: from, lte: f.to },
      status: { in: ["CLIENT_ERROR", "UPSTREAM_ERROR", "GATEWAY_ERROR"] },
      ...(f.userId ? { userId: f.userId } : {}),
      ...(f.modelSlug ? { modelSlug: f.modelSlug } : {}),
      ...(f.providerId ? { providerId: f.providerId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 200),
    select: {
      id: true,
      createdAt: true,
      modelSlug: true,
      endpoint: true,
      status: true,
      httpStatus: true,
      errorCode: true,
      errorMessage: true,
      internalError: opts.includeInternal ?? false,
      providerId: true,
      userId: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    modelSlug: r.modelSlug,
    endpoint: r.endpoint,
    status: r.status,
    httpStatus: r.httpStatus,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    internalError: "internalError" in r ? ((r as { internalError: string | null }).internalError ?? null) : null,
    providerId: r.providerId,
    userId: r.userId,
  }));
}

/** Per-provider window stats (admin lists). */
export async function getProviderWindowStats(from: Date, to: Date = new Date()) {
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>`
    SELECT r."providerId" AS id,
      count(*)::float8 AS requests,
      (count(*) FILTER (WHERE ${ERR}))::float8 AS errors,
      coalesce(sum(r."cost"), 0)::float8 AS cost,
      coalesce(sum(r."price"), 0)::float8 AS revenue
    FROM "RequestLog" r
    WHERE r."createdAt" >= ${from} AND r."createdAt" <= ${to} AND r."providerId" IS NOT NULL
    GROUP BY 1
  `;
  return new Map(rows.map((r) => [String(r.id), { requests: num(r.requests), errors: num(r.errors), cost: num(r.cost), revenue: num(r.revenue) }]));
}

/** Per-provider-key window stats (admin provider detail). */
export async function getProviderKeyWindowStats(from: Date, to: Date = new Date(), providerId?: string) {
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>`
    SELECT r."providerKeyId" AS id,
      count(*)::float8 AS requests,
      (count(*) FILTER (WHERE ${ERR}))::float8 AS errors,
      coalesce(sum(r."cost"), 0)::float8 AS cost
    FROM "RequestLog" r
    WHERE r."createdAt" >= ${from} AND r."createdAt" <= ${to} AND r."providerKeyId" IS NOT NULL
      ${providerId ? Prisma.sql`AND r."providerId" = ${providerId}` : Prisma.empty}
    GROUP BY 1
  `;
  return new Map(rows.map((r) => [String(r.id), { requests: num(r.requests), errors: num(r.errors), cost: num(r.cost) }]));
}
