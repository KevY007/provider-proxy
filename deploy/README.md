# Deploying ProviderProxy to Google Cloud

Target architecture (see `docs/PLAN.md` section 10):

```
Client -> Cloud Run (one container: UI + gateway, scales to zero) -> Supabase Postgres (pooler, TLS)
                                   |-> Memorystore Redis (scale-out profile only, Direct VPC egress)
(optional) Cloud Scheduler -> POST /api/cron/billing, /api/cron/health
Cloud Run Job (same image) -> prisma migrate deploy
Secret Manager -> env vars
```

**Two profiles.** Start with **lean**: one Cloud Run instance at most, no Redis, no VPC, scales to zero. The
only always-on cost is the database (Supabase). Move to **scale-out** (Redis + several instances) when one instance is no longer
enough. Steps marked *(scale-out)* are skipped in the lean profile. Costs: [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md#profiles-and-cost).

Everything below is copy/paste `gcloud`. Replace the variables in step 0. Run from a Cloud Shell or any
machine with `gcloud` authenticated (`gcloud auth login`).

> The app also runs on any Docker host: `docker compose -f docker-compose.prod.yml up -d --build`
> (app + postgres + redis, migrations run automatically).

## 0. Variables

```bash
export PROJECT_ID=my-project
export REGION=us-west1                    # next to Supabase us-west-2 (Oregon)
export REPO=providerproxy                 # Artifact Registry repo
export SERVICE=providerproxy              # Cloud Run service
export SA=providerproxy-run               # runtime service account name
export DOMAIN=api.example.com             # your public hostname
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$SERVICE:latest

gcloud config set project $PROJECT_ID
```

## 1. Enable APIs

```bash
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com \
  redis.googleapis.com compute.googleapis.com     # redis + compute: scale-out profile only
```

## 2. Artifact Registry

```bash
gcloud artifacts repositories create $REPO --repository-format=docker --location=$REGION \
  --description="ProviderProxy images"
```

## 3. Database: Supabase (Postgres)

The app needs a plain Postgres database; it does not use Supabase Auth, Storage or the Data API. Two ways:

- **Recommended: a dedicated Supabase project** (Supabase dashboard > New project, in the same organization, region
  `us-west-2` next to the Cloud Run region `us-west1`). Fully isolated from your main app: its own compute,
  connections and backups, so neither can slow down or break the other. Cost: the project's compute (Micro, about
  $10/month on the Pro plan).
- **No extra cost: a dedicated schema inside an existing project.** Run `deploy/supabase-setup.sql` once: it creates a
  `provider_proxy` login that owns a `provider_proxy` schema and can touch nothing else (other schemas, Auth,
  Storage), capped at 20 connections with 60 s statement / idle-transaction timeouts, so the proxy can never starve
  or lock the other app. Connect as `provider_proxy.<project-ref>` with `?schema=provider_proxy`, through the
  **session** pooler (port 5432). It shares the project's compute and backups (a point-in-time restore rolls both
  back).

Connection strings come from the project's **Connect** dialog (Supabase dashboard). Cloud Run has no IPv6 egress and
the direct host `db.<ref>.supabase.co` is IPv6-only, so use the **pooler** host (IPv4):

| Variable | Value | Used by |
|---|---|---|
| `DATABASE_URL` | Transaction pooler: `postgresql://postgres.<ref>:<PASSWORD>@aws-0-us-west-2.pooler.supabase.com:6543/postgres` (dedicated project). With `?schema=`: the session pooler, port `5432`. | the app, the seed job |
| `DIRECT_URL` | Session pooler: same host, port `5432` (+ `?schema=...` if used) | the migration job (`prisma migrate deploy` needs a session connection) |
| `DATABASE_CA_CERT` | Supabase's CA: Database settings > SSL Configuration > **Download certificate** (`prod-supabase.cer`, its content) | the app, the seed job |

URL-encode special characters in the password, and copy the exact pooler host (`aws-0-...` or `aws-1-...`) from the
dashboard. The app verifies the server certificate and host name against `DATABASE_CA_CERT` (verify-full); without it
`pg` would check the certificate against the public CAs and refuse Supabase's. Turn on **Enforce SSL** in Database
settings.

Pool size per instance is `DB_POOL_SIZE`: keep `max-instances x DB_POOL_SIZE` under the project's pooler limits
(pool size in Database settings > Connection pooling; max pooler clients per compute size). The lean profile uses
1 instance x 8; leave headroom for the second instance that runs briefly during a rolling deploy and for the
migration job (with the isolated role from `deploy/supabase-setup.sql`, connection limit 20: 2 x 8 + migrations fit). Backups: the Pro plan takes daily backups (kept 7 days); point-in-time recovery is a paid add-on.

## 4. Memorystore Redis (scale-out profile only)

Skip this in the lean profile. Without Redis the app keeps rate limits, concurrency slots, funds holds and cache
invalidation in memory, which is exact for **one** instance, so the lean profile pins `--max-instances=1`. As soon as
you run more than one instance you need Redis, so those limits and holds are shared.

Give the proxy its own small network (nothing else uses it) and a password-protected instance. `standard` keeps a
replica in a second zone and fails over automatically; `basic` is half the price without that.

```bash
gcloud services enable compute.googleapis.com redis.googleapis.com
gcloud compute networks create $SERVICE-vpc --subnet-mode=custom
gcloud compute networks subnets create $SERVICE-$REGION --network=$SERVICE-vpc --region=$REGION \
  --range=10.80.0.0/20 --enable-private-ip-google-access      # /20 = room for ~4000 instances' egress addresses
gcloud redis instances create $SERVICE-redis --region=$REGION --tier=standard --size=1 --redis-version=redis_7_2 \
  --network=projects/$PROJECT_ID/global/networks/$SERVICE-vpc --enable-auth --redis-config=maxmemory-policy=volatile-lru

export REDIS_HOST=$(gcloud redis instances describe $SERVICE-redis --region=$REGION --format='value(host)')
export REDIS_AUTH=$(gcloud redis instances get-auth-string $SERVICE-redis --region=$REGION --format='value(authString)')
printf 'redis://:%s@%s:6379/0' "$REDIS_AUTH" "$REDIS_HOST" | gcloud secrets create REDIS_URL --data-file=-
```

The service reaches Redis through **Direct VPC egress** (flags in step 9). Unlike a Serverless VPC connector it has
no VMs that bill while the service is idle. Every key the app writes has a TTL, so `volatile-lru` only ever evicts
expired-soon data; 1 GB holds the shared state of a very large deployment.

> Memorystore bills around the clock, even when the service is idle (1 GB: roughly $35/month basic, $70/month
> standard; check the pricing page for your region).

## 5. Secrets (Secret Manager)

```bash
mk() { printf %s "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic; }

mk DATABASE_URL    "postgresql://postgres.<ref>:<PASSWORD>@aws-0-us-west-2.pooler.supabase.com:6543/postgres"   # step 3
mk DIRECT_URL      "postgresql://postgres.<ref>:<PASSWORD>@aws-0-us-west-2.pooler.supabase.com:5432/postgres"   # step 3
gcloud secrets create DATABASE_CA_CERT --data-file=prod-supabase.cer --replication-policy=automatic     # Supabase CA (step 3)
mk SESSION_SECRET  "$(openssl rand -base64 48 | tr -d '\n')"
mk ENCRYPTION_KEY  "$(openssl rand -base64 32)"        # 32 bytes base64 - BACK THIS UP, losing it makes stored upstream keys unreadable
mk CRON_SECRET     "$(openssl rand -hex 24)"
mk ADMIN_PASSWORD  "choose-a-strong-admin-password"
# Optional / when ready:
mk REDIS_URL       "redis://$REDIS_HOST:6379"       # scale-out profile only
mk STRIPE_SECRET_KEY      "sk_live_..."
mk STRIPE_PUBLISHABLE_KEY "pk_live_..."
mk STRIPE_WEBHOOK_SECRET  "whsec_..."                  # created in step 11
mk SMTP_URL        "smtps://resend:re_YOUR_RESEND_API_KEY@smtp.resend.com:465"   # Resend SMTP (any SMTP works)
```

## 6. Service account and IAM

```bash
gcloud iam service-accounts create $SA --display-name="ProviderProxy runtime"
export SA_EMAIL=$SA@$PROJECT_ID.iam.gserviceaccount.com

# secrets: grant access per secret (ADMIN_PASSWORD is read only by the seed job; the service itself never maps it)
# (skip the names you did not create, e.g. REDIS_URL in the lean profile)
for s in DATABASE_URL DIRECT_URL DATABASE_CA_CERT SESSION_SECRET ENCRYPTION_KEY ADMIN_PASSWORD CRON_SECRET REDIS_URL STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET SMTP_URL; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA_EMAIL --role=roles/secretmanager.secretAccessor
done

# Cloud Build needs to deploy Cloud Run + act as the runtime SA
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
export CB_SA=$PROJECT_NUMBER@cloudbuild.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$CB_SA --role=roles/run.developer
gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL --member=serviceAccount:$CB_SA --role=roles/iam.serviceAccountUser
```

## 7. Build and push the image

```bash
gcloud builds submit --tag $IMAGE .          # uses the root Dockerfile
```

(Or let `deploy/cloudbuild.yaml` do build + migrate + deploy, see step 10.)

## 8. Migration job (Cloud Run Job, same image)

```bash
gcloud run jobs create $SERVICE-migrate \
  --image=$IMAGE --region=$REGION --service-account=$SA_EMAIL \
  --set-secrets=DIRECT_URL=DIRECT_URL:latest \
  --command=sh --args="-c,cd /prisma-cli && node node_modules/prisma/build/index.js migrate deploy" \
  --max-retries=0 --task-timeout=600

gcloud run jobs execute $SERVICE-migrate --region=$REGION --wait
```

Re-run the job after every deploy that contains new migrations (`cloudbuild.yaml` does this for you).

## 9. Deploy the Cloud Run service

Flags that matter for a streaming gateway:

* `--use-http2` - **end-to-end HTTP/2 (h2c) to the container.** Cloud Run caps HTTP/1.1 request bodies at
  **32 MiB**; only HTTP/2 end-to-end lifts that cap, so uploads of hundreds of MB (Files API, multipart image /
  audio / video uploads, huge prompts) need it. The image serves HTTP/1.1 **and** h2c on the same port
  (`server.mjs` sniffs the first bytes of every connection), so health probes, `docker run` and plain `curl`
  keep working.
* `--timeout=3600` - the Cloud Run maximum (60 minutes per request); long streams are not cut at the default 5 min.
  A single request (stream or upload) can never live longer than this on Cloud Run.
* `--concurrency=250` - requests per instance (streams are I/O bound; lower if you see CPU saturation). With
  `--use-http2` many streams share one connection, so concurrency is not limited by connections.
* `--max-instances=1` (lean, no Redis) - required without Redis (see step 4). One instance at `--concurrency=250`
  carries a lot of proxy traffic because streams are I/O bound. Scale-out: raise it, together with Redis.
* `--cpu=1 --memory=1Gi` (lean) or `--cpu=2 --memory=2Gi` (scale-out / large uploads).
* `--cpu-boost` - extra CPU while an instance starts, which shortens cold starts.
* `--startup-probe ... initialDelaySeconds=0,periodSeconds=1` - an instance gets traffic about as soon as it is ready
  (the app is ready about 1 s after the container starts; a slower probe would add seconds to every cold start).
* `--min-instances=0` - scale to zero while nobody calls: an idle service has no Cloud Run cost, and the app itself
  runs no timer and pings nothing by default (docs/OPERATIONS.md, "Background jobs"). Use `1` to avoid cold starts
  or to run the optional 24/7 monitoring timers (Settings > Monitoring).
* `--no-cpu-throttling` - CPU stays allocated after the response so post-response metering completes and
  heartbeats keep flowing on silent streams.
* `--execution-environment=gen2`.
* Size `--memory` for uploads: a multipart/JSON body is spooled to the instance's temp directory and Cloud Run's
  filesystem is **in memory**, so in-flight uploads count against the instance memory (about the sum of the bodies
  being uploaded at that moment). `2Gi` is fine for a few concurrent 500 MB uploads; raise it (or lower
  `--concurrency`) if you expect many large uploads at once. Streamed passthrough (Files API uploads, downloads,
  completions) uses only a few MB per request.

Lean profile (no Redis, scales to zero):

```bash
gcloud run deploy $SERVICE \
  --image=$IMAGE --region=$REGION --service-account=$SA_EMAIL \
  --allow-unauthenticated \
  --execution-environment=gen2 \
  --use-http2 \
  --timeout=3600 --concurrency=250 \
  --min-instances=0 --max-instances=1 \
  --no-cpu-throttling --cpu=1 --memory=1Gi --cpu-boost \
  --set-env-vars="APP_URL=https://$DOMAIN,ADMIN_EMAIL=you@example.com,EMAIL_FROM=ProviderProxy <no-reply@$DOMAIN>,DB_POOL_SIZE=8,TRUSTED_PROXY_HOPS=1" \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,DATABASE_CA_CERT=DATABASE_CA_CERT:latest,SESSION_SECRET=SESSION_SECRET:latest,ENCRYPTION_KEY=ENCRYPTION_KEY:latest,CRON_SECRET=CRON_SECRET:latest,STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest,STRIPE_PUBLISHABLE_KEY=STRIPE_PUBLISHABLE_KEY:latest,STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest,SMTP_URL=SMTP_URL:latest" \
  --startup-probe=httpGet.path=/api/healthz,initialDelaySeconds=0,periodSeconds=1,timeoutSeconds=1,failureThreshold=60 \
  --liveness-probe=httpGet.path=/api/healthz,periodSeconds=30
```

Scale-out profile (after step 4): change these flags, add the Redis secret and switch the database URL to the
**transaction pooler** (Supabase: port 6543 instead of 5432; `DIRECT_URL` for migrations stays on the session
pooler):

```bash
  --max-instances=100 --concurrency=500 --cpu=2 --memory=2Gi \
  --network=$SERVICE-vpc --subnet=$SERVICE-$REGION --vpc-egress=private-ranges-only \
  --set-secrets="...,DATABASE_URL=DATABASE_URL_POOLED:latest,REDIS_URL=REDIS_URL:latest" \
  --set-env-vars="...,DB_POOL_SIZE=2"
```

Why these numbers: the request path needs no database round trip (auth, limits, holds and config are cached or in
Redis; metering is batched), so each instance needs only a couple of connections. With the transaction pooler,
`max-instances x DB_POOL_SIZE` client connections (here at most 200) share the role's own connection limit (20 in
`deploy/supabase-setup.sql`) on the database, so the proxy can never take connections away from other apps on the
same database. 100 instances x 500 concurrent requests = 50,000 requests in flight; for more, raise
`--max-instances` (Cloud Run quota: "Maximum instances per service" / regional CPU) and the pooler's client limit
(Supabase compute size) together. Idle, it still scales to zero.

Always on, no cold starts (e.g. while the service fronts your main app around the clock):
`gcloud run services update $SERVICE --region=$REGION --min-instances=1`.

Drop the Stripe/SMTP secrets you did not create (the app treats them as optional).

> The container listens on `$PORT` (Cloud Run injects 8080). `TRUSTED_PROXY_HOPS=1` makes client-IP
> detection read the last `x-forwarded-for` entry appended by Google's front end; use `2` if you put a
> Global HTTPS Load Balancer in front - and then ALSO restrict ingress
> (`gcloud run services update $SERVICE --ingress=internal-and-cloud-load-balancing`), otherwise a client can call the
> `*.run.app` URL directly with a forged `X-Forwarded-For` entry and pass the per-key IP allowlist / login throttles.
> Self-hosted without any proxy in front: `TRUSTED_PROXY_HOPS=0` (the socket address is used; `docker-compose.prod.yml`
> sets it).

### Seed the first admin + defaults (once)

The image contains a one-file seed (`seed.mjs`): settings, the pools, the first admin (`ADMIN_EMAIL` +
`ADMIN_PASSWORD`), the provider presets (disabled, without keys) and the model catalog. It is idempotent. Run it as a
Cloud Run Job on the same image (no workstation or database tunnel needed):

```bash
gcloud run jobs create $SERVICE-seed \
  --image=$IMAGE --region=$REGION --service-account=$SA_EMAIL \
  --command=node --args=seed.mjs \
  --set-env-vars="NODE_ENV=production,ADMIN_EMAIL=you@example.com" \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,DATABASE_CA_CERT=DATABASE_CA_CERT:latest,ENCRYPTION_KEY=ENCRYPTION_KEY:latest,ADMIN_PASSWORD=ADMIN_PASSWORD:latest" \
  --max-retries=0 --task-timeout=300
gcloud run jobs execute $SERVICE-seed --region=$REGION --wait
```

Then log in as the admin, set up 2FA (required for staff in production), add upstream keys in **Admin > Providers**
and enable the providers you use.

## 10. Continuous deployment (push to `main` = deploy)

The deployment pulls from the repository: a **Cloud Build trigger** in your project watches `main` and, on every
push, builds the image (BuildKit), updates and runs the migration job, rolls the service to the new image (Cloud Run
moves traffic only once the new revision passes its startup probe, so a broken build never takes the site down),
keeps the seed job on the same image and checks `/api/healthz`. Nothing deployment-specific lives in the repository:
the build steps, project, region and service names are stored in the trigger, and forks or other clones never deploy
anywhere.

One-time setup (after steps 1-9):

1. Connect the repository: Cloud Build > Repositories > Connect repository > GitHub (install the Google Cloud Build
   GitHub app on the account that owns the repository, granting it only this repository).
2. A deploy service account that may build, push to this image repo only, and manage only this service and its jobs:

```bash
export DEPLOY_SA=$SERVICE-deploy@$PROJECT_ID.iam.gserviceaccount.com
gcloud iam service-accounts create $SERVICE-deploy --display-name="$SERVICE deploys"
gcloud artifacts repositories add-iam-policy-binding $REPO --location=$REGION --member=serviceAccount:$DEPLOY_SA --role=roles/artifactregistry.writer
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$DEPLOY_SA --role=roles/logging.logWriter
gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL --member=serviceAccount:$DEPLOY_SA --role=roles/iam.serviceAccountUser
gcloud run services add-iam-policy-binding $SERVICE --region=$REGION --member=serviceAccount:$DEPLOY_SA --role=roles/run.developer
for j in $SERVICE-migrate $SERVICE-seed; do
  gcloud run jobs add-iam-policy-binding $j --region=$REGION --member=serviceAccount:$DEPLOY_SA --role=roles/run.developer; done
```

3. The trigger, with its build steps kept in Google Cloud (`trigger-build.yaml` is a local file, not part of the
   repository):

```yaml
# trigger-build.yaml
substitutions:
  _REGION: us-west1                       # $REGION
  _SERVICE: provider-proxy                # $SERVICE
  _IMAGE: REGION-docker.pkg.dev/PROJECT_ID/REPO/provider-proxy
  _URL: https://SERVICE-URL               # the run.app URL or your domain
options: { logging: CLOUD_LOGGING_ONLY, machineType: E2_HIGHCPU_8 }
timeout: 2400s
steps:
  - id: build
    name: gcr.io/cloud-builders/docker
    env: ["DOCKER_BUILDKIT=1"]
    args: ["build", "-t", "${_IMAGE}:${SHORT_SHA}", "."]
  - id: push
    name: gcr.io/cloud-builders/docker
    args: ["push", "${_IMAGE}:${SHORT_SHA}"]
  - id: migrate
    name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    entrypoint: bash
    args: ["-ec", "gcloud run jobs update ${_SERVICE}-migrate --region=${_REGION} --image=${_IMAGE}:${SHORT_SHA} --quiet && gcloud run jobs execute ${_SERVICE}-migrate --region=${_REGION} --wait"]
  - id: deploy
    name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    entrypoint: bash
    args: ["-ec", "gcloud run deploy ${_SERVICE} --region=${_REGION} --image=${_IMAGE}:${SHORT_SHA} --quiet && (gcloud run jobs update ${_SERVICE}-seed --region=${_REGION} --image=${_IMAGE}:${SHORT_SHA} --quiet || true)"]
  - id: smoke
    name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    entrypoint: bash
    args: ["-c", "for i in 1 2 3 4 5 6; do curl -fsS --max-time 30 ${_URL}/api/healthz && exit 0; sleep 10; done; exit 1"]
```

```bash
gcloud builds triggers create github --name=$SERVICE-main --repo-owner=OWNER --repo-name=REPO_NAME \
  --branch-pattern='^main$' --inline-config=trigger-build.yaml \
  --service-account=projects/$PROJECT_ID/serviceAccounts/$DEPLOY_SA
gcloud builds triggers run $SERVICE-main --branch=main      # first deploy / redeploy by hand
```

Watch runs under Cloud Build > History. To change the pipeline, edit the trigger (console, or `gcloud builds triggers
import`); the repository stays deployment-agnostic. `deploy/cloudbuild.yaml` (build + migrate + deploy in one run)
and `deploy/cloudbuild-image.yaml` (image only, for `gcloud builds submit`) remain for manual builds.

## 11. Cron (Cloud Scheduler, optional) and Stripe webhook

The scheduler jobs are **optional**. Without them the background jobs run while the service handles calls and admin
pages (throttled), so an idle deployment stays at zero instances. Create them only if you want upkeep, billing and
uptime pings (when Settings > Monitoring > Uptime monitoring is on) to keep running while nobody uses the service.
Each run wakes an instance.

```bash
export CRON_SECRET_VALUE=$(gcloud secrets versions access latest --secret=CRON_SECRET)

gcloud scheduler jobs create http pp-billing-cron --location=$REGION \
  --schedule="0 * * * *" --time-zone="Etc/UTC" \
  --uri="https://$DOMAIN/api/cron/billing" --http-method=POST \
  --headers="Authorization=Bearer $CRON_SECRET_VALUE" --attempt-deadline=180s

gcloud scheduler jobs create http pp-health-cron --location=$REGION \
  --schedule="*/5 * * * *" --time-zone="Etc/UTC" \
  --uri="https://$DOMAIN/api/cron/health" --http-method=POST \
  --headers="Authorization=Bearer $CRON_SECRET_VALUE" --attempt-deadline=120s
```

**Stripe webhook:** in the Stripe dashboard (Developers > Webhooks) add the endpoint
`https://$DOMAIN/api/stripe/webhook` and subscribe to `payment_intent.succeeded`,
`payment_intent.payment_failed`, `payment_intent.canceled`, `checkout.session.completed`, `checkout.session.expired`,
`charge.refunded`, `charge.dispute.created`, `setup_intent.succeeded`, `payment_method.detached` (the list in
`HANDLED_EVENTS`, `src/server/billing/webhook.ts`; a dispute that closes in your favour is not handled automatically:
re-credit / re-activate the customer from the admin console). Copy the signing secret into the
`STRIPE_WEBHOOK_SECRET` secret, then roll a new revision
(`gcloud run services update $SERVICE --region=$REGION --update-secrets=STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest`).

## 12. Custom domain

Simplest (supported regions): domain mapping.

```bash
gcloud beta run domain-mappings create --service=$SERVICE --domain=$DOMAIN --region=$REGION
gcloud beta run domain-mappings describe --domain=$DOMAIN --region=$REGION   # shows the DNS records to create
```

For production traffic prefer a **Global external HTTPS Load Balancer** with a serverless NEG
pointing at the service (managed certificate, Cloud Armor, CDN off for `/v1/*`). Remember to set
`TRUSTED_PROXY_HOPS=2` in that case, `--ingress=internal-and-cloud-load-balancing` and `APP_URL=https://$DOMAIN`.

After DNS propagates, verify:

```bash
curl https://$DOMAIN/api/healthz        # {"ok":true,"db":"ok","redis":"ok"}
```

## Operations cheat sheet

| Task | Command |
|---|---|
| Tail logs (structured JSON, `severity`) | `gcloud run services logs tail $SERVICE --region=$REGION` |
| Roll back | `gcloud run services update-traffic $SERVICE --region=$REGION --to-revisions=REVISION=100` |
| Rotate a secret | add a new secret version, then `gcloud run services update $SERVICE --region=$REGION --update-secrets=NAME=NAME:latest` |
| Run migrations | `gcloud run jobs execute $SERVICE-migrate --region=$REGION --wait` |
| Scale | `gcloud run services update $SERVICE --region=$REGION --min-instances=2 --max-instances=50` |

### Connection fidelity, keep-alive and graceful shutdown

The gateway is a 1:1 proxy (docs/PLAN.md section 9d): a client disconnect aborts the upstream request immediately; an
upstream failure is mirrored to the client (same status / headers / error body before the response started, the
upstream's own error event inside a stream, a dropped connection when the upstream resets mid-stream); nothing is
compressed; request bodies are unlimited (`maxRequestBodyMb`, 0 = unlimited) and streamed.

* **Keep-alive.** HTTP/1 keep-alive is 620 s (`KEEP_ALIVE_TIMEOUT`, above Google's 600 s load-balancer idle timeout), the
  HTTP/1 request timeout is disabled so slow uploads are never cut, TCP keep-alive probes run on every connection, and a
  silent SSE stream gets a `: keep-alive` comment line every `streamHeartbeatSec` (default 15 s, 0 = off; admin
  setting). Heartbeats are only ever sent on an already-started SSE response.
* **Upstream HTTP/2 is OPT-IN (default off).** `--use-http2` above only concerns the leg *client -> gateway*. The leg
  *gateway -> provider* uses HTTP/1.1 keep-alive pools by default (a lost connection then costs exactly one
  stream). To multiplex streams over one connection to a specific https upstream, set `"http2": true` in that
  provider's **Settings (JSON)** (Admin > Providers > provider > Connection & settings). Leave it off unless you know
  the provider speaks h2 well: a dropped h2 connection ends *every* stream running on it. Related provider settings:
  `idleTimeoutSec` (cut a stream that is silent for N seconds; default never).
* **New sticky objects.** Uploaded files / multipart uploads / Gemini upload sessions are recorded in
  `UpstreamObject` (pinned to the upstream account that holds them, scoped to the owning customer). The older
  `VideoJob` table is unchanged; it keeps serving video jobs.
* **SIGTERM / deploys.** On SIGTERM the container stops accepting connections, sends HTTP/2 GOAWAY and
  `Connection: close`, lets every in-flight request and stream run to completion (bounded by
  `SHUTDOWN_DRAIN_SECONDS`, default 600), flushes the metering buffer and exits (code 143). During a rolling deploy
  Cloud Run moves new traffic to the new revision and the old revision's instances finish their in-flight requests
  first. **Platform limit:** Cloud Run SIGKILLs an instance 10 s after SIGTERM, so a stream that is still running when
  Cloud Run *forces* an instance down (scale-in of a busy instance, maintenance) is cut by the platform; our drain is
  what keeps every graceful shutdown (deploys, `docker stop -t 700`, Kubernetes with
  `terminationGracePeriodSeconds`) from truncating streams. On a plain Docker host use `docker stop -t <seconds>`
  at least as large as `SHUTDOWN_DRAIN_SECONDS`.
* **Verify.** `node scripts/h2c-check.mjs http://127.0.0.1:8080 /api/healthz` (HTTP/2 prior knowledge, no curl
  HTTP/2 support needed) and `curl http://127.0.0.1:8080/api/healthz` (HTTP/1.1); `pnpm chaos --docker <image>` runs
  1000 concurrent two-minute streams against the container and sends SIGTERM in the middle.

Cloud Run sends SIGTERM with a 10 s grace period on shutdown; the gateway flushes its metering buffer
on SIGTERM, so keep deploys rolling (default) rather than killing instances.
