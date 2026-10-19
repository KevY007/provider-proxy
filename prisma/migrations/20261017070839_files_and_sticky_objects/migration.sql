-- CreateTable
CREATE TABLE "UpstreamObject" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "upstreamId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerKeyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpstreamObject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UpstreamObject_userId_kind_createdAt_idx" ON "UpstreamObject"("userId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "UpstreamObject_providerKeyId_idx" ON "UpstreamObject"("providerKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamObject_kind_upstreamId_providerId_key" ON "UpstreamObject"("kind", "upstreamId", "providerId");

-- AddForeignKey
ALTER TABLE "UpstreamObject" ADD CONSTRAINT "UpstreamObject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
