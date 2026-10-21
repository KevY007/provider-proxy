# ProviderProxy — Handoff & Continuation Guide

**Read this first.** It is written for a new agent or cloud session picking the project up cold. Originally written at `780d14a`;
**§5-§6 updated 2026-10-19** (deployment, scale-out and the final feature PRs added to §5) after Steps A, B, D and E were completed in a cloud session on branch `claude/task-49gbi5`
(same history as `feat/initial-build` plus the new commits - fast-forward `feat/initial-build` to it, or open the PR from it).

---------------------------------------------------------------------------------------------------------------------------------

## 1. What this is

A metered, multi-provider AI gateway ("be the AI provider for our customers"). Customers get `sk-pp-…` keys and call our
OpenAI / Anthropic / Gemini-compatible endpoints (`/v1/*`, `/v1beta/*`); we forward to admin-configured upstream providers
(OpenAI, Anthropic, Google, xAI, Groq, DeepSeek, OpenRouter, fal.ai, Replicate, Codex-Everywhere, any OpenAI-compatible URL), each with
any number of upstream keys/accounts and concurrency slots. Every request is metered: customer price, our cost, profit, and the
official list price (for customer-facing savings). Pay-as-you-go billing (Stripe), admin console, customer portal, public site + docs.
Target hosting: Google Cloud Run + Supabase Postgres (+ optional Memorystore Redis). DNS on Cloudflare, mail via Resend SMTP.

Stack: Next.js 16 App Router (TS strict, `src/`), Prisma 7.10 + Postgres 16, Redis 7 (optional, in-memory fallbacks), Tailwind v4 +
shadcn (radix-nova), Recharts, Stripe, vitest. Custom h1+h2c server `server.mjs` in the container.

## 2. Where everything is

| What | Where |
|---|---|
| Repo | `github.com/KevY007/provider-proxy` (private). Collaborator `mehadh` invited (write). |
| Working branch | `feat/initial-build` → **draft PR #1 into `main`**. Never push to `main`; the owner merges. |
| Owner's local checkout | `C:\Users\rehab\Desktop\ProviderProxy` (main folder, on `feat/initial-build`). Owner wants sessions to START here. |
| Previous background-job worktree | `C:\Users\rehab\Desktop\ProviderProxy\.claude\worktrees\proxy-build` (branch `worktree-proxy-build`, same commits). Can be removed once nothing is in flight: `git worktree remove .claude/worktrees/proxy-build`. |
| Architecture contract | `docs/PLAN.md` (authoritative; §5 gateway, §6 pricing, §8 UI, §9b slots/scale/model control, §9c pricing transparency, §9d faithful-proxy fidelity, §10 hosting) |
| Shared helpers / conventions | `docs/FOUNDATION.md` |
| Fidelity evidence | `docs/CONNECTION-FIDELITY.md` |
| Live test results + bug list | `docs/LIVE-WORKLOAD-REPORT.md` |
| **In-flight work, item by item** | `docs/FIXES-PROGRESS.md` (exact state of the current fix batch — resume there) |
| Deploy guide | `deploy/README.md`, `deploy/cloudbuild.yaml`, `Dockerfile`, `server.mjs` |
| Next.js 16 caveat | `AGENTS.md` (read `node_modules/next/dist/docs/` before Next-specific code; `middleware.ts` is `proxy.ts`; async params) |

## 3. Bring-up (fresh machine or cloud session)

```bash
git clone https://github.com/KevY007/provider-proxy.git && cd provider-proxy
git checkout feat/initial-build
docker compose up -d                 # postgres :5433, redis :6380 (after a PC restart: just re-run this)
pnpm install                         # postinstall generates the Prisma client into src/generated/prisma (gitignored)
node scripts/init-env.mjs            # creates .env with fresh secrets (or copy .env.example and fill in)
pnpm db:deploy                       # or pnpm db:migrate in dev; 5 migrations, latest 20261017103545_tools_and_batches
pnpm db:seed                         # admin, demo customer, groups, provider presets, catalog models, Mock Upstream (dev)
pnpm mock:upstream                   # fake OpenAI/Anthropic/Gemini/fal/Replicate on :4010 (tests + dev)
pnpm dev                             # http://localhost:3000
```

Seeded logins: `admin@example.com / admin-password-123`, `demo@example.com / demo-password-123`. Dev-only demo API key:
`sk-pp-devdemo000000000000000000000000000000000` (mock models `mock-gpt`, `mock-claude`, `mock-embed`, `mock-image`).

**Live provider keys are NOT in the repo.** They live only in the owner's gitignored `.env` as `LIVE_OPENAI_API_KEY`,
`LIVE_ANTHROPIC_API_KEY`, `LIVE_FAL_KEY`, `LIVE_REPLICATE_API_TOKEN`. A cloud session must ask the owner for them (or skip live
tests). `pnpm setup:live` reads them, creates/updates the live providers + models (encrypted keys in the DB). Never print, log or
commit these values; the owner should rotate them after testing.

Running several dev servers from one checkout: `NEXT_DIST_DIR=.next-<name> pnpm next dev -p <port>`. `next dev` rewrites
`tsconfig.json` (adds `.next-*` includes) and `AGENTS.md` — `git checkout tsconfig.json` afterwards; AGENTS.md content is committed as-is.

## 4. Owner decisions (do not re-litigate)

1. **Faithful 1:1 proxy** (§9d): client disconnect → abort upstream immediately; upstream failure → mirrored to the client with the
   same status/headers/native error body (identity scrubbed); mid-stream upstream drop → client connection dropped the same way (no
   synthetic `[DONE]`). Only invisible additions: pre-commit failover across our own keys/routes, SSE keep-alive comments. Documented
   deviations in PLAN §9d.7 (our-key 401/402/403 → 503 `no_available_provider`; no-status transport failure → 502/504).
2. **No compression anywhere** (Next `compress:false`, `Accept-Encoding: identity` upstream, strip encoding headers, decode inbound encodings).
3. **Unlimited, streamed request bodies** (`maxRequestBodyMb` 0 = unlimited); Files APIs proxied + pinned to the owning upstream key;
   Cloud Run must run with `--use-http2`.
4. **Pricing vocabulary**: Official price / Your price (customer) / Customer price (admin) / Our cost / Savings / Margin — never "upstream/downstream".
5. **Default customer price on official-vendor routes = match official** (`PERCENT_OF_OFFICIAL` 100); models without an official price
   default to cost + 30%. Admin can override per model (FIXED / % of official / markup over cost).
6. **Savings are snapshots**: `RequestLog.officialPrice` + `price` are written once per request; totals only sum them (price changes never rewrite history).
7. **Funds protection**: credit holds before any upstream call; 402 `insufficient_balance` without contacting upstream; stream cutoff at the
   hold (our one deliberate non-passthrough behaviour).
8. Pause at milestones: get to a compiling checkpoint, stop servers, commit + push, tell the owner it's safe to restart.
9. Budgets for live testing: Anthropic key has ~$200 credit (API / Batch / Agent SDK) — use freely (~$6.6 used); keep **OpenAI ≲ $10 total**
   (~$1.6 used); fal/Replicate ≲ $1.

## 5. Status

| Phase | State |
|---|---|
| 1 Foundation (scaffold, schema, auth, shells, seed, GCP files) | ✅ |
| 2 Gateway, Billing, Admin console, Customer portal + public site | ✅ |
| 3 Live providers (OpenAI/Anthropic/fal/Replicate), video API, UI QA | ✅ |
| 4 Pricing transparency, funds reservations, durable metering, guided admin setup, savings totals, OpenRouter/LiteLLM pricing endpoints | ✅ |
| 4b Faithful connection fidelity, keep-alive, h2c, unlimited bodies, Files APIs, chaos suite | ✅ (`docs/CONNECTION-FIDELITY.md`) |
| 4c Live real-world workload (techpack SVG/PDF, agents, Claude Code CLI) | ✅ run; all bug fixes done (mock-verified) |
| Step A: server-tool editors, tool usage in logs, pricing / default-policy tests | ✅ |
| Batch API (Anthropic + OpenAI, exactly-once metering) | ✅ `src/gateway/batches.ts`, `tests/gateway/batches.test.ts`, `/docs/batches` |
| Step C: live re-verification | ✅ e2e:live 36/36; workload A-G, I-K pass (L content-quality only; H needs a workstation) - see `docs/LIVE-WORKLOAD-REPORT.md` |
| Provider "Test connection" / "Fetch pricing", provider-published prices prefill Our cost | ✅ `src/gateway/remote-pricing.ts` |
| Auto-updated costs (lazy, during calls only), "% of our cost" + +/- adjustment | ✅ `src/server/pricing/auto-sync.ts` |
| Latency from real calls (admin `/admin/latency`, status page, customer Usage + Models) | ✅ `src/server/analytics/latency.ts` |
| Cold by default: activity-driven upkeep/billing, optional timed uptime pings + jobs (Settings > Monitoring), uptime/ping history | ✅ `src/server/maintenance.ts`, `src/server/admin/uptime-queries.ts` (PR #9) |
| Responsive QA (every page at 390 / 820 / 1440 px on the production build) + lean GCP profile and cost table | ✅ `docs/DEPLOYMENT.md` "Profiles and cost" |
| 6 Security audit | ✅ `docs/SECURITY-AUDIT.md` (fixes + `tests/security/audit-regressions.test.ts`; open items listed there) |
| 5 Full docs + `.github` | ✅ README, `docs/*` guides, CI, templates, CODEOWNERS, dependabot, LICENSE, SECURITY/CONTRIBUTING |
| Production deployment (Cloud Run + Supabase schema + Memorystore) with continuous deployment from `main` via a Cloud Build trigger | ✅ `deploy/README.md` steps 3-10, `deploy/supabase-setup.sql`; verified live: smoke suites, 400 concurrent streams across many instances with exact billing, 14-minute streaming generations |
| Admin user management (create with invite + starting credit, edit, delete/anonymise), signup switch | ✅ `src/server/admin/customers-actions.ts` (PR #13) |
| Public visibility switches (pricing, model list, status page), `SEARCH_INDEXING=off`, orange/ink theme + brand mark | ✅ `src/server/customer/visibility.ts`, `src/lib/indexing.ts` (PR #13) |
| Scale-out profile: Redis (shared limits/holds), transaction pooler, up to 100 instances | ✅ `deploy/README.md` steps 4 and 9 (PR #14) |
| 1:1 output limits (explicit `max_tokens` passed through), admin API key reveal (audited), Pricing API docs, full-width logs | ✅ PR #15 |
| Portal-only switch (no public site: login page only for visitors who are not signed in) | ✅ `requirePublicSite` in `src/server/customer/visibility.ts` (PR #17) |
| `/api/pricing` with an API key while pricing is private (the key's own prices) | ✅ `checkApiKey` in `src/gateway/auth.ts` (PR #18) |
| Upstream 403s told apart (bad key / no credit / not allowed for this model or endpoint); Codex Everywhere preset verified live | ✅ `classifyStatus` in `src/gateway/keyhealth.ts` (PR #19) |

Last verified gates (2026-10-21, cloud session): `pnpm typecheck` clean, `pnpm lint` 0 errors, `pnpm test` 805 passed / 1 skipped,
`pnpm build` OK, CI green on `main`; live smoke suites against the production deployment 19/19.

**State:** everything is done, merged into `main` (PR #1 - #15) and running in production: every push to `main`
deploys automatically (build, migrate, roll out, smoke test). Verified live: all API formats, streaming, images,
translations, email delivery, signups, user management, visibility switches, concurrency limits shared across
instances, and billing at official prices to the last digit. Not exercised: live Stripe payments (not configured). Owner follow-ups: rotate the temporary live keys; set up 2FA on the admin account (required
in production); re-run live scenario H (Claude Code CLI) on a workstation; the only open audit item is D2 (`braces` transitive dev dependency, no fixed
version published - see `docs/SECURITY-AUDIT.md`). Step list below is historical.

## 6. Exactly where to resume (historical - all steps done)

### Step A — finish the live-workload fix batch (`docs/FIXES-PROGRESS.md` has file-level detail)
1. Run the gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Fix anything red.
2. Item 4 leftovers (server-tool metering): pure pricing unit tests (tool amounts, multiplier, official fallback, batch discount order);
   admin "Server tools" editors (model: sell + official per tool key + `batchDiscountPct`; route: cost per tool key + `batchCostDiscountPct`;
   import/export + wizard prefill); show `toolUsage` (and later `batchId`) in customer + admin logs and CSV export.
3. Missing test: `tests/pricing/default-policy.test.ts` (`defaultRuleForKnown`, `migrateSeededMarkupRules` skips audited models and models without official price).

### Step B — Batch API (design fully specified in `docs/FIXES-PROGRESS.md` → "Item 7")
Anthropic Message Batches (`/v1/messages/batches` create/list/get/results/cancel/delete) and OpenAI Batch (`/v1/batches` + input file rewrite
+ output file ownership). Per-request model allow-checks (reject whole batch), single provider key per batch, durable credit hold, sticky +
ownership via `UpstreamObject kind "batch"`, masked models, faithful passthrough, metering each result exactly once at batch prices
(deterministic RequestLog ids; triggered by results fetch, cron `sweepBatches()` in `/api/cron/billing` + `/api/cron/health`, and delete).
Mock support + `tests/gateway/batches.test.ts` + docs section.

### Step C — live re-verification (budget: Anthropic ≤ $15, OpenAI ≤ $3)
Dev server `NEXT_DIST_DIR=.next-workload pnpm next dev -p 3011`, then `pnpm tsx scripts/live-workload/run.ts --only C,G,I,K,D` (see the
runner for flags): C code-exec PDF downloaded via our `/v1/files/{id}/content`; G OpenAI SDK → Claude with/without `reasoning_effort`, stream +
tools (if adaptive models 400 in a tools+reasoning loop, apply `hasToolTurnWithoutThinking` to adaptive mode in `chatRequestToMessages`);
I no CANCELLED rows for completed streams; K Anthropic batch end-to-end metered once + an OpenAI batch in the background; D web_search
metered. Also `POST /v1/messages {model:"claude-haiku-4-5-20251001"}` resolves via alias. Add a "Fix verification" section to
`docs/LIVE-WORKLOAD-REPORT.md` (and correct its bug 7a: Sonnet 5.5 cache read is $0.10, the catalog is right).
Then commit + push, sync the owner's main folder, and **pause** (owner rule).

### Step D — Phase 6: full security audit (owner request)
Run parallel reviewers by area, verify each finding, fix with regression tests, re-run all gates; write `docs/SECURITY-AUDIT.md` (finding,
severity, file:line, fix, test). Scope:
- **Secrets & leakage**: upstream keys never reach clients/logs/errors/browser bundles; `secretHint` only; customer key hashing + constant-time
  compare; request/response body logging (`logBodies`) redaction; git history + Docker image + `.next` output scanned; `.env` handling.
- **Gateway**: auth bypass / key enumeration, header injection & request smuggling (h1/h2c, `server.mjs`), SSRF (provider base URLs are admin
  input; image URLs, file ids, container/batch/video ids, `/v1/files` content proxy), cross-tenant access to files/videos/batches/logs,
  DoS (unbounded bodies are by design → check spool/disk/memory bounds, slowloris, queue/slot exhaustion, hold races, JSON bombs, decompression
  bombs on inbound `Content-Encoding`), rate-limit bypass, model masking leaks, error-message leaks.
- **Web app**: authz on every server action/route handler/CSV export (admin vs SUPPORT vs customer, IDOR), the hand-written markdown renderer
  (XSS), CSRF/origin checks on route handlers, open redirects (`?next=`), session fixation/rotation, 2FA bypass, impersonation abuse/audit,
  login/signup/reset brute force + enumeration, email change flow.
- **Billing**: Stripe webhook signature + replay, amount validation (negative/rounding), double credit, redeem-code races, refund/dispute paths,
  auto-recharge abuse, ledger invariants.
- **Infra**: `pnpm audit` / dependency CVEs, security headers (CSP, HSTS, frame-ancestors, referrer-policy), cookie flags, CORS scope
  (`*` only on API + public pricing), Dockerfile (non-root, no secrets in layers), Cloud Run service account least privilege, Secret Manager.
Commit + push + pause.

### Step E — Phase 5: full documentation + repo hygiene, final push
- Rewrite `README.md` (product overview, architecture diagram, quickstart, scripts, env vars incl. LIVE_* names, testing, deploy pointer).
- `docs/` guides: architecture, local development, deployment (GCP, from `deploy/README.md`), admin guide (providers/keys/slots, models &
  routes & pricing rules, pools/groups, customers/credits, logs/analytics, settings), customer/API guide (endpoints per format, auth, errors,
  rate limits/concurrency, files, batches, video, savings), pricing & billing concepts, operations runbook (cron jobs, dead-letter replay,
  key rotation, incident checklist), security (link SECURITY-AUDIT.md). Keep PLAN.md as the contract; mark FIXES-PROGRESS/HANDOFF as historical.
- `CONTRIBUTING.md`, `SECURITY.md` (private reporting), `CHANGELOG.md`, `LICENSE` (proprietary, all rights reserved).
- `.github/`: CI workflow (pnpm install, prisma generate, typecheck, lint, test with postgres+redis service containers, build), PR template,
  issue templates, CODEOWNERS (KevY007, mehadh), dependabot.
- Fix the two dead package scripts: `e2e` → point to `scripts/e2e-live.ts` or create `scripts/e2e.ts` (mock-based end-to-end); `loadtest` →
  `GW_LOAD=1 vitest run tests/gateway/load.test.ts`.
- Update PR #1 description (summary of everything, how to test, decisions), mark it ready for review. Owner merges.
- Final cleanup: remove the old worktree; remind the owner to rotate the live keys.

## 7. Verification gates (every step)
`pnpm typecheck` · `pnpm lint` (0 errors) · `pnpm test` · `pnpm build` · secret scan before every commit:
`git grep --cached -n -e "sk-svcacct-" -e "sk-ant-api03-" -e "r8_" ` (expect no real keys; the dev demo key in docs is fine).
Heavier, opt-in: `GW_LOAD=1 pnpm vitest run tests/gateway/load.test.ts` (1000 streams), `pnpm chaos` (see `scripts/chaos.ts` flags,
container runs with `--docker <image>`), `pnpm e2e:live` / live-workload runner (needs LIVE_* keys, costs money).

## 8. Gotchas
- Windows + Git Bash sandbox: very long/compound shell commands (heredocs mixed with other commands, `cd` + git) may be refused as "too
  complex" — use the Edit/Write tools for code and one command per call.
- A worktree-isolated Claude session cannot run git against the main folder; to sync the owner's checkout: exit the worktree, `git pull
  --ff-only origin feat/initial-build`, `pnpm install`, `pnpm prisma migrate status`.
- `tests/gateway/cache-redis.test.ts` and other Redis tests share one Redis; parallel runs are isolated by per-run namespaces/tags — keep that pattern.
- Restart the mock (`pnpm mock:upstream`) after pulling — old mock builds lack newer markers (`[[codeexec]]`, `[[runaway]]`, `x-mock-linger-ms`…).
- Sora (`sora-2`) is shut down upstream (2026-09-24); the video API is mock-verified only. `gpt-4.1-nano` / `gpt-image-1-mini` have shutdown dates.
- Cloud Run: 60-min max request; SIGTERM grace 10 s (drain is implemented in `server.mjs`); HTTP/1 bodies capped at 32 MB unless `--use-http2`.
- Upstream HTTP/2 is opt-in per provider (`provider.settings.http2`), untested against real h2 upstreams.
