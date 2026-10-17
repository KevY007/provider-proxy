-- CreateEnum
CREATE TYPE "PricingMode" AS ENUM ('FIXED', 'PERCENT_OF_OFFICIAL', 'MARKUP_OVER_COST');

-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "officialAudioInputPrice" DECIMAL(24,12),
ADD COLUMN     "officialAudioOutputPrice" DECIMAL(24,12),
ADD COLUMN     "officialCacheWritePrice" DECIMAL(24,12),
ADD COLUMN     "officialImagePrice" DECIMAL(24,12),
ADD COLUMN     "officialPerMillionChars" DECIMAL(24,12),
ADD COLUMN     "officialPerMinutePrice" DECIMAL(24,12),
ADD COLUMN     "officialPerSecondPrice" DECIMAL(24,12),
ADD COLUMN     "officialRequestPrice" DECIMAL(24,12),
ADD COLUMN     "pricingMode" "PricingMode" NOT NULL DEFAULT 'FIXED',
ADD COLUMN     "pricingValue" DECIMAL(10,4),
ADD COLUMN     "retiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RequestLog" ADD COLUMN     "officialPrice" DECIMAL(24,12) NOT NULL DEFAULT 0;
