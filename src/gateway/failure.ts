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
}

/** Customer-facing error once attempts are exhausted (never reveals upstream identity). */
export function finalError(f: Failure, settings: Pick<SettingValues, "passUpstreamRateLimits">): GatewayError {
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
      return new GatewayError("no_available_provider", undefined, { ...opts, retryAfterSec: 30 });
    default:
      if (f.status === 529) return new GatewayError("upstream_overloaded", undefined, { ...opts, retryAfterSec: f.retryAfterSec ?? 5, anthropicType: "overloaded_error" });
      return new GatewayError("upstream_error", undefined, opts);
  }
}
