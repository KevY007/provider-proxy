/** Pure helpers for the public status page (no DB access, unit-tested). */

export type StatusLevel = "operational" | "degraded" | "down" | "nodata";

/** Thresholds on the success ratio (0..100). */
export const DEGRADED_BELOW = 99;
export const DOWN_BELOW = 90;

/** Availability percentage, or null when there were no countable requests. */
export function availabilityPct(success: number, failed: number): number | null {
  const total = success + failed;
  if (total <= 0) return null;
  return (success / total) * 100;
}

/** Level for a success ratio (null => no data). */
export function levelFromPct(pct: number | null): StatusLevel {
  if (pct === null) return "nodata";
  if (pct >= DEGRADED_BELOW) return "operational";
  if (pct >= DOWN_BELOW) return "degraded";
  return "down";
}

const RANK: Record<StatusLevel, number> = { nodata: 0, operational: 1, degraded: 2, down: 3 };

/** Worst of the given levels, ignoring "nodata" unless everything is nodata. */
export function worstLevel(levels: StatusLevel[]): StatusLevel {
  let worst: StatusLevel = "nodata";
  for (const l of levels) if (RANK[l] > RANK[worst]) worst = l;
  return worst;
}

/** Provider health enum -> level. */
export function levelFromHealth(h: string): StatusLevel {
  switch (h) {
    case "OPERATIONAL":
      return "operational";
    case "DEGRADED":
      return "degraded";
    case "DOWN":
      return "down";
    default:
      return "nodata";
  }
}

/**
 * Combine the health of the active upstreams serving a vendor. Because requests fail over between
 * upstreams, a vendor is only "down" when every known upstream is down.
 */
export function combineHealth(levels: StatusLevel[]): StatusLevel {
  const known = levels.filter((l) => l !== "nodata");
  if (known.length === 0) return "nodata";
  if (known.every((l) => l === "down")) return "down";
  if (known.some((l) => l === "degraded" || l === "down")) return "degraded";
  return "operational";
}

/** Current level: recent request success rate wins when there is enough traffic, otherwise upstream health. */
export function currentLevel(recentSuccess: number, recentFailed: number, health: StatusLevel, minSamples = 5): StatusLevel {
  const total = recentSuccess + recentFailed;
  const fromTraffic = total >= minSamples ? levelFromPct(availabilityPct(recentSuccess, recentFailed)) : "nodata";
  if (fromTraffic === "nodata") return health;
  // Traffic looks fine but health checks say every upstream is down: flag it as degraded.
  if (fromTraffic === "operational" && health === "down") return "degraded";
  return fromTraffic;
}

export interface DayBar {
  /** YYYY-MM-DD (UTC). */
  date: string;
  success: number;
  failed: number;
  pct: number | null;
  level: StatusLevel;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Build exactly `days` daily bars ending today (UTC), oldest first, filling gaps with "nodata".
 * `rows` are per-day counts keyed by YYYY-MM-DD.
 */
export function buildDailyBars(rows: Array<{ date: string; success: number; failed: number }>, days = 90, now = new Date()): DayBar[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const bars: DayBar[] = [];
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = days - 1; i >= 0; i--) {
    const date = dayKey(new Date(end - i * 86_400_000));
    const r = byDate.get(date);
    const success = r?.success ?? 0;
    const failed = r?.failed ?? 0;
    const pct = availabilityPct(success, failed);
    bars.push({ date, success, failed, pct, level: levelFromPct(pct) });
  }
  return bars;
}

/** Aggregate availability over the last `n` bars (weighted by request count). */
export function windowAvailability(bars: DayBar[], n: number): number | null {
  const slice = bars.slice(-n);
  const s = slice.reduce((a, b) => a + b.success, 0);
  const f = slice.reduce((a, b) => a + b.failed, 0);
  return availabilityPct(s, f);
}

export const LEVEL_LABEL: Record<StatusLevel, string> = {
  operational: "Operational",
  degraded: "Degraded performance",
  down: "Major outage",
  nodata: "No data",
};

/** Overall banner level from vendor levels. */
export function overallLevel(levels: StatusLevel[]): StatusLevel {
  const known = levels.filter((l) => l !== "nodata");
  if (known.length === 0) return "nodata";
  if (known.every((l) => l === "down")) return "down";
  if (known.some((l) => l !== "operational")) return "degraded";
  return "operational";
}
