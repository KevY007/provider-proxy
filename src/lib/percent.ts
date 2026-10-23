// Price multipliers are stored as factors (0.5); admins read and type them as percentages (50 %).

/** "0.5" -> "50", "1.2" -> "120", "" -> "" (at most 2 decimals). */
export function multiplierToPercent(m: string | number | null | undefined): string {
  if (m === null || m === undefined || String(m).trim() === "") return "";
  const n = Number(m);
  return Number.isFinite(n) ? String(Math.round(n * 10000) / 100) : "";
}

/** "50" -> "0.5", "" -> "" (what the actions store). */
export function percentToMultiplier(p: string): string {
  if (p.trim() === "") return "";
  const n = Number(p);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 10000) : p;
}

/** "50% (50% off)" / "120% (20% markup)" / "100% (no change)". */
export function describePercent(pct: number): string {
  if (!Number.isFinite(pct)) return "";
  const r = Math.round(pct * 100) / 100;
  if (r === 100) return "100% (no change)";
  return r < 100 ? `${r}% (${Math.round((100 - r) * 100) / 100}% off)` : `${r}% (${Math.round((r - 100) * 100) / 100}% markup)`;
}
