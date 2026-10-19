/** Hydration-safe date formatting for admin tables (always UTC, so server and client render identically). */
export function fmtDateTime(iso: string | Date | null | undefined, withSeconds = true): string {
  if (!iso) return "-";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "-";
  const s = d.toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, withSeconds ? 19 : 16)}`;
}

export function fmtDate(iso: string | Date | null | undefined): string {
  if (!iso) return "-";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? "-" : d.toISOString().slice(0, 10);
}

/** "5m ago" style relative time (computed from `now`, pass a stable value from the server when SSR matters). */
export function timeAgo(iso: string | Date | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = (typeof iso === "string" ? new Date(iso) : iso).getTime();
  if (Number.isNaN(t)) return "-";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(iso);
}
