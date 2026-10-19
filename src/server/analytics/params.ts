/**
 * Pure helpers for analytics query parameters (safe for server + tests; no DB imports).
 *
 * Exports:
 *   parseAnalyticsParams(searchParams, opts?) -> { range, gran, filter }
 *   normalizeGranularity(range, requested?) -> Granularity   (bounds bucket counts)
 *   previousRange(range) -> { from, to }                       (same-length window right before `range`)
 *   marginPct(revenue, cost) -> number                         ((revenue-cost)/revenue*100, 0 when revenue is 0)
 *   fillTimeBuckets(points, from, to, gran) -> points           (zero-fills hour/day gaps)
 *   BREAKDOWN_DIMS, isBreakdownDim
 */
import { parseRangeParams, suggestGranularity as suggestHourOrDay, type DateRangeValue } from "@/lib/date-range";

export type Granularity = "hour" | "day" | "week" | "month";
export const GRANULARITIES: Granularity[] = ["hour", "day", "week", "month"];

export const BREAKDOWN_DIMS = ["model", "provider", "providerKey", "customer", "group", "endpoint", "status", "errorCode", "apiKey"] as const;
export type BreakdownDim = (typeof BREAKDOWN_DIMS)[number];
export const isBreakdownDim = (v: unknown): v is BreakdownDim => typeof v === "string" && (BREAKDOWN_DIMS as readonly string[]).includes(v);

export const REQUEST_STATUSES = ["SUCCESS", "CLIENT_ERROR", "UPSTREAM_ERROR", "GATEWAY_ERROR", "CANCELLED"] as const;
export type RequestStatusValue = (typeof REQUEST_STATUSES)[number];

export interface AnalyticsFilter {
  from: Date;
  to: Date;
  /** Scope to one customer (customer portal reuses all queries with this). */
  userId?: string;
  modelSlug?: string;
  providerId?: string;
  providerKeyId?: string;
  groupSlug?: string;
  apiKeyId?: string;
  endpoint?: string;
  status?: RequestStatusValue;
}

type SP = Record<string, string | string[] | undefined> | URLSearchParams;

function one(sp: SP, key: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(key) ?? undefined;
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

export function parseAnalyticsParams(
  sp: SP,
  opts: { userId?: string; defaultRange?: "24h" | "7d" | "30d" | "90d"; now?: Date } = {},
): { range: DateRangeValue; gran: Granularity; filter: AnalyticsFilter } {
  const range = parseRangeParams(
    { range: one(sp, "range"), from: one(sp, "from"), to: one(sp, "to") },
    opts.defaultRange ?? "7d",
    opts.now,
  );
  const requested = one(sp, "gran");
  const gran = normalizeGranularity(range, GRANULARITIES.includes(requested as Granularity) ? (requested as Granularity) : undefined);
  const status = one(sp, "status");
  const clean = (k: string) => {
    const v = one(sp, k)?.trim();
    return v ? v.slice(0, 200) : undefined;
  };
  const filter: AnalyticsFilter = {
    from: range.from,
    to: range.to,
    userId: opts.userId ?? clean("userId"),
    modelSlug: clean("model"),
    providerId: clean("provider"),
    providerKeyId: clean("providerKey"),
    groupSlug: clean("group"),
    apiKeyId: clean("apiKey"),
    endpoint: clean("endpoint"),
    status: (REQUEST_STATUSES as readonly string[]).includes(status ?? "") ? (status as RequestStatusValue) : undefined,
  };
  return { range, gran, filter };
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Default granularity for a range, never producing more than ~750 buckets. */
export function normalizeGranularity(range: Pick<DateRangeValue, "from" | "to">, requested?: Granularity): Granularity {
  const span = range.to.getTime() - range.from.getTime();
  const wanted = requested ?? suggestHourOrDay({ preset: "custom", ...range });
  if (wanted === "hour" && span > 31 * DAY) return "day";
  if (wanted === "day" && span > 750 * DAY) return "week";
  return wanted;
}

export function previousRange(range: Pick<DateRangeValue, "from" | "to">): { from: Date; to: Date } {
  const span = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - span), to: new Date(range.from.getTime()) };
}

export function marginPct(revenue: number, cost: number): number {
  if (!revenue) return 0;
  return ((revenue - cost) / revenue) * 100;
}

/** Trend vs previous value, in percent (null when there is no baseline). */
export function trendPct(current: number, previous: number): number | null {
  if (!previous) return current ? null : 0;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function floorTo(d: Date, gran: "hour" | "day"): number {
  const t = d.getTime();
  const unit = gran === "hour" ? HOUR : DAY;
  return Math.floor(t / unit) * unit;
}

/**
 * Zero-fill missing hour/day buckets (UTC) between from and to so charts have a continuous axis.
 * week/month are returned unchanged. `makeEmpty(iso)` builds an empty point.
 */
export function fillTimeBuckets<T extends { t: string }>(points: T[], from: Date, to: Date, gran: Granularity, makeEmpty: (t: string) => T): T[] {
  if (gran !== "hour" && gran !== "day") return points;
  const unit = gran === "hour" ? HOUR : DAY;
  const byT = new Map(points.map((p) => [new Date(p.t).getTime(), p]));
  const out: T[] = [];
  const end = to.getTime();
  for (let t = floorTo(from, gran); t <= end && out.length < 2000; t += unit) {
    out.push(byT.get(t) ?? makeEmpty(new Date(t).toISOString()));
  }
  return out;
}
