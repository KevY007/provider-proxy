/** Minimal CSV serialisation (pure; used by admin export routes and tests). */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  // neutralise spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T extends object>(rows: T[], columns: Array<{ key: keyof T & string; header?: string }>): string {
  const head = columns.map((c) => csvEscape(c.header ?? c.key)).join(",");
  const body = rows.map((r) => columns.map((c) => csvEscape((r as Record<string, unknown>)[c.key])).join(","));
  return [head, ...body].join("\r\n") + "\r\n";
}

export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"`,
      "cache-control": "no-store",
    },
  });
}
