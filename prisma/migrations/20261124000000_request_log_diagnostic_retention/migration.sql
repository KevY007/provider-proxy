-- Constant default: no table rewrite. IF NOT EXISTS allows pre-staging for the initial scrub.
ALTER TABLE "RequestLog" ADD COLUMN IF NOT EXISTS "diagnosticsExpired" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "RequestLog_diagnosticsExpired_createdAt_id_idx"
    ON "RequestLog" ("diagnosticsExpired", "createdAt", id);
