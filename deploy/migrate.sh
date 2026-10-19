#!/bin/sh
# Applies pending Prisma migrations using the toolkit baked into the app image (/prisma-cli).
# Used as the command of the Cloud Run migration Job and of the `migrate` service in
# docker-compose.prod.yml. Requires DATABASE_URL in the environment.
#
#   gcloud run jobs execute providerproxy-migrate --region "$REGION" --wait
set -eu

cd "$(dirname "$0")/.." 2>/dev/null || true
if [ -d /prisma-cli ]; then cd /prisma-cli; fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set" >&2
  exit 1
fi

echo "Running prisma migrate deploy ..."
exec node node_modules/prisma/build/index.js migrate deploy
