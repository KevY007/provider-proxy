-- Admins can reveal customer API keys: the full key, AES-256-GCM encrypted with ENCRYPTION_KEY.
ALTER TABLE "ApiKey" ADD COLUMN "secretEncrypted" TEXT;
