-- Codex-Everywhere account sync (id-scoped; every statement is a no-op on databases without these rows).

-- admin@texhub.ai's balance mirrors the Codex-Everywhere account balance (upkeep refreshes it)
UPDATE "User" SET "balanceMirrorProviderId" = 'cmvhvy4ns000101s67u2kr0f3'
WHERE id = 'c7364482fd7ea506878ed3b6e' AND EXISTS (SELECT 1 FROM "Provider" WHERE id = 'cmvhvy4ns000101s67u2kr0f3');

-- CE allows 20 concurrent requests per ACCOUNT: both CE providers share one 20-slot pool, extra requests queue
UPDATE "Provider" SET settings = settings || '{"sharedConcurrency":{"group":"codex-everywhere-account","max":20}}'::jsonb
WHERE id IN ('cmvhvy4ns000101s67u2kr0f3', 'cecodingprovider000000001');

-- the discarded "Studio 2" upstream key (never used)
DELETE FROM "ProviderKey" WHERE id = 'pkstudio2cea0000000000002';

-- test traffic: anonymous requests rejected before authentication
DELETE FROM "RequestLog" WHERE "userId" IS NULL AND status = 'CLIENT_ERROR' AND "createdAt" < '2026-10-23T16:00:00Z';

-- the first Claude-via-Kiro request wrote 1M tokens to the 1h cache; its official price used the customer's discounted
-- 1h rate (2.40) instead of Anthropic's $8/1M, so it showed ~1% saved instead of 70%
UPDATE "RequestLog" SET "officialPrice" = "officialPrice" + 5.6
WHERE id = 'lou5ls93kc9ql4y8t59uv3iq' AND "officialPrice" < 2.5;
