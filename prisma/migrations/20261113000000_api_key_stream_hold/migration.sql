-- Per API key stream start hold in seconds: NULL = the gateway setting, 0 = no hold (events are sent as they arrive).
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "streamHoldSec" INTEGER;
