# Live workload report

Real customer/agent workloads driven through the gateway (dev server `NEXT_DIST_DIR=.next-workload pnpm next dev -p 3011`, customer
`workload@example.com`, $500 balance, standard group, one `sk-pp-...` key) against the real Anthropic, OpenAI, fal and Replicate
accounts configured by `pnpm setup:live`. 2026-10-17. No secrets appear in this document or in `live-output/`.

Re-run: `pnpm tsx scripts/live-workload/run.ts --only L,B,C` (ids A..L, `--skip H`); artifacts land in `live-output/<id>/`
(gitignored), per-scenario JSON in `live-output/results/`. Needs the dev server on `WL_BASE_URL` (default `http://localhost:3011`).
New devDependencies added for this: `@anthropic-ai/sdk`, `openai`, `@resvg/resvg-js` (SVG -> PNG), `pdf-lib` (PDF page count).

## Best artifacts (open these first)

Priority use case (L): reference photo + instructions -> ONE SVG techpack with all flats.

| What | Path |
|---|---|
| Reference photo (fal flux-schnell through the gateway) | `live-output/l/reference.jpg` |
| **gpt-6-astra, Chat Completions stream** - SVG / PNG | `live-output/l/astra-chat.svg`, `live-output/l/astra-chat.png` |
| **gpt-6-astra, Responses API stream (`input_image`)** - SVG / PNG | `live-output/l/astra-responses.svg`, `live-output/l/astra-responses.png` |
| claude-sonnet-5-5 `/v1/messages` (same prompt + image) - SVG / PNG | `live-output/l/sonnet-messages.svg`, `live-output/l/sonnet-messages.png` |
| claude-opus-5-5 hoodie techpack (B) - SVG / PNG | `live-output/b/techpack-claude-opus-5-5.svg`, `live-output/b/techpack-claude-opus-5-5.png` |
| Hoodie techpack PDF, 6 pages (Claude HTML -> local headless Chrome; the code-execution PDF could not be downloaded, bug 1) | `live-output/c/techpack-html/techpack-chrome.pdf` |
| Claude Code CLI output (python CLI + unittest, run through the gateway) | `live-output/claude-code/run-sonnet/` |

Quality note (L): both gpt-6-astra outputs are complete, print-ready pages: title block (style no., season, fabric, colorway), FRONT/BACK/SIDE
flats that match the photo (4 patch pockets, corduroy collar, button front), 16 numbered callouts tied to a stitch/SPI schedule, POM letters
A-K drawn on the flats and linked to a graded S-XL table with tolerances, D1-D4 enlarged construction details, trims table, Pantone colorway,
construction notes. Astra took 187-247 s and 14-16k output tokens (1.8-2.3k reasoning) for $0.95-1.05; Sonnet (effort low, no thinking) produced
a usable but weaker page (misaligned callouts, one table overlapping) in 69 s for $0.16.

## Results

| # | Scenario | Result | Notes (latency, tokens, cost / price / official) |
|---|---|---|---|
| A | Chat like a user: sonnet-5-5 + haiku-5-5 6-turn conversations (plain + SDK `messages.stream()`), opus-5-5, fable-5-1 | **PASS** | 15 requests, all SUCCESS, public model slug returned, memory across turns correct. $0.0384 cost / $0.0499 price |
| B | Hoodie techpack as one SVG, streamed 48k max_tokens | **Gateway PASS, sonnet output invalid** | Opus-5-5: 17.2k out, 140 s, valid XML, renders, all 6 sections. Sonnet-5-5: 12.9k out, 72 s, but the model wrote a mismatched tag (XML error line 238) - model defect, not gateway. Opus $0.347 cost / $0.451 price |
| C | Techpack PDF via code execution tool (`code_execution_20260521`, no beta header needed) + download via `/v1/files/{id}/content` | **FAIL (bug 1)** | Claude built a 5-page A4 PDF in the sandbox, but the gateway answers 404 for the generated file (metadata and content). Local HTML -> Chrome PDF fallback: 6 pages, valid. Code-exec request: 1.30M input tokens summed over its internal iterations = $2.81 cost / $3.65 price |
| D | Agentic: thinking + 4-round client tool loop, web_search, code_execution, prompt caching, PDF by file_id, image input, count_tokens | **PASS** (after `pnpm setup:live` re-run, bug 6) | Thinking blocks + signatures streamed and replayed (4 tool rounds, no 400). Cache: call 2 read 28,862 tokens, price $0.0942 -> $0.0042. Cached/uncached, input = input+read+write all reconcile |
| E | ~150k-token prompt, needle | **PASS** | 151,946 tokens: cold 5.4 s ($0.4955 price / $0.3811 cost, cache write), cached re-ask 2.7 s ($0.0217). Needle found both times |
| F | 50 parallel streaming haiku requests | **PASS** | Default key (customer concurrency 20): 20 pass, 30 get 429 + `retry-after`, all 50 logged, rejected ones price 0. Key with maxConcurrency 60: 50/50 succeed, 30 queued for the 20 upstream slots (max queue 2.0 s), all metered, tokens equal client totals |
| G | OpenAI SDK -> `/v1/chat/completions` -> claude-sonnet-5-5 (techpack SVG, tools) | **FAIL (bugs 2, 3)** | Tool loop (4 streamed rounds) and image+stop+system PASS; long SVG generation and `reasoning_effort` broken (below) |
| H | Real Claude Code CLI 2.1.302 through the gateway | **PASS** (+ gap 6b) | `-p --model claude-sonnet-5-5 --dangerously-skip-permissions --max-turns 15`: exit 0, 5 turns, 3 sonnet requests (all streamed, 53k tokens served from cache), python CLI + sample.csv + test created, unittest passes when re-run independently; haiku-5-5 quick prompt OK; default-env run (no `--model`, default models) OK via claude-opus-5-5. Cost $0.097 / price $0.126 |
| I | OpenAI: Responses + function tool + stream (gpt-5-mini, `previous_response_id`), SDK chat stream (gpt-4o-mini), gpt-image-1-mini low, embeddings, Files upload + `input_file` + delete | **PASS functionally, FAIL on log status (bug 3)** | all calls correct and metered; 6 of 20 short SDK streams logged `CANCELLED/499` |
| J | Customer views | **PASS** | `/dashboard`, `/logs`, `/usage`, `/models`, `/keys`, `/billing` render for the customer; CSV export 453 rows, charged total equals DB; savings card shows "+$2.44 more than official (30% above)" which equals DB (-30.0%) |
| K | Anthropic Message Batches (`POST /v1/messages/batches`) | **FAIL - gap (bug 4)** | 404 `Unknown endpoint` |
| L | Reference image -> techpack SVG: gpt-6-astra (Chat stream + Responses stream) and claude-sonnet-5-5 | **PASS** | see "Best artifacts". Astra chat: in 1,902 / out 15,813 (2,303 reasoning), 247 s, TTFT 62.5 s, $0.8097 cost / $1.0526 price. Astra responses: in 1,903 / out 14,172 (1,773 reasoning), 187 s, $0.7276 / $0.9459. Sonnet: 12.1k out, 69 s, $0.126 / $0.163 |

Every billed row in every scenario passed: `price > cost > 0`, `officialPrice` recorded, logged cost equals cost recomputed independently from the
route cost table (including cache read/write), and the user balance dropped by exactly the sum of the logged prices (453 requests).

### Spend (sum of `RequestLog.cost`, estimated upstream)

| Provider | Spend | Budget |
|---|---|---|
| Anthropic | $6.57 | $120 |
| OpenAI | $1.54 (all gpt-6-astra) | $10 |
| fal | $0.009 | $1 |
| Replicate | $0 | $1 |

Customer charged $10.56 in total (price = cost x 1.30); official-price equivalent $8.12.

## Bugs / gaps for the lead (exact repros)

Send customer key as `x-api-key` (Anthropic) or `Authorization: Bearer` (OpenAI). IDs are RequestLog ids / `x-request-id`.

### 1. [High] Files produced by the code execution tool cannot be downloaded through the gateway
- Request: `POST /v1/messages?beta=true` `{model:"claude-sonnet-5-5", tools:[{type:"code_execution_20260521",name:"code_execution"}], messages:[ask for a PDF saved as techpack.pdf]}` (stream) -> 200, response contains `bash_code_execution_tool_result` with `file_id` (e.g. `file_01HHFq8aGKUPahgoLDpSnVcs`). Request id `vwcl1k8g3j8y3efe4f8b4vjo` (earlier run: `ml06walokniglofnm27jxc4x`, file `file_01FaMy8iVNoo2VCt1PyKJXwv`).
- Then `GET /v1/files/file_01HHFq8aGKUPahgoLDpSnVcs/content` with `anthropic-beta: files-api-2025-04-14` (also without) and `GET /v1/files/{id}`.
- Expected: 200 with the PDF bytes (file belongs to this customer's own request). Actual: 404 `not_found` "File not found" - request ids `ltahooa5z4i6cfg7dctm2rnk` (content), `li22j1771nkdd656ni37y1ap` (metadata), `p4qw7bnbel49iwqobp2cm8rh` / `v99p0y4lq1l72h2980gbe7n0` (earlier file); log internalError: "file ... is not owned by the caller (or unknown)".
- Cause: ownership is only recorded for files uploaded through `/v1/files`; file ids that appear in `/v1/messages` responses (code execution / text-editor outputs, streamed or not) are never registered in `UpstreamObject`. Fix: scan response content (and `content_block_start` events) for `file_id` and register them for the user + provider key. Files uploaded through the gateway work (D: upload, metadata, use by `file_id` in `/v1/messages`, delete all 200).

### 2. [High] Chat Completions -> Claude translation: thinking is mishandled for the 5.x models
Observed with `POST /v1/chat/completions` (OpenAI SDK 7.34) to Claude 5.5 models:
- `reasoning_effort` "low" / "minimal" (and "high" on sonnet) with `max_tokens` large enough for the budget -> 400 `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort"`. Matrix (messages = "Reply with one word: ok"): sonnet-5-5 low/4000 -> 400 (`c3vbkks274x5tqqo5l66o830`), sonnet high/20000 -> 400 (`dzqouhjzmltqil9wwpigfz2y`), haiku-5-5 low/8000 -> 400 (`cmv4utihv1vdeqgg1uqsab4h`), opus-5-5 medium/48000 -> 400 (`g9kh0dsc8hf67bgcwfd9u3xz`), sonnet minimal/4000 -> 400 (`hl87n54ujvoqxbl9qc7vh5lf`); the same models with medium/xhigh/max at 4000 or with `reasoning_effort:"none"` -> 200. Pattern: the translator sends `thinking:{type:"enabled",budget_tokens:N}` whenever N < max_tokens, which Sonnet 5.5, Haiku 5.5, Opus 5.5 reject. Expected: `thinking:{type:"adaptive"}` + `output_config.effort`.
- Without `reasoning_effort` (what a normal OpenAI-SDK customer sends) the models default to adaptive thinking; on a long generation (the techpack SVG prompt, `max_tokens` 48000) the thinking consumes the whole budget and the client gets NOTHING: sonnet-5-5 stream silent for 240 s (`tme6feu86v4kov8en14n8pwr`, client aborted), haiku-5-5 returned `finish_reason:"length"`, 32,000 completion tokens, empty content, billed $0.032 (`ohm1q7os7xd4o4ox6pw1mjit`). The thinking stream is dropped (no `reasoning_content`), so the customer cannot see or stop it. Suggest: surface thinking as `reasoning_content`, and for models that think by default send `output_config.effort` (map `reasoning_effort`, default to a low/medium effort) or cap thinking so visible output is guaranteed. Same prompt through native `/v1/messages` with `thinking:{type:"between_tools"}` works (12.9k tokens, 72 s).

### 3. [Medium] Streams that completed normally are logged `CANCELLED` / 499 `client_closed`
- Repro: official `openai` SDK (7.34), `chat.completions.create({model:"gpt-4o-mini", stream:true, stream_options:{include_usage:true}, max_tokens:12, ...})`, consume the stream, repeat 20 times -> 6/20 RequestLog rows are `CANCELLED 499 client_closed` although the client received `[DONE]` (ids `wsqjob32fffsfdtnpumaziyj`, `g5nwnikfg8iqrqw0peng2yg8`, `y7yxfrqfqazvr5e47gwq4fal`, `zyr9p6ciaai64a3j81k3jk1x`, `ril990mymfbxzhmsjviocfr6`, `jacerv19h0vda17ec22tzyq9`). Translated chat->Claude tool-call streams: 4/4 rounds cancelled (`z52wfgwv48c8b8i9yzovamp9`, `evxi9l1x43bt3fjvm8cpq7mz`, `im1klhak0keymoa29oen64j8`, `kuzq179xugarvaiqgqki1r63`). Usage and price are still recorded correctly; the status/error code is wrong (dashboard shows cancelled/499 for successful calls, affects error-rate stats and key health if used).
- Cause (src/gateway/stream.ts `toReadable`): `finish("completed")` runs only in the next `pull()` after the last chunk was enqueued; the SDK stops reading right after `[DONE]` and cancels the stream first, so `cancel()` records `cancelled`. Fix: in `cancel()` treat the stream as completed when the processor already saw its terminal event and nothing is pending (or finalize at the moment the terminal event is enqueued).

### 4. [Medium, gap] Anthropic Message Batches are not supported
`POST /v1/messages/batches` (3 haiku-5-5 requests) -> 404 `not_found_error` "Unknown endpoint" (`irpm3eda6g07c84fjdx3fphp`, `emr4ue9q2e2mms7lyf3befqu`). Not worked around. Either proxy batches (create/get/results/cancel/list, 50% batch pricing, ownership + sticky key) or answer a clear `unsupported_endpoint`.

### 5. [Medium] Server-tool usage is not metered
`web_search_20260209` returned `usage.server_tool_use.web_search_requests = 1` (request `ggb75g0k76rz23c1cdhybncb`, cost row = tokens only). Anthropic bills $10 per 1000 searches (and web_fetch / code-execution container time beyond the free allowance); `RequestLog` has no field for it, so these fees are neither costed nor charged. Same for the code-execution call above.

### 6. [Medium/Low] Stale provider setup and missing aliases
a. Before this run the dev DB providers had no `openai_files` / `anthropic_files` formats (set up by an older `setup:live`), so `POST /v1/files` -> 400 `unsupported_endpoint` "File uploads are not available on this API" (`ty1igykfmkv2j0zbw0gdjmag` OpenAI, `cofhl1xnpx9lodyxtk9o6jpq` Anthropic). Re-running `pnpm setup:live` fixed it. Existing installs need a migration (or admin hint) that adds the new formats to existing providers.
b. `setup:live` does not store the catalog aliases, so dated ids 404: `POST /v1/messages {model:"claude-haiku-4-5-20251001"}` -> 404 `model_not_found` (`wqmejwdv0975tgqs4ijkouci`). That is the id Claude Code uses for its background/small model (not hit in the CLI runs here, which worked), and the vendor API accepts it. Expected: the alias listed in `price-catalog.ts` resolves.

### 7. [Low] Price-catalog values differ from the vendor reference (verify before launch)
Per the Anthropic reference used by `claude-api` (cached 2026-10-06): Sonnet 5.5 cache read is $0.20/MTok, catalog has $0.10 (our recorded cost for cache reads is half); context window 1M / max output 128k for Sonnet 5.5, Opus 5.5, Haiku 5.5 (catalog: 500k/64k, 500k/64k, 200k/32k); Haiku 5.5 has a >100K-prompt tier ($0.50 / $2.50, no `longContext` set). All three are `needsReview` seeds. A 150k prompt to sonnet-5-5 worked, i.e. the gateway does not enforce the smaller windows.

### 8. [Low] `RequestLog.reasoningTokens` is 0 for Claude thinking
`usage.output_tokens_details.thinking_tokens` (e.g. 5,479 on `vwcl1k8g3j8y3efe4f8b4vjo`) is not extracted; OpenAI reasoning tokens are (gpt-6-astra 2,303). Billing is unaffected (thinking is inside `output_tokens`).

### 9. [Info / product decision] Savings vs official is negative on every request
Route cost = official list price and sell price = cost x 1.30, so `officialPrice < price` always (total -$2.44 = -30.0% on this run). The dashboard overview, CSV (`saved_usd`) and per-request figures are all consistent and honest ("+$2.44 more than official (30% above)"), but the "Your savings vs official prices" card title will read oddly to customers.

## Things that worked well (no action)
- Native Anthropic passthrough incl. SDK streaming, extended thinking with signature replay across a 4-round tool loop, web_search, code execution (no beta header needed for `_20260521`), prompt caching (read/write counts and prices exact), Files API upload/reference/delete, base64 image input, `count_tokens`, 150k-token prompts, `/v1/models` Anthropic shape.
- Public model slugs are returned in every response (no dated ids leak); upstream errors keep native shape; 429 customer limit carries `retry-after`; rejected requests cost 0.
- OpenAI side: Responses streaming + function-call rounds with `previous_response_id` (sticky), chat stream usage, image tokens metering, embeddings, Files upload + `input_file`.
- Claude Code CLI works unmodified (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`), streaming, caching and tool loops included.
- Prompt-quality hint for operators: Sonnet 5.5 and Haiku 5.5 can burn the whole `max_tokens` on thinking for big structured outputs (observed twice natively: 48,000 thinking tokens, empty text, $0.48); `thinking:{type:"between_tools"}` or `output_config.effort:"low"` fixes it natively.
