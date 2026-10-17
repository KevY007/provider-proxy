-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "batchDiscountPct" DECIMAL(5,2),
ADD COLUMN     "officialToolPrices" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "toolPrices" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "ModelRoute" ADD COLUMN     "batchCostDiscountPct" DECIMAL(5,2) NOT NULL DEFAULT 50,
ADD COLUMN     "toolCosts" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "RequestLog" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "toolUsage" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "UpstreamObject" ADD COLUMN     "meterClaimedAt" TIMESTAMP(3),
ADD COLUMN     "meteredAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT;

-- CreateIndex
CREATE INDEX "RequestLog_batchId_idx" ON "RequestLog"("batchId");

-- CreateIndex
CREATE INDEX "UpstreamObject_kind_meteredAt_idx" ON "UpstreamObject"("kind", "meteredAt");
