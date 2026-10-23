-- Pool pricing basis: "model" (multiplier x model price, as before) or "cost" (multiplier x the serving route's upstream cost).
ALTER TABLE "Group" ADD COLUMN IF NOT EXISTS "priceBasis" TEXT NOT NULL DEFAULT 'model';
