-- AI price sync: pricing pages read by an AI run through one of our own pools, turned into route-cost proposals.
CREATE TABLE "PriceSync" (
    "providerId" TEXT NOT NULL,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "basis" TEXT NOT NULL DEFAULT 'official',
    "poolName" TEXT,
    "modelSources" JSONB NOT NULL DEFAULT '{}',
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "intervalHours" INTEGER NOT NULL DEFAULT 10,
    "maxAutoChangePct" INTEGER NOT NULL DEFAULT 50,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PriceSync_pkey" PRIMARY KEY ("providerId")
);

CREATE TABLE "PriceSyncRun" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "proposals" JSONB NOT NULL DEFAULT '[]',
    "pool" JSONB,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "requestIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "costUsd" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "applied" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "PriceSyncRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PriceSyncRun_providerId_createdAt_idx" ON "PriceSyncRun"("providerId", "createdAt");

ALTER TABLE "PriceSync" ADD CONSTRAINT "PriceSync_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PriceSyncRun" ADD CONSTRAINT "PriceSyncRun_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
