# Connection fidelity (Phase 4b) - final reference

Design: [PLAN.md](PLAN.md) section 9d (principle, 9d.7 = implementation record and decisions). This file is the evidence:
what the gateway does on each connection event, what was measured, and the deliberate deviations. Everything below was
re-run on the final tree against the built container (`docker build -t providerproxy:fidelity .`).

Status: ALL ITEMS DONE. Verification at the final run: `pnpm typecheck` clean, `pnpm lint` clean, `pnpm test` 51 files /
634 tests passed + 1 skipped (live) - repeated 4x with no failure, `pnpm build` (run inside `docker build`) green.

## Reproduce

```bash
pnpm typecheck && pnpm lint && pnpm test
docker build -t providerproxy:fidelity .
pnpm chaos --docker providerproxy:fidelity --scenarios                                   # table below, HTTP/1.1 and h2c
pnpm chaos --docker providerproxy:fidelity --streams 1000 --seconds 120 --sigterm-after 40          # drain, HTTP/1.1
pnpm chaos --docker providerproxy:fidelity --streams 1000 --seconds 120 --sigterm-after 40 --h2     # drain, h2c
pnpm chaos --docker providerproxy:fidelity --bigbody 1024 --bigjson 200                  # big bodies, both protocols
pnpm chaos --docker providerproxy:fidelity --live        # real OpenAI, < $0.001; --live-h2 = upstream leg over HTTP/2
GW_CHAOS_HEAVY=1 pnpm vitest run tests/gateway/bigbody.test.ts                           # in-process 1 GB / 200 MB
```

## Scenario table (container, identical over HTTP/1.1 and h2c: 16 scenarios, 0 violations)

| Scenario | Client observed | Upstream observed | Metering (RequestLog) |
|---|---|---|---|
| Complete stream | 200 SSE, `[DONE]`, `x-upstream-request-id`, no `content-encoding` | answered normally | SUCCESS 200, out=50, $0.000200 |
| Upstream 529 on every key | HTTP 529 + `retry-after: 7` + the upstream's native error body (identity scrubbed) | 3 attempts (one per key), all 529 | UPSTREAM_ERROR 529, out=0, $0 |
| Upstream TCP RST mid-stream | 200, 7 frames, then connection error (h1: `terminated`; h2: RST_STREAM / `ERR_HTTP2_STREAM_ERROR`); no synthetic `[DONE]` | RST after 7 frames | UPSTREAM_ERROR 502, out=6 (est), $0 to the customer (our cost recorded) |
| Upstream clean FIN, no terminal event | same as RST: the client stream is dropped, not closed cleanly | FIN after 7 frames, no terminator | UPSTREAM_ERROR 502, out=6 (est), $0 to the customer |
| Error event inside the stream | 200, the upstream's error event verbatim, then the normal end | error event after 2 frames | UPSTREAM_ERROR 502, out=1 (est), $0 to the customer |
| Upstream gzips despite `identity` | 200, plain SSE, no `content-encoding` | sent `Content-Encoding: gzip` | SUCCESS 200, out=50 |
| Client aborts mid-stream | gone after ~460-480 ms | request aborted 2-3 ms later (phase "streaming") | CANCELLED 499, out=2 (est), partial usage billed, slots and credit hold released |
| Client aborts a non-stream request | gone after ~400 ms | request aborted 1-3 ms later (phase "waiting") | CANCELLED (logged by the gateway) |

Also covered in `tests/gateway/chaos.test.ts` (89 tests, all six wire paths: OpenAI chat, Responses, Anthropic, Gemini, chat->Anthropic and
Messages->chat translated): 408/429/5xx mirrored with `retry-after`/rate-limit headers, drop before content -> failover then 502, heartbeats on silent and
stalled streams, client leaving while queued for a slot (upstream never contacted), multipart / Files upload aborted mid-flight (spool file removed),
Files download aborted, gzip request bodies, byte-identical JSON forwarding, no RequestLog lost.

## Drain (SIGTERM at 40 s), 1000 concurrent 120 s streams, container

| | HTTP/1.1 | h2c (10 sessions x 100 streams) |
|---|---|---|
| Streams complete / truncated | 1000 / 0 | 1000 / 0 |
| Stream duration min / avg / max | 120.8 / 121.5 / 122.1 s | 120.9 / 121.4 / 121.9 s |
| Heartbeats per stream | 14 | 14 |
| New connection after SIGTERM | refused | refused |
| Container exit | 143, 0.4 s after the last stream | 143, 0.7 s after the last stream |
| RequestLogs / not SUCCESS | 1000 / 0 | 1000 / 0 |
| Balance debit == sum of prices | 0.2 == 0.2 | 0.2 == 0.2 |
| Container memory under load | 353 MiB | 332 MiB |

## Big bodies (container, byte-identical at the upstream by sha-256 except the rewritten `model`)

| Body | HTTP/1.1 | h2c |
|---|---|---|
| 1 GB multipart upload | 44.5 s, memory 148 -> 393 MB (+245 MB) | 76.6 s, memory 578 -> 578 MB (baseline already high from the preceding run) |
| 200 MB JSON prompt | 6.4 s, 359 -> 980 MB (+622 MB, about 3x the body) | 18.5 s, 389 -> 1007 MB (+619 MB) |

In-process (`GW_CHAOS_HEAVY=1 bigbody.test.ts`): 1 GB multipart 4.8 s, RSS growth about 100 MB; 200 MB JSON RSS growth about 620 MB.
Multipart is spooled (memory up to 8 MB, then a temp file) and forwarded as the customer's bytes; JSON must be parsed once for validation / billing, hence about 3x.

## Live check (real OpenAI `gpt-4o-mini`, throwaway user, `max_tokens` 20)

| Run | Complete stream | Client abort |
|---|---|---|
| `--live` (upstream HTTP/1.1), client over HTTP/1.1 and h2c | 200, `[DONE]`, `x-upstream-request-id` present, no `openai-organization`, no `content-encoding`; SUCCESS out=20 | gateway logged CANCELLED 0.5 s after the client left, partial usage out=6 (est) |
| `--live-h2` (`provider.settings.http2 = true`), both client protocols | same | same (CANCELLED, out=6 est) |

Each run = 2 client protocols x (1 full + 1 aborted request): customer price $0.000059, our cost $0.000045 per run; about $0.0001 for both. The runs restore the
provider settings and delete their fixtures.

## Deliberate deviations from "mirror everything" (PLAN 9d.7) and why

1. Upstream 401 / 403 are returned as 503 `no_available_provider`, and an upstream account out of credit (402, or a 403 about balance) as 503 `upstream_insufficient_balance`: they are OUR account problem; a mirrored 401 would make SDKs blame the customer's key. The real code stays in `RequestLog.errorCode`.
2. Failures with no upstream answer (connect error, reset before headers, headers timeout) have no status to mirror -> native-shaped 502 / 504 (every SDK retries these like a network error).
3. A stream is complete only when the upstream's terminal event arrived; a missing terminal (RST, FIN, idle cutoff) drops the client connection instead of faking an end. Heartbeats exist only on SSE, only after the response started or the upstream stayed silent for one interval.
4. JSON bodies need about 3x their size in memory (parsed once for validation, funds estimate and usage fallback). Multipart does not. Size the container memory for the largest JSON body you accept.
5. Upstream HTTP/2 is OPT-IN (`provider.settings.http2: true`, https only, default off). Lead decision: one lost h2 connection ends every stream multiplexed on it. Live-checked against OpenAI (`--live-h2`, passes), documented in the admin provider settings help text.
6. `VideoJob` is left as is. New sticky objects (files, uploads, Gemini upload sessions) use `UpstreamObject`.
7. Multipart spool uses `os.tmpdir()` (memory-backed on serverless container platforms); no per-request disk quota.
8. An upstream's own SSE comment lines are not forwarded as written: each comment block becomes the gateway's `: keep-alive` line. Relays put their name in them (`: <relay> keep-alive`, `: <ROUTER> PROCESSING`), which would tell the customer who serves the pool. Their purpose (the connection stays alive) is kept, also on translated streams (`tests/gateway/stream.test.ts`).

## Stream start hold (relays that fail right after accepting a request)

Some relays answer 200, send the opening bookkeeping event (a role-only chunk, `response.created`, `message_start`)
and then an in-band "Service Unavailable" seconds later, before any output (measured on one reseller: 11 of 30
streams, all 8-27 s in, none after output had started). The gateway does not treat those opening events as the start
of the response: it holds the response until real output arrives, for up to `streamStartHoldSec` (default 120 s), and
a failure in that window is retried invisibly (`tests/gateway/integration.test.ts`, mock fault `flakystart`). The
chaos suite pins the hold to one heartbeat interval where it times the heartbeat itself.

Reasoning counts as opening events too, and so does commentary: a Responses model that was given tools first sends a
message item of `phase: "commentary"` (one sentence about what it is going to do) and then reasons for minutes. On
another reseller such streams died in that reasoning phase, 15 of 17 calls, each already committed by the commentary
sentence 10-20 s in. Commentary text is now held like reasoning (`tests/gateway/studio-compat.test.ts`, mock
credential `commentdrop`). A stream that fails after it was committed is logged with the event that started it and
the last events the upstream sent (types only), so the two cases can be told apart afterwards.

## Limits and not covered (stated plainly)

- A TCP RST discards whatever the peer had not read yet, so after an upstream reset the client may miss the last few events (real providers behave the same).
- A serverless container platform may force-kill shortly after SIGTERM (e.g. 10 s): only graceful shutdowns (deploys, idle scale-in, `docker stop -t`) are lossless.
- Not covered by an end-to-end test: `GATEWAY_ERROR` through a real socket (StreamSession unit test only); a dedicated video-content abort test (shares the Files content code path); live Files APIs against real OpenAI / Anthropic / Gemini; billing of the hidden `files` model (implemented, untested).
- Lookups of file ids hit the database each time (no Redis-shared `UpstreamObject` cache).
- Existing providers need `openai_files` / `anthropic_files` / `gemini_files` in their formats: Admin > Providers > provider > "Apply preset formats" (one click, with confirm), or pick them in the formats multi-select.

## Test hygiene note

`tests/gateway/harness.ts` tags every harness provider with `iso-<suffix>` and restricts the harness group to that tag: Files calls pick ANY active provider
that speaks the format, so parallel test files used to upload to each other's providers (a rare `files.test.ts` failure in full runs). `cache-redis.test.ts`
waits for its own two pub/sub messages instead of "any two" on the shared channel.
