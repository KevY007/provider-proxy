# Deployment (Google Cloud)

This page summarises the production setup and explains why each piece is configured the way it is. The exact
copy/paste `gcloud` commands are in **[deploy/README.md](../deploy/README.md)**; the section numbers below match it.

```
Client -> Cloud Run (one container: UI + gateway, --use-http2) -> Cloud SQL (Postgres 16, unix socket)
                                     |-> Memorystore Redis (optional, Serverless VPC connector)
(optional) Cloud Scheduler -> POST /api/cron/health, POST /api/cron/billing   [Bearer CRON_SECRET]
Cloud Run Job (same image) -> prisma migrate deploy
Secret Manager -> env vars          Stripe -> POST /api/stripe/webhook
```

Any Docker host works too: `docker compose -f docker-compose.prod.yml up -d --build`. That starts app, Postgres
and Redis, and a one-shot `migrate` service runs `migrate deploy` before the app starts. `POSTGRES_PASSWORD` must be
set in `.env`; compose refuses to start without it. The app port is published directly with
`TRUSTED_PROXY_HOPS=0`, so the client IP comes from the socket. If you put a TLS proxy in front, set the number of
proxies instead.

## The image

`Dockerfile` (multi-stage, Node 24 slim, non-root user `nextjs`):
- `build`: `prisma generate` + `next build` (standalone output).
- `migrator`: an isolated Prisma CLI with the schema and migrations in `/prisma-cli`.
- `runner`: standalone server + `server.mjs` + `/prisma-cli`. `CMD ["node", "server.mjs"]`, `PORT=8080`,
  `KEEP_ALIVE_TIMEOUT=620000`, `SHUTDOWN_DRAIN_SECONDS=600`. The healthcheck calls `/api/healthz`.

`server.mjs` serves HTTP/1.1 **and** h2c on one port. HTTP/2 is required end to end on Cloud Run, while health
probes and `curl` still use HTTP/1.1.

## Steps

| # | Step | Notes |
|---|---|---|
| 1 | Enable APIs | run, cloudbuild, artifactregistry, sqladmin, secretmanager, cloudscheduler, redis, vpcaccess, compute |
| 2 | Artifact Registry repo | Docker format |
| 3 | Cloud SQL Postgres 16 | Database `proxy`, user `proxy`. `DATABASE_URL=postgresql://proxy:PASS@localhost/proxy?host=/cloudsql/PROJECT:REGION:INSTANCE` (URL-encode the password). Keep `max-instances x DB_POOL_SIZE` under the instance's connection limit. Use `--availability-type=regional` for HA. |
| 4 | Memorystore Redis + VPC connector (optional) | Recommended with more than one instance. Without it, slots, holds, rate limits, sticky Responses and cache invalidation are per instance (invalidation then waits for the 30 s TTL). |
| 5 | Secret Manager | `DATABASE_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `CRON_SECRET`, `ADMIN_PASSWORD`, optionally `REDIS_URL`, `STRIPE_*` and `SMTP_URL` |
| 6 | Service account | `roles/cloudsql.client`, `roles/secretmanager.secretAccessor`. Cloud Build needs `run.admin` and `iam.serviceAccountUser` on it. |
| 7 | Build | `gcloud builds submit --tag $IMAGE .` |
| 8 | Migration job | Cloud Run Job on the same image: `sh -c "cd /prisma-cli && node node_modules/prisma/build/index.js migrate deploy"` (`deploy/migrate.sh` does the same). Run it before every deploy that contains migrations. |
| 9 | Cloud Run service | Flags below. Seed once from a workstation through the Cloud SQL Auth Proxy with `NODE_ENV=production pnpm db:seed`. |
| 10 | CI/CD (optional) | `deploy/cloudbuild.yaml`: build, push, update + execute the migration job, deploy with `--use-http2 --timeout=3600 --no-cpu-throttling` |
| 11 | Cloud Scheduler + Stripe webhook | See below |
| 12 | Custom domain | Domain mapping, or a Global external HTTPS LB with a serverless NEG (then `TRUSTED_PROXY_HOPS=2`; keep CDN off for `/v1/*`) |

**Generate the secrets** (losing `ENCRYPTION_KEY` makes every stored upstream key and TOTP secret unreadable, so back
it up outside GCP as well):

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY (exactly 32 bytes)
openssl rand -hex 24      # CRON_SECRET
```

## Cloud Run flags that matter

| Flag | Why |
|---|---|
| `--use-http2` | **Required.** Cloud Run caps HTTP/1.1 request bodies at 32 MiB. Only end-to-end h2c lifts the cap, which large Files uploads, multipart and huge prompts need. |
| `--timeout=3600` | Maximum request time (60 min) for long streams. No request can outlive it on Cloud Run. |
| `--no-cpu-throttling` | CPU stays allocated after the response, so the metering buffer flushes and heartbeats keep flowing. Billing is per instance lifetime, and an idle instance is still shut down. |
| `--min-instances=0` (default) | Scale to zero when nobody calls: no instance cost while idle. The first call after an idle period waits for a cold start (a few seconds). Use `--min-instances=1` for no cold starts, or for 24/7 timers (see below). |
| `--concurrency=250` | Streams are I/O bound. Lower it if CPU saturates. |
| `--execution-environment=gen2`, `--cpu=2 --memory=2Gi --cpu-boost` | Multipart and JSON bodies are spooled to `/tmp`, which is **in memory** on Cloud Run. Size memory for the uploads in flight at once. JSON bodies take about 3x their size while parsed. |
| `--add-cloudsql-instances`, `--vpc-connector --vpc-egress=private-ranges-only` | DB socket; Redis (drop if no Redis) |
| `--startup-probe` / `--liveness-probe` `httpGet.path=/api/healthz` | Only the DB gates readiness |
| env `APP_URL=https://$DOMAIN`, `TRUSTED_PROXY_HOPS=1` (2 behind a Global LB), `DB_POOL_SIZE`, `ADMIN_EMAIL`, `EMAIL_FROM` | |

Drain and shutdown: on SIGTERM the container stops accepting connections, sends GOAWAY / `Connection: close`, lets
in-flight requests finish (up to `SHUTDOWN_DRAIN_SECONDS`), flushes the meter buffer and exits 143. Cloud Run
force-kills 10 s after SIGTERM, so only graceful shutdowns are lossless: rolling deploys, where old revisions drain,
and scale-in of idle instances. Keep deploys rolling (the default). On plain Docker use
`docker stop -t <SHUTDOWN_DRAIN_SECONDS>`.

Upstream HTTP/2 is separate from `--use-http2` and is off by default. Enable it per provider with
`"http2": true` in the provider's Settings JSON, and only for providers known to handle h2 well, because one lost h2
connection ends every stream on it.

## Running cold (cost) and 24/7 monitoring

The defaults keep an idle deployment idle:

- **The app** does nothing without activity. No in-process timer runs, no provider is pinged, and background upkeep
  happens only while calls or admin pages are served ([OPERATIONS.md](OPERATIONS.md#background-jobs-cold-by-default)).
  With `--min-instances=0` Cloud Run then scales to zero, so the Cloud Run cost of an idle service is zero.
- **What still costs money while idle** is the infrastructure that is always on whatever the app does: Cloud SQL
  (choose the smallest tier you need, or a serverless Postgres that can scale to zero), Memorystore Redis if you use
  it (optional; skip it for a single-instance deployment), a Serverless VPC connector if you use one (it keeps at least
  2 small VMs running; Direct VPC egress `--network=default --subnet=default --vpc-egress=private-ranges-only` has no
  idle cost), Secret Manager and Artifact Registry storage (cents).
- **Do not create the Cloud Scheduler jobs** for a cold deployment: each run wakes an instance.

For **24/7 uptime checks and timed jobs**, turn on **Settings > Monitoring > Uptime monitoring** and/or **Background
jobs on a timer** (intervals default to 5 minutes). Timers run inside a running instance, so also do one of these:

- keep an instance up: `gcloud run services update $SERVICE --region=$REGION --min-instances=1`, or
- keep `--min-instances=0` and add the Cloud Scheduler jobs below. Each run wakes an instance, which then
  stays up for up to about 15 minutes.

## Cron jobs (Cloud Scheduler, optional)

Only for 24/7 monitoring without a permanent instance (see above). The routes run the same jobs as the timers, and
the uptime pings only when Uptime monitoring is on.

```bash
CRON_SECRET_VALUE=$(gcloud secrets versions access latest --secret=CRON_SECRET)
gcloud scheduler jobs create http pp-health-cron --location=$REGION --schedule="*/5 * * * *" --time-zone=Etc/UTC \
  --uri="https://$DOMAIN/api/cron/health" --http-method=POST \
  --headers="Authorization=Bearer $CRON_SECRET_VALUE" --attempt-deadline=120s
gcloud scheduler jobs create http pp-billing-cron --location=$REGION --schedule="0 * * * *" --time-zone=Etc/UTC \
  --uri="https://$DOMAIN/api/cron/billing" --http-method=POST \
  --headers="Authorization=Bearer $CRON_SECRET_VALUE" --attempt-deadline=180s
```

What they do is listed in [OPERATIONS.md](OPERATIONS.md#cron-jobs). Both routes have `maxDuration = 300`. If you
rotate `CRON_SECRET`, update both scheduler jobs (`gcloud scheduler jobs update http ... --update-headers`).

## Migrations

- Run `gcloud run jobs execute $SERVICE-migrate --region=$REGION --wait` before the new revision takes traffic.
  `cloudbuild.yaml` does this automatically and fails the build if a migration fails.
- Migrations are forward-only (`prisma migrate deploy`). Make them backwards compatible with the running revision
  (additive first, destructive in a later release), because old instances keep serving while they drain.
- Local check before deploying: `pnpm db:deploy` against a copy of production.

## Stripe

1. Set `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` (live keys) as secrets.
2. In the Stripe dashboard, add the webhook endpoint `https://$DOMAIN/api/stripe/webhook` with these events. They
   are the ones the code handles (`HANDLED_EVENTS` in `src/server/billing/webhook.ts`):
   `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`,
   `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`,
   `setup_intent.succeeded`, `payment_method.detached`.
3. Put the signing secret in `STRIPE_WEBHOOK_SECRET` and roll a revision
   (`gcloud run services update $SERVICE --update-secrets=STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest`).
4. Test with `stripe trigger payment_intent.succeeded`, or by making a small real top-up.

Without Stripe the app runs normally. Billing pages show "Stripe not configured", and only redeem codes and admin
credits add balance. The billing cron is then a no-op apart from the batch sweep.

## Email (SMTP)

Set `SMTP_URL=smtp://user:pass@host:587` (any SMTP provider) and `EMAIL_FROM` to an address on a domain with
SPF/DKIM configured. Without `SMTP_URL`, emails are only logged and stored in `EmailOutbox`. Customers then cannot
verify their email, so either configure SMTP or turn off **Require email verification** in Admin > Settings.

## First boot checklist

1. `curl https://$DOMAIN/api/healthz` returns `{"ok":true,"db":"ok","redis":"ok"|"disabled"}`.
2. Log in as `ADMIN_EMAIL`, enable 2FA, and review **Admin > Settings** (signups, trial credit, top-up limits).
3. **Admin > Providers**: add upstream keys, click **Test**, then enable the provider. The seed creates providers
   disabled and without keys.
4. **Admin > Models**: enable or add models and check the prices (the "Quick start" checklist on the admin overview
   guides you).
5. Make a test request with a customer key and check it in **Admin > Logs**.
6. Confirm both scheduler jobs ran: the last run shows success in Cloud Scheduler, and the billing cron logs
   `billing cron finished`. Run one by hand with **Force run** (`gcloud scheduler jobs run pp-health-cron --location=$REGION`).
