# Phase 4b (connection fidelity) - progress checkpoint

State when paused: `pnpm typecheck` (tsc) clean, `pnpm lint` clean, migration `20261017070839_files_and_sticky_objects` applied to the dev DB
and the Prisma client generated. Last FULL `pnpm test` run (before the final additions): 51 files / 611 tests passed (500 old + 111 new); since then
`tests/gateway/bodies.test.ts` (23 tests) was added and passes. Nothing is committed. No server, mock, container or background process is left
running (`docker ps` shows only the owner's postgres/redis); no `.next-*` dirs; `tsconfig.json` untouched. The local `.next/` build output and
`.next/standalone/` are stale build artifacts (gitignored). Docker image `providerproxy:fidelity` was built from the current tree minus the
last edits to `scripts/chaos.ts` / `tests` (the image only contains app code; rebuild with `docker build -t providerproxy:fidelity .`).

Resume checklist: `pnpm typecheck && pnpm lint && pnpm test`, then the remaining items below.

## Files touched / added (map)

Changed: `Dockerfile`, `README.md`, `deploy/README.md`, `deploy/cloudbuild.yaml`, `docs/PLAN.md` (9d.7 added, 9 + 10 touched), `package.json` (`chaos` script),
`prisma/schema.prisma` (+`UpstreamObject`), `prisma/seed-data.ts`, `scripts/mock-upstream.ts`, `scripts/setup-live-providers.ts`,
`src/components/admin/providers/provider-form.tsx`, `src/gateway/{context,errors,execute,failure,handle,multipart,path,processor,select,shape,stream,stream-processors,types,upstream}.ts`,
`src/gateway/providers/{adapters,fal-video,presets}.ts`, `src/gateway/translate/{anthropic-to-chat,chat-to-anthropic}.ts`, `src/lib/settings.ts`,
tests `integration.test.ts` / `stream.test.ts` / `util.test.ts` (updated for the new semantics).
New: `server.mjs`, `scripts/chaos.ts`, `scripts/h2c-check.mjs`, `src/app/upload/[...path]/route.ts`, `src/gateway/{bodyin,files,headers,jsonscan,spool}.ts`,
`prisma/migrations/20261017070839_files_and_sticky_objects/`, tests `chaos.test.ts`, `files.test.ts`, `bigbody.test.ts`, `bodies.test.ts`, `http-adapter.ts`.

Existing tests whose expectations were changed ON PURPOSE (the old ones asserted the synthetic behaviour 9d removes): `integration.test.ts` (all-keys-429 now returns
the upstream's own `rate_limit_exceeded` code + `x-upstream-request-id`; upstream 500s now surface as HTTP 500 with the upstream's error document instead of 502
`upstream_error`), `stream.test.ts` (rewritten: verbatim error events, destroyed client stream on reset/truncation, heartbeats, commit-after-silence, gateway_error),
`util.test.ts` (anthropic preset formats now include `anthropic_files`; multipart helper API is size/range based).
The mock's fail-key messages no longer contain "mock failXXX" (the gateway now forwards upstream messages).

## Per 9d item

### 1. Mirror client disconnect -> upstream abort - DONE
Verified (in-process over real sockets, `tests/gateway/chaos.test.ts`, and against the built container with `pnpm chaos --docker providerproxy:fidelity --scenarios`):
streaming for all 6 format paths (OpenAI chat, Responses, Anthropic, Gemini, chat->Anthropic, Messages->chat): mock sees the abort 2-5 ms after the client leaves (phase
"streaming"), RequestLog `CANCELLED` with partial usage billed, slots and credit hold released; non-stream (phase "waiting", 1-3 ms); client leaving while queued for a slot
(upstream never contacted, queue count back to 0, CANCELLED, no attempts); multipart upload aborted mid-upload (spool temp file removed, upstream never contacted); spooled multipart
aborted while the upstream works; Files upload aborted mid-stream (upstream sees phase "uploading"); Files download aborted mid-stream. Container: HTTP/1.1 and h2c.
Bugs found/fixed on the way: prime-failure classification called `h.abort()` before checking the abort reason (every prime failure looked like a client abort); h2c client
RST_STREAM was invisible to Next (compat layer reports `writableFinished === true` on cancel) - fixed in `server.mjs` by reporting `writableFinished` only after the app ended the response.
NOT done: video-content endpoint abort is covered only by the generic binary path (same code as Files content), no dedicated test.

### 2. Mirror upstream failure - DONE
Pre-commit: last upstream status (408/429/5xx incl. 529) + `retry-after`/rate-limit headers + `x-upstream-request-id` + native scrubbed error document, all formats incl. translated (tests).
Exceptions documented in PLAN 9d.7 (upstream 401/402/403 -> 503 `no_available_provider`; no-answer transport failures -> 502/504). In-stream error event verbatim (translated streams get the
equivalent native event), upstream RST / clean close without terminal / idle cutoff -> client stream errored = connection dropped (h1: no terminal chunk, h2: RST_STREAM), verified on the container for both
protocols; our own processor exception -> upstream aborted + client dropped + `GATEWAY_ERROR` log + `logger.error("GATEWAY_ERROR")` (unit test in `stream.test.ts`). Not covered by an end-to-end test:
`GATEWAY_ERROR` through a real socket (only the StreamSession unit test).

### 3. Header passthrough - DONE
`src/gateway/headers.ts` allow-list; applied to JSON, SSE, binary, mirrored errors, Files. Tested (`bodies.test.ts` unit, `chaos.test.ts`, container scenarios: `x-upstream-request-id` present, `openai-organization`, `x-powered-by`, `content-encoding` absent).

### 4. Keep-alive both legs - DONE (one default is a decision for the lead)
Heartbeats (`: keep-alive`, `streamHeartbeatSec` default 15, 0 = off, SSE only, commit-by-silence in `StreamSession.prime`) tested incl. stalled upstream; undici agent per 9d.4 (`connections: 10000` - a lower cap
silently queued streams, found by the 1000-stream run; keep-alive 60/600 s, TCP keep-alive, connect 15 s, header timeout counted from the end of the upload, `bodyTimeout: 0`); optional idle cutoff
(`provider.settings.idleTimeoutSec`, else setting `upstreamIdleTimeoutSec`, default 0). HTTP/2 to the upstream is implemented but OPT-IN (`provider.settings.http2: true`, https only) and has NEVER been
exercised against a real h2 upstream - the planned live check (`pnpm chaos --live-h2 ...`) was not run. Decide: keep opt-in, or default it on for openai/anthropic/google after the live check.
Settings added: `streamHeartbeatSec`, `maxRequestBodyMb`, `upstreamIdleTimeoutSec` (admin UI lists them automatically from `SETTING_DEFS`).

### 5. No compression anywhere - DONE
`Accept-Encoding: identity` always (sendUpstream), gzip upstream decoded + headers stripped (tests, JSON + SSE, all formats, container), inbound gzip/deflate/br/zstd decoded (`bodyin.ts`, unit + e2e tests), 415 for unknown, 400 for corrupt.
SSE headers: `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `Connection: keep-alive`.

### 6. Unlimited streamed bodies - DONE
`maxRequestBodyMb` (0 = unlimited; 413 test), multipart spooled + scanned (`multipart.ts`, `spool.ts`), JSON spooled/parsed once/forwarded by splice (`jsonscan.ts`, byte-identity tests), duplex half uploads.
Measured: in-process 1 GB multipart 4.8 s, RSS growth ~100 MB; 200 MB JSON RSS growth ~620 MB (~3x, because JSON must be parsed for validation/billing - documented). In the container over HTTP/1.1: 1 GB multipart 40 s, container
memory 160 -> 406 MB; 200 MB JSON 372 -> 992 MB; over h2c: 1 GB 74 s (memory 585 -> 585 MB, baseline already high from the previous run), 200 MB JSON 389 -> 1006 MB; all byte-identical at the upstream (sha-256).
Not done: spool uses os.tmpdir() (on Cloud Run this is memory - documented in deploy/README); no per-request disk quota.

### 7. Files APIs + sticky + ownership - DONE (video migration deliberately not done)
Paths, handlers, `UpstreamObject` + migration (applied), ownership 404s (native shapes for OpenAI/Anthropic/Gemini), listings from our records, reference pinning (`file_id`, `fileData.fileUri`), key affinity for new uploads,
Gemini session URL rewrite, OpenAI uploads flow - all covered by `tests/gateway/files.test.ts` (12 tests, passing). `VideoJob` left as is. Not done: live check against real OpenAI/Anthropic/Gemini Files APIs; billing of files via a
hidden `files` model is implemented (`filesRoutes`) but untested; a `files` model needs a manual admin setup. Existing providers in a customer DB need `openai_files` / `anthropic_files` / `gemini_files` added to `formats`
in the admin UI (presets, seed and `setup:live` already list them).

### 8. Cloud Run HTTP/2 - DONE
`server.mjs` (first-bytes sniffer: `PRI` -> node:http2 via a replay duplex, else node:http; Next's headers/statusMessage/writableFinished normalised), `Dockerfile` (`CMD ["node","server.mjs"]`, `KEEP_ALIVE_TIMEOUT=620000`,
`SHUTDOWN_DRAIN_SECONDS=600`), `deploy/cloudbuild.yaml` (`--use-http2 --timeout=3600 --no-cpu-throttling`), `deploy/README.md` (why, 32 MB cap, 60-min limit, memory note, drain). Proof: container answers HTTP/1.1 and h2c
(`node scripts/h2c-check.mjs http://127.0.0.1:PORT /api/healthz`, curl on this Windows box has no HTTP/2), SSE over both (`pnpm chaos --docker ... --scenarios`: 16 scenarios, 0 violations).

### 9. Graceful shutdown - DONE
SIGTERM in `server.mjs`: stop accepting, GOAWAY / `Connection: close`, drain (<= `SHUTDOWN_DRAIN_SECONDS`), meter flushed by the existing exit hook, exit 143. Proven on the container: `pnpm chaos --docker ... --streams 1000 --seconds 120 --sigterm-after 40`
(HTTP/1.1): 1000/1000 complete, new connection refused, exit 143 0.4 s after the last stream, 1000 RequestLogs SUCCESS, balance debit == sum of prices (that run was made BEFORE the `connections` fix, so half of the
streams ran 2x as long as intended but still all completed; a 40 s run before/after is the evidence for that fix). A 20-stream h2c drain run also passed.
NOT run after the fix: the full 1000 x 120 s h2c run (`--h2`) and a repeat of the HTTP/1.1 one - re-run both to produce the final numbers (about 4 min each).

### 10. Fidelity / chaos suite - DONE except the final heavy re-runs
`tests/gateway/chaos.test.ts` (89 tests: every bullet of 9d.6 for all 6 formats), `scripts/chaos.ts` (modes: default heavy drain run, `--scenarios`, `--bigbody MB --bigjson MB`, `--live` / `--live-h2`), mock extended
(`x-mock-mode` drop-headers / drop-pre-content / rst-after / fin-after / stall-after / error-after / gzip / early-headers, `x-mock-fail`, abort log `/__mock/aborts`, streaming hash mode, Files endpoints per credential).
`GW_CHAOS_HEAVY=1 pnpm vitest run tests/gateway/bigbody.test.ts` runs the 1 GB / 200 MB version (passed).

## IN PROGRESS / NOT STARTED

1. **Live check - NOT RUN.** Code is written (`pnpm chaos --docker providerproxy:fidelity --live` and `--live-h2`; uses the existing live OpenAI provider/model `gpt-4o-mini`, a throwaway $1 user,
   max_tokens 20, 2 requests per protocol, well under $0.01; restores provider settings and deletes its fixture). Prerequisite: rebuild the image (`docker build -t providerproxy:fidelity .`), `.env` must have `ENCRYPTION_KEY`
   matching the stored provider key. Expect: complete stream SUCCESS with `x-upstream-request-id` and no `openai-organization`; client abort logged CANCELLED with partial `out` tokens. Never print .env secrets.
2. **Final heavy re-runs** (see item 9) and a final capture of the `--scenarios` output (client / upstream / metering per scenario) for the report.
3. **Full suite re-run**: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, then `docker build` (the last docker build succeeded before the final test-only edits).
4. Optional hardening not done: end-to-end test of `GATEWAY_ERROR` over a socket; dedicated video-content abort test; default-on HTTP/2 upstream decision (item 4); Redis-shared UpstreamObject cache (lookups hit the DB each time a body references a file id).
5. Docs: PLAN.md 9d.7 and README are written; update 9d.7's "Evidence" numbers if the heavy runs are repeated.
6. The lead should review: the deliberate deviations listed in PLAN 9d.7 (401/402/403 -> 503, transport failure with no status -> 502/504, JSON ~3x memory) and the flaky pre-existing `cache-redis.test.ts` ("publishes local invalidations", cross-test pub/sub interference; passes in isolation).

## Housekeeping notes

- Chaos fixtures are created with random suffixes (`chz-`, `chl-`, `chaos-`) and removed by the scripts; they were swept from the dev DB at this checkpoint (0 left).
- `scripts/chaos.ts` needs Docker for the drain run (Windows cannot deliver SIGTERM to a child process); `--url` works against any running server.
- Windows tooling quirk met during the work: shell commands containing heredocs with template literals are refused in this worktree sandbox - use the Edit/Write tools for file changes.
