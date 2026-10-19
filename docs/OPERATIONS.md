# Operations runbook

For deployment see [DEPLOYMENT.md](DEPLOYMENT.md). For how things work see [ARCHITECTURE.md](ARCHITECTURE.md).
Commands assume `$SERVICE`, `$REGION` and `$PROJECT_ID` from `deploy/README.md`.

## Background jobs (cold by default)

By default **nothing runs on a timer and no provider is contacted while nobody uses the service**. The background
work runs while the server is busy anyway, as a side effect of real activity (an API call or an admin page), and is
throttled: upkeep at most every 5 minutes, billing at most hourly (`src/server/maintenance.ts`). An idle deployment
does nothing, so Cloud Run can scale it to zero.

| Job | Work | Activity-driven (default) | Timer (Settings > Monitoring) | Optional Cloud Scheduler route |
|---|---|---|---|---|
| `upkeep` | Provider health + uptime samples from the last 5 min of real calls (no upstream request), refund failed video jobs, sweep batches (meter ended ones), replay the metering dead-letter file, prune uptime history older than 35 days | every 5 min at most | `backgroundJobs` on: every `maintenanceIntervalMin` (5) | `/api/cron/health` |
| `billing` | If Stripe is configured: auto-recharge sweep, postpaid settlement, reconcile `PENDING` payments older than 24 h | hourly at most | `backgroundJobs` on: hourly | `/api/cron/billing` |
| `probes` | Uptime ping of every non-disabled key of every ACTIVE provider (a free model-list request): key status INVALID on bad auth, COOLDOWN on 429/402, ACTIVE again on success; ping history | never | `activeHealthChecks` on: every `healthCheckIntervalMin` (5) | `/api/cron/health` (only while `activeHealthChecks` is on) |

Each run is claimed atomically in the `JobRun` table, so instances, timers and Cloud Scheduler never run a job twice
in its interval. `/admin/status` shows the mode and the last run of each job. **Run checks now** pings on demand.

Timers only fire while an instance is running. For 24/7 monitoring of an idle deployment either keep one instance
(`--min-instances=1`) and turn the timers on, or add the Cloud Scheduler jobs (they wake an instance; both routes
take `Authorization: Bearer $CRON_SECRET`, GET or POST):

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://$DOMAIN/api/cron/health
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://$DOMAIN/api/cron/billing
```

While nothing runs (idle and timers off) you do not lose anything permanently: failed-video refunds and batch
metering also happen when the customer polls, dead letters are replayed at every instance start, auto-recharge is
also triggered after each metering flush, and everything else catches up on the next call. Expired COOLDOWN keys
come back on their own; INVALID keys need a ping (Run checks now) or **Reset**.

## Metering dead letters

The meter writer never drops usage silently. Rows it cannot write after retries and per-row isolation are appended
to `$METER_DEADLETTER_DIR/providerproxy-meter-deadletter.jsonl` (default: the OS temp dir) **and** logged.

| Log message (severity ERROR) | Meaning |
|---|---|
| `METER_DEAD_LETTER` | One row dead-lettered. The log entry contains the full row, the reason, and `debited` (balance already applied through the fallback). |
| `METER_BUFFER_SPILLED` | The whole buffer went to disk (DB outage > 30 s, or shutdown) |
| `METER_DEAD_LETTER_FILE_WRITE_FAILED` | Could not write the file. The log entry is now the only copy. |
| `METER_DEAD_LETTER_REPLAY_FAILED` / `METER_DEAD_LETTER_POISONED` | Replay failed / gave up after 10 attempts (moved to `providerproxy-meter-poison.jsonl`) |
| `meter dead letter replayed` (INFO) | Replay result `{found, replayed, failed, kept}` |

Replay runs automatically 3 s after start-up and with every upkeep run. It is idempotent: `skipDuplicates`, and
rows marked `debited` do not touch balances again. Trigger it manually with `/api/cron/health`.

**Cloud Run caveat:** the temp dir is in memory and local to the instance. If the instance is gone before a replay,
the file is gone too. The `METER_DEAD_LETTER` / `METER_BUFFER_SPILLED` log lines are then the record. To recover
from them:
1. Filter in Cloud Logging: `jsonPayload.message=~"^METER_"`.
2. For each row, check whether `RequestLog` with that `id` exists. If not, insert it. If `debited` is false, also
   debit `User.balance`, `ApiKey.spent` and `ProviderKey.totalCost` by its price / cost.
3. Alternatively, mount a persistent volume (for example a Cloud Storage volume) and set `METER_DEADLETTER_DIR` to
   it, so the file survives instances.

Fix the root cause first (DB down, connection limit, migration not applied: Prisma "Unknown argument" errors go
straight to isolation).

## Key rotation

| Secret | How | Impact |
|---|---|---|
| Upstream provider key | Admin > Providers > key > **Rotate secret** (or add the new key, then disable and delete the old one) | None. Takes effect within seconds. Files, batches and responses are pinned to the key record. Use **Rotate secret** only when the new secret belongs to the same upstream account or project. For a different account, add a new key and keep the old one until the objects pinned to it are no longer needed. |
| `ENCRYPTION_KEY` | **There is no re-encryption tool.** Rotating makes every stored `ProviderKey.secretEncrypted` and every customer `totpSecret` unreadable. | Plan it: rotate in a maintenance window, then re-enter every upstream key (Rotate secret) and have 2FA users set up 2FA again. Back the key up. Losing it has the same effect. |
| `SESSION_SECRET` | New Secret Manager version + new revision | Only used by the `hmac()` helper, which nothing calls today. Sessions are DB rows (sha256 of the cookie token), so rotating does **not** sign anyone out. To sign everyone out, delete the `Session` rows. |
| `CRON_SECRET` | New version + new revision + update both Scheduler jobs' header | Crons get 401 until both sides match |
| `STRIPE_WEBHOOK_SECRET` | Roll the secret in Stripe, store it, new revision | Webhooks fail signature checks in between. Stripe retries them. |
| `STRIPE_SECRET_KEY` | New version + new revision | |
| DB password | `gcloud sql users set-password`, update `DATABASE_URL`, new revision, update the migration job | Brief connection errors. The meter writer buffers and retries. |
| Customer API keys | Customers revoke and create in the portal. Admins disable/revoke in Admin > API Keys. | Immediate (cache invalidation) |

Rolling a secret into the service:

```bash
printf %s "$NEW" | gcloud secrets versions add NAME --data-file=-
gcloud run services update $SERVICE --region=$REGION --update-secrets=NAME=NAME:latest
```

## Provider outage

The gateway handles most of it automatically. Failing keys go to cooldown, requests fail over to other keys and
routes before anything reaches the client, and once failover is exhausted clients get the upstream's own
429/5xx/529 with `retry-after`, so SDKs retry.

1. **Confirm**: `/admin/status` (provider DOWN/DEGRADED, failed checks), `/admin/logs` filtered by provider and
   status, Cloud Logging `jsonPayload.message="gateway request failed"`.
2. **Reduce impact**:
   - Add or raise a fallback route on another provider for the affected models (Admin > Models > Routes, higher
     priority), or disable the failing route.
   - Disable the provider (Admin > Providers) to skip it entirely.
   - If the cause is our account (401/402/403 show up as 503 `no_available_provider` and as key status
     INVALID/COOLDOWN), top up or replace the upstream key.
3. **Tell customers**: post an announcement (Admin > Settings). The public `/status` page updates from real
   traffic.
4. **Recover**: when the provider is back, COOLDOWN keys come back when their cooldown expires. INVALID keys come
   back on the next successful ping (**Run checks now**, or timed uptime monitoring), or when you click **Reset** on the key. Re-enable the routes and
   providers.

## Incident checklist

1. `curl https://$DOMAIN/api/healthz`: 503 means the DB is down; `redis: "down"` means degraded but serving.
2. `gcloud run services logs tail $SERVICE --region=$REGION`, or Cloud Logging with `severity>=WARNING`.
3. Is it one model, one provider, or everything? Use `/admin/logs` (status, error code) and `/admin/status`.
4. Check capacity: `/admin/providers` live slots. Many `no_capacity` 429s mean you should raise key concurrency or add
   keys. Many `rate_limited` 429s are customer-side limits.
5. Check money: 402 spikes (customer balances or a pricing mistake, see `/admin/analytics`), `METER_*` errors,
   failed crons.
6. Recent deploy? Roll back:
   `gcloud run services update-traffic $SERVICE --region=$REGION --to-revisions=REVISION=100`.
   Migrations are forward-only, so a rollback must be compatible with the new schema.
7. Afterwards: replay dead letters (`/api/cron/health`), check that balances match (`sum(RequestLog.price)` vs debits for
   the affected window), and refund or credit customers if needed (Admin > Customers > Add credit > Refund).

## Monitoring

Logs are JSON lines on stdout, one object per line, with `severity` (`DEBUG` / `INFO` / `WARNING` / `ERROR`),
`message` and `time`, plus context fields. Cloud Logging parses `severity` automatically. Set the level with
`LOG_LEVEL`.

| Message / fields | Use |
|---|---|
| `gateway request failed` (WARNING): `requestId`, `endpoint`, `status` (UPSTREAM_ERROR / GATEWAY_ERROR), `httpStatus`, `errorCode`, `model`, `providerKeyId`, `attempts`, `detail` | Upstream and gateway failures. Client errors are only in `RequestLog`. |
| `gateway internal error`, `GATEWAY_ERROR`, `stream finalize failed` (ERROR) | Our bugs. Correlate by `requestId` (= `x-request-id` = `RequestLog.id`). |
| `health check changed an upstream key state`, `upstream key marked INVALID` | Upstream account problems |
| `METER_*`, `meter flush failed, will retry` | Metering durability (alert on these) |
| `billing cron finished` / `billing cron failed`, `health cron failed`, `batch metering failed`, `video refund failed` | Cron health |
| `auto-recharge disabled after repeated failures`, `postpaid settlement failed`, `payment amount differs from amount received` | Billing |
| `redis error`, `redis slot acquire failed, using memory fallback` | Redis degraded (still serving, but per instance) |
| `shutdown: draining` / `shutdown: exiting` (`activeRequests`, `forced`) | Deploys and scale-in. `forced: true` means streams were cut at the drain limit. |

Suggested alerts: any `severity=ERROR` with `message=~"^METER_"`; a high rate of `gateway request failed`; uptime
checks on `/api/healthz`; Cloud Scheduler job failures; Cloud SQL CPU and connections.

Business metrics live in the app (`/admin` overview, `/admin/analytics`): revenue, cost, profit, margin, error
rate, p50/p95 latency.

## Data retention and backups

- **Cloud SQL**: enable automated backups and point-in-time recovery
  (`gcloud sql instances patch $SQL_INSTANCE --backup-start-time=03:00 --enable-point-in-time-recovery`). Test a
  restore into a scratch instance now and then. On-demand: `gcloud sql backups create --instance=$SQL_INSTANCE`.
- **Export**: `gcloud sql export sql $SQL_INSTANCE gs://BUCKET/proxy-$(date +%F).sql.gz --database=proxy`.
- **`ENCRYPTION_KEY`**: back it up separately from the DB backups. A DB restore is useless for upstream keys and
  TOTP without it.
- **Redis** holds only ephemeral state (slots, holds, caches, sticky Responses ids). It needs no backup. Losing it
  releases slots and holds via TTL and makes old `resp_...` ids unreachable for follow-up calls.
- **Retention**: `HealthCheck` rows are pruned after 14 days. `RequestLog`, `LedgerEntry`, `AuditLog` and
  `EmailOutbox` are kept forever. `RequestLog` is the largest table, so plan partitioning or archiving when it grows.
  With `logBodies` on it also stores full request and response bodies.
