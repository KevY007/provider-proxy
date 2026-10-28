-- One-off data cleanup for the production deployment: remove the test traffic run while setting it up
-- (2026-10-21..23): twelve revoked "(temporary)" test keys, their requests, and test requests sent from the build /
-- sandbox environment (recorded client IP 0.0.0.0) on the Studio key or without a key. The spend of those requests is
-- refunded to the account that paid it, and the key / upstream-key usage counters are lowered by the same amounts.
-- Every statement is scoped to these exact ids (and the 0.0.0.0 test window), so on any other database it does nothing.

WITH t AS (
  SELECT id, price, cost, "userId", "apiKeyId", "providerKeyId"
  FROM "RequestLog"
  WHERE "apiKeyId" IN (
      'c77dfeba7b7d7289f178f0fce', 'cad66e87557a62dd5bb243ec1', 'c8ec2677b5047e58a6d94715a', 'c0eef79e4c2a5f5d8094327cf',
      'efftest414f8bebdaabe282ec', 'cmptest00000000000000000001', 'vtest0000000000000000000001', 'cmpce000000000000000000001',
      'cmpoa000000000000000000001', 'fixst00000000000000000001', 'fixsd00000000000000000001', 'vfy2000000000000000000001')
     OR (ip = '0.0.0.0' AND "createdAt" >= '2026-10-21' AND "createdAt" < '2026-10-24'
         AND ("apiKeyId" = 'c7ebebc23d56f6851b6f02464' OR "apiKeyId" IS NULL))
),
refund AS (
  UPDATE "User" u SET balance = u.balance + s.p
  FROM (SELECT "userId", sum(price) AS p FROM t WHERE "userId" IS NOT NULL GROUP BY 1) s
  WHERE u.id = s."userId"
  RETURNING u.id
),
key_spent AS (
  UPDATE "ApiKey" k SET spent = greatest(0, k.spent - s.p)
  FROM (SELECT "apiKeyId", sum(price) AS p FROM t WHERE "apiKeyId" = 'c7ebebc23d56f6851b6f02464' GROUP BY 1) s
  WHERE k.id = s."apiKeyId"
  RETURNING k.id
),
upstream_totals AS (
  UPDATE "ProviderKey" pk SET "totalRequests" = greatest(0, pk."totalRequests" - s.n), "totalCost" = greatest(0, pk."totalCost" - s.c)
  FROM (SELECT "providerKeyId", count(*)::int AS n, sum(cost) AS c FROM t WHERE "providerKeyId" IS NOT NULL GROUP BY 1) s
  WHERE pk.id = s."providerKeyId"
  RETURNING pk.id
)
DELETE FROM "RequestLog" WHERE id IN (SELECT id FROM t);

DELETE FROM "ApiKey"
WHERE status = 'REVOKED' AND id IN (
  'c77dfeba7b7d7289f178f0fce', 'cad66e87557a62dd5bb243ec1', 'c8ec2677b5047e58a6d94715a', 'c0eef79e4c2a5f5d8094327cf',
  'efftest414f8bebdaabe282ec', 'cmptest00000000000000000001', 'vtest0000000000000000000001', 'cmpce000000000000000000001',
  'cmpoa000000000000000000001', 'fixst00000000000000000001', 'fixsd00000000000000000001', 'vfy2000000000000000000001');
