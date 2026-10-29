# Local development

## Prerequisites

Node 24, pnpm 11 (`corepack enable`), Docker (for Postgres and Redis).

## Bring-up

```bash
docker compose up -d          # postgres 16 on localhost:5433, redis 7 on localhost:6380 (re-run after a reboot)
pnpm install                  # postinstall: prisma generate -> src/generated/prisma (gitignored)
node scripts/init-env.mjs     # creates .env from .env.example with fresh SESSION_SECRET / ENCRYPTION_KEY / CRON_SECRET
                              # and ADMIN_PASSWORD=admin-password-123 (does nothing if .env exists)
pnpm db:migrate               # prisma migrate dev; or pnpm db:deploy to apply without prompts
pnpm db:seed                  # re-runnable: settings, groups, provider presets, catalog, admin, demo data, Mock Upstream
pnpm mock:upstream            # second terminal: fake upstream on :4010
pnpm dev                      # http://localhost:3000
```

| Login | Credentials |
|---|---|
| Admin | `admin@example.com` / the `ADMIN_PASSWORD` in `.env` (`admin-password-123` from `init-env`) |
| Demo customer | `demo@example.com` / `demo-password-123`, $25 balance |
| Demo API key | `sk-pp-devdemo000000000000000000000000000000000` |

What the dev seed creates:
- Groups `standard` (1.0x, default), `pro` (0.8x) and `enterprise` (0.6x, not public).
- Provider presets (disabled, no keys).
- The model catalog with official prices.
- The **Mock Upstream** provider (`MOCK_UPSTREAM_URL`, tag `mock`, 3 keys with 100 slots each) and the models
  `mock-gpt`, `mock-claude`, `mock-embed` and `mock-image`.

The seeded mock provider speaks chat, completions, Responses, embeddings, images, audio, Anthropic Messages and
Gemini. To try Files, Batches or videos locally, add `openai_files` / `anthropic_files` / `gemini_files` /
`openai_batches` / `anthropic_batches` / `openai_videos` to its formats under **Admin > Providers > Mock Upstream**.
The mock implements all of them.

Without `SMTP_URL`, emails (verify, reset, low balance) are printed to the console and stored in the `EmailOutbox`
table. Without Stripe keys, billing shows "Stripe not configured"; use redeem codes or admin credits instead.

### Live providers (optional, costs money)

Put `LIVE_OPENAI_API_KEY`, `LIVE_ANTHROPIC_API_KEY`, `LIVE_FAL_KEY` and `LIVE_REPLICATE_API_TOKEN` in `.env`. It is
gitignored: never commit, print or log them. Then:

```bash
pnpm setup:live                                   # providers + one encrypted key each + models + prices (idempotent)
NEXT_DIST_DIR=.next-live pnpm next dev -p 3005    # dev server for the live run
pnpm e2e:live [--skip-video]                      # real traffic; creates/keeps customer live-e2e@example.com
```

By default `setup:live` prices models at "match official". `--markup 1.30` forces cost x 1.30 and
`--percent-of-official 70` forces 70% of official. It disables models whose upstream `shutdown_date` has passed.

## Running several dev servers

`next.config.ts` reads `NEXT_DIST_DIR`, so each server gets its own build directory:

```bash
NEXT_DIST_DIR=.next-a pnpm next dev -p 3001
NEXT_DIST_DIR=.next-b pnpm next dev -p 3002
```

`.next-*` is gitignored. `next dev` may rewrite `tsconfig.json` (adding `.next-*` includes) and re-adds its block to
`AGENTS.md`. Revert `tsconfig.json` with `git checkout tsconfig.json`. The `AGENTS.md` block is committed as is.

All servers share one Postgres and Redis. Customer slots, holds and caches are shared through Redis. Without
`REDIS_URL` each server has its own in-memory state.

## Mock upstream (`scripts/mock-upstream.ts`)

The mock is a fake OpenAI / Anthropic / Gemini / fal.ai / Replicate server on `:4010` (`MOCK_UPSTREAM_PORT`
overrides). Tests start it in-process (`startMockUpstream(0)`). Restart it after pulling, because old builds lack
newer markers.

**Fault keys.** The fault is chosen by the upstream credential the gateway presents. Create a provider key whose
secret contains one of these strings:

| Secret contains | Mock answers |
|---|---|
| `fail429` | 429 + `retry-after: 2` |
| `fail500` | 500 |
| `fail529` | 529 overloaded |
| `bad` | 401 invalid key |
| `slow` | +1500 ms before the response / first byte |

**Prompt markers**, placed in the last user text, prompt or input:

| Marker | Effect |
|---|---|
| `[[delay:N]]` | Wait N ms (non-stream: before responding; stream: before every chunk). Also `x-mock-delay-ms` header or `mock_delay_ms` body field. |
| `[[usage:in=1000,out=500,cached=200,cw=50]]` | Report this usage |
| `[[words:N]]` | Reply with N words (1 token each), obeying the request's output cap |
| `[[runaway:N]]` | N words, **ignoring** the cap (tests the stream funds cutoff) |
| `[[http400]]` | 400 `invalid_request` |
| `[[notool]]` | Suppress the automatic tool call |
| `[[ws:N]]` / `[[fs:N]]` | N web searches / file searches (server-tool metering) |
| `[[codeexec]]` | Code-execution run that creates a downloadable file |
| `[[think:N]]`, `[[thinkburn]]`, `[[nothinkdetails]]` | Thinking tokens; thinking uses the whole budget; thinking not itemized |
| `[[sync504]]`, `[[fal422]]` | fal: sync answers 504 (adapter falls back to the queue); validation error |
| `[[slowpred]]`, `[[predfail]]`, `[[prednsfw]]`, `[[pred422]]` | Replicate: slow / failed / NSFW / validation error |
| `[[vidfail]]` | Video job ends `failed` (tests the refund) |
| `[[batchslow]]`, `[[batcherr]]` | Batch keeps running / that request fails (a batch otherwise ends on the first GET) |

**Fidelity headers.** The gateway forwards `x-mock-*` headers to providers tagged `mock`.

| Header | Effect |
|---|---|
| `x-mock-mode: drop-headers \| drop-pre-content \| rst-after:N \| fin-after:N \| stall-after:N \| error-after:N \| gzip \| early-headers` | Connection faults (comma separated) |
| `x-mock-fail: <status>` | Answer that status with `retry-after: 7`, a request id, rate-limit headers and a native body |
| `x-mock-linger-ms: N` | Keep the stream connection open N ms after the last frame |
| `x-mock-tag: <id>` | Label the request in `/__mock/aborts` |
| `x-mock-hash-body: 1` | Hash the body on the fly instead of buffering it (automatic above 32 MB) |

Introspection (no auth): `/__mock/stats`, `/__mock/reset`, `/__mock/last?path=/v1/messages`, `/__mock/aborts`,
`/healthz`. Files and batches are kept per upstream credential.

## Resetting the database

```bash
pnpm prisma migrate reset && pnpm db:seed   # drop the dev DB, re-apply migrations, then seed explicitly
                                            # (Prisma 7 does not run the seed automatically on reset)
# or start completely fresh:
docker compose down -v && docker compose up -d && pnpm db:deploy && pnpm db:seed
```

Redis holds only ephemeral state (it runs without persistence). `docker compose restart redis` clears it.

## Tests

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm vitest run tests/gateway/funds.test.ts         # one file
pnpm e2e                                            # tests/gateway only
```

| Kind | Needs | Examples |
|---|---|---|
| Unit (pure) | nothing | `tests/pricing/*`, `tests/lib/*`, `tests/gateway/{pricing,translate,select,validate}.test.ts` |
| DB-backed | docker-compose Postgres (`DATABASE_URL`, migrated). Skipped when unreachable. | gateway integration / chaos / files / batches / funds / meter-durable, billing |
| Redis | a Redis at `GW_TEST_REDIS_URL` (default `redis://localhost:6380`). Skipped when unreachable. | `slots-redis`, `holds-redis`, `cache-redis` |
| Opt-in heavy | `GW_LOAD=1` (or `pnpm loadtest`), `GW_LOAD_N`; `GW_CHAOS_HEAVY=1` (`GW_BIG_MULTIPART_MB`, `GW_BIG_JSON_MB`) | `load.test.ts`, `bigbody.test.ts` |
| Container | Docker | `pnpm chaos --docker <image> [--scenarios] [--h2] [--bigbody 1024 --bigjson 200]` |
| Live | `LIVE_*` keys, running dev server | `pnpm e2e:live` |

Vitest forces `REDIS_URL=""` (memory backends) and fixed test secrets (`vitest.config.mts`). The gateway harness
(`tests/gateway/harness.ts`) creates uniquely named users, keys and providers per run and tags providers `iso-<suffix>`,
so parallel test files stay isolated. Keep that pattern in new tests.

## Windows notes

- pnpm runs scripts through `cmd.exe`, so the `VAR=value cmd` prefix does not work. In PowerShell use
  `$env:NEXT_DIST_DIR=".next-a"; pnpm next dev -p 3001`. In cmd use `set NEXT_DIST_DIR=.next-a && pnpm next dev -p 3001`.
  Or use Git Bash. `pnpm loadtest` opts in by script name, so it needs no env var.
- Windows cannot deliver SIGTERM to a child process. The drain part of `pnpm chaos` needs Docker or Linux.
- Docker Desktop must be running before `docker compose up -d`. Ports 5433 and 6380 avoid clashes with local installs.

## Next.js 16 caveats

This is Next.js 16 and it differs from older versions. Read `AGENTS.md` and the guides in `node_modules/next/dist/docs/`
before writing Next-specific code.
- Middleware is `src/proxy.ts` (export `proxy`), not `middleware.ts`.
- `params`, `searchParams`, `cookies()` and `headers()` are async.
- Gateway route handlers use `runtime = "nodejs"`, `dynamic = "force-dynamic"` and `maxDuration`.
- `pnpm typecheck` runs `next typegen` first.
- `compress: false` and `output: "standalone"` are required (see `next.config.ts`). Do not turn compression on.
