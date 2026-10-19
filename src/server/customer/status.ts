import "server-only";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  buildDailyBars,
  combineHealth,
  currentLevel,
  levelFromHealth,
  overallLevel,
  windowAvailability,
  availabilityPct,
  type DayBar,
  type StatusLevel,
} from "./status-calc";

/** Vendor-level status. Deliberately exposes nothing about internal providers, keys or routes. */
export interface VendorStatus {
  vendor: string;
  modelCount: number;
  level: StatusLevel;
  availability24h: number | null;
  availability7d: number | null;
  availability90d: number | null;
  bars: DayBar[];
}

export interface StatusSnapshot {
  generatedAt: string;
  overall: StatusLevel;
  vendors: VendorStatus[];
}

const HISTORY_DAYS = 90;
const CACHE_MS = 15_000;
const g = globalThis as unknown as { __publicStatus?: { at: number; value: StatusSnapshot } };

interface WindowRow {
  vendor: string;
  s15: number;
  f15: number;
  s24: number;
  f24: number;
  s7: number;
  f7: number;
}
interface DayRow {
  vendor: string;
  day: string;
  success: number;
  failed: number;
}
interface HealthRow {
  vendor: string;
  health: string;
}

async function compute(): Promise<StatusSnapshot> {
  const now = new Date();
  const since7d = new Date(now.getTime() - 7 * 86_400_000);
  const since24h = new Date(now.getTime() - 86_400_000);
  const since15m = new Date(now.getTime() - 15 * 60_000);
  const since90d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (HISTORY_DAYS - 1) * 86_400_000);

  const [models, windows, days, health] = await Promise.all([
    db.model.groupBy({ by: ["vendor"], where: { status: "ACTIVE" }, _count: { _all: true } }),
    db.$queryRaw<WindowRow[]>`
      SELECT m."vendor" AS vendor,
        COUNT(*) FILTER (WHERE r."status" = 'SUCCESS' AND r."createdAt" >= ${since15m})::int AS s15,
        COUNT(*) FILTER (WHERE r."status" <> 'SUCCESS' AND r."createdAt" >= ${since15m})::int AS f15,
        COUNT(*) FILTER (WHERE r."status" = 'SUCCESS' AND r."createdAt" >= ${since24h})::int AS s24,
        COUNT(*) FILTER (WHERE r."status" <> 'SUCCESS' AND r."createdAt" >= ${since24h})::int AS f24,
        COUNT(*) FILTER (WHERE r."status" = 'SUCCESS')::int AS s7,
        COUNT(*) FILTER (WHERE r."status" <> 'SUCCESS')::int AS f7
      FROM "RequestLog" r
      JOIN "Model" m ON m."slug" = r."modelSlug"
      WHERE r."createdAt" >= ${since7d} AND r."status" IN ('SUCCESS', 'UPSTREAM_ERROR', 'GATEWAY_ERROR')
      GROUP BY m."vendor"`,
    db.$queryRaw<DayRow[]>`
      SELECT m."vendor" AS vendor,
        to_char(date_trunc('day', r."createdAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
        COUNT(*) FILTER (WHERE r."status" = 'SUCCESS')::int AS success,
        COUNT(*) FILTER (WHERE r."status" <> 'SUCCESS')::int AS failed
      FROM "RequestLog" r
      JOIN "Model" m ON m."slug" = r."modelSlug"
      WHERE r."createdAt" >= ${since90d} AND r."status" IN ('SUCCESS', 'UPSTREAM_ERROR', 'GATEWAY_ERROR')
      GROUP BY 1, 2`,
    db.$queryRaw<HealthRow[]>`
      SELECT DISTINCT m."vendor" AS vendor, p."healthStatus"::text AS health
      FROM "Model" m
      JOIN "ModelRoute" mr ON mr."modelId" = m."id" AND mr."enabled" = true
      JOIN "Provider" p ON p."id" = mr."providerId" AND p."status" = 'ACTIVE'
      WHERE m."status" = 'ACTIVE'`,
  ]);

  const windowBy = new Map(windows.map((w) => [w.vendor, w]));
  const healthBy = new Map<string, StatusLevel[]>();
  for (const h of health) {
    const arr = healthBy.get(h.vendor) ?? [];
    arr.push(levelFromHealth(h.health));
    healthBy.set(h.vendor, arr);
  }
  const daysBy = new Map<string, Array<{ date: string; success: number; failed: number }>>();
  for (const d of days) {
    const arr = daysBy.get(d.vendor) ?? [];
    arr.push({ date: d.day, success: Number(d.success), failed: Number(d.failed) });
    daysBy.set(d.vendor, arr);
  }

  const vendors: VendorStatus[] = models
    .map((m) => {
      const w = windowBy.get(m.vendor);
      const bars = buildDailyBars(daysBy.get(m.vendor) ?? [], HISTORY_DAYS, now);
      const healthLevel = combineHealth(healthBy.get(m.vendor) ?? []);
      return {
        vendor: m.vendor,
        modelCount: m._count._all,
        level: currentLevel(Number(w?.s15 ?? 0), Number(w?.f15 ?? 0), healthLevel),
        availability24h: availabilityPct(Number(w?.s24 ?? 0), Number(w?.f24 ?? 0)),
        availability7d: availabilityPct(Number(w?.s7 ?? 0), Number(w?.f7 ?? 0)),
        availability90d: windowAvailability(bars, HISTORY_DAYS),
        bars,
      };
    })
    .sort((a, b) => b.modelCount - a.modelCount || a.vendor.localeCompare(b.vendor));

  return { generatedAt: now.toISOString(), overall: overallLevel(vendors.map((v) => v.level)), vendors };
}

/** Public status snapshot, cached in-process for a few seconds to bound DB load from anonymous traffic. */
export async function getStatusSnapshot(): Promise<StatusSnapshot> {
  const c = g.__publicStatus;
  if (c && Date.now() - c.at < CACHE_MS) return c.value;
  try {
    const value = await compute();
    g.__publicStatus = { at: Date.now(), value };
    return value;
  } catch (err) {
    logger.error("status snapshot failed", { err });
    if (c) return c.value;
    return { generatedAt: new Date().toISOString(), overall: "nodata", vendors: [] };
  }
}
