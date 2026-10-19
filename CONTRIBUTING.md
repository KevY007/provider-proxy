# Contributing

## Setup

See [docs/LOCAL-DEVELOPMENT.md](docs/LOCAL-DEVELOPMENT.md). In short: `docker compose up -d`, `pnpm install`,
`node scripts/init-env.mjs`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm mock:upstream`, `pnpm dev`.

This project uses **Next.js 16**, whose APIs differ from older versions (`middleware.ts` is `proxy.ts`, route params
are async, ...). Read the matching guide in `node_modules/next/dist/docs/` before writing Next-specific code.

## Workflow

- Branch from `main`; open a pull request. Never push to `main` directly.
- Keep pull requests focused; describe how to test them (the template asks for it).
- Before pushing, run every gate: `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test`, `pnpm build`.
- Schema changes: `pnpm db:migrate --name <change>` creates the migration; commit it with the schema.
- Secret scan before committing: `git grep --cached -n -e "sk-svcacct-" -e "sk-ant-api03-" -e "r8_"` (only test fixtures may match).

## Rules that are easy to break

- **Faithful proxy** (docs/PLAN.md §9d): the gateway mirrors upstream status codes, headers, error bodies and
  connection behaviour. Any deviation must be deliberate and documented.
- **Money**: use `Decimal` (`@/lib/money`), never floats. Every request is metered exactly once; price changes never
  rewrite history (`RequestLog.price` / `officialPrice` are snapshots). Add tests for any pricing / billing change.
- **Pricing vocabulary**: Official price, Your price (customer), Customer price (admin), Our cost, Savings, Margin.
- **Secrets**: upstream keys never leave the server (only `secretHint` is shown); never log request headers or keys.
- **Tests** that touch the database create uniquely named fixtures and clean them up (see `tests/gateway/harness.ts`).
- Live provider tests (`pnpm e2e:live`, `scripts/live-workload`) cost money and need `LIVE_*` keys in your own `.env`.
