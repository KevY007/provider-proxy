-- AlterTable
ALTER TABLE "HealthCheck" ADD COLUMN     "degraded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'probe';

-- CreateTable
CREATE TABLE "JobRun" (
    "name" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "lastOkAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT '',
    "result" JSONB,
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "HealthCheck_createdAt_idx" ON "HealthCheck"("createdAt");
