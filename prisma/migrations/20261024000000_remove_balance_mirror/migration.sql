-- Balance mirror removed: customer wallets are never driven by an upstream account (customers can use several providers).
ALTER TABLE "User" DROP COLUMN IF EXISTS "balanceMirrorProviderId";
