# Foundation reference (read with docs/PLAN.md)

## Run
`docker compose up -d` (postgres :5433, redis :6380) · `pnpm db:migrate` · `pnpm db:seed` · `pnpm dev` · `pnpm mock:upstream` (port 4010).
Seeded logins: `admin@example.com / admin-password-123`, `demo@example.com / demo-password-123` ($25 balance).
Dev API key for demo: `sk-pp-devdemo000000000000000000000000000000000`. Seed also has mock models `mock-gpt`, `mock-claude`, `mock-embed`, `mock-image` routed to provider "Mock Upstream" (3 keys, 100 slots each).

## Prisma
Prisma 7.10.1. `import { db } from "@/lib/db"`. Types/enums/`Prisma` from `"@/generated/prisma/client"` (generated, gitignored).
Seed convention: `Provider.settings.anthropicBaseUrl` = origin (append `/v1/messages`); `settings.geminiBaseUrl` = origin or origin+`/v1beta` (strip trailing `/v1beta` before appending `/v1beta/models/...`).

## src/lib
- `env.ts` — `env`, `isProd`, `isDev`, `appUrl` (also DB_POOL_SIZE, TRUSTED_PROXY_HOPS, LOG_LEVEL)
- `db.ts` — `db`
- `crypto.ts` — `encrypt(s)`, `decrypt(s)`, `sha256(s)`, `hmac(s)`, `safeEqual(a,b)`, `randomToken(bytes=32)`, `randomBase62(n)`, `generateApiKey(): {key,prefix,hash}`, `hashApiKey(k)`, `secretHint(s)`
- `money.ts` — `Decimal`, `ZERO`, `toDecimal(v,fallback?)`, `sum(iter)`, `perMillion(units,price)`, `roundDb`, `toDbString`, `toNumber`, `isZero`, `max`, `min`, `formatUSD(v,{decimals?,signed?,tinyDigits?,compact?})`, `formatPricePerMillion`, `percent`
- `redis.ts` — `getRedis(): Redis|null` (no offline queue: commands fail fast until connected → always fall back), `getRedisSubscriber()`, `redisReady()`, `publishConfigInvalidate(scope)`, `CONFIG_INVALIDATE_CHANNEL`
- `ratelimit.ts` — `rateLimit(key,{limit,windowSec}) → {ok,limit,remaining,retryAfterMs,retryAfterSec}`, `rateLimitAll`, `resetRateLimit`
- `settings.ts` — `getSetting(key)`, `getSettings()`, `setSetting`, `setSettings(partial)`, `invalidateSettingsCache()`, `SETTING_DEFS` (label/description/group/type per key — for admin UI), `SETTING_KEYS`. Money settings are JSON numbers (USD).
- `audit.ts` — `audit(actorId, action, {type,id}|null, data?, ip?)` (never throws)
- `email.ts` — `sendEmail({to,subject,html}) → {ok,id?}`, `sendTemplate(to, tpl)`, `emailTemplates.{verifyEmail,resetPassword,emailChange,lowBalance,paymentFailed,autoRechargeDisabled,welcome,accountExists}`
- `logger.ts` — `logger.{debug,info,warn,error,child}` (JSON with `severity`)
- `http.ts` — `getClientIp(headers)`, `isSameOrigin(req)`, `assertSameOrigin(req)`, `safeNextPath()`
- `utils.ts` — `cn` + format helpers · `date-range.ts` — `parseRangeParams`, `rangeToParams`, `rangeFromPreset`, `suggestGranularity`

## src/lib/auth
- `session.ts` — `getSession() → {session,user,impersonatorId}|null`, `requireUser()`, `requireAdmin({adminOnly?})`, `requireUserForAction()` / `requireAdminForAction()` (throw `AuthError` instead of redirect — use in server actions), `createSession(userId,opts)`, `destroyCurrentSession`, `listSessions`, `revokeSession`, `revokeOtherSessions`, `revokeAllSessions`, `getCurrentSessionId`
- `service.ts` — `grantTrialCredit(userId) → {granted,amount?,reason?}`, `requestEmailChange`, `verifyEmailToken`, `changePassword`
- `totp.ts` — `beginTotpSetup`, `enableTotp`, `disableTotp`, `verifyUserTotp`
- `actions.ts` — server actions returning `ActionResult` (`{ok:true,data?,message?} | {ok:false,error,fieldErrors?}`): signup/login/2FA/logout/verify/resend/forgot/reset/changePassword/requestEmailChange/begin|enable|disableTotp/revokeSession/revokeOtherSessions/stopImpersonation. Zod schemas in `schemas.ts`.

## UI
- Shell: `src/components/shell/` — `AppShell variant="customer"|"admin"`, nav in `nav.ts`. shadcn style is `radix-nova` (neutral, custom navy/emerald theme); use `field` + `input-group` instead of `form`.
- Common: `src/components/common/` — `StatCard`, `PageHeader`, `DataTable` (TanStack v8.21), `DateRangePicker`, `CopyButton`, `ConfirmDialog`, `MoneyText`, `StatusBadge`, `EmptyState`, `ChartCard` + `AreaChart`/`BarChart`/`DonutChart`, `TextField`/`PasswordField`/`SubmitButton`, `ComingSoon`, `RouteError`/`RouteLoading`.

## Cross-agent interfaces (stubs exist; owner implements, signatures fixed)
| File | Owner | Exports |
|---|---|---|
| `src/gateway/providers/presets.ts` | Gateway | `ENDPOINT_FORMATS`, `EndpointFormat`, `ProviderPreset`, `PROVIDER_PRESETS`, `getPreset(id)` |
| `src/gateway/health.ts` | Gateway | `checkProviderKey(id)`, `checkProvider(id)`, `runAllHealthChecks()` |
| `src/gateway/slots.ts` | Gateway | `getSlotSnapshot(): Promise<SlotSnapshot>` (+ internal slot manager) |
| `src/gateway/cache.ts` | Gateway | `invalidateGatewayConfig(scope?, id?)` — **Admin, Billing & Portal MUST call this after mutating** providers/keys/models/routes/groups/settings/users/api keys/balances |
| `src/server/billing/auto-recharge.ts` | Billing | `triggerAutoRecharge(userId)`, `maybeSendLowBalanceAlert(userId)` |

## Parallel-work rules
- Only edit files you own (PLAN §2). Need a change in a shared file? Keep it minimal & additive and list it in your report.
- Do **not** run `pnpm build` (the lead/QA does). Use `pnpm typecheck` / `pnpm lint` and only fix errors in **your** files — other agents are mid-flight.
- Dev servers: each agent uses its own dist dir & port so they don't collide: `NEXT_DIST_DIR=.next-<agent> pnpm next dev -p <port>` (Gateway 3001, Billing 3002, Admin 3003, Portal 3004). Mock upstream runs on 4010 (Gateway starts it; others may reuse it if running).
- Do not run `prisma migrate` / change the schema. If you truly need a schema field, stop and describe it in your report.
- Do not git commit; the lead commits.
