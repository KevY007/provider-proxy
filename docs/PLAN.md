# ProviderProxy — Build Plan & Architecture Contract

A metered, multi-provider AI gateway. Customers get **our** API keys and call **our** endpoints in
OpenAI / Anthropic / Gemini format. We forward to **upstream providers** that the admin configures at
runtime (OpenAI, Anthropic, Google, xAI, Groq, DeepSeek, OpenRouter, the relay, any
OpenAI-compatible URL…), each with any number of **upstream keys/accounts**. Every request is metered:
we charge the customer our **sell price** and record our **cost price** → profit per request.

Reference product studied: codex-everywhere.com (pools = "groups" with price multipliers, per-key group,
channel status page, usage analytics by model/group/endpoint, image studio, Stripe/crypto top-ups,
redeem codes, OpenAI `/v1/*` + Anthropic `/v1/messages` + Gemini `/v1beta` on one base URL).

---------------------------------------------------------------------------------------------------

## 1. Stack (fixed — do not change)

| Concern | Choice |
|---|---|
| App | **Next.js 16 App Router**, TypeScript strict, `src/` dir, pnpm |
| UI | Tailwind CSS v4 + **shadcn/ui** (new-york, neutral base, dark mode via `next-themes`), `lucide-react`, **Recharts** for charts, `sonner` toasts, `@tanstack/react-table` for tables |
| DB | **PostgreSQL 16** via **Prisma** (use the version installed; follow its docs in `node_modules` — Prisma 7 uses `prisma.config.ts`, the `prisma-client` generator with an explicit `output`, and the `@prisma/adapter-pg` driver adapter) |
| Cache / rate limit | **Redis 7** via `ioredis`; every Redis use MUST have an in-memory fallback when `REDIS_URL` is unset |
| Payments | **Stripe** (`stripe` server SDK, `@stripe/stripe-js` + `@stripe/react-stripe-js` Payment Element) |
| Email | `nodemailer` SMTP; when `SMTP_URL` unset, log emails to console + store in `EmailOutbox` table (dev) |
| Auth | Custom: `@node-rs/argon2` (or `bcryptjs` fallback) password hashes, DB sessions (httpOnly cookie, sha256-hashed token in DB), email verification, password reset, TOTP 2FA via `otpauth` (+ `qrcode`) |
| Validation | `zod` v4 everywhere (forms, server actions, admin APIs) |
| Tokenizer fallback | `js-tiktoken` (o200k_base) for usage estimation when upstream returns no usage |
| Tests | `vitest` |
| Local infra | `docker-compose.yml` with postgres + redis |

Next.js 16 notes: `middleware.ts` is renamed **`proxy.ts`** (export `proxy`), `params`/`searchParams`/`cookies()`/`headers()` are async. Read `node_modules/next/dist/docs/` when unsure. Gateway route handlers must use `export const runtime = 'nodejs'`, `export const dynamic = 'force-dynamic'`, `export const maxDuration = 800`.

## 2. Repository layout & ownership

```
prisma/schema.prisma            (Foundation)   prisma/seed.ts (Foundation; others may append seed data via their own files)
src/lib/                        (Foundation)   db.ts, crypto.ts (AES-256-GCM for upstream secrets, sha256, random tokens),
                                               money.ts (Decimal helpers), auth/*, email.ts, settings.ts, audit.ts,
                                               redis.ts, ratelimit.ts, env.ts (zod-validated env), utils.ts
src/components/ui/              (Foundation)   shadcn components
src/components/shell/           (Foundation)   AppShell (sidebar+topbar), nav configs for /dashboard and /admin, theme toggle
src/app/(auth)/                 (Foundation)   login, signup, verify-email, forgot-password, reset-password, 2fa
src/proxy.ts                    (Foundation)   route guards (/dashboard needs session, /admin needs ADMIN/SUPPORT role)

src/gateway/                    (Gateway)      the proxy engine (framework-agnostic: handle(Request) => Response)
src/app/v1/[...path]/route.ts   (Gateway)      OpenAI + Anthropic surface
src/app/v1beta/[...path]/route.ts (Gateway)    Gemini surface
scripts/mock-upstream.ts        (Gateway)      fake OpenAI/Anthropic/Gemini server for tests & local dev
tests/gateway/                  (Gateway)

src/server/billing/             (Billing)      stripe.ts, ledger.ts, topup.ts, auto-recharge.ts, redeem.ts, invoices
src/app/api/stripe/webhook/     (Billing)
src/app/api/cron/               (Billing)      billing cron (auto-recharge sweep, postpaid settlement)
src/app/dashboard/billing/      (Billing)      customer billing UI
src/app/admin/billing/          (Billing)      admin payments/ledger/redeem codes UI

src/server/admin/               (Admin)        server actions + queries for admin
src/server/analytics/           (Admin)        shared aggregate SQL (scoped by optional userId) — customer portal may import
src/app/admin/** (except billing) (Admin)

src/server/customer/            (Portal)       server actions + queries for customer
src/app/dashboard/** (except billing) (Portal)
src/app/(marketing)/            (Portal)       landing, /pricing, /docs/*, /status
```

**Rule:** an agent only creates/edits files in the areas it owns. Shared files (package.json, schema,
lib/, shell nav) belong to Foundation; if another agent truly needs a change there it must be minimal,
additive, and mentioned in its report. All deps are installed by Foundation up front.

## 3. Environment (`.env.example`)

```
DATABASE_URL=postgresql://proxy:proxy@localhost:5433/proxy
REDIS_URL=redis://localhost:6380            # optional
APP_URL=http://localhost:3000
SESSION_SECRET=                              # 32+ chars
ENCRYPTION_KEY=                              # 32 bytes base64 — encrypts upstream provider secrets
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me-now-please
STRIPE_SECRET_KEY=                           # optional in dev; billing UI shows "Stripe not configured"
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
SMTP_URL=                                    # optional; console/outbox fallback
EMAIL_FROM="ProviderProxy <no-reply@example.com>"
CRON_SECRET=
MOCK_UPSTREAM_URL=http://localhost:4010      # dev seed creates a "Mock Upstream" provider pointing here
```

## 4. Data model (authoritative — Foundation writes exactly this, may add indexes/fields but not rename)

Money is `Decimal @db.Decimal(24, 12)` in **USD**. Prices are **USD per 1M tokens** unless stated.

```prisma
enum Role { CUSTOMER SUPPORT ADMIN }
enum UserStatus { PENDING_VERIFICATION ACTIVE SUSPENDED }
enum BillingMode { PREPAID POSTPAID }
enum TokenType { EMAIL_VERIFY PASSWORD_RESET EMAIL_CHANGE }
enum KeyStatus { ACTIVE DISABLED REVOKED }
enum ProviderStatus { ACTIVE DISABLED }
enum ProviderKeyStatus { ACTIVE DISABLED COOLDOWN INVALID EXHAUSTED }
enum AuthStyle { BEARER X_API_KEY X_GOOG_API_KEY AZURE_API_KEY QUERY_KEY }
enum HealthStatus { UNKNOWN OPERATIONAL DEGRADED DOWN }
enum ModelStatus { ACTIVE HIDDEN DISABLED }
enum RequestStatus { SUCCESS CLIENT_ERROR UPSTREAM_ERROR GATEWAY_ERROR CANCELLED }
enum LedgerType { TOPUP AUTO_RECHARGE TRIAL_CREDIT REDEEM ADJUSTMENT REFUND CHARGEBACK POSTPAID_SETTLEMENT USAGE_CORRECTION }
enum PaymentStatus { PENDING SUCCEEDED FAILED REFUNDED DISPUTED CANCELED }

model User {
  id                 String      @id @default(cuid())
  email              String      @unique
  name               String?
  passwordHash       String
  role               Role        @default(CUSTOMER)
  status             UserStatus  @default(PENDING_VERIFICATION)
  emailVerifiedAt    DateTime?
  totpSecret         String?     // encrypted
  totpEnabled        Boolean     @default(false)
  groupId            String?
  group              Group?      @relation(fields: [groupId], references: [id])
  priceMultiplier    Decimal?    @db.Decimal(10, 4)   // per-customer override on top of group
  balance            Decimal     @default(0) @db.Decimal(24, 12)
  creditLimit        Decimal     @default(0) @db.Decimal(24, 12)  // how far below 0 they may go (postpaid)
  billingMode        BillingMode @default(PREPAID)
  monthlySpendLimit  Decimal?    @db.Decimal(24, 12)
  stripeCustomerId   String?     @unique
  defaultPaymentMethodId String?
  autoRechargeEnabled   Boolean  @default(false)
  autoRechargeThreshold Decimal  @default(5) @db.Decimal(24, 12)
  autoRechargeAmount    Decimal  @default(20) @db.Decimal(24, 12)
  lowBalanceAlertAt     Decimal? @db.Decimal(24, 12)
  trialGrantedAt     DateTime?
  signupIp           String?
  lastLoginAt        DateTime?
  createdAt          DateTime    @default(now())
  updatedAt          DateTime    @updatedAt
  sessions  Session[]  tokens VerificationToken[]  apiKeys ApiKey[]  requests RequestLog[]
  ledger    LedgerEntry[] @relation("LedgerUser")  payments Payment[]  redeemUses RedeemCodeUse[]
}

model Session { id String @id  /* sha256 of cookie token */  userId String  user User @relation(fields:[userId], references:[id], onDelete: Cascade)
  expiresAt DateTime  ip String?  userAgent String?  twoFactorPassed Boolean @default(false)  impersonatorId String?  createdAt DateTime @default(now())  @@index([userId]) }

model VerificationToken { id String @id @default(cuid())  userId String  user User @relation(fields:[userId], references:[id], onDelete: Cascade)
  type TokenType  tokenHash String @unique  newEmail String?  expiresAt DateTime  usedAt DateTime?  createdAt DateTime @default(now()) }

model ApiKey {
  id           String    @id @default(cuid())
  userId       String
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  name         String
  prefix       String    // first 12 chars shown in UI, e.g. "sk-pp-AbCd12"
  keyHash      String    @unique   // sha256(fullKey)
  status       KeyStatus @default(ACTIVE)
  groupId      String?   // key-level group (pool) override; falls back to user.group then default group
  group        Group?    @relation(fields: [groupId], references: [id])
  allowedModels String[] @default([])   // empty = all models the group allows
  ipAllowlist  String[]  @default([])   // CIDR or exact IPs, empty = any
  rpmLimit     Int?
  tpmLimit     Int?
  spendLimit   Decimal?  @db.Decimal(24, 12)  // lifetime cap for this key
  spent        Decimal   @default(0) @db.Decimal(24, 12)
  expiresAt    DateTime?
  lastUsedAt   DateTime?
  isPlayground Boolean   @default(false)       // auto-created hidden key used by the dashboard playground
  createdAt    DateTime  @default(now())
  requests     RequestLog[]
  @@index([userId])
}

model Group {                       // = "pool" / pricing tier
  id              String   @id @default(cuid())
  name            String
  slug            String   @unique
  description     String?
  priceMultiplier Decimal  @default(1) @db.Decimal(10, 4)   // applied to model sell prices
  providerTags    String[] @default([])   // if non-empty, only routes whose provider has ANY of these tags are used
  allowedModels   String[] @default([])   // model slugs; empty = all public models
  isDefault       Boolean  @default(false)
  isPublic        Boolean  @default(true)  // customers may pick it for their keys
  rpmLimit        Int?
  sortOrder       Int      @default(0)
  users User[]  apiKeys ApiKey[]
}

model Provider {
  id            String         @id @default(cuid())
  name          String
  slug          String         @unique
  preset        String         // "openai" | "anthropic" | "google" | "xai" | "groq" | "deepseek" | "openrouter" | "mistral" | "together" | "fireworks" | "azure" | "codex-everywhere" | "custom"
  baseUrl       String         // e.g. https://api.openai.com/v1 , https://api.anthropic.com , https://generativelanguage.googleapis.com
  authStyle     AuthStyle      @default(BEARER)
  formats       String[]       // natively accepted EndpointFormat values (see §5)
  tags          String[]       @default([])
  extraHeaders  Json           @default("{}")
  settings      Json           @default("{}")   // { anthropicVersion, azureApiVersion, stripFields:[], forceStreamUsage:true, ... }
  status        ProviderStatus @default(ACTIVE)
  timeoutMs     Int            @default(600000)
  priority      Int            @default(0)
  healthStatus  HealthStatus   @default(UNKNOWN)
  lastCheckAt   DateTime?
  lastLatencyMs Int?
  notes         String?
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt
  keys ProviderKey[]  routes ModelRoute[]  requests RequestLog[]  checks HealthCheck[]
}

model ProviderKey {                 // an upstream credential / account
  id                  String            @id @default(cuid())
  providerId          String
  provider            Provider          @relation(fields: [providerId], references: [id], onDelete: Cascade)
  label               String
  secretEncrypted     String            // AES-256-GCM via lib/crypto
  secretHint          String            // last 4 chars for display
  status              ProviderKeyStatus @default(ACTIVE)
  weight              Int               @default(1)
  priority            Int               @default(0)   // higher = tried first
  rpmLimit            Int?
  tpmLimit            Int?
  dailyBudget         Decimal?          @db.Decimal(24, 12)   // stop using after this cost/day
  cooldownUntil       DateTime?
  consecutiveFailures Int               @default(0)
  lastError           String?
  lastUsedAt          DateTime?
  totalRequests       Int               @default(0)
  totalCost           Decimal           @default(0) @db.Decimal(24, 12)
  extra               Json              @default("{}")  // org id, project id, azure deployment map, ...
  createdAt           DateTime          @default(now())
  requests RequestLog[]  checks HealthCheck[]
  @@index([providerId, status])
}

model Model {                       // public catalog entry (what customers put in "model")
  id            String      @id @default(cuid())
  slug          String      @unique     // "gpt-6-astra", "claude-opus-5-5", "gemini-3.1-pro", "gpt-image-2"
  aliases       String[]    @default([])
  displayName   String
  vendor        String      // "openai" | "anthropic" | "google" | "xai" | ...
  description   String?
  capabilities  String[]    // "chat","responses","completions","embeddings","images","audio_speech","audio_transcription","moderation","vision","tools","reasoning"
  contextWindow Int?
  maxOutput     Int?
  status        ModelStatus @default(ACTIVE)
  sortOrder     Int         @default(0)
  // SELL prices (what customers pay, before group/user multipliers). USD per 1M units unless noted.
  inputPrice        Decimal @default(0) @db.Decimal(24, 12)
  outputPrice       Decimal @default(0) @db.Decimal(24, 12)
  cachedInputPrice  Decimal? @db.Decimal(24, 12)    // null => inputPrice
  cacheWritePrice   Decimal? @db.Decimal(24, 12)    // null => inputPrice (5m)
  cacheWrite1hPrice Decimal? @db.Decimal(24, 12)
  imagePrice        Decimal? @db.Decimal(24, 12)    // USD per generated image (flat); if null bill image tokens
  requestPrice      Decimal? @db.Decimal(24, 12)    // USD flat per request (added)
  audioInputPrice   Decimal? @db.Decimal(24, 12)    // per 1M audio tokens
  audioOutputPrice  Decimal? @db.Decimal(24, 12)
  perMinutePrice    Decimal? @db.Decimal(24, 12)    // transcription USD/minute
  perMillionChars   Decimal? @db.Decimal(24, 12)    // TTS USD per 1M input chars
  longContextThreshold  Int?                        // input tokens above which multiplier applies
  longContextMultiplier Decimal? @db.Decimal(10, 4)
  // reference official price (marketing/"savings" display only)
  officialInputPrice  Decimal? @db.Decimal(24, 12)
  officialOutputPrice Decimal? @db.Decimal(24, 12)
  officialCachedPrice Decimal? @db.Decimal(24, 12)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  routes ModelRoute[]
}

model ModelRoute {                  // how a public model maps to an upstream provider + our COST
  id            String   @id @default(cuid())
  modelId       String
  model         Model    @relation(fields: [modelId], references: [id], onDelete: Cascade)
  providerId    String
  provider      Provider @relation(fields: [providerId], references: [id], onDelete: Cascade)
  upstreamModel String   // model id sent upstream
  enabled       Boolean  @default(true)
  priority      Int      @default(0)    // higher first; same priority => weighted random
  weight        Int      @default(1)
  // COST prices (what we pay upstream) — same units as Model sell prices
  inputCost       Decimal  @default(0) @db.Decimal(24, 12)
  outputCost      Decimal  @default(0) @db.Decimal(24, 12)
  cachedInputCost Decimal? @db.Decimal(24, 12)
  cacheWriteCost  Decimal? @db.Decimal(24, 12)
  cacheWrite1hCost Decimal? @db.Decimal(24, 12)
  imageCost       Decimal? @db.Decimal(24, 12)
  requestCost     Decimal? @db.Decimal(24, 12)
  audioInputCost  Decimal? @db.Decimal(24, 12)
  audioOutputCost Decimal? @db.Decimal(24, 12)
  perMinuteCost   Decimal? @db.Decimal(24, 12)
  perMillionCharsCost Decimal? @db.Decimal(24, 12)
  createdAt DateTime @default(now())
  @@unique([modelId, providerId, upstreamModel])
}

model RequestLog {
  id              String        @id @default(cuid())   // also returned as x-request-id
  userId          String?
  user            User?         @relation(fields: [userId], references: [id], onDelete: SetNull)
  apiKeyId        String?
  apiKey          ApiKey?       @relation(fields: [apiKeyId], references: [id], onDelete: SetNull)
  groupSlug       String?
  modelSlug       String?
  endpoint        String        // "/v1/chat/completions", "/v1/messages", "/v1beta/models:generateContent" ...
  inboundFormat   String
  providerId      String?
  provider        Provider?     @relation(fields: [providerId], references: [id], onDelete: SetNull)
  providerKeyId   String?
  providerKey     ProviderKey?  @relation(fields: [providerKeyId], references: [id], onDelete: SetNull)
  upstreamModel   String?
  status          RequestStatus
  httpStatus      Int
  errorCode       String?
  errorMessage    String?       // customer-safe message
  internalError   String?       // admin-only detail (upstream body, stack) — never shown to customers
  stream          Boolean       @default(false)
  inputTokens     Int           @default(0)
  outputTokens    Int           @default(0)
  cachedTokens    Int           @default(0)
  cacheWriteTokens Int          @default(0)
  reasoningTokens Int           @default(0)
  imageCount      Int           @default(0)
  audioSeconds    Float         @default(0)
  characters      Int           @default(0)
  usageEstimated  Boolean       @default(false)
  price           Decimal       @default(0) @db.Decimal(24, 12)   // charged to customer
  cost            Decimal       @default(0) @db.Decimal(24, 12)   // paid upstream
  profit          Decimal       @default(0) @db.Decimal(24, 12)
  latencyMs       Int           @default(0)
  ttftMs          Int?
  attempts        Json          @default("[]")  // [{providerId, providerKeyId, status, error, latencyMs}]
  ip              String?
  userAgent       String?
  requestBody     Json?         // only if settings.logBodies
  responseBody    Json?
  createdAt       DateTime      @default(now())
  @@index([userId, createdAt])  @@index([createdAt])  @@index([providerId, createdAt])  @@index([modelSlug, createdAt])  @@index([apiKeyId, createdAt])  @@index([status, createdAt])
}

model LedgerEntry {                 // every balance movement EXCEPT per-request usage (that lives in RequestLog)
  id          String     @id @default(cuid())
  userId      String
  user        User       @relation("LedgerUser", fields: [userId], references: [id], onDelete: Cascade)
  type        LedgerType
  amount      Decimal    @db.Decimal(24, 12)     // + credit, - debit
  balanceAfter Decimal   @db.Decimal(24, 12)
  description String
  paymentId   String?    @unique
  payment     Payment?   @relation(fields: [paymentId], references: [id])
  createdById String?    // admin who made an adjustment
  metadata    Json       @default("{}")
  createdAt   DateTime   @default(now())
  @@index([userId, createdAt])
}

model Payment {
  id                    String        @id @default(cuid())
  userId                String
  user                  User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  stripePaymentIntentId String?       @unique
  stripeCheckoutId      String?       @unique
  amount                Decimal       @db.Decimal(24, 12)
  currency              String        @default("usd")
  status                PaymentStatus @default(PENDING)
  kind                  String        // "topup" | "auto_recharge" | "postpaid_settlement"
  failureReason         String?
  receiptUrl            String?
  createdAt             DateTime      @default(now())
  updatedAt             DateTime      @updatedAt
  ledger LedgerEntry?
}

model RedeemCode { id String @id @default(cuid())  code String @unique  amount Decimal @db.Decimal(24,12)  maxUses Int @default(1)  uses Int @default(0)
  expiresAt DateTime?  note String?  createdById String?  createdAt DateTime @default(now())  usages RedeemCodeUse[] }
model RedeemCodeUse { id String @id @default(cuid())  codeId String  code RedeemCode @relation(fields:[codeId], references:[id], onDelete: Cascade)
  userId String  user User @relation(fields:[userId], references:[id], onDelete: Cascade)  createdAt DateTime @default(now())  @@unique([codeId, userId]) }

model HealthCheck { id String @id @default(cuid())  providerId String  provider Provider @relation(fields:[providerId], references:[id], onDelete: Cascade)
  providerKeyId String?  providerKey ProviderKey? @relation(fields:[providerKeyId], references:[id], onDelete: Cascade)
  ok Boolean  latencyMs Int?  error String?  createdAt DateTime @default(now())  @@index([providerId, createdAt]) }

model Setting { key String @id  value Json  updatedAt DateTime @updatedAt }
model AuditLog { id String @id @default(cuid())  actorId String?  action String  targetType String?  targetId String?  data Json @default("{}")  ip String?  createdAt DateTime @default(now())  @@index([createdAt]) }
model Announcement { id String @id @default(cuid())  title String  body String  level String @default("info")  active Boolean @default(true)  createdAt DateTime @default(now()) }
model EmailOutbox { id String @id @default(cuid())  to String  subject String  html String  sentAt DateTime?  error String?  createdAt DateTime @default(now()) }
```

### Settings keys (`lib/settings.ts` — typed getters with defaults, cached 30s)
`signupEnabled=true`, `requireEmailVerification=true`, `trialCredit=0` (USD granted on verify),
`requireCardForTrial=false`, `minTopup=5`, `maxTopup=1000`, `minBalanceToCall=0` (reject when
`balance + creditLimit <= this`), `logBodies=false`, `maxAttempts=3`, `keyCooldownSeconds=60`,
`failuresBeforeCooldown=3`, `defaultGroupSlug="standard"`, `siteName="ProviderProxy"`,
`supportEmail`, `lowBalanceEmail=true`.

## 5. Gateway (the core)

### Inbound surface (one base URL, like CE)
| Format id | Paths |
|---|---|
| `openai_chat` | `POST /v1/chat/completions` |
| `openai_completions` | `POST /v1/completions` |
| `openai_responses` | `POST /v1/responses`, `GET/DELETE /v1/responses/{id}`, `POST /v1/responses/{id}/cancel`, `GET /v1/responses/{id}/input_items` (passthrough, sticky to provider key recorded for that response id in Redis/mem, else 404) |
| `openai_embeddings` | `POST /v1/embeddings` |
| `openai_images` | `POST /v1/images/generations`, `/v1/images/edits` (multipart), `/v1/images/variations` (multipart). fal.ai and Replicate models are served on `/generations` only (see 5c) |
| `openai_audio` | `POST /v1/audio/speech` (binary response), `/v1/audio/transcriptions`, `/v1/audio/translations` (multipart) |
| `openai_moderations` | `POST /v1/moderations` |
| `openai_videos` | `POST /v1/videos` (JSON or multipart), `GET /v1/videos`, `GET /v1/videos/{id}`, `GET /v1/videos/{id}/content[?variant=]`, `DELETE /v1/videos/{id}` (see 5c) |
| `anthropic_messages` | `POST /v1/messages`, `POST /v1/messages/count_tokens` |
| `gemini` | `POST /v1beta/models/{model}:generateContent`, `:streamGenerateContent` (`?alt=sse`), `:countTokens`, `:embedContent`, `:batchEmbedContents` |
| catalog | `GET /v1/models`, `GET /v1/models/{id}` (OpenAI shape; Anthropic shape when `anthropic-version` header present), `GET /v1beta/models` (Gemini shape) — only models the key's group allows |

Auth accepted from: `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, `?key=`.
Also accept `/chat/completions` etc. without `/v1`? No — but `/v1/v1/...` doubled prefix should be normalized.

### Pipeline (`src/gateway/handle.ts`)
1. Assign `requestId` (cuid) → response header `x-request-id` on every response, success or error.
2. Parse path → `format` + operation; unknown → 404 in OpenAI error shape.
3. Authenticate key (sha256 lookup, cached 30s in Redis/mem; invalidated on key change via `revalidateKeyCache(keyId)` export) → checks: key ACTIVE, not expired, IP allowlist, user ACTIVE & email verified, key spendLimit, user monthlySpendLimit.
4. Parse body (JSON or multipart) → `model` (Gemini: from path). Resolve model by slug/alias → must be ACTIVE (HIDDEN allowed if explicitly requested), allowed by key.allowedModels and group.allowedModels, and have the capability for this operation.
5. Rate limits: key rpm/tpm, group rpm → 429 with `retry-after`.
6. Balance check: `balance + creditLimit > minBalanceToCall` and a rough pre-estimate (input tokens estimate × input price + min(max_tokens, 4096) × output price) must fit; else 402 `insufficient_balance`.
7. Route selection: enabled routes for model, provider ACTIVE, provider tags ∩ group.providerTags (if set). Sort by route.priority desc then provider.priority; within same priority weighted random. Prefer routes whose provider natively supports the inbound format; otherwise use a route only if a translator exists (§ translation matrix).
8. Key selection within provider: ACTIVE (or COOLDOWN with cooldownUntil passed → treat ACTIVE), under rpm/daily budget, highest priority, weighted random, **and with a free concurrency slot (see §9b — slot manager decides)**.
9. Execute upstream request through the provider **adapter** (URL building, auth header, extra headers, body transform, `upstreamModel` substitution, timeouts via AbortController linked to client disconnect).
10. Failover: on network error / timeout / 429 / 5xx / 401 / 403 / 529 **before any byte was streamed to the client**, record attempt, update key health (429 → cooldown using retry-after or `keyCooldownSeconds`; 401/403 → `INVALID` after 2 consecutive; 5xx/timeout → `consecutiveFailures++`, cooldown after `failuresBeforeCooldown`), then try next key, then next route, up to `maxAttempts`. 4xx validation errors (400/404/413/422) are returned to client as-is (never failover).
11. Response: non-stream → parse usage, transform back to inbound format if translated, return. Stream → pipe SSE through a `TransformStream` that (a) translates events if needed, (b) extracts usage, (c) measures TTFT, (d) on completion/abort finalizes metering. For OpenAI chat streams always inject `stream_options: {include_usage: true}` upstream; if the client didn't ask for it, strip the final usage-only chunk.
12. Metering & billing (`src/gateway/metering.ts` + `pricing.ts`): compute `price` and `cost` (§6), then hand to the batched **meter-writer** (§9b), which applies in one DB transaction per flush: insert RequestLog, `UPDATE "User" SET balance = balance - price`, `UPDATE "ApiKey" SET spent = spent + price, lastUsedAt`, `UPDATE "ProviderKey" SET totalRequests+1, totalCost+cost, lastUsedAt, consecutiveFailures=0`. Done with `after()`/fire-and-forget **after** the response finishes so it never delays the client — but must be awaited reliably (use `waitUntil`-style promise tracking; on failure log to console + retry once).
13. If balance crosses below `autoRechargeThreshold` and autoRecharge enabled → call `triggerAutoRecharge(userId)` from `src/server/billing/auto-recharge.ts` (Billing owns; Gateway imports it — Billing must export `triggerAutoRecharge(userId: string): Promise<void>` that is idempotent and never throws). Low balance alert email likewise via `maybeSendLowBalanceAlert(userId)` from same module.
14. Errors always logged (status, code, customer-safe message, internal detail) and returned in the **inbound format's** error shape:
    - OpenAI: `{"error":{"message","type","code","param":null}}`
    - Anthropic: `{"type":"error","error":{"type","message"}}`
    - Gemini: `{"error":{"code","message","status"}}`
    Gateway error codes: `invalid_api_key`(401) `key_disabled`(401) `key_expired`(401) `ip_not_allowed`(403) `account_suspended`(403) `email_not_verified`(403) `model_not_found`(404) `model_not_allowed`(403) `unsupported_endpoint`(400) `insufficient_balance`(402) `spend_limit_reached`(402) `rate_limited`(429) `no_available_provider`(503) `upstream_timeout`(504) `upstream_error`(502) `invalid_request`(400) `internal_error`(500).
    Never leak upstream key, upstream base URL or provider name in customer-facing messages; upstream 4xx bodies are passed through with provider identity scrubbed.

### Provider adapters (`src/gateway/providers/*`)
`interface ProviderAdapter { buildUrl(provider, op, upstreamModel, stream): string; buildHeaders(provider, secret, inboundHeaders): Headers; }`
- **openai** / **openai-compatible** (openai, xai, groq, deepseek, openrouter, mistral, together, fireworks, codex-everywhere, custom): Bearer; `${baseUrl}/chat/completions` etc. (baseUrl includes `/v1`).
- **anthropic**: `x-api-key` + `anthropic-version` (forward client's header, default `2023-06-01`) + forward `anthropic-beta`; `${baseUrl}/v1/messages`.
- **google**: `x-goog-api-key`; native `${baseUrl}/v1beta/models/{m}:generateContent`; also OpenAI-compat at `${baseUrl}/v1beta/openai/chat/completions` (so openai_chat → google needs no translator).
- **azure**: `api-key` header, `${baseUrl}/openai/deployments/{deployment}/chat/completions?api-version=…` (deployment = upstreamModel).
- **fal** (preset `fal`, formats `openai_images`): `Authorization: Key <key>` (applied in `providers/adapters.ts`, keyed on preset - no AuthStyle change); synchronous `https://fal.run/{model}` with automatic fallback to the queue API; see 5c.
- **replicate** (preset `replicate`, formats `openai_images`): Bearer; predictions API with polling; see 5c.
- the relay preset: formats `openai_chat, openai_responses, openai_images, anthropic_messages, gemini, openai_embeddings`; baseUrl `https://codex-everywhere.com/v1`; anthropic at same base; gemini at `https://codex-everywhere.com/v1beta` (store in settings.geminiBaseUrl).

Presets live in `src/gateway/providers/presets.ts` (exported; Admin UI uses them for the "Add provider" form): name, baseUrl, authStyle, formats, docs link, sample models.

### Translation matrix (`src/gateway/translate/*`)
| inbound \ provider native | openai_chat | anthropic_messages | gemini |
|---|---|---|---|
| openai_chat | passthrough | **chat→messages** (+stream) | via google openai-compat endpoint |
| anthropic_messages | **messages→chat** (+stream) | passthrough | messages→chat→google openai-compat |
| gemini | not supported unless native (error `unsupported_endpoint`) | — | passthrough |
| openai_responses | passthrough only | — | — |
Translations must cover: system prompts, multi-turn, images (base64 + url), tool definitions, tool_choice, tool calls & results, stop sequences, temperature/top_p/max_tokens, streaming deltas (text, tool-call args), finish/stop reasons, usage mapping.

### 5c. Live providers: fal.ai, Replicate and the video API

**Drivers** (`src/gateway/providers/{fal,replicate,drivers,driver-env,driver-types,image-common}.ts`). Providers whose API is not "one OpenAI-shaped HTTP exchange" run through a *driver* chosen by `provider.preset` and the operation (`getDriver`). `execute.ts` keeps doing slots, key selection, failover, metering and logging; the driver only talks to the vendor (submit / poll / download) inside the attempt and returns the OpenAI-shaped body + normalised usage. Errors are mapped uniformly: transport/timeout/5xx/429/401/403/402 -> failover and key-health handling; vendor 4xx -> `invalid_request` (422 reported as 400, body scrubbed); a deterministic model failure (failed prediction) is a final 502 without retry (no double payment).
- **Request mapping** (`POST /v1/images/generations`): `prompt`, `n` (1-10), `size` (fal `image_size` preset or `{width,height}`; Replicate nearest `aspect_ratio`), `seed`, `negative_prompt`, `output_format`, `response_format` `url` (default) | `b64_json` (result downloaded and base64-encoded), and `extra_input` (object merged into the vendor input; the route's `paramOverrides` are merged last and win).
- **fal**: `settings.falMode` = `sync` | `queue` | `auto` (default; sync, falling back to `queueBaseUrl` queue + status/result polling on 408/504/524 or after `falSyncTimeoutMs`). A 403 "locked/exhausted balance" is treated as a payment problem (10 min key cooldown), not an invalid key. Health probe: queue status of a non-existent job (404 = key ok, 401 = bad key; free).
- **Replicate**: `owner/name` -> `POST /models/{owner}/{name}/predictions`; `owner/name:version` (or a bare 64-hex version) -> `POST /predictions {version}`; polls `/predictions/{id}`. `settings.replicateWait` (seconds) opts in to `Prefer: wait` (OFF by default: against the live API it holds the call for the full wait even when the prediction finished after ~5 s). Health probe: `GET /account`.
- **Billing**: flat per image (`Model.imagePrice` / `ModelRoute.imageCost`, `RequestLog.imageCount`); token-billed image models (gpt-image-1-mini) bill the usage the vendor reports.

**Videos** (`src/gateway/video.ts`, format `openai_videos`, capability `video`). OpenAI Sora-compatible job API. Our public id is `video_<48 hex>`; the `VideoJob` table stores the upstream id, the provider key that created the job (status / content / delete stay sticky to that upstream account and survive restarts), the owner (every lookup is scoped to the authenticated user: foreign or unknown ids answer 404), the charge and the refund flag.
- **Billing**: charged at creation, `seconds x Model.perSecondPrice x multiplier` (cost: `ModelRoute.perSecondCost`; `RequestLog.videoSeconds`). A model without a per-second price is refused (fail closed). If a status poll (or the cron sweep in `/api/cron/health`) first observes the job as `failed`, the charge is refunded exactly once as a `REFUND` ledger entry (claim of `VideoJob.refunded` and ledger write in one transaction; `ApiKey.spent` is reduced too). Polls and downloads are free.
- **Content** streams through the normal pipeline (slots, Range / 206, CDN redirects followed once, credentials never sent cross-origin). Model masking applies to every video object.
- **Upstream reality check (2026-10)**: OpenAI shut the Sora API down on 2026-09-24 (`GET /v1/models/sora-2` carries `shutdown_date`; `/v1/videos` is 404 upstream). `pnpm setup:live` therefore creates `sora-2` DISABLED. The video flow is covered end to end by `tests/gateway/live-providers.test.ts` against the mock upstream; a live-capable video provider only needs the `openai_videos` format and a `perSecondPrice`.

**Pricing policy** (changed twice; current = owner decision of 2026-10-17): route cost = upstream list price; the DEFAULT sell price of a model served through the maker's own API is **match official** (`PERCENT_OF_OFFICIAL` 100, server-tool prices included; `src/server/pricing/default-policy.ts`), and **cost x 1.30** (`MARKUP_OVER_COST` 30) only for a model with no official price. `pnpm setup:live` takes `--markup N` / `--percent-of-official N` to force a rule; the public price table shows a saving only when our price is below the official one.

**Live tooling**: `pnpm setup:live [--markup 1.30]` (idempotent; enables OpenAI / Anthropic / fal / Replicate from the `LIVE_*` variables in `.env`, one encrypted key "live-1" each, upserts models + routes + prices, creates the `smart-fast` Anthropic->OpenAI failover demo model, disables models whose upstream `shutdown_date` has passed and prints a price table) and `pnpm e2e:live [--skip-video]` (real traffic against a running dev server: wire shapes, masking, translation, streaming, tool rounds, failover with a real upstream 401, native error shapes, exact metering/balance deltas; prints a pass/fail table with latency, charge, total upstream cost and profit).

### Health checks
`src/gateway/health.ts` exports `checkProviderKey(providerKeyId)` (cheap call: `GET /models` or 1-token completion) writing `HealthCheck` rows and updating Provider.healthStatus/lastLatencyMs. Also derive health passively from RequestLog. Admin owns UI; cron `/api/cron/health` (Billing owns cron folder, but this one route is created by Gateway at `src/app/api/cron/health/route.ts`).

## 6. Pricing math (`src/gateway/pricing.ts`, pure + unit tested)
```
effectiveMultiplier = (user.priceMultiplier ?? 1) × group.priceMultiplier
uncachedInput = inputTokens - cachedTokens - cacheWriteTokens   (Anthropic reports these separately: input_tokens excludes cache; normalize so inputTokens = total prompt tokens)
lc = (longContextThreshold && inputTokens > threshold) ? longContextMultiplier : 1
priceUSD = lc × effectiveMultiplier × (
    uncachedInput × inputPrice + cachedTokens × (cachedInputPrice ?? inputPrice)
  + cacheWriteTokens × (cacheWritePrice ?? inputPrice) + (outputTokens incl. reasoning) × outputPrice
  + audioIn × audioInputPrice + audioOut × audioOutputPrice ) / 1e6
  + imageCount × imagePrice + requestPrice + minutes × perMinutePrice + chars × perMillionChars / 1e6
  + videoSeconds × perSecondPrice
costUSD = same formula with route cost fields, lc applied, NO multipliers.
profit = price - cost
```
For images: if `imagePrice` set bill per image, else bill token usage returned by the image API.

## 7. Billing (PAYG)
- **Prepaid (default):** customer adds card (Stripe SetupIntent + Payment Element) → top up any amount between min/max (PaymentIntent on saved card, or Stripe Checkout if no card) → webhook `payment_intent.succeeded` credits balance (idempotent by PaymentIntent id; LedgerEntry TOPUP). Auto-recharge: when balance < threshold, off-session PaymentIntent for `autoRechargeAmount` (Redis/mem lock per user, at most one in flight, at most N/day; failures disable auto-recharge after 3 consecutive and email the user).
- **Postpaid (admin enables per customer):** `creditLimit` > 0 lets balance go negative; daily cron charges the outstanding negative balance to the saved card (POSTPAID_SETTLEMENT). Failure → suspend new requests once below -creditLimit.
- Refunds/disputes via webhooks → ledger REFUND/CHARGEBACK and balance debit; dispute auto-suspends the user.
- Redeem codes (admin-generated, single/multi use) and trial credit on email verification (optionally only after a card is attached).
- Every balance change = LedgerEntry with `balanceAfter`, done in a transaction with `SELECT … FOR UPDATE` on the user row (or atomic increment returning).
- Stripe not configured → billing pages show a clear banner and only redeem codes work.

## 8. UI

**Design:** clean dark-first dashboard (CE-like): left sidebar, top bar with balance pill + user menu + theme toggle; stat cards; Recharts area/bar/pie charts; data tables with filters, pagination, CSV export; detail drawers. Light mode supported. Every form: zod validation, inline errors, toast on success/failure, loading states, empty states, error boundaries (`error.tsx`) and `loading.tsx` per segment.

**Public (Portal):** `/` landing (hero with curl snippet, model price table showing official vs ours with % savings, provider cards, FAQ, CTA) · `/pricing` (live from DB, per group) · `/docs` (quickstart, auth, OpenAI-compatible, Anthropic-compatible, Gemini-compatible, images, audio, embeddings, streaming, errors reference table with all codes from §5, rate limits, SDK snippets for curl/Python/Node, client configs for Codex CLI, Claude Code, OpenCode, Cursor) · `/status` (public provider-group health, 24h/7d availability bars from HealthCheck + RequestLog; no provider secrets).

**Customer `/dashboard` (Portal, Billing for /billing):** Overview (balance, today/7d spend, requests, tokens, error rate, avg latency, spend chart, model distribution, recent errors) · API Keys (create shows full key ONCE with copy; name, group/pool, allowed models, rpm/tpm, spend limit, expiry, IP allowlist; enable/disable/revoke; "Use key" modal with ready-to-paste configs for curl/Python/Node/Codex/Claude Code/OpenCode) · Usage analytics (range picker, granularity, by model/key/endpoint, tokens vs cost toggles) · Logs (filterable table: time, key, model, endpoint, status, tokens, cost, latency; drawer with request id, error code & customer-safe message, attempts count) · Models & Pricing (their effective price incl. multipliers) · Playground (chat with streaming, model picker, system prompt, params; Image Studio tab for image models; shows tokens & cost per run; uses a hidden `isPlayground` key and calls `/v1/...` from the browser) · Billing (balance, add/remove cards, top up, auto-recharge settings, transactions ledger, payments with receipts, redeem code, spend limits) · Settings (profile, change email w/ verification, password, 2FA, sessions list w/ revoke, delete account).

**Admin `/admin` (Admin, Billing for /billing):** Overview (revenue, cost, profit, margin %, requests, error rate, active customers, p50/p95 latency; charts revenue vs cost vs profit over time; top models, top customers, provider health tiles) · Providers (list w/ health; create from preset; edit base URL/auth/formats/tags/headers/settings/timeout; **keys/accounts** sub-table: add (single or bulk paste, one per line), label, weight, priority, rpm, daily budget, status, cooldown, failures, last error, usage & cost; "Test" button per key; bulk enable/disable) · Models (catalog CRUD: slug, aliases, capabilities, context, sell prices incl. cached/cache-write/image/audio/request/long-context, official prices; **routes** sub-table with provider, upstream model, priority, weight, cost prices; live margin preview per route = (sell−cost)/sell; "duplicate model"; bulk import JSON) · Groups/Pools (multiplier, provider tags, allowed models, default, public, rpm) · Customers (search, list w/ balance & spend, detail: profile, status (suspend/activate), role, group, price multiplier, billing mode, credit limit, monthly limit, balance adjustment with reason → ledger ADJUSTMENT, keys, usage, logs, payments; impersonate (support) ) · API Keys (all keys, revoke) · Logs (all requests with internalError + attempts JSON, filters by customer/model/provider/key/status) · Analytics (revenue/cost/profit by model, provider, customer, group; error breakdown by code; latency percentiles; token volume) · Billing (payments, ledger, redeem code generator) · Status (health checks history, run checks now) · Settings (all §4 settings keys, announcements) · Audit log.

## 9. Security & correctness checklist
- Upstream secrets encrypted at rest; never sent to the client (admin UI shows `secretHint` only).
- Customer API keys: `sk-pp-` + 40 random base62 chars; stored as sha256; shown once.
- Sessions: httpOnly, secure in prod, sameSite=lax, 30-day rolling; admin routes require 2FA if enabled for that admin.
- All server actions re-check role; all admin mutations write AuditLog.
- Login/signup/reset rate-limited per IP + email; generic error messages; email verification required before keys work (setting).
- CSRF: server actions are same-origin; route handlers for UI use session + origin check.
- Body size: **unlimited by default** (`maxRequestBodyMb` setting, 0 = unlimited; the upstream's own limit applies, see 5c / 9d). Client disconnect aborts the upstream request; partial stream still metered from received usage or tokenizer estimate (`usageEstimated=true`).

## 9b. Concurrency slots, scale & model control (REQUIRED — added by lead; schema additions below are authoritative)

**Schema additions** (Foundation adds these fields):
- `ProviderKey.maxConcurrency Int?` (slots per upstream key/account; null = settings.defaultKeyConcurrency, default 50) · `Provider.maxConcurrency Int?` (cap across all its keys)
- `ApiKey.maxConcurrency Int?` · `User.maxConcurrency Int?` · `Group.maxConcurrency Int?` (customer-side concurrent request slots; null = unlimited / settings default `defaultCustomerConcurrency=20`)
- `ModelRoute.groupSlugs String[] @default([])` (route only used for these groups/pools; empty = all) · `ModelRoute.paramOverrides Json @default("{}")` (deep-merged into upstream body, e.g. `{"reasoning_effort":"low"}`; `null` value = delete field) · `ModelRoute.maxOutputTokens Int?` (clamp) · `ModelRoute.label String?`
- `Model.maskUpstreamModel Boolean @default(true)` (rewrite `model` in responses/stream chunks to the public slug so customers never see the real upstream model)
- `RequestLog.queueMs Int @default(0)`
- Settings: `queueTimeoutMs=20000`, `defaultKeyConcurrency=50`, `defaultCustomerConcurrency=20`, `passUpstreamRateLimits=true`.

**Slot manager** (`src/gateway/slots.ts`, Gateway owns): distributed counting semaphore.
- Redis implementation: per-slot-pool sorted set `slots:{kind}:{id}` with member = lease id, score = expiry timestamp; acquire = Lua script (remove expired, check `ZCARD < max`, `ZADD`); lease TTL 60s renewed every 20s while the request/stream is alive (heartbeat timer); release on finish/abort/error in `finally`. Leaks self-heal through TTL. In-memory fallback with identical semantics (single instance).
- **Customer slots** acquired first (key → user → group). If full → immediate `429 rate_limited` ("Too many concurrent requests", `retry-after: 1`) in the inbound format — exactly like a native provider would answer.
- **Upstream slots**: key selection (§5 step 8) becomes: among candidate keys of the chosen route ordered by priority desc, then weighted, try `tryAcquire` on key slot (and provider slot). First key with a free slot wins (key 1 full → key 2 → …). If every key of every eligible route is full → **wait in queue**: poll/subscribe (Redis pub/sub on release, or 100ms backoff polling) until a slot frees or `queueTimeoutMs` elapses → then `429` (`no_capacity`, `retry-after`) in native shape. Queue wait time recorded as `queueMs`. Client disconnect while queued removes it.
- **Upstream 429s**: retry on another key/route transparently; if all exhausted, return a 429 to the client in its native format, with `retry-after` (and Anthropic/OpenAI rate-limit headers `x-ratelimit-*` / `anthropic-ratelimit-*` passed through when `passUpstreamRateLimits`), so the client SDK's built-in retry logic works as if talking to the real provider. Same for 529 overloaded (Anthropic) → `overloaded_error`.
- Admin sees live slot usage: `GET /api/admin/slots` (Gateway exports `getSlotSnapshot()` returning `{providerKeys:[{id, inUse, max}], providers:[…], customers top N}`); Admin UI shows "in use / max" bars per key and provider with 5s auto-refresh.

**Throughput targets** (1000+ concurrent streaming requests per instance):
- Use one shared `undici` `Agent` (keep-alive, `connections` per origin high e.g. 512, `pipelining 0`, body/headers timeouts from provider.timeoutMs) for all upstream fetches; stream bodies straight through (no buffering of full streams except the small rolling buffer needed for usage/translation).
- Hot-path caching: API key auth, model+routes+provider+keys config, group, settings cached in-process (30s TTL, invalidated via Redis pub/sub channel `config:invalidate` when admin edits). Upstream secrets decrypted once per cache fill. **Zero DB queries on the hot path before the upstream call** except the balance check, which reads a cached balance (Redis `bal:{userId}`, refreshed from DB at most every 5s and decremented locally on settle).
- **Metering writer** (`src/gateway/meter-writer.ts`): in-process buffer flushed every 500ms or 200 entries: `createMany` RequestLogs + one aggregated `UPDATE` per user/apiKey/providerKey (sum of price/cost) in a single transaction; retry with backoff on failure; flush on SIGTERM (Cloud Run sends SIGTERM, 10s grace). Prisma pool `connection_limit` configurable via `DATABASE_URL`.
- Load test script `scripts/loadtest.ts` (QA): 1000 concurrent streaming requests against mock upstream with a provider of 3 keys × 100 slots → verify no slot exceeds max, queueing works, all requests metered exactly once, balances correct.

**Model control (what we show vs what we use):** public `Model.slug` is what customers see/call; each `ModelRoute` maps it to any provider + any `upstreamModel` (e.g. public `gpt-6-astra` → upstream `gpt-6.1-sol` for a cheap pool), restricted by `groupSlugs`/provider tags, weighted traffic split between routes, param overrides & output clamps per route, response model name masked. Admin model page shows this mapping clearly with margin per route.

## 9c. Pricing transparency & ease of use (Phase 4 — added by lead)

**Vocabulary (use EXACTLY these labels in UI; never "upstream/downstream"):**
- **Official price** — the original provider's public list price for that exact model. Admin-editable; reference only (savings math). Visible to everyone.
- **Your price** (customer UI) / **Customer price** (admin UI) — what we charge (after group + customer multipliers).
- **Our cost** — what we pay our supplier (provider key/pool/self-hosted). Admin-only.
- **Savings** = Official − Your price (green "−62% vs official"; if negative show neutral/amber "+15% vs official" — transparent, never hidden).
- **Margin** = Customer price − Our cost (admin-only; red + warning when ≤ 0).
A short glossary tooltip/explainer appears on admin Models pages and customer Models page.

**Schema:** official prices for every billable unit (add `officialCacheWritePrice`, `officialImagePrice`, `officialRequestPrice`, `officialPerSecondPrice`, `officialPerMinutePrice`, `officialPerMillionChars`, `officialAudioInputPrice`, `officialAudioOutputPrice`); `Model.pricingMode` enum `FIXED | PERCENT_OF_OFFICIAL | MARKUP_OVER_COST` + `pricingValue Decimal?` (e.g. 30 → 30% of official, or +30% over primary route cost) — when not FIXED, sell prices are recomputed automatically on save/when official or route cost changes (admin can still override per field by switching to FIXED); `RequestLog.officialPrice Decimal` (what the request would cost at official prices — computed by the gateway pricing engine with the same usage) so savings are exact per request.

**Customer:** Models & Pricing page and public /pricing: columns Official · Your price · Savings per unit (input/output/cached/image/second…); dashboard Overview + Usage: "You saved $X vs official prices" (range) and savings over time; Logs: Official / Charged / Saved columns + in detail sheet; playground per-run "saved $X". Onboarding checklist on overview (verify email → add balance → create key → make first request, each auto-ticks).

**Admin ease of setup:** "Add model" guided flow (3 steps: choose provider → choose the real model from that provider's live `/models` list (Gateway helper `listUpstreamModels(providerId)`) or type it → prices prefilled from a built-in known-price catalog (`src/gateway/price-catalog.ts`) for official + cost → choose pricing rule (fixed / % of official / markup over cost) with live preview of Your price, Savings and Margin) ; bulk action "apply pricing rule to selected models"; "Quick start" checklist on admin overview (add provider key → test → add/enable models → set pricing → invite customers); inline margin & savings badges in model lists; loss warnings.

**Funds protection (no bleeding supplier accounts):** credit **reservations** in the gateway — before any upstream call reserve `hold = est. input tokens × input price + effective max output × output price (+ flat/per-image/per-second parts)` against `available = balance + creditLimit − open holds` (also against key spendLimit and monthlySpendLimit); insufficient → `402 insufficient_balance` in native shape, upstream never contacted. If the client omits max_tokens/max_output_tokens, clamp it to what's affordable (≥ a sane minimum, ≤ model.maxOutput); if even the minimum isn't affordable → 402. Streaming: track accrued cost; when it reaches the hold, abort upstream and end the stream with a native error event (`insufficient_balance`), meter what was produced. Holds live in Redis (`hold:{userId}` hash, TTL safety) with in-memory fallback, released/settled at completion. Load test: N concurrent requests against a small balance never drives balance below −(creditLimit) by more than one request's rounding.
**Video/per-second gaps (from Phase 3):** admin model + route editors must expose `perSecondPrice` / `perSecondCost` (and official per-second); customer Models page, public pricing and logs must show per-second prices and `videoSeconds`; capability badge `video`. Show models with an upstream shutdown date (e.g. from setup:live) with a "retiring <date>" badge in admin.
**Admin credits:** "Add credit" dialog with type (Promotional credit / Refund / Correction → ledger types ADJUSTMENT/REFUND with metadata.kind) + reason; bulk "Grant credit" to selected customers from the customers table; customer billing history labels them clearly.

## 9d. Connection fidelity & keep-alive (Phase 4b — added by lead)
**Owner principle: we are a FAITHFUL 1:1 proxy.** Connections stay alive on both legs and nothing *we* do may ever drop or alter a stream. When a leg breaks, the break is MIRRORED to the other leg the same way — never masked, rescued, replayed or stitched:
- **Client disconnects / cancels → abort the upstream request immediately** (close/abort the upstream connection the same way). Nothing keeps running, nothing is buffered for later. Meter only what upstream produced until the abort (usage from received events, tokenizer fallback, `CANCELLED`).
- **Upstream fails → the client gets exactly that failure:** (a) HTTP error before the response is committed → after our own pre-commit failover across our keys/routes is exhausted (§5 step 10 — invisible pooling, stays), return the **last upstream's real status code**, its `retry-after` and rate-limit headers, and its error body in the native shape (scrub only our account/key/base-URL identity; keep upstream error type/code/message); (b) in-stream error event from upstream → pass through verbatim; (c) upstream connection drop/RST/timeout mid-stream → **terminate the client connection abruptly the same way** (destroy the response stream — no synthetic `[DONE]`, no injected error event), so the client SDK sees the same network failure it would see natively and applies its own retry; (d) normal upstream end → normal end.
- Our own internal errors after commit (bug/exception in a processor) → same as (c): abort the client stream (and the upstream), log `GATEWAY_ERROR` — never a silent truncated "success".
- NOT doing (removed by owner decision): continue-on-disconnect, replay buffers, implicit reattach, stream resume endpoints, prefill continuation/stitching. Idempotency-Key is forwarded upstream unchanged (providers that support it handle it) and logged — no gateway-side dedupe.

1. **Heartbeats (keep-alive only, never content):** while the upstream is silent for `streamHeartbeatSec` (default 15s) on an already-committed SSE response, write an SSE comment line `: keep-alive\n\n` (ignored by every SSE parser incl. OpenAI/Anthropic/Gemini SDKs). Anthropic's own `ping` events are passed through as-is (we never synthesize native events). Heartbeats stop the instant either leg closes.
2. **Commit point:** the client response is committed (status + headers sent) only once the upstream has answered with its status/headers — so pre-commit failover across our pool stays invisible and the client always receives the real upstream status. No early headers for stream requests (a queued request waits uncommitted; queue timeout → 429 as today).
3. **Faithful header passthrough:** forward upstream response status and relevant headers (rate-limit headers, `retry-after`, `request-id`-style ids renamed to `x-upstream-request-id`, content-type) — strip hop-by-hop + encoding headers (5c) and anything identifying our accounts.
4. **Stall handling:** no artificial idle cutoff by default (`upstreamIdleTimeoutSec` = 0 = disabled; provider.settings may set one). Connect timeout 15s and headers timeout = provider.timeoutMs before commit (→ pre-commit failover). undici Agent: keep-alive, `keepAliveTimeout` 60s, `keepAliveMaxTimeout` 600s, `connect: { timeout: 15000, keepAlive: true, keepAliveInitialDelay: 30000 }` (TCP keep-alive), allowH2 where supported, `bodyTimeout: 0` for streams (never kill a slow-but-alive stream).
5. **Transport**: SSE headers `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`, never compressed; flush first bytes immediately. Node server `KEEP_ALIVE_TIMEOUT` (Next standalone env) = 620000 ms (> Google LB 600s idle), headers timeout above it. Cloud Run: `--use-http2`, `--timeout=3600`, no CPU throttling, graceful SIGTERM: stop taking new requests, let in-flight streams run until done (old revisions drain), flush meter; documented in deploy/README with the 60-min Cloud Run hard per-request limit.
5c. **No compression anywhere (owner requirement):** Next `compress: false` (done by lead). Upstream requests send `Accept-Encoding: identity` and never forward the client's accept-encoding; if an upstream still compresses, decode it and ALWAYS strip `content-encoding`, `content-length`, `transfer-encoding` (and hop-by-hop headers) from forwarded responses. Inbound request bodies with `Content-Encoding: gzip|br|deflate|zstd` are decoded before parsing (never rejected). **Body size — max it out (owner requirement):** setting `maxRequestBodyMb` default **0 = unlimited** (the upstream's own limit is the only limit; its native error is passed through faithfully). Multipart/binary bodies (images edits, audio, video input_reference, file uploads) are **streamed through without buffering** (parse only the small text fields needed — model, n, size — from the head of the multipart stream, pipe file parts straight to upstream); JSON bodies are parsed only to read/swap `model` + apply overrides + meter, forwarded byte-identical when unmodified; memory per request must stay bounded for multipart. Undici request body streaming with `duplex: "half"`; no `bodyTimeout` on uploads.
**Files APIs passthrough** (large attachments): OpenAI `POST/GET/DELETE /v1/files`, `/v1/files/{id}/content`, `/v1/uploads` (+ parts/complete/cancel); Anthropic `/v1/files` (beta headers forwarded); Gemini resumable upload `/upload/v1beta/files` + `/v1beta/files`. Inbound format `openai_files` / `anthropic_files` / `gemini_files`. Stateful → sticky: new `UpstreamObject` table (kind file|upload|video|response, upstream id, providerId, providerKeyId, userId, createdAt) — later requests that reference a file id (in chat/responses/messages bodies or file endpoints) are pinned to the same provider key; ownership enforced (other customers get 404). Billing: file storage/upload free by default (configurable `requestPrice` on a hidden `files` model), usage of files billed via normal token usage.
**Cloud Run:** HTTP/1 request bodies are capped at 32 MB by Cloud Run → deploy MUST use `--use-http2` (h2c end-to-end, no request size limit); Next standalone server must speak h2c — if Next's server can't, ship a tiny custom `server.mjs` (node:http2 `createServer` with `allowHTTP1: true` wrapping Next's request handler) and document it.
Tests: gzip-encoded upstream response → client receives correct plain body without content-encoding; gzip-encoded request body accepted; **1 GB multipart upload and 200 MB JSON prompt** round-trip through the mock with RSS growth bounded (assert < ~300 MB for multipart); Files API upload → reference in chat → download content, pinned to the same mock key; other customer 404.
6. **Fidelity / chaos test suite** (`tests/gateway/chaos.test.ts` + `scripts/chaos.ts`), each format (OpenAI chat, Responses, Anthropic, Gemini, translated paths): upstream 429/500/529 pre-commit with all keys failing → client gets the same status + retry-after + native error body; upstream in-stream error event → passed verbatim; upstream RST/drop mid-stream → client connection is aborted (client observes a network error, NOT a clean end/[DONE]); client abort mid-stream → upstream request aborted within 100 ms (mock records the abort), RequestLog CANCELLED with partial usage, slots + credit holds released; slow trickle (1 token / 40 s) survives with heartbeats and no gateway-side timeout; gzip-compressed upstream response handled (5c); 1000 concurrent 2-min streams with heartbeats under a simulated SIGTERM drain → none truncated by us. No RequestLog lost in any case.

### 9d.7 Implementation record (Phase 4b - what was built, decisions, measured evidence)

**Code map.** `src/gateway/stream.ts` (stream engine: mirror semantics + heartbeats), `execute.ts` (failover, error mirroring, header
passthrough), `headers.ts` (allow-list), `shape.ts` (`mirrorErrorFromUpstream`, JSON splice), `jsonscan.ts` + `spool.ts` +
`multipart.ts` + `bodyin.ts` (streamed bodies), `files.ts` (Files APIs), `upstream.ts` (undici agent), `server.mjs` (h2c + drain),
`scripts/chaos.ts`, `scripts/h2c-check.mjs`, tests `chaos.test.ts` / `files.test.ts` / `bigbody.test.ts` (+ `http-adapter.ts`, which
serves `handle()` over a real socket the way Next does).

**Decisions (where the principle needed a concrete rule).**
1. *Stream end.* A stream is complete only when the upstream's terminal event arrived (`[DONE]`/`finish_reason`, `response.completed|incomplete|failed`,
   Anthropic `message_stop`, Gemini `finishReason`/`blockReason`). Upstream error event -> forwarded verbatim (identity-scrubbed message only) and the stream
   ends the way the upstream ended it. Upstream RST / clean close without terminal / stall past the optional idle cutoff / our own processor exception ->
   the client stream is *errored*, which Next turns into `res.destroy()` (h1: no terminal chunk; h2: RST_STREAM) - no synthetic `[DONE]`/end/error event, translated
   streams included (the old "finalize the Anthropic stream when [DONE] is missing" was removed; a translated stream is only closed when the upstream already sent its `finish_reason`).
   The only gateway-authored event left is the funds guard's `insufficient_balance` (9c).
2. *Commit point.* The response is committed on the first upstream output event. Before that, an error event as the FIRST event or a drop fails over to the next key (invisible
   pooling); exhausted -> the last upstream's status/body (a first-event `overloaded_error` becomes HTTP 529 etc.). If the upstream answered 200 but stays silent for one heartbeat
   interval the response is committed anyway so heartbeats can keep the client connection alive (`streamHeartbeatSec`, default 15, 0 = off; SSE only, never Gemini JSON-array streams).
3. *Error mirroring.* After pool failover is exhausted, 408/429/5xx (incl. 529) are returned with the LAST upstream's real status, `retry-after`/`x-ratelimit-*`/`anthropic-ratelimit-*`/`x-should-retry`,
   its request id as `x-upstream-request-id`, and its native error document rebuilt from whitelisted fields (type/code/param/message kept, message scrubbed of provider name, host, key, upstream model).
   Deliberate exceptions: upstream 401/402/403 are OUR account problems (a 401 would make SDKs blame the customer's key) -> 503 `no_available_provider`; failures with no upstream answer
   at all (connect error, reset before headers, headers timeout) have no status to mirror -> 502/504 native error (every SDK retries those exactly like a network error).
   The gateway's own error code stays in `RequestLog.errorCode`.
4. *Headers.* Allow-list only (`headers.ts`): rate-limit family, `retry-after`, `x-should-retry`, request id renamed, media headers on downloads, `x-goog-upload-*` on Gemini uploads. Never forwarded:
   hop-by-hop, `content-encoding`/`content-length` of a decoded body, `set-cookie`, `server`, org/project ids, anything else. `Idempotency-Key` is forwarded unchanged and recorded in `RequestLog.attempts`.
5. *Transport.* One undici agent: keep-alive 60 s (up to 600 s), TCP keep-alive probes from 30 s, connect timeout 15 s, `connections: 10000` per origin (a lower cap silently queued streams behind
   the first 512 - found by the 1000-stream run), `headersTimeout`/`bodyTimeout` disabled in undici and enforced per request: headers timeout = `provider.timeoutMs` counted from the END of the request upload,
   no body timeout, optional stream idle cutoff = `provider.settings.idleTimeoutSec` (else `settings.upstreamIdleTimeoutSec`, default 0 = never). HTTP/2 to the upstream is opt-in per provider
   (`provider.settings.http2: true`, https origins only, ALPN): multiplexing shares one connection between streams, so a connection loss hits all of them - not on by default.
6. *Compression.* `Accept-Encoding: identity` always; an upstream that compresses anyway is decoded by undici and `content-encoding`/`content-length` are never copied. Inbound `Content-Encoding` gzip/deflate/br/zstd is decoded
   on the fly (corrupt data -> 400, other encodings -> 415).
7. *Bodies.* `maxRequestBodyMb` (0 = unlimited). Request bodies are never `arrayBuffer()`-ed: they are spooled (memory up to 8 MB, then a temp file) while a streaming scanner records multipart part offsets / JSON top-level member offsets,
   then forwarded as the customer's own bytes with only the changed members spliced (multipart `model`; JSON `model`, injected `stream_options` / output cap ...). Anything not expressible as a splice (translation, `paramOverrides`, deleted fields)
   re-serialises. A request that is still arriving when the client leaves cancels the spool (file removed) and never reaches the upstream. JSON is parsed once (validation, funds estimate, usage fallback need it): peak RSS is about 3x the
   body for a 200 MB prompt; multipart peaks at about 100 MB growth even for 1 GB. Raw Files uploads are streamed straight through (no spool, no failover: one attempt).
8. *Files.* Formats `openai_files` / `anthropic_files` / `gemini_files` (a provider lists them in `formats`; `/v1/files` is told apart by the `anthropic-version` header). `UpstreamObject` (migration `files_and_sticky_objects`) stores kind
   `file` | `upload` | `gemini_upload`, the owner and the upstream account; the file JSON is kept in `meta`, so listings come from our own records (a shared upstream account never leaks other customers' files). References
   (`file_id` anywhere in a body, `fileData.fileUri`) pin the request to the owning account; another customer's id -> native 404; a customer's new uploads prefer the account that already holds their files; files spanning two accounts
   in one request -> 400 with a clear message. Gemini's `x-goog-upload-url` is rewritten to the gateway (session id stored server-side, upstream URL origin-checked). Storage is free; an admin can price it with a hidden model slug `files`
   (requestPrice / route requestCost). `VideoJob` keeps its own stickiness (not migrated).
9. *Container.* `server.mjs` wraps Next's generated `server.js`: a first-bytes sniffer sends `PRI * HTTP/2.0` connections to `node:http2` and everything else to `node:http` (cleartext `http2.createServer` cannot do HTTP/1.1, and `allowHTTP1` needs TLS);
   the h2 path replays the sniffed bytes through a duplex and normalises Next's expectations (headers object, status message). HTTP/1 request timeout disabled, keep-alive 620 s, headers timeout above it, 1 MB HTTP/2 window.
   SIGTERM: stop accepting, GOAWAY / `Connection: close`, drain in-flight requests (<= `SHUTDOWN_DRAIN_SECONDS`, default 600), flush the meter (exit hook), exit 143. Cloud Run: `--use-http2 --timeout=3600 --no-cpu-throttling`.

**Evidence** (all reproducible with the commands in README): `tests/gateway/chaos.test.ts` - 6 formats (OpenAI chat, Responses, Anthropic, Gemini, chat->Anthropic and Messages->chat translated) x {429/500/529 mirrored, good stream headers, gzip upstream,
verbatim error event, RST + FIN mid-stream = client connection broken, drop before content -> 502, client abort -> upstream sees the abort 2-5 ms later, CANCELLED with partial usage billed}, plus non-stream aborts, a queued client leaving,
multipart / Files uploads aborted mid-flight (spool file removed), heartbeats on silent and stalled streams, gzip request bodies, byte-identical JSON forwarding, "no RequestLog lost". `tests/gateway/bigbody.test.ts` - 1 GB multipart and
200 MB JSON byte-identical at the upstream (sha-256), RSS growth ~100 MB / ~620 MB. `pnpm chaos --docker ...` - 1000 concurrent 120 s streams over the built container with SIGTERM at 40 s: 1000/1000 complete, new connection refused,
exit 143 0.4 s after the last stream, 1000 RequestLogs, balance debit == sum of prices.

Final numbers (scenario table, 1000 x 120 s drain over HTTP/1.1 and h2c, 1 GB / 200 MB container runs, live OpenAI check incl. `--live-h2`) are recorded in [CONNECTION-FIDELITY.md](CONNECTION-FIDELITY.md).
Lead decisions: upstream HTTP/2 stays opt-in (`provider.settings.http2`, default off); `VideoJob` is not migrated (new sticky objects use `UpstreamObject`).

**Not achievable / limits (stated plainly).** A TCP RST discards whatever the peer had not read yet, so after an upstream reset the client may lose the last few events (real providers behave the same). Cloud Run force-kills 10 s after SIGTERM:
only graceful shutdowns (deploys, scale-in of idle instances, `docker stop -t`) are lossless. `connection: keep-alive` is sent on SSE responses (HTTP/1 only meaningful; Node drops it on h2). Windows cannot deliver SIGTERM to a child process,
so the drain run needs Docker/Linux. In-memory slots/holds are per instance (Redis shares them across instances as before).

## 10. Hosting — Google Cloud (Foundation creates files, QA verifies `docker build`)
- **One container** (`Dockerfile`, multi-stage, `output: 'standalone'` in next.config, non-root, `PORT` env honored, started by `server.mjs` = HTTP/1.1 + h2c on one port, see 9d.7) serves UI + gateway. Target **Cloud Run** (gen2, `--use-http2` so request bodies are not capped at 32 MB, `--timeout=3600` for long streams, `--concurrency=80`, min-instances 1 to avoid cold starts on the API, CPU always allocated so post-response metering completes).
- **Cloud SQL for PostgreSQL** (connect via Cloud SQL connector unix socket: `DATABASE_URL=postgresql://USER:PASS@localhost/proxy?host=/cloudsql/PROJECT:REGION:INSTANCE`). **Memorystore Redis** via Serverless VPC connector (optional; app works without it). *(Updated: Direct VPC egress instead of a connector, and the default "lean" profile runs one instance without Redis; see docs/DEPLOYMENT.md "Profiles and cost".)*
- **Secret Manager** for all secrets, mapped to env vars in Cloud Run.
- **Migrations**: separate **Cloud Run Job** using the same image with command `pnpm prisma migrate deploy` (script `deploy/migrate.sh`).
- **Cron**: **Cloud Scheduler** → HTTPS POST to `/api/cron/billing` (hourly) and `/api/cron/health` (every 5 min) with header `Authorization: Bearer $CRON_SECRET`. *(Superseded 2026-10-19: background jobs are activity-driven by default and Cloud Scheduler is optional; see docs/OPERATIONS.md "Background jobs".)*
- Files: `Dockerfile`, `.dockerignore`, `deploy/cloudbuild.yaml` (build → push Artifact Registry → deploy service + migrate job), `deploy/README.md` (step-by-step gcloud commands: enable APIs, create SQL instance, secrets, service account, deploy, scheduler jobs, Stripe webhook URL, custom domain). Also works on any Docker host (`docker-compose.prod.yml` with app+postgres+redis).
- Health endpoint `GET /api/healthz` (DB ping) for Cloud Run startup/liveness probes.
- Logs: structured JSON to stdout (`src/lib/logger.ts`, `severity` field) so Cloud Logging parses levels; include `requestId`.

## 11. Phases
1. **Foundation** (1 agent): scaffold, deps, docker-compose, schema + migration, lib/, auth flows, shells with nav + placeholder pages for every route in §8, seed (admin, groups `standard` 1.0× default / `pro` 0.8× / `enterprise`, provider presets *without* secrets, model catalog with official prices and default sell prices, Mock Upstream provider + routes in dev). `pnpm build` must pass.
2. **Parallel** (4 agents): Gateway · Billing · Admin console · Customer portal + public site.
3. **Integration & QA** (1 agent): docker up, migrate, seed, run mock upstream, end-to-end script (`scripts/e2e.ts`) covering signup→verify→key→chat (stream & non-stream, OpenAI & Anthropic formats, translation both ways)→metering→balance decrement→failover on 429/500→insufficient balance 402→logs visible; `pnpm build`, `pnpm test`, lint; fix integration bugs.
4. **Lead review**: browser walkthrough of admin + customer flows, final report.
