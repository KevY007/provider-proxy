import { isObject } from "./util";

/**
 * An error an upstream reports INSIDE a stream (or an assembled one): an OpenAI Responses `error` event
 * (`{type:"error", code, message, param}`), the nested shape some relays send (`{type:"error", error:{...}, status:400}`),
 * a `response.failed` event's `response.error`, a chat chunk's `error`, an Anthropic `error` block.
 *
 * The HTTP status decides what happens next: a 4xx the request itself caused (invalid parameter, unsupported value) is
 * returned to the client as that 4xx without retrying; 429 / 5xx / overload are retried or failed over.
 */
export interface InbandError {
  status: number;
  message: string;
  /** the upstream's error type / code (kept for the client's error document) */
  type?: string;
  code?: string | null;
  param?: string | null;
}

/** Parse an in-band error object (the event body, or its `error` / `response.error` member). */
export function parseInbandError(raw: unknown, fallbackMessage = "upstream error"): InbandError {
  const outer = isObject(raw) ? raw : {};
  const e = isObject(outer.error) ? outer.error : outer;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const message = str(e.message) ?? str(outer.message) ?? str(e.type) ?? fallbackMessage;
  const code = str(e.code) ?? str(outer.code) ?? (typeof e.code === "number" ? String(e.code) : undefined);
  const type = str(e.type) && e.type !== "error" ? str(e.type) : undefined;
  const param = str(e.param) ?? str(outer.param) ?? null;
  const status = statusOf([outer.status, e.status, outer.status_code, e.status_code, typeof e.code === "number" ? e.code : undefined], `${code ?? ""} ${type ?? ""}`, message);
  return { status, message, ...(type ? { type } : {}), code: code ?? null, param };
}

function statusOf(candidates: unknown[], codes: string, message: string): number {
  for (const c of candidates) {
    const n = typeof c === "string" ? Number(c) : c;
    if (typeof n === "number" && Number.isInteger(n) && n >= 400 && n < 600) return n;
  }
  const c = codes.toLowerCase();
  if (/rate_limit|too_many|quota/.test(c)) return 429;
  if (/overloaded/.test(c)) return 529;
  if (/unavailable|capacity/.test(c)) return 503;
  if (/timeout/.test(c)) return 504;
  if (/invalid_api_key|authentication|unauthorized/.test(c)) return 401;
  if (/permission|forbidden/.test(c)) return 403;
  if (/not_found/.test(c)) return 404;
  if (/invalid|unsupported|not_supported|bad_request|context_length|too_long|missing_required/.test(c)) return 400;
  if (/rate limit|too many requests/i.test(message)) return 429;
  if (/overloaded|service unavailable|try again later|capacity/i.test(message)) return 503;
  if (/^invalid |invalid value|is not supported|unsupported (value|parameter)|unknown parameter|must be (a|an|one of)|is required/i.test(message)) return 400;
  return 502;
}

/** An OpenAI-shaped `type` for a status, used when the upstream gave none. */
export function openaiErrorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}
