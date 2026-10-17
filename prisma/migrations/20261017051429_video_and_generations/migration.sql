-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "perSecondPrice" DECIMAL(24,12);

-- AlterTable
ALTER TABLE "ModelRoute" ADD COLUMN     "perSecondCost" DECIMAL(24,12);

-- AlterTable
ALTER TABLE "RequestLog" ADD COLUMN     "videoSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "VideoJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "modelId" TEXT NOT NULL,
    "modelSlug" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerKeyId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "upstreamId" TEXT NOT NULL,
    "upstreamModel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "size" TEXT,
    "price" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "cost" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "refunded" BOOLEAN NOT NULL DEFAULT false,
    "refundedAt" TIMESTAMP(3),
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "requestId" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "lastObject" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "VideoJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VideoJob_userId_createdAt_idx" ON "VideoJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "VideoJob_status_idx" ON "VideoJob"("status");

-- AddForeignKey
ALTER TABLE "VideoJob" ADD CONSTRAINT "VideoJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
