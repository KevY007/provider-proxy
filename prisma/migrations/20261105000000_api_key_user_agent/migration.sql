-- Per API key user-agent: the identity the key presents upstream (preset id or text). NULL = pass the caller's through.
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "userAgent" TEXT;
