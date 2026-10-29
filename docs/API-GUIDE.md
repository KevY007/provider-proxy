# API guide (for integrators)

This page lists what the gateway accepts and how it behaves. Request and response examples, SDK snippets (curl,
Python, Node) and client setups (Codex CLI, Claude Code, OpenCode, Cursor) are in the in-app docs at **`/docs`**
(source: `src/components/marketing/docs/registry.ts`). Useful pages: `/docs/authentication`, `/docs/streaming`,
`/docs/tools`, `/docs/batches`, `/docs/rate-limits`, `/docs/billing` and `/docs/errors`.

One base URL serves every format: `https://<your-domain>`. Use `https://<domain>/v1` as the OpenAI base URL, the
origin as the Anthropic base URL, and the origin (`/v1beta/...`) for Gemini.

## Authentication

Send a customer key (`sk-pp-` + 40 base62 chars) in any of these. The first `sk-pp-` value wins.

| Style | Typical client |
|---|---|
| `Authorization: Bearer sk-pp-...` | OpenAI SDKs, most tools |
| `x-api-key: sk-pp-...` | Anthropic SDKs, Claude Code |
| `x-goog-api-key: sk-pp-...` | Google GenAI SDKs |
| `?key=sk-pp-...` | Gemini REST style |

Per key, the customer can set a pool (group), allowed models, RPM/TPM limits, a spend limit, an expiry, an IP
allowlist (CIDR or exact) and max concurrency. Every response carries `x-request-id` (our log id). Upstream request
ids are returned as `x-upstream-request-id`. CORS is open (`*`) on the API.

## Endpoints

### OpenAI-compatible (`/v1`)

| Endpoint | Notes |
|---|---|
| `POST /v1/chat/completions` | Stream + non-stream. Can be served by Anthropic models (translated). |
| `POST /v1/completions` | Legacy completions |
| `POST /v1/responses`, `GET/DELETE /v1/responses/{id}`, `POST /v1/responses/{id}/cancel`, `GET /v1/responses/{id}/input_items` | Lookups and `previous_response_id` are pinned to the account that created the response, and are owner-checked |
| `POST /v1/embeddings` | |
| `POST /v1/images/generations`, `/v1/images/edits`, `/v1/images/variations` | Edits/variations are multipart. fal.ai and Replicate models are on `/generations` only (`n`, `size`, `seed`, `negative_prompt`, `output_format`, `response_format` `url`/`b64_json`, `extra_input`). |
| `POST /v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/audio/translations` | Speech returns binary. The others are multipart. |
| `POST /v1/moderations` | |
| `POST /v1/videos` (JSON or multipart), `GET /v1/videos`, `GET /v1/videos/{id}`, `GET /v1/videos/{id}/content[?variant=]`, `DELETE /v1/videos/{id}` | Sora-style job API. Public ids are `video_<48 hex>`. Charged at creation, refunded automatically if the job fails. Polling and downloads are free. |
| `POST/GET /v1/files`, `GET/DELETE /v1/files/{id}`, `GET /v1/files/{id}/content` | OpenAI Files. The same paths with an `anthropic-version` header are the Anthropic Files API. |
| `POST /v1/uploads`, `POST /v1/uploads/{id}/parts`, `/complete`, `/cancel` | OpenAI multipart uploads |
| `GET /v1/containers/{id}/files/{file}[/content]` | Files that a Responses code-interpreter run created |
| `POST/GET /v1/batches`, `GET /v1/batches/{id}`, `POST /v1/batches/{id}/cancel` | OpenAI Batch. Line endpoints: `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/completions`, `/v1/moderations`. |
| `GET /v1/models`, `GET /v1/models/{id}` | Only the models your key may use. OpenAI shape plus OpenRouter-style `pricing` and our `x_pricing` (your price, official price, savings %). Anthropic shape when `anthropic-version` is sent. |
| `GET /v1/model/info` (alias `/v1/model_info`) | LiteLLM-style price and capability sheet at your effective price |

### Anthropic-compatible

| Endpoint | Notes |
|---|---|
| `POST /v1/messages` | Stream + non-stream. `anthropic-version` and `anthropic-beta` are forwarded. Can be served by OpenAI-format models (translated). |
| `POST /v1/messages/count_tokens` | Forwarded to a native Anthropic route. Estimated locally (free) when the model has none. |
| `/v1/files*` with `anthropic-version` | Anthropic Files API (beta headers forwarded) |
| `POST/GET /v1/messages/batches`, `GET/DELETE /v1/messages/batches/{id}`, `GET .../{id}/results`, `POST .../{id}/cancel` | Message Batches |

### Gemini-compatible (`/v1beta`)

| Endpoint | Notes |
|---|---|
| `POST /v1beta/models/{model}:generateContent` | |
| `POST /v1beta/models/{model}:streamGenerateContent` | `?alt=sse` for SSE. Without it you get a JSON array stream. |
| `:countTokens`, `:embedContent`, `:batchEmbedContents` | |
| `GET /v1beta/models`, `GET /v1beta/models/{model}` | Gemini shape |
| `POST/PUT /upload/v1beta/files`, `GET /v1beta/files`, `GET/DELETE /v1beta/files/{id}` | Resumable upload. `x-goog-upload-url` is rewritten to point at the gateway. |

Gemini requests need a model whose provider speaks Gemini natively; they are not translated. The gateway also
accepts the doubled `/v1/v1/...` prefix and Google's `/v1beta/openai/...` alias.

### Public, or with a key

`GET /api/pricing[?group=slug]` returns the price list (official price vs your price per unit) for public models.
It is CORS `*` and cached 60 s. The operator can make pricing private (Settings > Access, or portal-only); without
credentials it then answers `401 pricing_private`. A valid API key always unlocks it, sent the same ways as on the API
(`Authorization: Bearer`, `x-api-key`, `x-goog-api-key` or `?key=`), so price fetchers keep working:

    curl https://<host>/api/pricing -H "Authorization: Bearer sk-pp-..."

With a key and no `?group=`, the list is your own: your pool, your account multiplier and your key's model
allow-list, sent `cache-control: private, no-store`. A key that is wrong, disabled, revoked or expired gets the
usual `401`/`403` error even while pricing is public.

## Model names

Use the public slug or an alias. Responses and stream chunks show the public slug, not the upstream model, when
masking is on (the default). `model_not_found` (404) means unknown, DISABLED, or not visible to you.
`model_not_allowed` (403) means the key or pool may not use it. `unsupported_endpoint` (400) means the model cannot
do this operation or format.

## Errors

Errors come in the native shape of the format you called:

```jsonc
// OpenAI
{"error": {"message": "...", "type": "invalid_request_error", "code": "insufficient_balance", "param": null}}
// Anthropic
{"type": "error", "error": {"type": "billing_error", "message": "..."}, "request_id": "..."}
// Gemini
{"error": {"code": 402, "message": "...", "status": "FAILED_PRECONDITION"}}
```

| Code | HTTP | When |
|---|---|---|
| `invalid_api_key` / `key_disabled` / `key_expired` | 401 | Missing, unknown, disabled/revoked or expired key |
| `ip_not_allowed` / `account_suspended` / `email_not_verified` | 403 | Key IP allowlist, suspended account, unverified email |
| `model_not_allowed` | 403 | Key/pool allow-list |
| `model_not_found` / `not_found` | 404 | Unknown model / endpoint / object (also another customer's file, batch, video or response) |
| `method_not_allowed` | 405 | With an `allow` header |
| `invalid_request` / `unsupported_endpoint` | 400 | Validation; model cannot serve this endpoint |
| `payload_too_large` | 413 | Only when the admin set `maxRequestBodyMb` |
| `unsupported_media_type` | 415 | Unknown `Content-Encoding` |
| `insufficient_balance` / `spend_limit_reached` | 402 | Not enough funds for the worst case of this request (the upstream was not called); key, monthly or account limit reached |
| `rate_limited` | 429 | RPM/TPM or concurrency limit; also when every upstream key for the model is cooling down after an upstream 429 (`retry-after` = when the first one is free again) |
| `no_capacity` | 429 | All upstream slots busy past the queue timeout |
| `upstream_insufficient_balance` | 503 | Our upstream account is out of credit ("The upstream model is out of capacity / funding. Please retry later."), with `retry-after` |
| `no_available_provider` | 503 | No usable upstream right now (also our upstream account's 401/403 key problems) |
| `upstream_error` / `upstream_timeout` | 502 / 504 | Upstream unreachable or no answer |
| upstream 408 / 429 / 5xx / 529 | as upstream | Mirrored after our own failover: same status, `retry-after`, `x-ratelimit-*` / `anthropic-ratelimit-*`, native error body (provider identity scrubbed) |
| `client_closed` | 499 | You disconnected (logged only) |
| `internal_error` | 500 | Our bug; quote `x-request-id` |

Before you see an upstream 502 / 503 / 504 / 52x or a connection failure, the gateway keeps retrying it (every 30 s
by default, honouring the upstream's `retry-after`, for up to 3 minutes after your request arrived, as long as nothing
has been sent to you yet), so a slow answer can mean an upstream hiccup was ridden out. A stream that the upstream
drops before any output is retried invisibly; you are never billed for the dropped attempt.

Upstream 4xx validation errors are passed through, scrubbed. Inside a stream, upstream error events are passed
through verbatim. If the upstream connection drops mid-stream, your connection is dropped too (no fake `[DONE]`), so
your SDK's own retry logic applies. The one gateway-authored stream event is `insufficient_balance` when a stream
reaches its credit hold.

## Rate limits and concurrency

- **RPM / TPM** per key, and RPM per customer within a pool. Over the limit: 429 with `retry-after` and
  `x-ratelimit-limit-requests` / `-remaining-requests` / `-reset-requests`.
- **Concurrency**: in-flight requests per key, customer or pool (default 20 per customer). Over it: immediate 429
  with `retry-after: 1`.
- **Capacity**: if every upstream slot is busy, the request waits (default up to 20 s), then returns 429
  `no_capacity`. Queue time is shown in your logs.
- Upstream rate limits after failover arrive as the upstream's own 429/529 with its headers. SDK retries work
  unchanged.
- Repeated invalid keys from one IP are throttled (429).

## Bodies, streaming and connections

- No request size limit by default. Bodies are streamed, and gzip/deflate/br/zstd request encodings are accepted.
  Responses are never compressed.
- SSE streams get `: keep-alive` comment lines while the model is silent (every 15 s by default). Every SSE parser
  ignores them.
- Disconnecting cancels the upstream request at once. Only what was produced is billed.
- OpenAI chat streams always get upstream usage. The final usage-only chunk is removed if you did not ask for
  `stream_options.include_usage`.
- `Idempotency-Key` is forwarded upstream unchanged.

## Files: ownership and stickiness

- Every file, upload and Gemini upload session belongs to the customer who created it and lives on one upstream
  account. All later calls, and every chat / Responses / Messages / generateContent request that references the file
  (`file_id`, `fileData.fileUri`), are routed to that account.
- Listings show only your own objects. Another customer's id answers 404.
- Referencing files stored on two different accounts in one request returns 400. Upload them again together.
- Storage and upload are free unless the operator prices the hidden `files` model. Using a file in a prompt is billed
  as normal tokens.
- Files a model generates (Anthropic code execution, OpenAI code interpreter) are registered to you and downloadable
  through the normal Files / container endpoints.

## Batches

- **Validation of the whole batch up front.** Every request must name a model your key may use that supports the
  endpoint, and all models must be served by the same provider. One bad request rejects the entire batch with a
  native 400 naming its `custom_id`.
- **Funds**: one credit hold for the worst case of the whole batch at the batch price. The create call returns 402
  if it does not fit.
- **Billing**: each result is billed **exactly once**, at the batch price (by default 50% off token prices; server
  tools and flat prices are not discounted). Billing happens as soon as a status poll or results download sees the batch
  ended, or through the background sweep (every few minutes). Each result appears in your logs with the batch id. The hold is released
  afterwards.
- **OpenAI**: your input file must be a file you uploaded through us. Model names are rewritten for the upstream.
  Output and error files are registered to you; download them with `GET /v1/files/{id}/content`.
- Results are streamed through with model names masked. Ids are owner-checked (foreign ids answer 404).
- Deleting a batch, or an OpenAI batch output file, before its results are billed answers **409**. Retry after a
  minute.
- Route controls apply to each batch request as they do to normal calls: provider `stripFields`, route
  `paramOverrides`, and the route/model output cap.

## Pricing, savings and logs

Each request records **your price** and the **official price** (what the same usage would cost at the vendor's list
price). Savings = official price - your price. The dashboard shows totals and savings over time, and the logs show
Official / Charged / Saved per request. Both values are snapshots taken at request time, so later price changes never
rewrite history. Details: [PRICING-AND-BILLING.md](PRICING-AND-BILLING.md).

Billable responses carry `x-pool` (the pool that served and billed the call) and `x-price-multiplier`: that pool's
price as a share of the official price (0.3 = 30% of official). `GET /v1/requests/{x-request-id}` returns one of your
calls as it was metered: pool, usage, `charged_usd` and `list_usd` (it can answer 404 with `retry-after` for a second
or two right after the call). The `group.multiplier` / `groups[].multiplier` fields of `/api/pricing` are the same
share of the official price.

**Prices from the API** (to keep your own price tables in sync; the in-app docs page `/docs/pricing-api` has examples):

| Endpoint | Format |
|---|---|
| `GET /v1/models`, `GET /v1/models/{id}` | `pricing`: the OpenRouter convention (decimal strings, USD per token: `prompt`, `completion`, `input_cache_read`, `input_cache_write`, `request`, `image`), the de-facto standard other gateways and tools read. `x_pricing`: USD per 1M tokens, `yours` / `official` / `savings_pct`, per-call tool prices, and units for non-token models. Prices are your effective prices (pool and account multipliers applied). Also `context_length` and `top_provider.max_completion_tokens`. |
| `GET /v1/model/info` | LiteLLM format (`input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`, `max_input_tokens`, `max_output_tokens`, capabilities) for LiteLLM / Langfuse-style cost trackers. |
| `GET /api/pricing` | List for websites and price fetchers; public, or your own prices with an API key when pricing is private. ProviderProxy-specific shape (see above). |

**Limits are the provider's.** The gateway never truncates input by context length and passes an explicit
`max_tokens` / `max_completion_tokens` / `max_output_tokens` through unchanged; see the funds clamp in
PRICING-AND-BILLING.md for the one exception (insufficient balance).
