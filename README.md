# ProviderProxy

A metered, multi-provider AI gateway: "be the AI provider for your customers".

Customers sign up, add credit and create `sk-pp-...` API keys. They call **one base URL** with the API format they
already use (OpenAI `/v1/*`, Anthropic `/v1/messages`, Gemini `/v1beta/*`). The gateway forwards each request to an
upstream provider that an admin configured at runtime (OpenAI, Anthropic, Google, xAI, Groq, DeepSeek, Mistral,
Together, Fireworks, OpenRouter, Azure OpenAI, fal.ai, Replicate, Codex-Everywhere or any OpenAI-compatible URL). Each
provider can have any number of upstream keys/accounts. Every request is metered with the customer price, our cost,
the margin and the official list price, so customers can see their savings.

Stack: Next.js 16 (App Router, TypeScript strict) - Prisma 7 + PostgreSQL 16 - Redis 7 (optional, every use has an
in-memory fallback) - Tailwind v4 + shadcn/ui - Stripe - Vitest. It ships as one container (UI + gateway) on Google
Cloud Run + Cloud SQL.

The authoritative design contract is [docs/PLAN.md](docs/PLAN.md).

## Features

**Gateway**
- OpenAI-compatible: chat completions, completions, Responses (plus get/delete/cancel/input_items), embeddings, images
  (generations / edits / variations), audio (speech / transcriptions / translations), moderations, videos (Sora-style
  job API), Files + Uploads, Batch, models list.
- Anthropic-compatible: Messages, count_tokens, Files, Message Batches.
- Gemini-compatible: `generateContent`, `streamGenerateContent`, `countTokens`, `embedContent`, `batchEmbedContents`,
  `models`, Files + resumable upload.
- Translation between OpenAI chat and Anthropic Messages, both directions, streaming included. A Claude model can be
  called with the OpenAI SDK, and a GPT model can be called with the Anthropic SDK.
- Model control: the public model slug can map to any provider and upstream model through weighted, prioritised
  routes. Routes can be limited to pools, carry param overrides and output clamps, and the upstream model name is
  masked in responses.
- Failover across upstream keys and routes before the response is committed. Key health tracking (cooldown on 429,
  INVALID on repeated 401/403, cooldown after repeated 5xx).
- Concurrency slots per upstream key, provider, customer key, customer and pool. Requests queue for a free upstream
  slot. Requests-per-minute and tokens-per-minute limits.
- Faithful 1:1 proxying: client aborts abort the upstream request, upstream failures are mirrored to the client in
  native shape, nothing is compressed, request bodies have no size limit and are streamed, and idle SSE streams get
  keep-alive comments. Evidence is in [docs/CONNECTION-FIDELITY.md](docs/CONNECTION-FIDELITY.md).
- Funds protection: credit holds are placed before any upstream call. When funds are short the gateway answers 402
  without contacting the upstream, and a stream stops when it reaches its hold.
- Durable batched metering writer with a dead-letter file and replay.

**Billing**
- Prepaid pay-as-you-go with Stripe top-ups (saved card or Checkout), auto-recharge, low-balance emails, postpaid
  customers with a credit limit, redeem codes, trial credit, refunds and chargebacks, and a full ledger.
- Pricing rules per model: fixed, percent of official, or markup over cost. Pools (groups) and per-customer
  multipliers, long-context multipliers, cache read/write prices, server-tool prices and Batch API discounts.

**Apps**
- Admin console (`/admin`): overview, analytics, providers and keys with live slot usage, models and routes with a
  guided "Add model" wizard, groups, customers (credits, limits, impersonation), API keys, request logs, billing,
  status, settings and the audit log.
- Customer portal (`/dashboard`): overview with savings, API keys, usage, logs, playground (chat and images), models
  and pricing, billing and account settings with 2FA.
- Public site: landing page, `/pricing`, `/status` and the customer API docs at **`/docs`**.

## Architecture

```mermaid
flowchart LR
  C[Customer SDK / CLI] -->|/v1, /v1beta, /upload| G
  B[Browser] -->|/admin, /dashboard, /docs| UI
  subgraph Container["One container (server.mjs: HTTP/1.1 + h2c)"]
    UI[Next.js App Router UI + server actions]
    G[Gateway handle&#40;Request&#41;]
    MW[Meter writer]
  end
  G -->|undici keep-alive pool| U[(Upstream providers)]
  G --> MW --> PG[(PostgreSQL)]
  UI --> PG
  G <-.->|slots, holds, rate limits, cache invalidation| R[(Redis, optional)]
  S[Cloud Scheduler - optional] -.->|/api/cron/health, /api/cron/billing| UI
  ST[Stripe] -->|/api/stripe/webhook| UI
```

Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quickstart (local)

You need Node 24, pnpm 11 and Docker.

```bash
docker compose up -d          # postgres on :5433, redis on :6380
pnpm install                  # postinstall runs `prisma generate` (client in src/generated/prisma, gitignored)
node scripts/init-env.mjs     # writes .env with fresh secrets; or cp .env.example .env and fill it in
pnpm db:migrate               # apply migrations (pnpm db:deploy for a non-interactive apply)
pnpm db:seed                  # settings, groups, provider presets, model catalog, admin, demo customer, Mock Upstream
pnpm mock:upstream            # terminal 2: fake OpenAI / Anthropic / Gemini / fal / Replicate on :4010
pnpm dev                      # http://localhost:3000
```

Seeded logins (dev):

| Who | Login |
|---|---|
| Admin | `admin@example.com` / `admin-password-123`. This is the `ADMIN_PASSWORD` that `init-env` writes. If you copied `.env.example` unchanged it is `change-me-now-please`. |
| Demo customer | `demo@example.com` / `demo-password-123` ($25 balance) |
| Demo API key (dev only) | `sk-pp-devdemo000000000000000000000000000000000` (mock models `mock-gpt`, `mock-claude`, `mock-embed`, `mock-image`) |

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-pp-devdemo000000000000000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock-gpt","messages":[{"role":"user","content":"Hello"}]}'
```

Emails (verification, reset) are printed to the console and stored in the `EmailOutbox` table while `SMTP_URL` is
unset. More detail: [docs/LOCAL-DEVELOPMENT.md](docs/LOCAL-DEVELOPMENT.md).

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Next.js dev server (`NEXT_DIST_DIR=.next-x pnpm next dev -p 3001` for extra servers) |
| `pnpm build` / `pnpm start` | Production build (standalone output) / `next start` (the container uses `node server.mjs`) |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `next typegen && tsc --noEmit` |
| `pnpm test` | Whole Vitest suite (unit + DB-backed. DB tests skip when Postgres is unreachable) |
| `pnpm db:generate` | `prisma generate` (also runs on `postinstall`) |
| `pnpm db:migrate` | `prisma migrate dev` (development) |
| `pnpm db:deploy` | `prisma migrate deploy` (apply pending migrations, no prompts) |
| `pnpm db:seed` | Seed (re-runnable; skips the mock provider and demo data when `NODE_ENV=production`) |
| `pnpm db:studio` | Prisma Studio |
| `pnpm mock:upstream` | Mock upstream server on :4010 (`MOCK_UPSTREAM_PORT` overrides) |
| `pnpm e2e` | Mock-based gateway suite: `vitest run tests/gateway` (needs Postgres; starts the mock in-process) |
| `pnpm loadtest` | 1000 concurrent streams through the gateway against the mock (`tests/gateway/load.test.ts`; `GW_LOAD_N` changes N) |
| `pnpm chaos --docker <image> [--scenarios] [--h2]` | Connection-fidelity run against a real server/container: fault scenarios, SIGTERM drain with 1000 streams, big bodies |
| `pnpm setup:live [--markup 1.30 \| --percent-of-official 100]` | Idempotent: creates/updates live OpenAI / Anthropic / fal.ai / Replicate providers, keys, models and prices from the `LIVE_*` variables |
| `pnpm e2e:live [--skip-video]` | Real-traffic end-to-end check against a running dev server (`E2E_BASE_URL`, default `http://localhost:3005`). Costs money. |
| `node scripts/h2c-check.mjs <base-url> [path]` | HTTP/2 cleartext (prior knowledge) probe of a running server |

## Environment variables

Defined in `.env.example` and validated in `src/lib/env.ts`. Blank values count as unset.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://proxy:proxy@localhost:5433/proxy` | Postgres connection |
| `DB_POOL_SIZE` | `20` | Postgres pool size per instance |
| `REDIS_URL` | unset | Optional. Shared slots, holds, rate limits, balance cache and config invalidation. Without it these are in-memory and per instance. |
| `APP_URL` | `http://localhost:3000` | Public base URL (links in emails, Stripe redirects) |
| `SESSION_SECRET` | dev fallback | 32+ chars. Required in production. |
| `ENCRYPTION_KEY` | dev fallback | 32 bytes, base64. AES-256-GCM key for upstream provider secrets and TOTP secrets. Required in production. **Back it up.** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@example.com` / `change-me-now-please` (dev) | First admin, created by the seed if missing |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | unset | Optional. Without them billing shows "Stripe not configured" and only redeem codes and admin credits work. |
| `SMTP_URL` | unset | `smtp://user:pass@host:587`. Unset: emails go to the console and the `EmailOutbox` table. |
| `EMAIL_FROM` | `ProviderProxy <no-reply@example.com>` | Sender |
| `CRON_SECRET` | unset | Bearer token for `/api/cron/*`. `/api/cron/billing` refuses to run without it. `/api/cron/health` runs without it only when `NODE_ENV=development`. |
| `MOCK_UPSTREAM_URL` | `http://localhost:4010` | Where the dev seed points the "Mock Upstream" provider |
| `TRUSTED_PROXY_HOPS` | `1` | Trusted reverse proxies in front of the app, used for client-IP detection (Cloud Run = 1, behind a Global LB = 2). `0` = nothing in front: the socket address is used and any client-sent `X-Forwarded-For` is ignored (`docker-compose.prod.yml` sets this). |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

Container and runtime knobs (not in `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOSTNAME` | `8080` / `0.0.0.0` (image) | Listener |
| `KEEP_ALIVE_TIMEOUT` | `620000` | HTTP/1 keep-alive in ms. It must be above Google's 600 s LB idle timeout. |
| `SHUTDOWN_DRAIN_SECONDS` | `600` | Upper bound for the SIGTERM drain |
| `H2_INITIAL_WINDOW_BYTES` | `1048576` | HTTP/2 flow-control window |
| `METER_DEADLETTER_DIR` | OS temp dir | Where the metering dead-letter JSONL file is written |
| `METER_BATCH_FAIL_LIMIT` | `3` | Failed batch flushes before per-row isolation |
| `NEXT_DIST_DIR` | `.next` | Build/dev output dir (lets several dev servers run from one checkout) |

Optional, **dev only** (gitignored `.env`, never commit them, never needed in production):

| Variable | Used by |
|---|---|
| `LIVE_OPENAI_API_KEY` | `pnpm setup:live`, `pnpm e2e:live`, live-workload runner |
| `LIVE_ANTHROPIC_API_KEY` | same |
| `LIVE_FAL_KEY` | same (fal.ai images) |
| `LIVE_REPLICATE_API_TOKEN` | same (Replicate images) |

Test flags: `GW_TEST_REDIS_URL` (Redis tests, default `redis://localhost:6380`), `GW_LOAD` / `GW_LOAD_N`,
`GW_CHAOS_HEAVY`, `E2E_BASE_URL`, `E2E_COST_CAP`. See [docs/LOCAL-DEVELOPMENT.md](docs/LOCAL-DEVELOPMENT.md).

## Testing

```bash
pnpm typecheck && pnpm lint && pnpm test       # the standard gates
pnpm e2e                                       # just the gateway suite (mock upstream, needs Postgres)
pnpm loadtest                                  # 1000 concurrent streams
GW_CHAOS_HEAVY=1 pnpm vitest run tests/gateway/bigbody.test.ts   # 1 GB multipart + 200 MB JSON
docker build -t providerproxy:fidelity . && pnpm chaos --docker providerproxy:fidelity --scenarios
```

Unit tests need nothing. Gateway, billing and metering tests need the docker-compose Postgres (they skip when it is
unreachable). The Redis tests need a Redis at `GW_TEST_REDIS_URL`. The live checks (`setup:live`, `e2e:live`) need
the `LIVE_*` keys and spend real money.

## Deploying

Google Cloud Run (scales to zero by default) + Cloud SQL + Secret Manager (Memorystore Redis and Cloud Scheduler optional):
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), with the full copy/paste walkthrough in
[deploy/README.md](deploy/README.md). Any Docker host also works: set `POSTGRES_PASSWORD` (required) and the
secrets in `.env`, then run `docker compose -f docker-compose.prod.yml up -d --build`.

## Documentation

| Doc | For |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, request pipeline, translation, stateful objects, caching, metering, crons |
| [docs/LOCAL-DEVELOPMENT.md](docs/LOCAL-DEVELOPMENT.md) | Bring-up, multiple dev servers, mock upstream markers, tests, Windows notes |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production on Google Cloud |
| [docs/ADMIN-GUIDE.md](docs/ADMIN-GUIDE.md) | Running the admin console |
| [docs/API-GUIDE.md](docs/API-GUIDE.md) | Endpoint inventory and behaviour for integrators. Examples are in the in-app `/docs`. |
| [docs/PRICING-AND-BILLING.md](docs/PRICING-AND-BILLING.md) | Pricing vocabulary, rules, holds, Stripe, ledger |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Runbook: background jobs, dead letters, key rotation, incidents, monitoring, backups |
| [docs/PLAN.md](docs/PLAN.md) | Architecture contract (authoritative) |
| [docs/CONNECTION-FIDELITY.md](docs/CONNECTION-FIDELITY.md) | Fidelity evidence (chaos, drain, big bodies) |
| [docs/LIVE-WORKLOAD-REPORT.md](docs/LIVE-WORKLOAD-REPORT.md) | Live workload test results |
| [docs/HANDOFF.md](docs/HANDOFF.md), [docs/FOUNDATION.md](docs/FOUNDATION.md), [docs/FIXES-PROGRESS.md](docs/FIXES-PROGRESS.md) | Development history and conventions |
| [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) | Contributing, reporting vulnerabilities |

## Project map

```
prisma/                  schema, migrations, seed (+ seed-data.ts: provider presets and model catalog)
server.mjs               production entry: HTTP/1.1 + h2c on one port, graceful SIGTERM drain
src/gateway/             the proxy engine: handle(Request) => Response (framework agnostic)
src/app/v1, v1beta, upload/   gateway route handlers (thin wrappers around handle)
src/app/api/             healthz, cron/{health,billing}, stripe/webhook, pricing (public), admin/slots
src/app/admin/           admin console          src/app/dashboard/   customer portal
src/app/(marketing)/     landing, pricing, status, docs     src/app/(auth)/   login, signup, 2FA, reset
src/server/              billing, admin, customer, analytics, pricing server code
src/lib/                 db, env, crypto, money, redis, ratelimit, settings, audit, email, logger, auth
src/components/          ui (shadcn), shell, common, admin, customer, billing, marketing (docs content)
scripts/                 mock upstream, chaos, live setup / e2e, init-env, h2c check
tests/                   vitest suites (gateway, billing, admin, customer, pricing, lib)
deploy/                  Cloud Build config, migrate script, Google Cloud walkthrough
```

## License

Proprietary. Copyright (c) 2026 ProviderProxy. All rights reserved. See [LICENSE](LICENSE).
