-- Per-pool shown saving: the "would have cost" figure customers compare against (null = official list price).
ALTER TABLE "Group" ADD COLUMN IF NOT EXISTS "referenceSavingsPct" DECIMAL(5,2);
