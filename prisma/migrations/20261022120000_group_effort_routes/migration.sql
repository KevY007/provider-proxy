-- Effort routing: requests of a pool asking for a high reasoning effort can be served (and billed) as another pool
-- and/or by one specific provider, e.g. a reseller up to "high", the official provider for "xhigh" and above.
ALTER TABLE "Group" ADD COLUMN "effortRoutes" JSONB NOT NULL DEFAULT '[]';
