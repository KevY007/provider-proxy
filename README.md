# ProviderProxy

A metered, multi-provider AI gateway. Customers get **our** API keys and call **our** endpoints in
OpenAI / Anthropic / Gemini format; requests are forwarded to upstream providers (OpenAI, Anthropic,
Google, xAI, Groq, DeepSeek, OpenRouter, any OpenAI-compatible URL...) that an admin configures at
runtime, each with any number of upstream keys. Every request is metered: customers are charged the
**sell price**, we record the **cost price** and the profit.

Stack: Next.js 16 (App Router) - TypeScript - Tailwind v4 + shadcn/ui - PostgreSQL 16 + Prisma 7 -
Redis (optional) - Stripe. Deployed as one container on Google Cloud Run.

The authoritative design/contract is **[docs/PLAN.md](docs/PLAN.md)**.

## Local setup

Requires Node 24, pnpm 11, Docker.

```bash
docker compose up -d                 # postgres :5433, redis :6380
pnpm install                         # also runs `prisma generate`
node scripts/init-env.mjs            # or: cp .env.example .env  (then fill SESSION_SECRET / ENCRYPTION_KEY)
pnpm db:migrate                      # apply migrations
pnpm db:seed                         # settings, groups, providers, model catalog, admin, demo data
pnpm dev                             # http://localhost:3000
pnpm mock:upstream                   # (second terminal) fake OpenAI/Anthropic/Gemini upstream on :4010
```

Seeded logins (dev): `admin@example.com / admin-password-123` (from `.env`) and
`demo@example.com / demo-password-123` ($25 balance). A fixed dev API key for the demo customer is
printed by the seed. Verification/reset emails are logged to the console and stored in the
`EmailOutbox` table when `SMTP_URL` is unset.

### Scripts

| Script | What it does |
|---|---|
| `pnpm dev` / `build` / `start` | Next.js |
| `pnpm lint` / `typecheck` / `test` | ESLint, `tsc --noEmit`, Vitest |
| `pnpm db:migrate` / `db:deploy` / `db:seed` / `db:studio` | Prisma dev migrate, deploy migrations, seed, Studio |
| `pnpm mock:upstream` | Local fake upstream provider (OpenAI / Anthropic / Gemini, plus fal.ai, Replicate and `/v1/videos`) |
| `pnpm setup:live [--markup 1.30]` | Idempotent live setup: enable OpenAI / Anthropic / fal.ai / Replicate from the `LIVE_*` keys in `.env`, models + routes + profitable prices (sell = cost x markup) |
| `pnpm e2e:live [--skip-video]` | Real-traffic end-to-end check against a running dev server (see below) |
| `pnpm e2e` / `pnpm loadtest` | End-to-end and load-test scripts (QA) |

## Live providers (real upstream traffic)

Put the upstream credentials in `.env` (gitignored; never commit them): `LIVE_OPENAI_API_KEY`, `LIVE_ANTHROPIC_API_KEY`,
`LIVE_FAL_KEY`, `LIVE_REPLICATE_API_TOKEN`.

```bash
pnpm setup:live                                   # providers + one encrypted key each + models + prices (re-runnable)
NEXT_DIST_DIR=.next-live pnpm next dev -p 3005    # dev server (second terminal)
pnpm e2e:live                                     # drives the gateway with real OpenAI / Anthropic / fal.ai / Replicate calls
```

- **Pricing policy**: route cost = upstream list price, sell price = cost x 1.30 by default (`--markup` to change). Prices of
  post-2025 models are marked `*` in the setup summary: confirm them in /admin/models.
- `setup:live` asks OpenAI / Anthropic which models the key can use and **disables models whose upstream `shutdown_date`
  has passed** (sora-2 was shut down on 2026-09-24) and lists upcoming sunsets.
- `smart-fast` is a demo public model that routes to Claude Haiku (priority 10) and falls back to GPT-5 nano (priority 5).
- `e2e:live` creates the throwaway customer `live-e2e@example.com` ($5, random password that is not stored anywhere readable;
  use the admin impersonation to look at it) and keeps it, so the admin dashboard has real data. Estimated spend of a full run is
  about a cent; the paid video job only runs when every other check passed and a video model is enabled.
- fal.ai and Replicate image models use `POST /v1/images/generations` (`n`, `size`, `seed`, `response_format`, `extra_input`);
  videos use the OpenAI-style `/v1/videos` API. Details in [docs/PLAN.md](docs/PLAN.md) section 5c.

## Project map

```
prisma/                  schema, migrations, seed (+ seed-data.ts: provider presets & model catalog)
src/lib/                 db, env, crypto, money, redis, ratelimit, settings, audit, email, logger, http, utils
src/lib/auth/            sessions, signup/login/2FA/reset flows, server actions, guards (requireUser/requireAdmin)
src/proxy.ts             route guard for /dashboard/* and /admin/*
src/components/ui/       shadcn components
src/components/shell/    AppShell, sidebar nav configs, topbar
src/components/common/   StatCard, PageHeader, DataTable, DateRangePicker, ChartCard, MoneyText, ...
src/app/(auth)/          login, signup, verify-email, forgot/reset password, 2FA
src/app/dashboard/       customer portal            src/app/admin/   admin console
src/app/(marketing)/     public site                src/app/api/     healthz, cron, stripe webhook
src/gateway/ src/server/ gateway engine, billing, admin & customer server code (see PLAN section 2)
deploy/                  Cloud Build, migrate script, Google Cloud walkthrough (deploy/README.md)
```

## Deploying

See [deploy/README.md](deploy/README.md) (Google Cloud Run + Cloud SQL + Secret Manager) or run
`docker compose -f docker-compose.prod.yml up -d --build` on any Docker host.
