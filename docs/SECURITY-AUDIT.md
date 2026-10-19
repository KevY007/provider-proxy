# Security audit (Phase 6)

**Date:** 2026-10-19 · **Scope:** gateway, web app, billing, secrets handling, infrastructure + dependencies (HANDOFF §6 Step D).

**Method:** five parallel reviewers, one per area, read the code end to end. Each finding was then checked against the
code, or reproduced with a scratch script, before it was fixed. Every fix ships with a regression test where one can be
automated (`tests/security/audit-regressions.test.ts`, `tests/gateway/batches.test.ts`). After the fixes, all gates were
run again: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

Severity is what the finding allowed **before** the fix. Status values:
- **Fixed**
- **Partly fixed**
- **Open**: the owner needs to decide, or it is accepted and documented
- **Not reproduced**

## Summary

| Severity | Found | Fixed | Not fixed |
|---|---|---|---|
| High | 10 | 8 | S1 not reproduced (hardened anyway), D2 accepted (dev-only, no patched version exists) |
| Medium | 14 | 14 | - |
| Low | 20 | 20 | - |
| Info | 6 | 6 | (B11's unbilled gateway errors are by design) |

## Findings

### Gateway

| ID | Sev | Finding | Where | Fix | Test |
|---|---|---|---|---|---|
| SA-01 | High | Batch requests could reference **another customer's `file_id`**. There was no ownership check inside batch bodies, so on a shared upstream account a customer could read a stranger's file through the model. Found during self-review. | `src/gateway/batches.ts` | `batchFilePin`: `file_id`/`fileUri` references in every request must belong to the caller (foreign id: native 404) and pin the batch to the account that stores them. | `batches.test.ts` "a file referenced inside a request must belong to the caller" |
| G1 | High | **Decompression bomb.** A 665-byte brotli body decoded to 400 MB (memory grew by about 840 MB, reproduced). The body is read before the funds check. | `src/gateway/bodyin.ts` | `bombGuard`: past 64 MB, decoded bytes may be at most 200× the wire bytes. Beyond that the request fails with 413. Uncompressed bodies stay unlimited (by design). | `G1 decompression bombs` |
| G2 | High | **Multipart field-name confusion.** `name="…"` was matched in any part header. A crafted part made the gateway authorize and bill a cheap `model` while the upstream saw an expensive one, which also bypassed `allowedModels`. | `src/gateway/multipart.ts` | Name and filename are read only from `Content-Disposition`. Repeated routing/billing fields (`model`, `n`, `seconds`, `size`, `quality`, `response_format`) are rejected. | `G2 multipart` |
| G3 | High | **Hold underestimation.** Anthropic text documents were estimated at 8 tokens instead of about 330k; base64-looking text counted as one 1000-token image; PDFs and file references counted as 0 or 1000. Parallel requests could spend far beyond the balance. | `src/gateway/tokenizer.ts` | `collectText` counts document text, treats text as text, estimates encoded documents at chars/8 and adds 25k tokens per referenced file. Images keep the flat estimate. Used by request holds and batch holds. | `G3 hold estimates` |
| G4 | Medium | Batch requests skipped the per-route controls: `paramOverrides`, provider `stripFields`, the output cap. An explicit `max_tokens` above the model maximum was sent upstream although the hold only covered the maximum. | `src/gateway/batches.ts` | `applyRouteControls` applies the same controls and clamp as `prepareUpstream`. | `batches.test.ts` (model rewrite, prices) |
| G5 | Medium | fal video: `extra_input.duration` overrode the billed `seconds` (billed 1 s, generated 10 s). | `src/gateway/providers/fal-video.ts` | `duration` is set from `seconds` after the customer extras and admin overrides. | (driver code path; covered by video tests) |
| G6 | Medium | Another customer's `previous_response_id` was forwarded unpinned. On a shared account it continued their conversation. | `src/gateway/handle.ts` | A foreign sticky record answers 404. | `G6` |
| G7 | Low | Mirrored upstream errors leaked `org-…` / `proj_…` ids, account UUIDs and dated upstream model names. | `src/gateway/shape.ts` `scrubText` | These are redacted; suffixed upstream model names are replaced as a whole. | `G7` |
| G8 | Low | URLs returned by vendors (fal/Replicate results, video CDN links, cross-origin redirects) were fetched without a private-address check, a potential SSRF steered through `extra_input`. | `driver-env.ts`, `execute.ts` | `src/gateway/ssrf.ts` `assertPublicUrl`: loopback, private, link-local/metadata, CGNAT, ULA and multicast are refused unless the host is the provider's own. | `G8` |
| G9 | Low | Anonymous-log and bad-auth throttles are per instance and per exact IP: IPv6 rotation is possible, and the maps are cleared at 50k entries. | `src/gateway/limits.ts` | **Fixed (follow-up).** IPv6 throttled per /64 (`ipBucket`), oldest-half eviction instead of a full clear, a global per-instance ceiling for anonymous logs. | `G9 throttle buckets` |
| G-i | Info | Files and batch management calls are not counted against key rpm/tpm limits (they are not model calls). | `handle.ts` | **Fixed (follow-up).** Files / batch management calls count against the key's rpm limit (`checkLimits` before the raw handlers). | |

### Billing / metering

| ID | Sev | Finding | Where | Fix | Test |
|---|---|---|---|---|---|
| B1 | High | A Claude stream closed after its content but **before `message_delta`** was billed at about 1 output token, because `message_start` reports `output_tokens: 1`. | `src/gateway/execute.ts` `finalizeStream` | Streams that did not complete are billed at `max(reported, tokens delivered)`. | `B1` |
| B2 | High | **Batch results could escape metering:** delete the OpenAI output file, or race the Anthropic batch delete, before metering ran, and the results could never be billed. | `batches.ts`, `files.ts` | `ensureMetered`: deleting a batch, or a batch output/error file, first meters the batch and waits for it (409 while it cannot). Listing an ended batch also triggers metering. | `B2` |
| B3 | Medium | If an admin disabled the model, batch results were recorded at $0; if the key was gone, metering failed until the hold expired. | `batches.ts` | Fail closed: metering is postponed (logged as an error) while the model is missing, and the sweep keeps the hold of every unmetered batch in place. | |
| B4 | Medium | The batch hold ignored `n` (choices per request). | `batches.ts` `worstPrice` | The output estimate is multiplied by `n` (capped at 128). | |
| B5 | Medium | Trial credit can be farmed with one card across many accounts (no card-fingerprint check). | `src/lib/auth/service.ts`, `stripe.ts` | **Fixed (follow-up).** `User.trialCardFingerprint`: a card-gated trial is granted once per card fingerprint across accounts (advisory lock per fingerprint). | `B5` (audit-regressions) |
| B6 | Medium | The metering dead-letter file defaults to `os.tmpdir()`, which on Cloud Run is per-instance memory and is lost on shutdown. | `meter-writer.ts` | **Fixed (follow-up).** Dead-letter rows are mirrored into a Redis list (`meter:deadletter`) and replayed from it by any instance; replay is idempotent, so a row present in both places is written once. Also logged as `METER_DEAD_LETTER`. | |
| B7 | Low | A foreign-key error (deleted provider key) also dropped the user's debit. | `meter-writer.ts` `writeRow` | Provider references are dropped first; the user debit is kept. | |
| B8 | Low | The same log id twice in one flush was charged twice. | `meter-writer.ts` `writeBatch` | Entries are de-duplicated by id before insert and financials. | `B8` |
| B9 | Low | Auto-recharge could double-charge when Redis is down (in-memory lock only). | `auto-recharge.ts` | **Fixed (follow-up).** The in-flight / daily-cap / cooldown check and the PENDING payment are created under a Postgres advisory lock per customer. | billing tests |
| B10 | Low | `charge.dispute.closed` is not handled, so a won dispute leaves the customer debited and suspended. | `webhook.ts` | **Fixed (follow-up).** `charge.dispute.closed` with status `won` reverses the chargeback once (ADJUSTMENT), marks the payment SUCCEEDED and re-activates the customer only if our chargeback suspension is their latest status change. | `webhook.test.ts` |
| B11 | Info | `GATEWAY_ERROR` outcomes with usage are not billed; the admin balance-adjustment audit row has no IP. | | Open (no customer-triggerable path found). | **Fixed (follow-up)** for the audit IP (`adminAdjustBalance(..., ip)`); unbilled `GATEWAY_ERROR` usage stays by design (our fault, not the customer's). | |

### Web app

| ID | Sev | Finding | Where | Fix | Test |
|---|---|---|---|---|---|
| W1 | High | **Open redirect** after login/2FA: `?next=/%09/evil.com` (control characters are dropped by URL parsers). | `src/lib/http.ts` `safeNextPath` | Control characters are rejected; the target must resolve to the same origin and only path, query and hash are returned. | `W1` |
| W2 | Medium | Impersonation sessions survived suspension, demotion and "sign out everywhere" of the staff member, rolled forever, and stopping created a fresh admin session without 2FA. | `src/lib/auth/session.ts`, `actions.ts` | 1 h absolute lifetime (never rolled). The impersonator must still be ACTIVE staff on every request. Revocation includes the sessions a user opened as impersonator. Stopping asks for the admin's TOTP again when 2FA is on. | (needs a request context; manual check) |
| W3 | Medium | While impersonating, staff (SUPPORT included) could create API keys, change 2FA, password, email and sessions, charge cards or top up. Audit rows named the customer. | `actions.ts`, `billing/actions.ts`, `customer/keys.ts`, `src/lib/audit.ts` | These actions are refused while impersonating; every audit row written through an impersonation session records `impersonatorId`. | |
| W4 | Medium | Stored HTML/CSS injection into the admin analytics `<style>` through API-key names (chart config keys). | `src/components/ui/chart.tsx` | Keys and colours are reduced to safe characters before reaching the style text. | `W4` |
| W5 | Medium | IP rate limits (login/signup/reset) could be bypassed with a forged `X-Forwarded-For` on the self-hosted setup; login had no per-account limit. | `src/lib/http.ts`, `service.ts`, `server.mjs` | `TRUSTED_PROXY_HOPS=0` makes `server.mjs` use the socket address (set in `docker-compose.prod.yml`); `x-real-ip` is never trusted; per-account login limit of 30 per hour. | |
| W6 | Low | A pending (pre-2FA) session became a full session if 2FA was switched off later. | `session.ts`, `totp.ts` | `getSession` rejects every session that has not passed 2FA; enabling or disabling 2FA deletes pending sessions. | |
| W7 | Low | TOTP codes could be replayed within their window. | `src/lib/auth/totp.ts` | Each matched time step is single-use; 8 tries / 5 min and 30 / day (codes and recovery codes), and the owner is emailed (at most hourly) when the limit is hit. | `W7` |
| W8 | Low | Email change: the old address was not told, sessions and reset links survived, and "already in use" revealed registered addresses. | `service.ts` | The old address gets a notice; on change all sessions and pending tokens end; the answer no longer reveals whether an address is taken. | |
| W9 | Low | SUPPORT could verify staff accounts (e.g. a sign-up with `ADMIN_EMAIL`) and grant trial credit. | `customers-actions.ts` | `canManageTarget` on email verification and password-reset sending. | |
| W10 | Low | Password change/reset left pending reset and email-change tokens valid. | `service.ts` | They are deleted. | |
| W11 | Low | No clickjacking/CSP headers. | `next.config.ts` | See I2. | |
| W12 | Info | 2FA is optional for staff; no recovery codes. | | Open (owner decision). | **Fixed (follow-up).** 10 single-use recovery codes (hashed, shown once) accepted at the 2FA step; setting `requireStaffTwoFactor` (default on in production) sends staff without 2FA to Settings and blocks admin actions until it is enabled. | `W12` |

### Infrastructure, secrets, dependencies

| ID | Sev | Finding | Where | Fix | Test |
|---|---|---|---|---|---|
| S1 | High (reported) | "`.env` is copied into the Docker image." | `.dockerignore`, `Dockerfile` | **Not reproduced:** `.dockerignore` already excludes `.env` and `.env.*`. Defence in depth: the build stage now runs `rm -f .env .env.*` before `next build`. | |
| I1 | Medium | Client-IP spoofing (`x-real-ip` fallback; direct `*.run.app` calls behind a load balancer) bypassed the per-key IP allowlist. | `src/lib/http.ts`, `deploy/README.md` | `x-real-ip` removed; `TRUSTED_PROXY_HOPS=0` mode; docs require `--ingress=internal-and-cloud-load-balancing` with a load balancer. | |
| I2 | Medium | No browser security headers. | `next.config.ts` | App pages get `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, and HSTS in production. The gateway paths (`/v1`, `/v1beta`, `/upload`) are left untouched (faithful proxy). | |
| I3 | Medium | Slowloris / idle-connection exhaustion on the self-hosted listener. | `server.mjs` | **Fixed (follow-up):** first bytes within 15 s, `MAX_CONNECTIONS` cap per instance (default 20000). h2 `maxSessionMemory` stays at 256 MB (large-body throughput, see CONNECTION-FIDELITY); Cloud Run's front end absorbs the rest. | |
| I4 | Low | Build context can carry `live-output/`, `.next-*`, `*.pem` into the standalone trace. | `.dockerignore` | Added. | |
| I5 | Low | IAM too broad (project-wide `secretAccessor`, `run.admin`). | `deploy/README.md` | Per-secret bindings, `run.developer`. | |
| I6 | Low | An invalid `NODE_ENV` (e.g. `staging`) silently dropped every env var, which opened the health cron. | `src/lib/env.ts`, `api/cron/health` | Invalid env outside dev/test fails hard; the health cron is unauthenticated only with `NODE_ENV=development`. | |
| I7 | Low | Session cookie `Secure` depended on `APP_URL` being https. | `session.ts`, `proxy.ts` | Always `Secure` in production, except a plain-http localhost `APP_URL`. | |
| S2 | Low | A Gemini query key (`?key=`) could reach admin-visible error columns (`RequestLog.attempts`, `ProviderKey.lastError`, health checks) through fetch errors quoting the URL. | `util.ts`, `health.ts`, `providers-actions.ts` | `redactUrlSecrets` in `describeNetworkError` and the health probe; provider base URLs must parse. | `S2` |
| S3 | Low | Dead-letter log lines carried request/response bodies; the file was world-readable. | `meter-writer.ts` | Bodies are left out of the log line; the file is written with mode 0600. | |
| I8 | Low | Base image not pinned by digest; the migration CLI is installed without a lockfile. | `Dockerfile` | **Fixed (follow-up).** `NODE_IMAGE` pinned by digest (dependabot updates it); the migration CLI is installed with `npm ci` from `prisma/migrator/package-lock.json`. | |
| I9 | Info | Dev compose publishes Postgres and Redis on all interfaces; prod compose defaulted `POSTGRES_PASSWORD`; Cloud SQL public IP. | compose files, deploy docs | **Fixed (follow-up)** for compose: dev Postgres / Redis bound to 127.0.0.1; prod requires `POSTGRES_PASSWORD`. Cloud SQL private IP is a deployment choice (documented). | |
| S4 | Info | Provider `extraHeaders` and key `extra.headers` are stored in plaintext and shown to admins. | schema | **Fixed (follow-up).** Credential-like header values (`auth`, `key`, `token`, `secret`, `cookie` ...) are stored encrypted (`enc:`), decrypted only for the upstream request, and shown to admins as `[encrypted]` (saving it back keeps the value). | `S4` |
| S5 | Info | Whether Google echoes `key=` into the resumable-upload session URL stored in `UpstreamObject.meta.url` is unverified. | `files.ts` | **Fixed (follow-up)** defensively: the stored session URL is encrypted at rest (older rows still read). | |
| D1 | High (dev-only) | lodash code injection / prototype pollution through prisma studio. | `pnpm audit` | `pnpm-workspace.yaml` override to `^4.18.1`. | `pnpm audit` |
| D2 | High (dev-only) | braces ReDoS through shadcn's build tooling (GHSA-vfj7-8cjw-p6xm). | `pnpm audit` | **Accepted:** no patched version is published; not in the runtime image. `shadcn` moved to devDependencies. | |

## Checked and found fine (summary)

- **Credentials and sessions:**
  - Customer API keys: random, stored as sha256, looked up by hash.
  - Upstream keys: AES-256-GCM with a random IV; only `secretHint` reaches the UI; never selected into client components.
  - Sessions, verification and reset tokens: hashed, expiring, single use.
  - Passwords: argon2id.
  - Cron and webhook secrets: compared in constant time; Stripe signatures are verified on the raw body.
- **Data isolation:**
  - Owner checks on files, uploads, container files, videos, responses and batches; listings are served from our own records.
  - Admin actions re-check the role on every call; customer actions are scoped by `userId`.
  - The CSV exports guard against formula injection.
  - The Markdown renderer emits React elements only.
- **Payments:** no double credit (`settleSucceededPayment` is idempotent); redeem codes are claimed under a row lock; top-up amounts are validated; all money is handled as Decimal.
- **Upstream traffic:**
  - Only allow-listed headers are forwarded in either direction; auth headers cannot be overridden.
  - The strict HTTP parser is used (no request smuggling).
  - Customer-facing errors are scrubbed (key, host, provider name).
  - CORS `*` is set only on the gateway and the public pricing endpoint, never with credentials.
- **Container:** non-root user, no secrets in layers, Secret Manager for every secret.

## Follow-up round (2026-10-19, same day)

Every item that was open after the first round was fixed at the owner's request ("fix all open decisions"): B5, B6, B9,
B10, B11, G9, G-i, I3, I8, I9, W7, W12, S4, S5 (see the rows above). Only D2 remains accepted: the braces advisory has no
patched release and the package is build tooling (devDependencies), not shipped in the runtime image. Re-check with
`pnpm audit` when a fix is published (dependabot will propose it).
