# Admin guide

The admin console is at `/admin`. It needs a user with role **ADMIN** or **SUPPORT**. SUPPORT can view everything
and do customer support tasks (suspend or activate, verify email, revoke sessions, send a password reset,
impersonate, disable API keys, test keys, run health checks). Configuration and money actions are **ADMIN only**:
providers, keys, models, routes, groups, settings, balances and credits. Every mutation is written to the audit log,
and every change takes effect in the gateway within seconds (cache invalidation).

Vocabulary used throughout (never "upstream/downstream"):

| Term | Meaning |
|---|---|
| **Official price** | The original vendor's public list price. Used for reference and savings. |
| **Customer price** | What we charge, before the pool and customer multipliers |
| **Our cost** | What we pay our supplier for a route |
| **Savings** | Official price - customer price (what the customer sees) |
| **Margin** | Customer price - our cost (admin only, red when <= 0) |

The **Quick start** checklist on the admin overview walks through the first setup: add a provider key, test it,
enable models, set pricing, invite customers.

## Providers, keys and slots (`/admin/providers`)

A **provider** is an upstream API endpoint. Create one from a preset: OpenAI, Anthropic, Google, Azure, xAI, Groq,
DeepSeek, Mistral, Together, Fireworks, OpenRouter, the relay, fal.ai, Replicate or Custom
(OpenAI-compatible).

| Field | Notes |
|---|---|
| Base URL | OpenAI-compatible providers include `/v1`. Anthropic and Google use the origin. |
| Auth style | Bearer, `x-api-key`, `x-goog-api-key`, Azure `api-key`, or `?key=` |
| Native endpoint formats | Which inbound formats the provider speaks natively (`openai_chat`, `openai_responses`, `anthropic_messages`, `gemini`, `openai_files`, `anthropic_batches`, ...). A route is used only when the provider speaks the request's format, or when a translator exists (chat <-> Messages). **Apply preset formats** resets the list to the preset's (use it after upgrades that add new formats, e.g. Files or Batches). |
| Tags | Pools can restrict themselves to providers with given tags |
| Priority | Tie-breaker between routes of equal route priority |
| Timeout | Headers timeout per attempt, from the end of the upload. Default 600000 ms. |
| Max concurrency | Slots across all of the provider's keys (blank = no provider cap) |
| Extra headers (JSON) | Sent on every upstream request. Credential-like values (`authorization`, `*key*`, `*token*`, `*secret*`, ...) are stored encrypted and shown as `[encrypted]`; leave that value as it is to keep it |
| Settings (JSON) | `anthropicVersion`, `anthropicBaseUrl`, `geminiBaseUrl`, `openaiBaseUrl`, `azureApiVersion`, `stripFields: [...]`, `forceStreamUsage` (default true), `http2: true` (opt-in upstream HTTP/2, https only), `idleTimeoutSec` (cut a silent stream), `noCooldown: true` (transient 5xx / network / timeout failures never put this provider's keys on cooldown: for a single-key reseller a cooldown only turns flaky answers into "no provider available" for everyone; 429 / 402 / bad keys still apply), `streamUpstream: true` (non-streaming chat / responses / messages requests are sent upstream as streams and the reply is assembled back into the normal JSON: keeps long generations alive through relays behind a proxy read timeout, e.g. Cloudflare's 120 s, and any failure before the end is retried invisibly), `pricingUrl` (where the provider publishes its prices, see below), fal: `falMode` `sync`/`queue`/`auto`, `queueBaseUrl`, `falSyncTimeoutMs`; Replicate: `replicateWait` (seconds, opt in to `Prefer: wait`) |

**Test connection / Fetch pricing.** The provider form (new or saved) has two buttons that use the values currently in
the form, so a provider can be checked before you save it. Type an API key just for the test (never stored), or leave
it empty on a saved provider to use its first active key.

- **Test connection** lists the models the key can see (count, latency, a sample) or says why it failed (rejected key,
  no model list, unreachable).
- **Fetch pricing** reads the prices the provider publishes through its own API, if it does: OpenRouter-style `pricing`
  on `/models` or `/api/v1/models`, LiteLLM `/model/info`, Together / DeepInfra-style `pricing` fields, another
  ProviderProxy (`x_pricing` on `/v1/models`, `/api/pricing`; it also carries the official price), or any JSON price list at
  the provider's `settings.pricingUrl`. Prices are normalised to USD per 1M tokens / per image. Official vendor APIs
  (OpenAI, Anthropic, Google) publish none; for them the built-in catalog is used.

Found prices are a **starting point**: when you add a model or a route from this provider, the wizard prefills Our
cost (and the official price, when the source publishes one) from them and says where they came from. The model picker
marks such models with **provider price**. Nothing is saved until you confirm.

**Keys / accounts.** Each upstream credential is a key. You can add one at a time, or use **Bulk add keys** with one
per line as `secret` or `label|secret` (blank lines and `#` comments are skipped, duplicates are skipped, up to 500).
Secrets are encrypted with `ENCRYPTION_KEY`. Only the last 4 characters are ever shown.

| Key field | Effect |
|---|---|
| Weight / Priority | Higher priority is tried first. Within a priority, traffic is weighted random. |
| Max concurrency | Slots for this key (blank = `defaultKeyConcurrency`, 50) |
| RPM / TPM limit | Per-key limits. The key is skipped when it is over them. |
| Daily budget | Stop using the key after this much cost per day |
| Extra (JSON) | Org id, project id, Azure deployment map, ... |
| Status | ACTIVE, DISABLED, COOLDOWN (automatic, until `cooldownUntil`), INVALID (automatic after 2 consecutive 401s, or 403s whose message says the key itself is bad; a 403 about balance / quota is a 10-minute COOLDOWN, and any other 403 (a model or endpoint this key may not use, e.g. a reseller group without Claude) fails over without touching the key's status), EXHAUSTED |

Automatic key health: a 429 puts the key in cooldown until `retry-after` (or `keyCooldownSeconds`, 60). A 402 means
the account is out of credit and gives a 10 min cooldown. 5xx and timeouts count toward `failuresBeforeCooldown` (3).
A successful request or health probe resets the counters and revives INVALID keys. Actions available: **Test** (one
key), test all, enable/disable selected, **Reset** (clear failures and cooldown), rotate secret, delete.

**Live slots.** The provider page shows "in use / max" per key and per provider (auto-refresh, `GET
/api/admin/slots`). When every slot of every eligible route is busy, requests queue for up to `queueTimeoutMs` and
then get 429 `no_capacity`.

**Health and uptime.** `/admin/status` shows the **background mode** (activity-driven or timers) with the last run
of each job, then **Uptime history** per provider: one bar per 30 min / 3 h / 12 h for 24 h / 7 d / 30 d, green
(99%+ of calls and pings succeeded), amber (90-99%), red (below 90%), grey (no calls and no pings: never shown as
"up"), with the uptime %, approximate downtime and last ping. **Ping and latency history** charts, per provider,
the uptime-ping round trip next to the median latency of real calls. Below: provider health (OPERATIONAL / DEGRADED
/ DOWN from real traffic, plus pings when they run), key health with the last real call and p50, and recent failed
checks. **Run checks now** pings every key once. With **Uptime monitoring** on (Settings > Monitoring) the pings
run every 5 minutes (adjustable) even when nobody calls. The public `/status` page shows 90-day availability per
model family from real traffic, without provider names or secrets.

## Models and routes (`/admin/models`)

A **model** is what customers put in `model`. A **route** maps it to a provider and an upstream model, with our
cost.

**Add model** wizard:
1. Pick the provider.
2. Pick the real model from the provider's live `/models` list, or type it.
3. Prices are prefilled from the built-in price catalog (official price and cost).
4. Pick the pricing rule, with a live preview of customer price, savings and margin.

Model fields: public slug (renaming updates pool and API-key allow-lists), aliases, display name, vendor,
capabilities (`chat`, `responses`, `completions`, `embeddings`, `images`, `audio_speech`, `audio_transcription`,
`moderation`, `video`, `vision`, `tools`, `reasoning`), context window, max output, status (ACTIVE; HIDDEN = callable
by name but not listed; DISABLED = rejected), sort order, **Mask upstream model** (on by default: responses and
stream chunks show the public slug).

**Pricing** (per model, see [PRICING-AND-BILLING.md](PRICING-AND-BILLING.md)):

| Rule | Customer price |
|---|---|
| Fixed | You type every price |
| % of official | official x value / 100. **Default for models with an official price: 100 = match official.** |
| Markup over cost | primary route cost x (1 + value / 100). The primary route is the highest-priority enabled route. Default +30% for models without an official price. |
| % of our cost | primary route cost x value / 100 (50 = half of what we pay) |

Every derived rule also takes an **Adjustment** (+/- USD per unit, applied after the %, never below 0): e.g. "match
the provider's price minus $0.05".

With a derived rule, customer prices are recomputed whenever official prices, the rule, or the primary route's cost,
priority or enabled flag change. Units without a basis keep their typed value. Price units: input, output, cached
input, cache write (5 min) and cache write (1 h), per image, per request, audio in/out, per minute, per 1M chars,
per second (video), long-context threshold + multiplier (+ an optional separate output multiplier: OpenAI bills input 2x and output 1.5x above 272K), **Server tools** (customer and official price per tool
key, e.g. `web_search_request`, `web_fetch_request`, `code_execution_request`, `code_execution_hour`,
`web_search_call`, `file_search_call`), and **Batch API discount** (% off token prices of batch results; blank = 50).
The list shows margin and savings badges, loss warnings and "retiring <date>" badges. Use **Apply pricing rule** on
selected models for bulk changes.

**Routes** panel, per model:

| Route field | Effect |
|---|---|
| Provider + upstream model | Where requests go |
| Enabled | Disabled routes are never selected |
| Priority / Weight | Higher priority first. Weight splits traffic between routes of the same priority. |
| Restrict to pools (groups) | Route used only for these pools (empty = every pool) |
| Param overrides (JSON) | Deep-merged into the upstream body, e.g. `{"reasoning_effort":"low"}`. `null` deletes a field. |
| Max output tokens (clamp) | Caps the output limit sent upstream |
| Costs | Same units as the prices, plus server-tool costs and **Batch API cost discount** (default 50) |
| Auto-update cost from the provider | The costs follow the provider's published prices. Refreshed only during real calls on the route (every `autoPriceSyncHours` hours or `autoPriceSyncCalls` calls, whichever first; no timers), or with **Sync now**. Optional "provider's model id" when its price list names the model differently. Shows the last sync time and status. |

The "What customers see vs what runs" card shows the mapping and the margin per route. Other actions: duplicate
model (creates a HIDDEN copy with its routes), duplicate route, **Import** / **Export** JSON (models with routes by
provider slug, with a dry run that validates and shows changes without writing).

Example: a public `smart-fast` model with a Claude Haiku route (priority 10) and a GPT nano route (priority 5) fails
over from Anthropic to OpenAI. `pnpm setup:live` creates exactly this demo.

## Pools (groups) and multipliers (`/admin/groups`)

A group is a pricing tier and routing pool. The seed creates `standard` 1.0x (default), `pro` 0.8x and
`enterprise` 0.6x (not public).

| Field | Effect |
|---|---|
| Price multiplier | Applied to the customer price (0.8 = 20% off, 1.2 = 20% markup) |
| Provider tags | If set, only routes whose provider has one of these tags |
| Allowed models | Empty = every public model |
| Default | Pool for new customers and for keys/users without a pool (exactly one) |
| Public | Customers may pick it for their API keys |
| RPM limit | Requests per minute per customer in this pool |
| Max concurrency | Concurrent request slots for the pool |

The effective pool of a request is the key's group, else the customer's group, else the default. The effective
multiplier is the customer multiplier x the group multiplier. When you delete a group you can move its members to
the default group.

Customers choose a pool per API key when they create or edit it (the key and its secret stay the same; only the
pool changes). They can pick public pools, their own pool and the private pools an admin allowed for their account
under **Extra pools for API keys** on the customer page; any other private pool is refused, and an edit can always
keep the pool the key is already in.

## Customers and credits (`/admin/customers`)

The list has search, balance, spend and CSV export. **Create user** (admins) adds an account that is active and
verified right away, with a role, a group and optional starting credit (recorded as promotional credit); the invite
email links to a page where the user picks their own password (valid 7 days, afterwards **Send password reset**).
New self-service sign-ups are switched on and off under Settings > Access > **Signups enabled** (the ADMIN_EMAIL
account can always sign up). The detail page shows:
- **Profile & controls**: status (suspend / activate), role, verify email, group (pool), price multiplier (stacks on
  the group's), billing mode (PREPAID / POSTPAID), credit limit (how far below $0 the balance may go), monthly spend
  limit, max concurrency (across all their keys), and **Extra pools for API keys** (private pools this customer may
  put their keys in, besides their own pool).
- **Balance**: **Add credit** with type **Promotional credit** (ledger ADJUSTMENT), **Refund** (REFUND) or
  **Correction** (ADJUSTMENT, may be negative), plus a required reason. **Grant credit** applies to many customers
  selected in the list. **Adjust balance** is also available.
- Keys, usage, logs and Stripe payments.
- **Edit** (name and email; an email set by an admin counts as verified) and **Delete** (type the email to
  confirm). An account without payments or ledger entries is removed; one with billing history is anonymised and
  locked instead so the books stay complete: email replaced, name cleared, password and 2FA wiped, suspended, API
  keys revoked. You cannot delete yourself or the last active admin.
- **Revoke sessions**, **Send password reset**, **Impersonate**. Impersonation works on ACTIVE customers only and is
  audited. The session ends after 1 hour (it never rolls) or as soon as the staff member is no longer active staff.

`/admin/keys` lists every customer API key (enable / disable / revoke). Admins can **Reveal** a key in full: keys are stored as a sha256 fingerprint for authentication plus an AES-256-GCM copy (encrypted with `ENCRYPTION_KEY`) for this view, and every reveal is written to the audit log. Keys created before this feature only have the fingerprint and cannot be revealed; playground keys rotate on every use and are never stored.

## Logs and analytics

- **`/admin/logs`**: every request, with filters (customer, model, provider, key, status, ...) and CSV export of the
  filtered view. The detail sheet shows "what the customer saw vs what ran" (public model vs provider and upstream
  model), tokens (input, output, cached, cache write, reasoning), images, audio, video seconds, server tools, batch
  id, customer price, our cost, margin, official price and savings, latency / TTFT / queue wait, every upstream
  attempt, the admin-only internal error, and request/response bodies when `logBodies` is on.
- **`/admin/analytics`**: revenue, cost and profit by model, provider, customer and group. Error breakdown by code,
  latency percentiles, token volume, range picker and CSV export.
- **`/admin/latency`**: p50 / p95 total latency, time to first token and queue wait per provider, provider key and
  model, the latest call per row ("last ping") and a latency history chart, with range / granularity / model /
  provider filters. Every number comes from real customer calls (`RequestLog`); the proxy never pings upstreams on a
  timer, so a provider nobody calls has no recent numbers. `/admin/status` shows the same per provider and key (last
  real call, p50 and first token over 24 h). Customers see their own latency (p50 / p95 / first token, history, per
  model) under **Usage**, and per-model speed over the last 24 h (platform-wide, no provider names) under
  **Models & Pricing**.
- **`/admin/billing`**: payments, ledger and redeem codes (generate, disable, delete).
- **`/admin/audit`**: who changed what, when and from where.

## Settings (`/admin/settings`)

| Group | Setting (default) |
|---|---|
| Access | `signupEnabled` (true), `requireEmailVerification` (true), `requireStaffTwoFactor` (true in production), `defaultGroupSlug` ("standard"). What visitors who are not signed in may see: `publicPricing` (true; off hides the home-page price table and savings, `/pricing` and `/api/pricing`), `publicModels` (true; off also hides model names, counts and vendors on the home page and status page, real model ids in the docs, and public pricing), `publicStatus` (true; off sends `/status` to sign-in). `portalOnly` (false) turns the whole public site off for an internal deployment: visitors who are not signed in get only the login page (and signup, if signups are on), `/`, `/docs`, `/pricing`, `/status` and `/api/pricing` require signing in whatever the three switches say, `/` sends signed-in staff to `/admin` and customers to `/dashboard`, and `robots.txt` disallows everything. Signed-in users always see everything, and `/api/pricing` always answers a request carrying a valid customer API key (its own prices), so price fetchers keep working while pricing is private; private pricing is sent with `cache-control: private, no-store`. |
| Billing | `trialCredit` ($0), `requireCardForTrial` (false), `minTopup` ($5), `maxTopup` ($1000), `minBalanceToCall` ($0; reject when balance + credit limit <= this), `lowBalanceEmail` (true), `autoRechargeMaxPerDay` (3) |
| Gateway | `logBodies` (false; privacy and storage impact), `maxAttempts` (3), `keyCooldownSeconds` (60), `failuresBeforeCooldown` (3), `queueTimeoutMs` (20000), `defaultKeyConcurrency` (50), `defaultCustomerConcurrency` (20), `passUpstreamRateLimits` (true), `streamHeartbeatSec` (15, 0 = off), `maxRequestBodyMb` (0 = unlimited), `upstreamIdleTimeoutSec` (0 = never), `autoPriceSyncHours` (6), `autoPriceSyncCalls` (100) |
| Monitoring and background work | All off by default, so an idle server does nothing. `activeHealthChecks` (false; **Uptime monitoring**: ping every upstream key with a free model-list request every `healthCheckIntervalMin` (5) minutes and record uptime + ping history even when nobody calls), `backgroundJobs` (false; run upkeep every `maintenanceIntervalMin` (5) minutes and billing hourly on a timer instead of only during activity). Timers need a running instance; see [OPERATIONS.md](OPERATIONS.md#background-jobs-cold-by-default). |
| General | `siteName`, `supportEmail` |

**Announcements** (on the settings page) appear in the portal's announcements bell and on the customer overview.
Each has a level (info, success, warning, ...) and can be toggled active.
