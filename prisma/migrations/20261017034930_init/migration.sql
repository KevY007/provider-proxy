-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CUSTOMER', 'SUPPORT', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "BillingMode" AS ENUM ('PREPAID', 'POSTPAID');

-- CreateEnum
CREATE TYPE "TokenType" AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET', 'EMAIL_CHANGE');

-- CreateEnum
CREATE TYPE "KeyStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ProviderKeyStatus" AS ENUM ('ACTIVE', 'DISABLED', 'COOLDOWN', 'INVALID', 'EXHAUSTED');

-- CreateEnum
CREATE TYPE "AuthStyle" AS ENUM ('BEARER', 'X_API_KEY', 'X_GOOG_API_KEY', 'AZURE_API_KEY', 'QUERY_KEY');

-- CreateEnum
CREATE TYPE "HealthStatus" AS ENUM ('UNKNOWN', 'OPERATIONAL', 'DEGRADED', 'DOWN');

-- CreateEnum
CREATE TYPE "ModelStatus" AS ENUM ('ACTIVE', 'HIDDEN', 'DISABLED');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('SUCCESS', 'CLIENT_ERROR', 'UPSTREAM_ERROR', 'GATEWAY_ERROR', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('TOPUP', 'AUTO_RECHARGE', 'TRIAL_CREDIT', 'REDEEM', 'ADJUSTMENT', 'REFUND', 'CHARGEBACK', 'POSTPAID_SETTLEMENT', 'USAGE_CORRECTION');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'DISPUTED', 'CANCELED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'CUSTOMER',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "emailVerifiedAt" TIMESTAMP(3),
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "groupId" TEXT,
    "priceMultiplier" DECIMAL(10,4),
    "balance" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "creditLimit" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "billingMode" "BillingMode" NOT NULL DEFAULT 'PREPAID',
    "monthlySpendLimit" DECIMAL(24,12),
    "stripeCustomerId" TEXT,
    "defaultPaymentMethodId" TEXT,
    "autoRechargeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoRechargeThreshold" DECIMAL(24,12) NOT NULL DEFAULT 5,
    "autoRechargeAmount" DECIMAL(24,12) NOT NULL DEFAULT 20,
    "lowBalanceAlertAt" DECIMAL(24,12),
    "trialGrantedAt" TIMESTAMP(3),
    "signupIp" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "maxConcurrency" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "twoFactorPassed" BOOLEAN NOT NULL DEFAULT false,
    "impersonatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "TokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "newEmail" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "status" "KeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "groupId" TEXT,
    "allowedModels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ipAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rpmLimit" INTEGER,
    "tpmLimit" INTEGER,
    "maxConcurrency" INTEGER,
    "spendLimit" DECIMAL(24,12),
    "spent" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "isPlayground" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "priceMultiplier" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "providerTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedModels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "rpmLimit" INTEGER,
    "maxConcurrency" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "preset" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "authStyle" "AuthStyle" NOT NULL DEFAULT 'BEARER',
    "formats" TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extraHeaders" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "status" "ProviderStatus" NOT NULL DEFAULT 'ACTIVE',
    "timeoutMs" INTEGER NOT NULL DEFAULT 600000,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "maxConcurrency" INTEGER,
    "healthStatus" "HealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastCheckAt" TIMESTAMP(3),
    "lastLatencyMs" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderKey" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "secretHint" TEXT NOT NULL,
    "status" "ProviderKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "weight" INTEGER NOT NULL DEFAULT 1,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "rpmLimit" INTEGER,
    "tpmLimit" INTEGER,
    "maxConcurrency" INTEGER,
    "dailyBudget" DECIMAL(24,12),
    "cooldownUntil" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "totalRequests" INTEGER NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Model" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "displayName" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "description" TEXT,
    "capabilities" TEXT[],
    "contextWindow" INTEGER,
    "maxOutput" INTEGER,
    "status" "ModelStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "maskUpstreamModel" BOOLEAN NOT NULL DEFAULT true,
    "inputPrice" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "outputPrice" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "cachedInputPrice" DECIMAL(24,12),
    "cacheWritePrice" DECIMAL(24,12),
    "cacheWrite1hPrice" DECIMAL(24,12),
    "imagePrice" DECIMAL(24,12),
    "requestPrice" DECIMAL(24,12),
    "audioInputPrice" DECIMAL(24,12),
    "audioOutputPrice" DECIMAL(24,12),
    "perMinutePrice" DECIMAL(24,12),
    "perMillionChars" DECIMAL(24,12),
    "longContextThreshold" INTEGER,
    "longContextMultiplier" DECIMAL(10,4),
    "officialInputPrice" DECIMAL(24,12),
    "officialOutputPrice" DECIMAL(24,12),
    "officialCachedPrice" DECIMAL(24,12),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelRoute" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "upstreamModel" TEXT NOT NULL,
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "groupSlugs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "paramOverrides" JSONB NOT NULL DEFAULT '{}',
    "maxOutputTokens" INTEGER,
    "inputCost" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "outputCost" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "cachedInputCost" DECIMAL(24,12),
    "cacheWriteCost" DECIMAL(24,12),
    "cacheWrite1hCost" DECIMAL(24,12),
    "imageCost" DECIMAL(24,12),
    "requestCost" DECIMAL(24,12),
    "audioInputCost" DECIMAL(24,12),
    "audioOutputCost" DECIMAL(24,12),
    "perMinuteCost" DECIMAL(24,12),
    "perMillionCharsCost" DECIMAL(24,12),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "apiKeyId" TEXT,
    "groupSlug" TEXT,
    "modelSlug" TEXT,
    "endpoint" TEXT NOT NULL,
    "inboundFormat" TEXT NOT NULL,
    "providerId" TEXT,
    "providerKeyId" TEXT,
    "upstreamModel" TEXT,
    "status" "RequestStatus" NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "internalError" TEXT,
    "stream" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "audioSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "characters" INTEGER NOT NULL DEFAULT 0,
    "usageEstimated" BOOLEAN NOT NULL DEFAULT false,
    "price" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "cost" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "profit" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "ttftMs" INTEGER,
    "queueMs" INTEGER NOT NULL DEFAULT 0,
    "attempts" JSONB NOT NULL DEFAULT '[]',
    "ip" TEXT,
    "userAgent" TEXT,
    "requestBody" JSONB,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "LedgerType" NOT NULL,
    "amount" DECIMAL(24,12) NOT NULL,
    "balanceAfter" DECIMAL(24,12) NOT NULL,
    "description" TEXT NOT NULL,
    "paymentId" TEXT,
    "createdById" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeCheckoutId" TEXT,
    "amount" DECIMAL(24,12) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "kind" TEXT NOT NULL,
    "failureReason" TEXT,
    "receiptUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RedeemCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "amount" DECIMAL(24,12) NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedeemCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RedeemCodeUse" (
    "id" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedeemCodeUse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthCheck" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerKeyId" TEXT,
    "ok" BOOLEAN NOT NULL,
    "latencyMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailOutbox" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_tokenHash_key" ON "VerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "VerificationToken_userId_type_idx" ON "VerificationToken"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE INDEX "ApiKey_status_idx" ON "ApiKey"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Group_slug_key" ON "Group"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Provider_slug_key" ON "Provider"("slug");

-- CreateIndex
CREATE INDEX "ProviderKey_providerId_status_idx" ON "ProviderKey"("providerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Model_slug_key" ON "Model"("slug");

-- CreateIndex
CREATE INDEX "Model_status_sortOrder_idx" ON "Model"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "Model_vendor_idx" ON "Model"("vendor");

-- CreateIndex
CREATE INDEX "ModelRoute_providerId_idx" ON "ModelRoute"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRoute_modelId_providerId_upstreamModel_key" ON "ModelRoute"("modelId", "providerId", "upstreamModel");

-- CreateIndex
CREATE INDEX "RequestLog_userId_createdAt_idx" ON "RequestLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RequestLog_createdAt_idx" ON "RequestLog"("createdAt");

-- CreateIndex
CREATE INDEX "RequestLog_providerId_createdAt_idx" ON "RequestLog"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "RequestLog_modelSlug_createdAt_idx" ON "RequestLog"("modelSlug", "createdAt");

-- CreateIndex
CREATE INDEX "RequestLog_apiKeyId_createdAt_idx" ON "RequestLog"("apiKeyId", "createdAt");

-- CreateIndex
CREATE INDEX "RequestLog_status_createdAt_idx" ON "RequestLog"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_paymentId_key" ON "LedgerEntry"("paymentId");

-- CreateIndex
CREATE INDEX "LedgerEntry_userId_createdAt_idx" ON "LedgerEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_type_createdAt_idx" ON "LedgerEntry"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_stripePaymentIntentId_key" ON "Payment"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_stripeCheckoutId_key" ON "Payment"("stripeCheckoutId");

-- CreateIndex
CREATE INDEX "Payment_userId_createdAt_idx" ON "Payment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RedeemCode_code_key" ON "RedeemCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "RedeemCodeUse_codeId_userId_key" ON "RedeemCodeUse"("codeId", "userId");

-- CreateIndex
CREATE INDEX "HealthCheck_providerId_createdAt_idx" ON "HealthCheck"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_createdAt_idx" ON "EmailOutbox"("createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationToken" ADD CONSTRAINT "VerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderKey" ADD CONSTRAINT "ProviderKey_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelRoute" ADD CONSTRAINT "ModelRoute_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelRoute" ADD CONSTRAINT "ModelRoute_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestLog" ADD CONSTRAINT "RequestLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestLog" ADD CONSTRAINT "RequestLog_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestLog" ADD CONSTRAINT "RequestLog_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestLog" ADD CONSTRAINT "RequestLog_providerKeyId_fkey" FOREIGN KEY ("providerKeyId") REFERENCES "ProviderKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedeemCodeUse" ADD CONSTRAINT "RedeemCodeUse_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "RedeemCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedeemCodeUse" ADD CONSTRAINT "RedeemCodeUse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthCheck" ADD CONSTRAINT "HealthCheck_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthCheck" ADD CONSTRAINT "HealthCheck_providerKeyId_fkey" FOREIGN KEY ("providerKeyId") REFERENCES "ProviderKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
