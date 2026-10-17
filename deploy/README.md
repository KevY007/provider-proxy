# Deploying ProviderProxy to Google Cloud

Target architecture (see `docs/PLAN.md` section 10):

```
Client -> Cloud Run (one container: UI + gateway) -> Cloud SQL (Postgres 16)
                                   |-> Memorystore Redis (optional, via VPC connector)
Cloud Scheduler -> POST /api/cron/billing (hourly), /api/cron/health (every 5 min)
Cloud Run Job (same image) -> prisma migrate deploy
Secret Manager -> env vars
```

Everything below is copy/paste `gcloud`. Replace the variables in step 0. Run from a Cloud Shell or any
machine with `gcloud` authenticated (`gcloud auth login`).

> The app also runs on any Docker host: `docker compose -f docker-compose.prod.yml up -d --build`
> (app + postgres + redis, migrations run automatically).

## 0. Variables

```bash
export PROJECT_ID=my-project
export REGION=us-central1
export REPO=providerproxy                 # Artifact Registry repo
export SERVICE=providerproxy              # Cloud Run service
export SQL_INSTANCE=providerproxy-db
export SA=providerproxy-run               # runtime service account name
export DOMAIN=api.example.com             # your public hostname
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$SERVICE:latest

gcloud config set project $PROJECT_ID
```

## 1. Enable APIs

```bash
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  sqladmin.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com \
  redis.googleapis.com vpcaccess.googleapis.com compute.googleapis.com
```

## 2. Artifact Registry

```bash
gcloud artifacts repositories create $REPO --repository-format=docker --location=$REGION \
  --description="ProviderProxy images"
```

## 3. Cloud SQL (Postgres 16)

```bash
gcloud sql instances create $SQL_INSTANCE \
  --database-version=POSTGRES_16 --region=$REGION \
  --tier=db-custom-2-7680 --storage-type=SSD --storage-size=20GB --storage-auto-increase \
  --availability-type=zonal            # use regional for HA in production

gcloud sql databases create proxy --instance=$SQL_INSTANCE
export DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
gcloud sql users create proxy --instance=$SQL_INSTANCE --password="$DB_PASSWORD"

export SQL_CONN=$PROJECT_ID:$REGION:$SQL_INSTANCE
```

Connection string used by Cloud Run (unix socket through the Cloud SQL connector; URL-encode special
characters in the password):

```
postgresql://proxy:DB_PASSWORD@localhost/proxy?host=/cloudsql/PROJECT_ID:REGION:SQL_INSTANCE
```

Pool size per instance is `DB_POOL_SIZE` (default 20). Keep
`max-instances x DB_POOL_SIZE` below the Cloud SQL connection limit (`db-custom-2-7680` allows ~400;
raise `max_connections` flag or add PgBouncer for very large fleets).

## 4. Memorystore Redis + VPC connector (optional)

The app works without Redis (in-memory fallback), but with more than one instance you want Redis for
shared rate limits, concurrency slots and cache invalidation.

```bash
gcloud redis instances create providerproxy-redis --region=$REGION --tier=basic --size=1 \
  --redis-version=redis_7_0

export REDIS_HOST=$(gcloud redis instances describe providerproxy-redis --region=$REGION --format='value(host)')

gcloud compute networks vpc-access connectors create pp-connector \
  --region=$REGION --network=default --range=10.8.0.0/28 --min-instances=2 --max-instances=10
```

`REDIS_URL=redis://$REDIS_HOST:6379`

## 5. Secrets (Secret Manager)

```bash
mk() { printf %s "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic; }

mk DATABASE_URL    "postgresql://proxy:${DB_PASSWORD}@localhost/proxy?host=/cloudsql/${SQL_CONN}"
mk SESSION_SECRET  "$(openssl rand -base64 48 | tr -d '\n')"
mk ENCRYPTION_KEY  "$(openssl rand -base64 32)"        # 32 bytes base64 - BACK THIS UP, losing it makes stored upstream keys unreadable
mk CRON_SECRET     "$(openssl rand -hex 24)"
mk ADMIN_PASSWORD  "choose-a-strong-admin-password"
# Optional / when ready:
mk REDIS_URL       "redis://$REDIS_HOST:6379"
mk STRIPE_SECRET_KEY      "sk_live_..."
mk STRIPE_PUBLISHABLE_KEY "pk_live_..."
mk STRIPE_WEBHOOK_SECRET  "whsec_..."                  # created in step 11
mk SMTP_URL        "smtp://user:pass@smtp.example.com:587"
```

## 6. Service account and IAM

```bash
gcloud iam service-accounts create $SA --display-name="ProviderProxy runtime"
export SA_EMAIL=$SA@$PROJECT_ID.iam.gserviceaccount.com

gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$SA_EMAIL --role=roles/cloudsql.client
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$SA_EMAIL --role=roles/secretmanager.secretAccessor

# Cloud Build needs to deploy Cloud Run + act as the runtime SA
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
export CB_SA=$PROJECT_NUMBER@cloudbuild.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$CB_SA --role=roles/run.admin
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
  --set-cloudsql-instances=$SQL_CONN \
  --set-secrets=DATABASE_URL=DATABASE_URL:latest \
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
* `--min-instances=1` - no cold starts on the API.
* `--no-cpu-throttling` - CPU stays allocated after the response so post-response metering completes and
  heartbeats keep flowing on silent streams.
* `--execution-environment=gen2`.
* Size `--memory` for uploads: a multipart/JSON body is spooled to the instance's temp directory and Cloud Run's
  filesystem is **in memory**, so in-flight uploads count against the instance memory (about the sum of the bodies
  being uploaded at that moment). `2Gi` is fine for a few concurrent 500 MB uploads; raise it (or lower
  `--concurrency`) if you expect many large uploads at once. Streamed passthrough (Files API uploads, downloads,
  completions) uses only a few MB per request.

```bash
gcloud run deploy $SERVICE \
  --image=$IMAGE --region=$REGION --service-account=$SA_EMAIL \
  --allow-unauthenticated \
  --execution-environment=gen2 \
  --use-http2 \
  --timeout=3600 --concurrency=250 \
  --min-instances=1 --max-instances=20 \
  --no-cpu-throttling --cpu=2 --memory=2Gi --cpu-boost \
  --add-cloudsql-instances=$SQL_CONN \
  --vpc-connector=pp-connector --vpc-egress=private-ranges-only \
  --set-env-vars="APP_URL=https://$DOMAIN,ADMIN_EMAIL=you@example.com,EMAIL_FROM=ProviderProxy <no-reply@$DOMAIN>,DB_POOL_SIZE=20,TRUSTED_PROXY_HOPS=1" \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,SESSION_SECRET=SESSION_SECRET:latest,ENCRYPTION_KEY=ENCRYPTION_KEY:latest,CRON_SECRET=CRON_SECRET:latest,REDIS_URL=REDIS_URL:latest,STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest,STRIPE_PUBLISHABLE_KEY=STRIPE_PUBLISHABLE_KEY:latest,STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest,SMTP_URL=SMTP_URL:latest" \
  --startup-probe=httpGet.path=/api/healthz,initialDelaySeconds=2,periodSeconds=3,failureThreshold=20 \
  --liveness-probe=httpGet.path=/api/healthz,periodSeconds=30
```

Drop `--vpc-connector`/`--vpc-egress` and the `REDIS_URL` secret mapping if you skipped Redis, and drop
the Stripe/SMTP secrets you did not create (the app treats them as optional).

> The container listens on `$PORT` (Cloud Run injects 8080). `TRUSTED_PROXY_HOPS=1` makes client-IP
> detection read the last `x-forwarded-for` entry appended by Google's front end; use `2` if you put a
> Global HTTPS Load Balancer in front.

### Seed the first admin + defaults (once)

Seeding is a dev dependency (`tsx`) and is run from your workstation through the Cloud SQL Auth Proxy:

```bash
cloud-sql-proxy $SQL_CONN --port 5434 &
DATABASE_URL="postgresql://proxy:$DB_PASSWORD@localhost:5434/proxy" \
ENCRYPTION_KEY="<same as the secret>" ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' \
NODE_ENV=production pnpm db:seed
```

In production the seed skips the Mock Upstream provider and the demo customer. Providers are created
disabled and without keys: add upstream keys in **Admin > Providers**, then enable them.

## 10. CI/CD with Cloud Build (optional)

```bash
gcloud builds submit --config deploy/cloudbuild.yaml \
  --substitutions=_REGION=$REGION,_REPO=$REPO,_SERVICE=$SERVICE,_MIGRATE_JOB=$SERVICE-migrate
```

Create a Cloud Build trigger on your main branch with the same substitutions for push-to-deploy.
Steps: build image -> push -> update + run the migration job -> deploy the service revision.

## 11. Cron (Cloud Scheduler) and Stripe webhook

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
`payment_intent.payment_failed`, `setup_intent.succeeded`, `checkout.session.completed`,
`charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`. Copy the signing secret into the
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
`TRUSTED_PROXY_HOPS=2` in that case and `APP_URL=https://$DOMAIN`.

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
