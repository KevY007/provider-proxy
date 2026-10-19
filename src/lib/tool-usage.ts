/**
 * Server-tool usage of a request (`RequestLog.toolUsage`, e.g. `{"web_search_request": 2, "code_execution_hour": 0.0833}`)
 * for display. Pure: safe in server, client and CSV code.
 */

/** A Json column -> `{ key: units }` with only positive finite numbers, keys sorted. */
export function toolUsageMap(v: unknown): Record<string, number> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    const n = Number((v as Record<string, unknown>)[k]);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

const units = (n: number) => String(Number(n.toPrecision(4)));

/** "web_search_request ×2, code_execution_hour ×0.08333" ("" when no tools ran). */
export function formatToolUsage(m: Record<string, number>): string {
  return Object.entries(m)
    .map(([k, n]) => `${k} ×${units(n)}`)
    .join(", ");
}

/** CSV-friendly (ASCII): "web_search_request=2; code_execution_hour=0.08333". */
export function toolUsageCsv(m: Record<string, number>): string {
  return Object.entries(m)
    .map(([k, n]) => `${k}=${units(n)}`)
    .join("; ");
}
