/** Pure helpers for the status page (unit tested). */

/** ok/total as a percentage with 2 decimals; null when there are no samples. */
export function availabilityPct(ok: number, total: number): number | null {
  if (!total) return null;
  return Math.round((ok / total) * 10000) / 100;
}

/** Tone for an availability figure. */
export function availabilityTone(pct: number | null): "success" | "warning" | "danger" | "neutral" {
  if (pct === null) return "neutral";
  if (pct >= 99) return "success";
  if (pct >= 90) return "warning";
  return "danger";
}
