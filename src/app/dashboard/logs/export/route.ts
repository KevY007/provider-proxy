import { getSession } from "@/lib/auth/session";
import { parseRangeParams } from "@/lib/date-range";
import { csvResponse, toCsv } from "@/server/customer/csv";
import { exportLogs } from "@/server/customer/logs";
import { parseLogFilters } from "@/server/customer/log-filters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /dashboard/logs/export?<same filters as the logs page> - CSV of up to 50k customer-safe rows. */
export async function GET(req: Request) {
  const s = await getSession();
  if (!s) return new Response("Unauthorized", { status: 401 });
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  const filters = parseLogFilters(sp, parseRangeParams(sp, "7d"));
  const rows = await exportLogs(s.user.id, filters);
  const csv = toCsv(
    ["time_utc", "request_id", "key", "model", "endpoint", "stream", "status", "http_status", "error_code", "input_tokens", "output_tokens", "cached_tokens", "cost_usd", "latency_ms", "ttft_ms"],
    rows.map((r) => [r.createdAt, r.id, r.keyName, r.modelSlug, r.endpoint, r.stream, r.status, r.httpStatus, r.errorCode, r.inputTokens, r.outputTokens, r.cachedTokens, r.price, r.latencyMs, r.ttftMs]),
  );
  return csvResponse("request-logs", csv);
}
