# Gateway fixes + Batch API - progress / resume notes

Paused on the owner's request (2026-10-17). Committed + pushed as checkpoint `780d14a` (see `docs/HANDOFF.md` for the overall
resume plan). The tree was in a compiling, green state:
`pnpm tsc --noEmit` clean, `pnpm lint` 0 errors (3 old warnings in scripts), `pnpm vitest run` = 55 files passed / 682 tests passed / 1 skipped,
`pnpm build` NOT re-run since the changes (run it before finishing). Migration `20261017103545_tools_and_batches` is created, APPLIED to the
dev DB and the Prisma client is generated. **Live spend so far: $0** (no live runs were started; `pnpm setup:live` only lists models, which is free).
No dev server / mock / background process is running; no `.next-*` dirs; tsconfig.json untouched.

Source of truth for the work items: `docs/LIVE-WORKLOAD-REPORT.md` (bugs), `docs/PLAN.md` 5, 6, 9b-9d (faithful-proxy rules), this file.

Tooling note for the next agent: long `python - <<EOF` heredocs mixed with other commands were sometimes refused by the sandbox as "too complex";
use the Edit / Write tools for code edits and run commands one per call.

---------------------------------------------------------------------------------------------------------------------------------

## Item 3 - CANCELLED/499 race (report bug 3): DONE

- Fix: `src/gateway/stream.ts` - `StreamSession.deliveredEverything()`; `cancel()` and the "client abort lands on the idle read of the next pull"
  branch in `pull()` now finish `completed` when the processor already saw its terminal event (`[DONE]`, `finish_reason`, `response.completed`,
  Anthropic `message_stop`, translated `[DONE]`) and nothing is pending. A close BEFORE completion is still `cancelled`. New `expectedBytes`
  option for raw passthrough (`execute.ts` `knownLength(h)` passes content-length for binary/file downloads).
- Evidence: `tests/gateway/stream.test.ts` (6 new unit tests, 5 of them fail without the fix) and `tests/gateway/stream-status.test.ts`
  (real sockets, OpenAI-SDK reading pattern: stop at `[DONE]`, abort; 20 chat streams, 10 more, 4 translated chat->Claude tool-call rounds, 6
  Responses streams = all SUCCESS; early abort still CANCELLED 499). The new mock knob `x-mock-linger-ms` (connection stays open after the last
  frame) is what reproduces the live race; with the fix reverted 4 of 5 integration tests fail.
- Not yet done: the LIVE re-check (scenario I: 20 SDK streams against gpt-4o-mini + translated tool rounds -> no CANCELLED rows).

## Item 1 - server-generated files downloadable (report bug 1): DONE (mock-verified), live re-check pending

- `src/gateway/generated-files.ts` (pure scanners): Anthropic `*_tool_result` blocks -> every `file_id`; Responses output -> `container_file_citation`
  (stored as kind `container_file`, upstreamId `<container>/<file>`) and `file_path` annotations (kind `file`).
- `src/gateway/files.ts` `registerGeneratedFiles(ctx, cand, files)`: `UpstreamObject createMany skipDuplicates` (owner = caller, `providerKeyId` =
  serving key, meta `{fmt, generated:true}`); never takes over an existing row. Called from `execute.ts` `handleJson` (messages + responses, native
  mode), from the stream processors via `processor.onGeneratedFiles` the moment the id is seen (`content_block_start`, `response.completed`) and
  again (idempotent) in `finalizeStream`. Listing (`GET /v1/files`) synthesizes an object for generated files that were never fetched.
- New raw ops `containers_file_get` / `containers_file_content` (`GET /v1/containers/{cid}/files/{fid}[/content]`, path.ts + adapters.ts + files.ts),
  owner-checked and pinned like files.
- Evidence: `tests/gateway/server-tools.test.ts` (non-stream + stream Anthropic code-exec PDF, Responses container file, foreign customer 404,
  no takeover). Mock: `[[codeexec]]` marker creates the file (a `%PDF` body) on the serving credential.
- Next: live scenario C (code-exec PDF via `/v1/files/{id}/content`, valid `%PDF` saved to `live-output`).

## Item 2 - chat -> Claude reasoning (report bug 2): DONE (mock-verified), live re-check pending

- `src/gateway/translate/claude-reasoning.ts`: `claudeProfile(upstreamModel)` per generation (adaptive vs budget, default-on, how to switch off,
  efforts, sampling, forced tool_choice), `readReasoningAsk` (`reasoning_effort`, `reasoning.effort`, Claude-style `thinking`), `planReasoning`.
  Rules: reasoning requested -> 5.x/4.7+: `thinking {adaptive, display:"summarized"}` + `output_config.effort` (minimal/low->low, medium, high,
  xhigh->xhigh/max); older: `enabled` budget < max_tokens with >= max(1024, 25%) headroom (no thinking + admin note if it cannot fit).
  NOT requested: Sonnet 5.5 -> `between_tools`, Haiku 5.5 / Opus 5 / Sonnet 5 -> `disabled`, Opus 5.5 / Fable -> cannot disable -> `effort low`,
  models that do not think by default -> nothing sent. temperature/top_p dropped on models that reject them; forced `tool_choice` ->
  `auto` + a system hint on Fable 5.1 / Opus 5.5 / Sonnet 5.5.
- `chat-to-anthropic.ts`: `thinking_blocks` (LiteLLM-compatible, signed) returned in responses / stream deltas AND accepted back on assistant
  messages; `reasoning_content` kept; reasoning tokens from `usage.output_tokens_details.thinking_tokens`, else estimated from the thinking text
  (`Usage.reasoningEstimated`, noted in `RequestLog.internalError`); a burned budget (stop max_tokens, thinking only) -> finish_reason length, header
  `x-reasoning-budget-exhausted: true`, admin note. `ctx.notes` (new) carries such notes into `internalError`.
- Budget-style thinking is skipped (with a note) when the last assistant turn has tool calls without `thinking_blocks` (would 400). For ADAPTIVE models
  this check is not applied - unverified live: run G (tools + reasoning_effort, 2 rounds, haiku-5-5 / sonnet-5-5) and if the API 400s, apply
  `hasToolTurnWithoutThinking` to adaptive mode too (one-line change in `chatRequestToMessages`).
- Evidence: `tests/gateway/claude-reasoning.test.ts` (23 tests, incl. the full model x effort x max_tokens matrix against a mock that validates
  `thinking` / `output_config` / sampling like the real API, and a sanity test that the mock rejects the old shapes).
- Next: live scenario G (OpenAI SDK -> claude-sonnet-5-5 / haiku-5-5 with and without `reasoning_effort`, stream + tools).

## Item 4 - server-tool metering: PARTLY DONE

DONE (gateway, verified by `tests/gateway/server-tools.test.ts`):
- Schema (migrated): `Model.toolPrices` (sell), `Model.officialToolPrices` (official, added beyond the brief so savings stay exact),
  `ModelRoute.toolCosts`, `RequestLog.toolUsage`.
- Usage: `Usage.toolUsage` (+ `reasoningEstimated`); `usage.ts` `toolUsageFromAnthropic` (`web_search_requests` -> `web_search_request`,
  `web_fetch_requests`, `code_execution_requests` + `code_execution_hour` = 5/60 h per request that used code execution on its own, i.e. the
  5-minute minimum; free next to web search/fetch: dropped when the usage shows searches/fetches OR the request declares a `web_search_2026*` /
  `web_fetch_2026*` tool - `execute.ts` `applyToolPolicy`), `toolUsageFromResponsesOutput` (`web_search_call`, `file_search_call` items, also in
  the `response.completed` event), `mergeUsage` merges per key.
- Pricing engine (`pricing.ts`): `PriceTable.tools`, `toolTable()`, tools priced per unit (multiplier applies to price, never to cost), official
  falls back to sell x multiplier per tool; `tokenDiscountPct` / `priceRequest(..., batch)` for item 7. `metering.ts` writes `toolUsage`, `batchId`.
- Catalog (`price-catalog.ts`): `KnownPrice.tools`; Anthropic `{web_search_request: 0.01, code_execution_hour: 0.05}`, OpenAI (models with
  `responses`) `{web_search_call: 0.01, file_search_call: 0.0025}` - confirmed on the Anthropic pricing page and developers.openai.com pricing.
  `src/server/pricing/fields.ts` derives `toolPrices` under the pricing rules (PERCENT: official tool price x pct; MARKUP: route tool cost x factor)
  and writes `officialToolPrices` / `toolCosts` for catalog models; seed + setup:live backfill empty tool prices.
- Dev DB already carries the tool prices (checked: claude-sonnet-5-5 `web_search_request 0.01`, `code_execution_hour 0.05`; gpt-5-mini
  `web_search_call 0.01`, `file_search_call 0.0025`).

NOT DONE (next steps, in this order):
1. Pure unit tests for the pricing engine in `tests/gateway/pricing.test.ts`: tool amounts, multiplier, official fallback, `tokenDiscountPct`
   (batch) incl. long-context order (long-context factor, THEN discount; tools/flat NOT discounted), `deriveSellUpdates` for `toolPrices`.
2. Admin editors (keep minimal): `src/server/admin/models-calc.ts` (zod `modelFieldsBase` + `routeFieldsSchema`: `toolPrices`, `officialToolPrices`,
   `batchDiscountPct` on the model; `toolCosts`, `batchCostDiscountPct` on the route; a `jsonObj`-like parser of `{key: number}`), `models-actions.ts`
   (`modelData` / `routeData` / `duplicateRoute` already copies `toolCosts`), `models-queries.ts` (serialize), then a small "Server tools" section in
   `src/components/admin/models/pricing-editor.tsx` (sell + official per tool key, batch discount %) and `routes-panel.tsx` (cost per tool key, batch
   cost discount %). Key suggestions: web_search_request, code_execution_hour, web_search_call, file_search_call (+ free-form key).
   Also `modelToExport` / import schema in models-calc.ts, and the add-model wizard (`wizard-calc.ts` `tableToFields`) should prefill tool prices from the catalog.
3. Customer + admin logs show tool usage: `src/server/customer/logs.ts` + `src/components/customer/logs-client.tsx` (+ CSV export
   `src/app/dashboard/logs/export/route.ts`), `src/server/admin/logs-queries.ts` + `src/components/admin/logs/log-detail-sheet.tsx`
   (add a "Server tools" line: `web_search_request x2`, plus `batchId` once item 7 exists).
4. Optional: tool prices in the public price matrix (`src/gateway/price-view.ts` `priceMatrix`) and the customer Models page.
5. Live scenario D (web_search metering): one `claude-haiku-5-5` request with `web_search_20260209` -> row has `toolUsage.web_search_request`,
   price/cost include $0.01 per search (x1.0 under match-official).

## Item 5 - dev setup gaps: DONE

- `scripts/setup-live-providers.ts`: model aliases stored (catalog `aliases`, union with admin-added), provider `formats` refreshed to
  `getPreset(...).formats` (+ the spec list; logs what was added/removed), server-tool prices stored, `--markup N` / `--percent-of-official N` /
  `--keep-old-rules`, ends with `migrateSeededMarkupRules()`.
- `prisma/seed.ts`/`seed-data.ts`: aliases on create + backfill, per-model default rule, tool-price backfill, batch formats on the openai/anthropic seeds.
- Re-run against the dev DB: done. Verified in the DB: `claude-haiku-4-5` aliases `["claude-haiku-4-5-20251001"]`, openai formats now include
  `openai_batches`, anthropic `anthropic_batches` (the batch ENDPOINTS do not exist yet, item 7), claude-haiku-5-5 long context 100000 x5.
- Pending: a live `POST /v1/messages {model:"claude-haiku-4-5-20251001"}` check (resolves via the alias; needs the dev server).

## Item 6 - catalog corrections: DONE

Verified on the live Anthropic pricing page (2026-10-17): Opus 5.5 $4/$20, cache read $0.20, writes $5/$8; Sonnet 5.5 $2/$10, **cache read $0.10**
(0.05x; the report's "0.20" came from the cached claude-api skill table and is WRONG - the catalog value was right), writes $2.50/$4; Haiku 5.5
$0.10/$0.50 up to 100K prompt tokens and 5x ($0.50/$2.50) above, reads $0.01; Fable 5.1 $10/$50, read $0.25. Context 1M / max output 128K for all four
(models overview / migration guide). Changes in `price-catalog.ts`: context + max output fixed, Haiku 5.5 `longContext {100000, 5}`, `needsReview`
removed for the four verified models, source note, new entries (Fable 5, Opus 5, Opus 4.8/4.7/4.6, Sonnet 5, Sonnet 4.6, Opus 4.5 alias). Tests:
`tests/pricing/catalog.test.ts`.

## Owner pricing decision (report bug 9): DONE

Default = match official (`PERCENT_OF_OFFICIAL` 100; server-tool prices follow: sell = official tool price), `MARKUP_OVER_COST` 30 for models without an
official price. `src/server/pricing/default-policy.ts` (`defaultRuleForKnown`, `migrateSeededMarkupRules`: MARKUP 30 + has official price + no AuditLog
entry targeting the Model -> `applyPricingRule(..., 100)`). Applied in: seed (create + re-rule + migration), `setup:live` (default + flags),
admin Add-model wizard default selection (`wizard-calc.ts defaultRule` -> 100; the prefill value of the PERCENT option is 100; all three options kept),
README pricing section, PLAN 5c. Dev DB migration RAN: moved gemini-3.8-flash, grok-4.7, deepseek-v4, gpt-6-sol, gpt-5.6-sol, gpt-5.6-terra,
gpt-5.6-luna, gemini-3.1-pro; kept smart-fast (no official price) and omni-moderation-latest (free). The live models were re-upserted by setup:live
with the new rule (sell == official). `fields.ts`: under PERCENT the 1h cache-write sell follows the route cost when the model has an official
cache-write price. Missing: a test file for `default-policy.ts` (suggest `tests/pricing/default-policy.test.ts`: defaultRuleForKnown, migration skips
an audited model and a model without official price; DB-backed like `tests/pricing/rules.test.ts`).

## Item 7 - Batch API: NOT STARTED (foundation done)

Done so far (all verified by the green suite): schema + migration (`UpstreamObject.status/meteredAt/meterClaimedAt` + index, `RequestLog.batchId` + index,
`Model.batchDiscountPct`, `ModelRoute.batchCostDiscountPct` default 50); `anthropic_batches` / `openai_batches` format ids (presets, admin provider
form, seeds, errors/adapters surface); pricing engine batch discount (`tokenDiscountPct`, `priceRequest(..., batch)`, official equivalent = vendor batch
price = 50% off the token part); `recordOutcome` accepts `batchId` + `owner` (no AuthRecord in the cron); `ModelRec.batchDiscountPct`,
`RouteRec.batchCostDiscountPct` in the config cache.

Design decided (follow it):
- Paths (`path.ts`, before the generic `/v1/` branch): `POST|GET /v1/messages/batches`, `GET|DELETE /v1/messages/batches/{id}`,
  `GET .../{id}/results`, `POST .../{id}/cancel` (format `anthropic_batches`, errorFormat anthropic); `POST|GET /v1/batches`, `GET /v1/batches/{id}`,
  `POST /v1/batches/{id}/cancel` (format `openai_batches`). Add ops to `types.ts` (`batches_create|list|get|cancel|results|delete`), URLs in
  `adapters.ts` (`filesUrl`-style branch), and treat them as RAW-style ops (own handler like `handleRaw`, `prepareRawUpstream`/`handleFilesOk` pattern).
- Create (Anthropic): parse `requests[]` (stream it from the spool, big bodies are possible); per request: resolve model (`resolveModel`), key
  `allowedModels` / group `allowedModels` / capability -> otherwise reject the WHOLE batch with a native 400 naming the `custom_id` and model; rewrite
  `params.model` -> `route.upstreamModel`. Route selection once: eligible routes (`eligibleRoutes(snap, model, group, "anthropic_batches")`; the
  provider must list the batch format), all models of the batch must have a route on the SAME provider; pick one usable key (`buildCandidates`,
  one attempt - batch creation is cheap, take a slot like other calls). Credit hold = worst case over all requests (estimateInput + max_tokens, price
  with the batch discount, x multiplier): extend `holds.ts` `reserveHold` with a long `ttlMs` + no heartbeat tracking (durable hold id
  `batch:<requestId>`; keep the id in `meta.holdId`), 402 `insufficient_balance` when it does not fit; release it (`releaseHold`, both backends) when
  the batch is fully metered or cancelled/deleted. Forward faithfully (status + headers + native error body), then register
  `UpstreamObject kind "batch"` (upstreamId = batch id, owner, providerKeyId, `status`, `meta {object, models:[{slug,routeId,upstreamModel}], multiplier,
  holdId, holdAmount, endpoint, customIdModels?}`) and return the object with `results_url` rewritten to our public origin. Per-line model index only
  when the batch has > 1 distinct public models (custom_id -> model index), else every line uses the single model.
- OpenAI create: body `{input_file_id, endpoint, completion_window}`; the file must be owned (`owned(ctx,"file",id)`); download its content from the
  pinned key (GET /v1/files/{id}/content), validate + rewrite each JSONL line's `body.model` (same checks), and when anything changed upload the
  rewritten file (multipart `purpose=batch`) on the same key, register it, create the batch with the new file id. Output/error files: register
  `output_file_id` / `error_file_id` as owned files (kind `file`, `meta.batchOutputOf`) whenever the batch object is seen (create/get/list/sweep) so
  `GET /v1/files/{id}/content` works; mask `model` in those lines on download (line transform in the files_content path).
- get/list/cancel/delete/results: ownership via `UpstreamObject kind batch` (foreign -> native 404), pinned to `providerKeyId`; list from our records
  (refresh non-ended ones from upstream, best effort); `results` = JSONL stream passthrough (content-type + status passthrough, no compression, client
  abort -> upstream abort) with `message.model` masked line by line; cancel/delete forward; delete first meters unmetered results.
- Metering `meterBatch(row)` (new `src/gateway/batches.ts`): claim (`updateMany` on `meterClaimedAt` null or older than 10 min), download the results
  (Anthropic `/results` JSONL / OpenAI output file), for each line build a Usage (`usageFromAnthropic(message.usage)` / `usageFromOpenAI(response.body.usage)`
  incl. `toolUsage`), `recordOutcome({requestId: sha256(batchId + ":" + custom_id) formatted as a cuid-like id, batchId, owner, model, route, multiplier from
  meta, endpoint "/v1/messages/batches" or "/v1/batches", inboundFormat, status SUCCESS|CLIENT_ERROR|UPSTREAM_ERROR|CANCELLED per result type,
  billable only for succeeded})`, `await flushMeter()`, set `meteredAt`, release the hold. RequestLog ids are deterministic and the meter writer inserts with
  skipDuplicates, so repeated runs (customer fetch + cron sweep) are exactly-once. Trigger: results fetched by the customer (fire-and-forget after the
  stream starts), `sweepBatches()` in `src/app/api/cron/billing/route.ts` and `.../health/route.ts` (poll non-ended batches, meter ended ones), and
  `DELETE`.
- Mock (`scripts/mock-upstream.ts`, `buildAnthropicMessage(ctx, body)` is already reusable for result lines): Anthropic `/v1/messages/batches` (create ->
  `in_progress`, becomes `ended` after N polls or `[[batchslow]]`; results JSONL with `succeeded` / `errored` (`[[batcherr]]`) lines; cancel; delete; list)
  and OpenAI `/v1/batches` (+ output file in `state.files`, line shape `{id, custom_id, response:{status_code, request_id, body}, error}`). Per credential
  ownership like files.
- Tests (new `tests/gateway/batches.test.ts`): model not allowed -> whole batch 400; model rewrite visible at the mock; sticky/ownership (other customer 404);
  402 when the hold does not fit; hold released after metering; each result metered once at the batch price (price/cost/official, `batchId`, endpoint,
  per-result status) after results fetch + sweep + a second fetch (still exactly one row each); errored/canceled/expired results price 0; masked ids/models;
  faithful behaviour (client abort mid-results aborts upstream, 4xx/5xx passthrough, no compression); OpenAI path incl. file rewrite and output-file masking.
- Docs: add a "Batches" section to the docs page (`src/app/(marketing)/docs/**`, find the existing Files section) and PLAN 5 / README.
- Live (K): 3 haiku-5-5 requests via `POST /v1/messages/batches` end to end, results fetched, rows metered at the batch price exactly once; OpenAI
  batch with 2 gpt-4o-mini requests in the background (poll up to ~30 min, record status if not completed).

## Remaining after the items above

- Live re-verification through `scripts/live-workload` (C, G, I streams, K, D web_search, OpenAI batch); budget Anthropic <= $15, OpenAI <= $3; spend so
  far $0. Needs: `NEXT_DIST_DIR=.next-workload pnpm next dev -p 3011` (stop it afterwards, remove `.next-*`, `git checkout tsconfig.json` if touched).
- Update `docs/LIVE-WORKLOAD-REPORT.md` with a "Fix verification" section (also correct bug 7a: Sonnet 5.5 cache read is $0.10).
- Final gates: `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test`, `pnpm build`; docs: README + PLAN notes for tools, batches, reasoning translation, generated files.

## Files touched so far (all uncommitted)

New: `prisma/migrations/20261017103545_tools_and_batches/`, `src/gateway/generated-files.ts`, `src/gateway/translate/claude-reasoning.ts`,
`src/server/pricing/default-policy.ts`, `tests/gateway/{claude-reasoning,server-tools,stream-status}.test.ts`, this file.
Changed: prisma schema/seed/seed-data; `scripts/{mock-upstream,setup-live-providers}.ts`; gateway: `cache, context, errors, execute, files, metering, path,
price-catalog, price-view, pricing, processor, providers/{adapters,presets}, shape, stream, stream-processors, translate/{chat-to-anthropic,index}, types,
usage`; `src/server/pricing/fields.ts`, `src/server/admin/{models-actions,wizard-calc}.ts`; admin components (wizard/workspace/models-view/pricing-editor
default value 100, provider-form format list); tests `admin/pricing-ui`, `gateway/{stream,util}`, `pricing/catalog`; README, docs/PLAN.md.

Mock upstream additions (for tests): Anthropic strict validation of `thinking` / `output_config` / sampling per model generation
(`anthropicParamError`), markers `[[ws:N]]` `[[fs:N]]` `[[codeexec]]` `[[think:N]]` `[[thinkburn]]` `[[nothinkdetails]]`, `x-mock-linger-ms`, container
files `GET /v1/containers/{cid}/files/{fid}[/content]`, only custom tools are "called" (server tools are not).
