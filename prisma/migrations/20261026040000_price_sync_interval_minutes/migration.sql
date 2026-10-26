-- AI price sync interval in minutes (was hours): carry the saved value over, then drop the old key.
INSERT INTO "Setting" (key, value, "updatedAt")
SELECT 'priceSyncIntervalMin', to_jsonb(GREATEST(5, LEAST(43200, round((value #>> '{}')::numeric * 60)::int))), now()
FROM "Setting" WHERE key = 'priceSyncIntervalHours' AND jsonb_typeof(value) = 'number'
ON CONFLICT (key) DO NOTHING;
DELETE FROM "Setting" WHERE key = 'priceSyncIntervalHours';
