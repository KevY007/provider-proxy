/**
 * Date-range model shared by the DateRangePicker and server-side analytics queries.
 * Safe to import from both server and client code.
 */
export type RangePreset = "24h" | "7d" | "30d" | "90d" | "custom";

export interface DateRangeValue {
  preset: RangePreset;
  from: Date;
  to: Date;
}

export const RANGE_PRESETS: Array<{ value: Exclude<RangePreset, "custom">; label: string; ms: number }> = [
  { value: "24h", label: "24h", ms: 24 * 3600_000 },
  { value: "7d", label: "7d", ms: 7 * 24 * 3600_000 },
  { value: "30d", label: "30d", ms: 30 * 24 * 3600_000 },
  { value: "90d", label: "90d", ms: 90 * 24 * 3600_000 },
];

/** Range ending "now" for a preset (custom => last 7 days). */
export function rangeFromPreset(preset: RangePreset, now = new Date()): DateRangeValue {
  const p = RANGE_PRESETS.find((r) => r.value === preset) ?? RANGE_PRESETS[1];
  return { preset: preset === "custom" ? "custom" : p.value, from: new Date(now.getTime() - p.ms), to: now };
}

/**
 * Parse `?range=7d` or `?range=custom&from=2026-01-01&to=2026-01-31` search params into a range.
 * Invalid input falls back to `fallback` (default 7d). Custom ranges are clamped to 366 days.
 */
export function parseRangeParams(
  params: { range?: string | string[]; from?: string | string[]; to?: string | string[] },
  fallback: RangePreset = "7d",
  now = new Date(),
): DateRangeValue {
  const one = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);
  const range = one(params.range);
  if (range === "custom") {
    const from = new Date(one(params.from) ?? "");
    const to = new Date(one(params.to) ?? "");
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from < to) {
      const end = new Date(to);
      // a bare date (YYYY-MM-DD) means "through the end of that day"
      if (/^\d{4}-\d{2}-\d{2}$/.test(one(params.to) ?? "")) end.setUTCHours(23, 59, 59, 999);
      const minFrom = new Date(end.getTime() - 366 * 24 * 3600_000);
      return { preset: "custom", from: from < minFrom ? minFrom : from, to: end };
    }
    return rangeFromPreset(fallback, now);
  }
  const preset = RANGE_PRESETS.find((r) => r.value === range)?.value;
  return rangeFromPreset(preset ?? fallback, now);
}

/** Inverse of parseRangeParams, for building URLs. */
export function rangeToParams(r: DateRangeValue): Record<string, string> {
  return r.preset === "custom"
    ? { range: "custom", from: r.from.toISOString().slice(0, 10), to: r.to.toISOString().slice(0, 10) }
    : { range: r.preset };
}

/** Suggested bucket size for time-series charts. */
export function suggestGranularity(r: DateRangeValue): "hour" | "day" {
  return r.to.getTime() - r.from.getTime() <= 3 * 24 * 3600_000 ? "hour" : "day";
}
