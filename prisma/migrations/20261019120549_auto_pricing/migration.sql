-- AlterEnum
ALTER TYPE "PricingMode" ADD VALUE 'PERCENT_OF_COST';

-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "pricingAdjust" DECIMAL(24,12);

-- AlterTable
ALTER TABLE "ModelRoute" ADD COLUMN     "autoCostSourceModel" TEXT,
ADD COLUMN     "autoCostStatus" TEXT,
ADD COLUMN     "autoCostSync" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoCostSyncedAt" TIMESTAMP(3);
