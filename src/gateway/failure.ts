import type { SettingValues } from "@/lib/settings";
import { GatewayError, type GatewayErrorCode } from "./errors";
import type { FailureKind } from "./keyhealth";

export interface Failure {
  fk: FailureKind;
  status: number;
  message: string;
  startedAt?: number;
  retryAfterSec?: number;
  rlHeaders?: Record<string, string>;
  internal: string;
  /**
   * The upstream's own HTTP error, prepared for the client (PLAN 9d.1a): real status, retry-after / rate-limit headers,
   * request id and native error document (identity scrubbed). Present for 408 / 429 / 5xx answers (and for an error
   * event that arrived before the stream was committed).
   */
  mirror?: GatewayError;
}

/**
 * Error returned to the client once every pre-commit attempt failed. An upstream HTTP error is MIRRORED (status, headers,
 * error document of the LAST upstream answer); only failures without an upstream answer (connect error, timeout, no
 * usable key) and our own credential problems (401 / 402 / 403 from the upstream account, which would be misread as
 * the customer's key being wrong) get a gateway-authored native error.
 */
export function finalError(f: Failure, settings: Pick<SettingValues, "passUpstreamRateLimits">): GatewayError {
  if (f.mirror) return f.mirror;
  let code: GatewayErrorCode;
  let opts: ConstructorParameters<typeof GatewayError>[2] = { internal: `${f.status || "network"} ${f.fk}: ${f.internal}`.slice(0, 4000), upstreamStatus: f.status || undefined };
  switch (f.fk) {
    case "rate_limit":
      code = "rate_limited";
      opts = {
        ...opts,
        kind: "upstream",
        retryAfterSec: f.retryAfterSec ?? 2,
        headers: settings.passUpstreamRateLimits ? (f.rlHeaders ?? {}) : {},
      };
      return new GatewayError(code, "Rate limit exceeded. Please retry later.", opts);
    case "timeout":
      return new GatewayError("upstream_timeout", undefined, opts);
    case "auth":
    case "payment":
    case "forbidden":
      return new GatewayError("no_available_provider", undefined, { ...opts, retryAfterSec: 30 });
    default:
      if (f.status === 529) return new GatewayError("upstream_overloaded", undefined, { ...opts, retryAfterSec: f.retryAfterSec ?? 5, anthropicType: "overloaded_error" });
      return new GatewayError("upstream_error", undefined, opts);
  }
}
