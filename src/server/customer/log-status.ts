/**
 * Clear request-log status + error explanations (customer + admin logs). Pure: client + server safe.
 */
import { describeErrorCode } from "./error-codes";
import type { StatusTone } from "@/components/common/status-badge";

export interface LogStatusInfo {
  label: string;
  tone: StatusTone;
  /** One-line plain-English description. */
  hint: string;
}

const STATUS: Record<string, LogStatusInfo> = {
  SUCCESS: { label: "Success", tone: "success", hint: "The request completed and was billed." },
  CLIENT_ERROR: { label: "Rejected", tone: "warning", hint: "The request was refused before reaching a model (bad input, auth, limits or balance)." },
  UPSTREAM_ERROR: { label: "Model error", tone: "danger", hint: "The model failed or timed out." },
  GATEWAY_ERROR: { label: "Our error", tone: "danger", hint: "Something went wrong on our side." },
};

export function logStatusInfo(status: string | null | undefined, httpStatus?: number | null): LogStatusInfo {
  const base = STATUS[(status ?? "").toUpperCase()];
  if (base) return base;
  if (httpStatus && httpStatus >= 200 && httpStatus < 300) return STATUS.SUCCESS;
  if (httpStatus && httpStatus >= 500) return STATUS.UPSTREAM_ERROR;
  if (httpStatus && httpStatus >= 400) return STATUS.CLIENT_ERROR;
  return { label: status ?? "Unknown", tone: "neutral", hint: "" };
}

export interface ErrorExplanation {
  code: string;
  meaning: string;
  fix: string | null;
  docsHref: string;
}

/** Human explanation + docs link for an error code. Unknown codes still link to the errors reference. */
export function explainError(code: string | null | undefined, message?: string | null): ErrorExplanation | null {
  if (!code) return null;
  const info = describeErrorCode(code);
  return {
    code,
    meaning: info?.meaning ?? message ?? "The request failed.",
    fix: info?.fix ?? null,
    docsHref: `/docs/errors#${code}`,
  };
}

/** One upstream attempt as stored in RequestLog.attempts (status = upstream HTTP status, 0 = network error/timeout). */
export interface AttemptView {
  providerId: string | null;
  providerKeyId: string | null;
  routeId: string | null;
  status: number | null;
  ok: boolean;
  error: string | null;
  latencyMs: number | null;
}

export function parseAttempts(raw: unknown): AttemptView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => {
    const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    const status = num(o.status);
    const error = str(o.error);
    return {
      providerId: str(o.providerId),
      providerKeyId: str(o.providerKeyId),
      routeId: str(o.routeId),
      status,
      ok: status !== null && status >= 200 && status < 300 && !error,
      error,
      latencyMs: num(o.latencyMs),
    };
  });
}

/** Plain-English label for an attempt's upstream status. */
export function attemptStatusLabel(status: number | null): string {
  if (status === null) return "Unknown";
  if (status === 0) return "No response (network error or timeout)";
  if (status >= 200 && status < 300) return "OK";
  if (status === 429) return "Rate limited";
  if (status === 401 || status === 403) return "Rejected";
  if (status === 404) return "Model not found";
  if (status === 408 || status === 504) return "Timed out";
  if (status >= 500) return "Model error";
  return "Rejected";
}
