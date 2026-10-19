import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { num } from "./serialize";

/**
 * Uptime / downtime and ping history per provider, in time buckets. Sources, all of them real:
 *  - customer calls (RequestLog: SUCCESS vs UPSTREAM_ERROR) - always
 *  - uptime pings (HealthCheck source "probe") - only when uptime monitoring is on, or after "Run checks now"
 * A bucket with neither is "no data" (grey), never "up": the proxy does not invent health for idle providers.
 */
export type UptimeRange = "24h" | "7d" | "30d";
export const UPTIME_RANGES: Record<UptimeRange, { ms: number; buckets: number; label: string }> = {
  "24h": { ms: 24 * 3_600_000, buckets: 48, label: "24 hours (30 min bars)" },
  "7d": { ms: 7 * 86_400_000, buckets: 56, label: "7 days (3 h bars)" },
  "30d": { ms: 30 * 86_400_000, buckets: 60, label: "30 days (12 h bars)" },
};
export const isUptimeRange = (v: unknown): v is UptimeRange => typeof v === "string" && v in UPTIME_RANGES;

export type UptimeLevel = "up" | "degraded" | "down" | "nodata";

export interface UptimeBucket {
  t: string;
  level: UptimeLevel;
  /** Successful / all (calls + pings), 0..100; null = no data. */
  pct: number | null;
  calls: number;
  failedCalls: number;
  pings: number;
  failedPings: number;
  /** Average ping round trip (uptime pings). */
  pingMs: number | null;
  /** Median total latency of successful calls. */
  p50Ms: number | null;
}

export interface UptimeProvider {
  id: string;
  name: string;
  status: string;
  uptimePct: number | null;
  /** Minutes covered by buckets marked down. */
  downMinutes: number;
  lastPingMs: number | null;
  buckets: UptimeBucket[];
}

export function levelOf(pct: number | null): UptimeLevel {
  if (pct === null) return "nodata";
  if (pct >= 99) return "up";
  if (pct >= 90) return "degraded";
  return "down";
}

export async function getUptime(range: UptimeRange, now = new Date()): Promise<{ range: UptimeRange; bucketMs: number; from: string; providers: UptimeProvider[] }> {
  const r = UPTIME_RANGES[range];
  const bucketMs = r.ms / r.buckets;
  const from = new Date(now.getTime() - r.ms);
  const bucketSec = bucketMs / 1000;
  const idx = (col: string) => Prisma.raw(`floor(extract(epoch from (${col} - '${from.toISOString()}'::timestamptz)) / ${bucketSec})::int`);

  const [providers, calls, pings, lastPings] = await Promise.all([
    db.provider.findMany({ select: { id: true, name: true, status: true }, orderBy: [{ status: "asc" }, { name: "asc" }] }),
    db.$queryRaw<Array<Record<string, unknown>>>`
      SELECT r."providerId" AS pid, ${idx(`r."createdAt"`)} AS b,
        count(*) FILTER (WHERE r."status" = 'SUCCESS')::float8 AS ok,
        count(*) FILTER (WHERE r."status" = 'UPSTREAM_ERROR')::float8 AS bad,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY r."latencyMs") FILTER (WHERE r."status" = 'SUCCESS' AND r."latencyMs" > 0) AS p50
      FROM "RequestLog" r
      WHERE r."createdAt" >= ${from} AND r."createdAt" <= ${now} AND r."providerId" IS NOT NULL AND r."batchId" IS NULL
        AND r."status" IN ('SUCCESS', 'UPSTREAM_ERROR')
      GROUP BY 1, 2`,
    db.$queryRaw<Array<Record<string, unknown>>>`
      SELECT h."providerId" AS pid, ${idx(`h."createdAt"`)} AS b,
        count(*) FILTER (WHERE h.ok)::float8 AS ok,
        count(*) FILTER (WHERE NOT h.ok)::float8 AS bad,
        avg(h."latencyMs") FILTER (WHERE h.ok) AS ping
      FROM "HealthCheck" h
      WHERE h."createdAt" >= ${from} AND h."createdAt" <= ${now} AND h."source" = 'probe'
      GROUP BY 1, 2`,
    db.$queryRaw<Array<Record<string, unknown>>>`
      SELECT DISTINCT ON (h."providerId") h."providerId" AS pid, h."latencyMs" AS ms
      FROM "HealthCheck" h
      WHERE h."source" = 'probe' AND h.ok AND h."createdAt" >= ${from}
      ORDER BY h."providerId", h."createdAt" DESC`,
  ]);

  const key = (pid: unknown, b: unknown) => `${String(pid)}:${Number(b)}`;
  const callBy = new Map(calls.map((c) => [key(c.pid, c.b), c]));
  const pingBy = new Map(pings.map((p) => [key(p.pid, p.b), p]));
  const lastPingBy = new Map(lastPings.map((p) => [String(p.pid), p.ms === null ? null : num(p.ms)]));
  const active = new Set([...calls, ...pings].map((x) => String(x.pid)));

  const out: UptimeProvider[] = providers
    .filter((p) => p.status === "ACTIVE" || active.has(p.id))
    .map((p) => {
      let okAll = 0;
      let nAll = 0;
      let downBuckets = 0;
      const buckets: UptimeBucket[] = [];
      for (let i = 0; i < r.buckets; i++) {
        const c = callBy.get(key(p.id, i));
        const h = pingBy.get(key(p.id, i));
        const calls = c ? num(c.ok) + num(c.bad) : 0;
        const failedCalls = c ? num(c.bad) : 0;
        const pingsN = h ? num(h.ok) + num(h.bad) : 0;
        const failedPings = h ? num(h.bad) : 0;
        const n = calls + pingsN;
        const ok = n - failedCalls - failedPings;
        const pct = n ? (ok / n) * 100 : null;
        const level = levelOf(pct);
        if (level === "down") downBuckets++;
        okAll += ok;
        nAll += n;
        buckets.push({
          t: new Date(from.getTime() + i * bucketMs).toISOString(),
          level,
          pct,
          calls,
          failedCalls,
          pings: pingsN,
          failedPings,
          pingMs: h && h.ping !== null ? Math.round(num(h.ping)) : null,
          p50Ms: c && c.p50 !== null ? Math.round(num(c.p50)) : null,
        });
      }
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        uptimePct: nAll ? (okAll / nAll) * 100 : null,
        downMinutes: Math.round((downBuckets * bucketMs) / 60_000),
        lastPingMs: lastPingBy.get(p.id) ?? null,
        buckets,
      };
    });
  return { range, bucketMs, from: from.toISOString(), providers: out };
}
