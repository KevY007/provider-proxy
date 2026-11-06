-- Per API key list of upstream request headers to strip (none by default).
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "stripHeaders" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
