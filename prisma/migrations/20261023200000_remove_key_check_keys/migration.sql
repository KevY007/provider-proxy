-- One-off data cleanup for the provider.texhub.ai deployment: the two "key check (temporary)" API keys used on
-- 2026-10-23 to verify the new upstream keys (Studio 2, Claude 1) and the price-sync prompt, and their requests. The
-- spend is refunded to the account that paid it and the upstream-key usage counters are lowered by the same amounts.
-- Every statement is scoped to these exact ids, so on any other database it does nothing.

WITH t AS (
  SELECT id, price, cost, "userId", "providerKeyId"
  FROM "RequestLog"
  WHERE "apiKeyId" IN ('tmpkeycoding00000000000001', 'tmpkeystudio00000000000001')
),
refund AS (
  UPDATE "User" u SET balance = u.balance + s.p
  FROM (SELECT "userId", sum(price) AS p FROM t WHERE "userId" IS NOT NULL GROUP BY 1) s
  WHERE u.id = s."userId"
  RETURNING u.id
),
upstream_totals AS (
  UPDATE "ProviderKey" pk SET "totalRequests" = greatest(0, pk."totalRequests" - s.n), "totalCost" = greatest(0, pk."totalCost" - s.c)
  FROM (SELECT "providerKeyId", count(*)::int AS n, sum(cost) AS c FROM t WHERE "providerKeyId" IS NOT NULL GROUP BY 1) s
  WHERE pk.id = s."providerKeyId"
  RETURNING pk.id
)
DELETE FROM "RequestLog" WHERE id IN (SELECT id FROM t);

DELETE FROM "ApiKey" WHERE id IN ('tmpkeycoding00000000000001', 'tmpkeystudio00000000000001') AND name = 'key check (temporary)';
