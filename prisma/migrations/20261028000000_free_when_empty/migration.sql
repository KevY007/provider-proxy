-- Free-when-empty metering (admin switch per customer): once the balance is used up, requests are free instead of
-- refused. The balance never goes below 0; the part of a request's price the balance could not cover is `waived`.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "freeWhenEmpty" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RequestLog" ADD COLUMN IF NOT EXISTS "waived" DECIMAL(24,12) NOT NULL DEFAULT 0;
