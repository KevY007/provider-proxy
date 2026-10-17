import type { ErrorFormat } from "./types";

/**
 * Gateway error codes (PLAN 5 step 14) and per-format error rendering.
 *   OpenAI   : {"error":{"message","type","code","param":null}}
 *   Anthropic: {"type":"error","error":{"type","message"}}
 *   Gemini   : {"error":{"code","message","status"}}
 * Customer-facing messages never contain upstream identity, URLs or keys - detail goes in `internal`.
 */
export type GatewayErrorCode =
  | "invalid_api_key"
  | "key_disabled"
  | "key_expired"
  | "ip_not_allowed"
  | "account_suspended"
  | "email_not_verified"
  | "model_not_found"
  | "model_not_allowed"
  | "unsupported_endpoint"
  | "insufficient_balance"
  | "spend_limit_reached"
  | "rate_limited"
  | "no_capacity"
  | "no_available_provider"
  | "upstream_timeout"
  | "upstream_error"
  | "upstream_overloaded"
  | "invalid_request"
  | "payload_too_large"
  | "not_found"
  | "method_not_allowed"
  | "client_closed"
  | "internal_error";

/** Maps onto RequestLog.status. */
export type FailureKind = "client" | "gateway" | "upstream" | "cancelled";

interface ErrorDef {
  status: number;
  openaiType: string;
  kind: FailureKind;
  message: string;
}

export const ERROR_DEFS: Record<GatewayErrorCode, ErrorDef> = {
  invalid_api_key: { status: 401, openaiType: "invalid_request_error", kind: "client", message: "Incorrect API key provided." },
  key_disabled: { status: 401, openaiType: "invalid_request_error", kind: "client", message: "This API key has been disabled." },
  key_expired: { status: 401, openaiType: "invalid_request_error", kind: "client", message: "This API key has expired." },
  ip_not_allowed: { status: 403, openaiType: "permission_error", kind: "client", message: "Requests from this IP address are not allowed for this API key." },
  account_suspended: { status: 403, openaiType: "permission_error", kind: "client", message: "This account is suspended." },
  email_not_verified: { status: 403, openaiType: "permission_error", kind: "client", message: "Verify your email address before using the API." },
  model_not_found: { status: 404, openaiType: "invalid_request_error", kind: "client", message: "The requested model does not exist." },
  model_not_allowed: { status: 403, openaiType: "permission_error", kind: "client", message: "Your API key does not have access to this model." },
  unsupported_endpoint: { status: 400, openaiType: "invalid_request_error", kind: "client", message: "This model does not support this endpoint." },
  insufficient_balance: { status: 402, openaiType: "billing_error", kind: "client", message: "Insufficient balance. Add credit to continue." },
  spend_limit_reached: { status: 402, openaiType: "billing_error", kind: "client", message: "A spend limit has been reached." },
  rate_limited: { status: 429, openaiType: "rate_limit_error", kind: "client", message: "Rate limit exceeded. Please retry later." },
  no_capacity: { status: 429, openaiType: "rate_limit_error", kind: "gateway", message: "All capacity for this model is currently busy. Please retry shortly." },
  no_available_provider: { status: 503, openaiType: "server_error", kind: "gateway", message: "No provider is currently available for this model." },
  upstream_timeout: { status: 504, openaiType: "server_error", kind: "upstream", message: "The upstream provider timed out." },
  upstream_error: { status: 502, openaiType: "server_error", kind: "upstream", message: "The upstream provider returned an error." },
  upstream_overloaded: { status: 529, openaiType: "server_error", kind: "upstream", message: "The upstream provider is overloaded. Please retry shortly." },
  invalid_request: { status: 400, openaiType: "invalid_request_error", kind: "client", message: "Invalid request." },
  payload_too_large: { status: 413, openaiType: "invalid_request_error", kind: "client", message: "Request body is too large." },
  not_found: { status: 404, openaiType: "invalid_request_error", kind: "client", message: "Unknown endpoint." },
  method_not_allowed: { status: 405, openaiType: "invalid_request_error", kind: "client", message: "Method not allowed for this endpoint." },
  client_closed: { status: 499, openaiType: "invalid_request_error", kind: "cancelled", message: "Client closed the request." },
  internal_error: { status: 500, openaiType: "server_error", kind: "gateway", message: "Internal server error." },
};

export interface GatewayErrorOptions {
  status?: number;
  /** Override the OpenAI `type` field. */
  type?: string;
  param?: string | null;
  retryAfterSec?: number;
  /** Extra response headers (e.g. passed-through x-ratelimit-*). */
  headers?: Record<string, string>;
  /** Admin-only detail stored in RequestLog.internalError. */
  internal?: string;
  kind?: FailureKind;
  /** Anthropic error type override (e.g. overloaded_error). */
  anthropicType?: string;
  /** Raw upstream error body to re-send as-is (already scrubbed); used for same-format passthrough. */
  passthroughBody?: string;
  upstreamStatus?: number;
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;
  readonly kind: FailureKind;
  readonly opts: GatewayErrorOptions;

  constructor(code: GatewayErrorCode, message?: string, opts: GatewayErrorOptions = {}) {
    super(message ?? ERROR_DEFS[code].message);
    this.name = "GatewayError";
    this.code = code;
    this.status = opts.status ?? ERROR_DEFS[code].status;
    this.kind = opts.kind ?? ERROR_DEFS[code].kind;
    this.opts = opts;
  }

  get internal(): string | undefined {
    return this.opts.internal;
  }
  get retryAfterSec(): number | undefined {
    return this.opts.retryAfterSec;
  }
}

export function isGatewayError(e: unknown): e is GatewayError {
  return e instanceof GatewayError;
}

function anthropicTypeFor(status: number, code: GatewayErrorCode, override?: string): string {
  if (override) return override;
  if (code === "upstream_overloaded" || code === "no_available_provider") return "overloaded_error";
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 402:
      return "billing_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 529:
      return "overloaded_error";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

export function geminiStatusFor(status: number): string {
  switch (status) {
    case 400:
    case 413:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 402:
      return "FAILED_PRECONDITION";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 405:
      return "INVALID_ARGUMENT";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 499:
      return "CANCELLED";
    case 502:
    case 503:
    case 529:
      return "UNAVAILABLE";
    case 504:
      return "DEADLINE_EXCEEDED";
    default:
      return status >= 500 ? "INTERNAL" : "INVALID_ARGUMENT";
  }
}

/** JSON-serialisable error body in the given inbound error format. */
export function errorBody(format: ErrorFormat, err: GatewayError, requestId?: string): Record<string, unknown> {
  const def = ERROR_DEFS[err.code];
  switch (format) {
    case "anthropic":
      return {
        type: "error",
        error: { type: anthropicTypeFor(err.status, err.code, err.opts.anthropicType), message: err.message },
        ...(requestId ? { request_id: requestId } : {}),
      };
    case "gemini":
      return { error: { code: err.status, message: err.message, status: geminiStatusFor(err.status) } };
    default:
      return {
        error: {
          message: err.message,
          type: err.opts.type ?? def.openaiType,
          code: err.code,
          param: err.opts.param ?? null,
        },
      };
  }
}

export function errorHeaders(err: GatewayError, requestId?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (requestId) h["x-request-id"] = requestId;
  if (err.opts.retryAfterSec !== undefined) h["retry-after"] = String(Math.max(0, Math.ceil(err.opts.retryAfterSec)));
  if (err.opts.headers) Object.assign(h, err.opts.headers);
  return h;
}

/** Error as an HTTP Response in the inbound format's shape. */
export function errorResponse(format: ErrorFormat, err: GatewayError, requestId?: string): Response {
  const body = err.opts.passthroughBody ?? JSON.stringify(errorBody(format, err, requestId));
  return new Response(body, { status: err.status, headers: errorHeaders(err, requestId) });
}

/** Serialised mid-stream error event for SSE responses (status already 200). */
export function streamErrorEvent(format: ErrorFormat, err: GatewayError, requestId?: string): string {
  const body = errorBody(format, err, requestId);
  if (format === "anthropic") return `event: error\ndata: ${JSON.stringify(body)}\n\n`;
  return `data: ${JSON.stringify(body)}\n\n`;
}

export function toGatewayError(e: unknown): GatewayError {
  if (e instanceof GatewayError) return e;
  const msg = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
  return new GatewayError("internal_error", undefined, { internal: msg.slice(0, 4000) });
}

export function errorFormatFor(inbound: string): ErrorFormat {
  if (inbound === "anthropic_messages") return "anthropic";
  if (inbound === "gemini") return "gemini";
  return "openai";
}
