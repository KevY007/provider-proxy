# syntax=docker/dockerfile:1.7
# ProviderProxy - one image serves the UI + gateway AND can run `prisma migrate deploy`
# (a migration job runs the same image with: cd /prisma-cli && node node_modules/prisma/build/index.js migrate deploy).

# pinned by digest (reproducible builds; dependabot proposes updates). Override with --build-arg NODE_IMAGE=...
ARG NODE_IMAGE=node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
WORKDIR /app

# ---- 1. dependencies ---------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# ---- 2. build (prisma generate + next build, standalone output) --------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# (defence in depth: no env file may end up in the standalone output, whatever the build context contained)
RUN rm -f .env .env.* && pnpm exec prisma generate && pnpm build && pnpm build:seed

# ---- 3. migration toolkit: prisma CLI + schema + migrations in an isolated dir -----------
FROM base AS migrator
WORKDIR /prisma-cli
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY prisma/migrator/package.json prisma/migrator/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY prisma.config.ts ./
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma/migrations ./prisma/migrations

# ---- 4. runtime --------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs --create-home nextjs
WORKDIR /app
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
# server.mjs wraps Next's generated server.js: HTTP/1.1 + cleartext HTTP/2 (h2c) on ONE port, no HTTP/1 request timeout,
# 620 s keep-alive, graceful SIGTERM drain (see the header of server.mjs).
COPY --from=build --chown=nextjs:nodejs /app/server.mjs ./server.mjs
# One-file seed (first admin, settings, pools, provider presets, model catalog): `node seed.mjs`, e.g. as a Cloud Run
# Job on this image. Idempotent.
COPY --from=build --chown=nextjs:nodejs /app/dist/seed.mjs ./seed.mjs
COPY --from=migrator --chown=nextjs:nodejs /prisma-cli /prisma-cli
# KEEP_ALIVE_TIMEOUT must exceed Google's 600 s load-balancer idle timeout; SHUTDOWN_DRAIN_SECONDS bounds the SIGTERM drain
ENV KEEP_ALIVE_TIMEOUT=620000
ENV SHUTDOWN_DRAIN_SECONDS=600
USER nextjs
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
