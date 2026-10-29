-- Notification copies: extra addresses per account that get a BCC copy of every notification email (balance and
-- billing alerts), never the owner-only security emails. The console/outbox fallback records the BCC list too.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notifyCc" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "EmailOutbox" ADD COLUMN IF NOT EXISTS "bcc" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
