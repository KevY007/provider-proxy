import "server-only";
import { db } from "@/lib/db";
import { getSlotSnapshot } from "@/gateway/slots";
import { getProviderWindowStats } from "@/server/analytics/queries";
import { getLatencyBreakdown, type LatencyRow } from "@/server/analytics/latency";
import { availabilityPct } from "./status-utils";
import { iso, num } from "./serialize";

export interface StatusProviderRow {
  id: string;
  name: string;
  status: string;
  healthStatus: string;
  lastCheckAt: string | null;
  lastLatencyMs: number | null;
  avail24h: number | null;
  avail7d: number | null;
  checks24h: number;
  req24h: number;
  err24h: number;
  /** Real-traffic latency over 24 h (no timer pings). */
  p50Ms24h: number | null;
  ttftP50Ms24h: number | null;
  lastCallMs: number | null;
  lastCallAt: string | null;
}

export interface StatusKeyRow {
  id: string;
  providerId: string;
  providerName: string;
  label: string;
  secretHint: string;
  status: string;
  consecutiveFailures: number;
  lastError: string | null;
  avail24h: number | null;
  avail7d: number | null;
  checks24h: number;
  fails24h: number;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastLatencyMs: number | null;
  p50Ms24h: number | null;
  lastCallMs: number | null;
  lastCallAt: string | null;
}

export interface RecentFailure {
  id: string;
  createdAt: string;
  providerName: string;
  keyLabel: string | null;
  latencyMs: number | null;
  error: string | null;
}

const H = 3600_000;

export async function getStatusData() {
  const now = Date.now();
  const d1 = new Date(now - 24 * H);
  const d7 = new Date(now - 7 * 24 * H);

  const noRows: LatencyRow[] = [];
  const [providers, keys, agg, latest, failures, stats, slots, pLat, kLat] = await Promise.all([
    db.provider.findMany({
      orderBy: [{ status: "asc" }, { name: "asc" }],
      select: { id: true, name: true, status: true, healthStatus: true, lastCheckAt: true, lastLatencyMs: true },
    }),
    db.providerKey.findMany({
      orderBy: [{ providerId: "asc" }, { label: "asc" }],
      select: {
        id: true, providerId: true, label: true, secretHint: true, status: true, consecutiveFailures: true, lastError: true,
        provider: { select: { name: true } },
      },
    }),
    db.$queryRaw<Array<Record<string, unknown>>>`
      SELECT "providerId", "providerKeyId",
        (count(*) FILTER (WHERE "createdAt" >= ${d1}))::float8 AS n1,
        (count(*) FILTER (WHERE ok AND "createdAt" >= ${d1}))::float8 AS ok1,
        (count(*))::float8 AS n7,
        (count(*) FILTER (WHERE ok))::float8 AS ok7
      FROM "HealthCheck"
      WHERE "createdAt" >= ${d7}
      GROUP BY 1, 2`,
    db.$queryRaw<Array<Record<string, unknown>>>`
      SELECT DISTINCT ON ("providerKeyId") "providerKeyId", ok, "latencyMs", "createdAt"
      FROM "HealthCheck"
      WHERE "providerKeyId" IS NOT NULL AND "createdAt" >= ${d7}
      ORDER BY "providerKeyId", "createdAt" DESC`,
    db.healthCheck.findMany({
      where: { ok: false },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true, createdAt: true, latencyMs: true, error: true,
        provider: { select: { name: true } }, providerKey: { select: { label: true } },
      },
    }),
    getProviderWindowStats(d1).catch(() => new Map()),
    getSlotSnapshot().catch(() => ({ providerKeys: [], providers: [], customers: [], queued: 0, at: new Date().toISOString() })),
    getLatencyBreakdown("provider", { from: d1, to: new Date(now) }, 1000).catch(() => noRows),
    getLatencyBreakdown("providerKey", { from: d1, to: new Date(now) }, 5000).catch(() => noRows),
  ]);
  const pLatBy = new Map(pLat.map((r) => [r.key, r]));
  const kLatBy = new Map(kLat.map((r) => [r.key, r]));

  const pAgg = new Map<string, { n1: number; ok1: number; n7: number; ok7: number }>();
  const kAgg = new Map<string, { n1: number; ok1: number; n7: number; ok7: number }>();
  for (const r of agg) {
    const v = { n1: num(r.n1), ok1: num(r.ok1), n7: num(r.n7), ok7: num(r.ok7) };
    const pid = String(r.providerId);
    const p = pAgg.get(pid) ?? { n1: 0, ok1: 0, n7: 0, ok7: 0 };
    p.n1 += v.n1; p.ok1 += v.ok1; p.n7 += v.n7; p.ok7 += v.ok7;
    pAgg.set(pid, p);
    if (r.providerKeyId) kAgg.set(String(r.providerKeyId), v);
  }
  const lastByKey = new Map(latest.map((r) => [String(r.providerKeyId), r]));

  const providerRows: StatusProviderRow[] = providers.map((p) => {
    const a = pAgg.get(p.id);
    const s = stats.get(p.id);
    return {
      id: p.id, name: p.name, status: p.status, healthStatus: p.healthStatus, lastCheckAt: iso(p.lastCheckAt), lastLatencyMs: p.lastLatencyMs,
      avail24h: a ? availabilityPct(a.ok1, a.n1) : null, avail7d: a ? availabilityPct(a.ok7, a.n7) : null, checks24h: a?.n1 ?? 0,
      req24h: s?.requests ?? 0, err24h: s?.errors ?? 0,
      p50Ms24h: pLatBy.get(p.id)?.p50Ms ?? null, ttftP50Ms24h: pLatBy.get(p.id)?.ttftP50Ms ?? null,
      lastCallMs: pLatBy.get(p.id)?.lastMs ?? null, lastCallAt: pLatBy.get(p.id)?.lastAt ?? null,
    };
  });

  const keyRows: StatusKeyRow[] = keys.map((k) => {
    const a = kAgg.get(k.id);
    const l = lastByKey.get(k.id);
    return {
      id: k.id, providerId: k.providerId, providerName: k.provider.name, label: k.label, secretHint: k.secretHint, status: k.status,
      consecutiveFailures: k.consecutiveFailures, lastError: k.lastError,
      avail24h: a ? availabilityPct(a.ok1, a.n1) : null, avail7d: a ? availabilityPct(a.ok7, a.n7) : null,
      checks24h: a?.n1 ?? 0, fails24h: a ? a.n1 - a.ok1 : 0,
      lastCheckAt: l ? new Date(l.createdAt as Date).toISOString() : null, lastCheckOk: l ? Boolean(l.ok) : null,
      lastLatencyMs: l && l.latencyMs != null ? num(l.latencyMs) : null,
      p50Ms24h: kLatBy.get(k.id)?.p50Ms ?? null, lastCallMs: kLatBy.get(k.id)?.lastMs ?? null, lastCallAt: kLatBy.get(k.id)?.lastAt ?? null,
    };
  });

  const failureRows: RecentFailure[] = failures.map((f) => ({
    id: f.id, createdAt: f.createdAt.toISOString(), providerName: f.provider.name, keyLabel: f.providerKey?.label ?? null,
    latencyMs: f.latencyMs, error: f.error,
  }));

  return { providers: providerRows, keys: keyRows, failures: failureRows, slots };
}
