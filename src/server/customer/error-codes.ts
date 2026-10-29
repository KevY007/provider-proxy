/** Customer-facing reference of every gateway error code (PLAN section 5). Pure data; used by docs, logs drawer, playground. */
export interface ErrorCodeInfo {
  code: string;
  http: number;
  meaning: string;
  fix: string;
}

export const ERROR_CODES: ErrorCodeInfo[] = [
  { code: "invalid_api_key", http: 401, meaning: "The API key is missing, malformed or does not exist.", fix: "Send your key as `Authorization: Bearer sk-pp-...` (or `x-api-key` / `x-goog-api-key`). Check for stray whitespace and that you copied the full key." },
  { code: "key_disabled", http: 401, meaning: "The key exists but was disabled or revoked.", fix: "Enable it on the API Keys page, or create a new key." },
  { code: "key_expired", http: 401, meaning: "The key passed its expiry date.", fix: "Create a new key (or clear the expiry on this one)." },
  { code: "ip_not_allowed", http: 403, meaning: "The request came from an IP address that is not on the key's allowlist.", fix: "Add the IP/CIDR to the key's allowlist or remove the restriction." },
  { code: "account_suspended", http: 403, meaning: "Your account is suspended.", fix: "Contact support." },
  { code: "email_not_verified", http: 403, meaning: "Your email address has not been verified yet.", fix: "Open the verification link we emailed you (you can resend it from the login page)." },
  { code: "model_not_found", http: 404, meaning: "No model with that name exists in the catalog.", fix: "Call `GET /v1/models` or see Models & Pricing for valid model ids." },
  { code: "model_not_allowed", http: 403, meaning: "The model exists but your key or pool is not allowed to use it.", fix: "Edit the key's allowed models, or switch the key to a pool that includes the model." },
  { code: "unsupported_endpoint", http: 400, meaning: "The model does not support this endpoint (for example chat on an embeddings model).", fix: "Use the right endpoint for the model's capabilities." },
  { code: "insufficient_balance", http: 402, meaning: "Your balance is too low to run this request.", fix: "Add funds on the Billing page; consider enabling auto-recharge." },
  { code: "spend_limit_reached", http: 402, meaning: "The key's spend limit or your monthly spend limit has been reached.", fix: "Raise the limit on the key or in your billing settings." },
  { code: "rate_limited", http: 429, meaning: "Too many requests per minute/tokens, or too many concurrent requests.", fix: "Back off and retry after the `retry-after` header; lower concurrency or raise the key limits." },
  { code: "no_capacity", http: 429, meaning: "All capacity was busy for longer than the queue timeout.", fix: "Retry after the `retry-after` header. Official SDKs do this automatically." },
  { code: "no_available_provider", http: 503, meaning: "This model is temporarily unavailable.", fix: "Retry shortly; check the Status page." },
  { code: "upstream_insufficient_balance", http: 503, meaning: "The upstream model is out of capacity / funding (not your balance).", fix: "Retry later. If it persists, contact support." },
  { code: "upstream_timeout", http: 504, meaning: "The model took too long to respond.", fix: "Retry; use streaming for long generations." },
  { code: "upstream_error", http: 502, meaning: "The model returned an error or was unreachable.", fix: "Retry with backoff. If it persists, share the request id with support." },
  { code: "invalid_request", http: 400, meaning: "The request body or parameters are invalid.", fix: "Check the error message for the offending field and compare with the API reference." },
  { code: "internal_error", http: 500, meaning: "Unexpected error on our side.", fix: "Retry; if it persists contact support with the request id." },
];

const BY_CODE = new Map(ERROR_CODES.map((e) => [e.code, e]));

export function describeErrorCode(code: string | null | undefined): ErrorCodeInfo | null {
  if (!code) return null;
  return BY_CODE.get(code) ?? null;
}
