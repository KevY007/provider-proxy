-- Balance mirror: a customer whose balance mirrors an upstream account's balance (refreshed by upkeep).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "balanceMirrorProviderId" TEXT;
