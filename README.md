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
| `pnpm mock:upstream` | Local fake upstream provider |
| `pnpm e2e` / `pnpm loadtest` | End-to-end and load-test scripts (QA) |

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
