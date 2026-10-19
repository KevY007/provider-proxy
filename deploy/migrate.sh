#!/bin/sh
# Applies pending Prisma migrations using the toolkit baked into the app image (/prisma-cli).
# Used as the command of the Cloud Run migration Job and of the `migrate` service in
# docker-compose.prod.yml. Uses DIRECT_URL (Supabase: direct or session-pooler URL), else DATABASE_URL.
#
#   gcloud run jobs execute providerproxy-migrate --region "$REGION" --wait
set -eu

cd "$(dirname "$0")/.." 2>/dev/null || true
if [ -d /prisma-cli ]; then cd /prisma-cli; fi

if [ -z "${DIRECT_URL:-}" ] && [ -z "${DATABASE_URL:-}" ]; then
  echo "DIRECT_URL / DATABASE_URL is not set" >&2
  exit 1
fi

echo "Running prisma migrate deploy ..."
exec node node_modules/prisma/build/index.js migrate deploy
