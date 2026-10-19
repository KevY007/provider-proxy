import type { DateRangeValue } from "@/lib/date-range";
import type { LogFilters } from "./logs";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

const STATUSES = new Set(["success", "error", "SUCCESS", "CLIENT_ERROR", "UPSTREAM_ERROR", "GATEWAY_ERROR", "CANCELLED"]);

/** Pure URL-param -> filter parsing shared by the logs page and the CSV export (validates, never trusts input shape). */
export function parseLogFilters(params: Params, range: DateRangeValue): LogFilters {
  const status = one(params.status);
  return {
    keyId: one(params.key)?.slice(0, 64),
    model: one(params.model)?.slice(0, 120),
    errorCode: one(params.code)?.slice(0, 64),
    status: status && STATUSES.has(status) ? (status as LogFilters["status"]) : undefined,
    from: range.from,
    to: range.to,
  };
}
