-- Balance mirror removed: customer wallets are never driven by an upstream account (customers can use several
-- providers). Each mirror adjustment that ran (the main customer, -874.93) is reversed with an opposite entry.
WITH m AS (
  SELECT e.id, e."userId", e.amount FROM "LedgerEntry" e
  WHERE e.metadata ? 'balanceMirror' AND NOT EXISTS (SELECT 1 FROM "LedgerEntry" r WHERE r.metadata->>'reverses' = e.id)
), upd AS (
  UPDATE "User" u SET balance = u.balance - s.amt
  FROM (SELECT "userId", sum(amount) AS amt FROM m GROUP BY 1) s
  WHERE u.id = s."userId"
  RETURNING u.id, u.balance
)
INSERT INTO "LedgerEntry" (id, "userId", type, amount, "balanceAfter", description, metadata, "createdAt")
SELECT 'revbalmirror' || substr(md5(m.id), 1, 12), m."userId", 'ADJUSTMENT', -m.amount, upd.balance,
       'Reversal: balance mirror removed (the wallet no longer follows the upstream account)',
       jsonb_build_object('reverses', m.id), now()
FROM m JOIN upd ON upd.id = m."userId";

ALTER TABLE "User" DROP COLUMN IF EXISTS "balanceMirrorProviderId";
