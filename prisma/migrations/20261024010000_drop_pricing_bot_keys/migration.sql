-- The price-sync AI now uses a throwaway key per call (deleted right after); drop the standing internal key(s).
DELETE FROM "ApiKey" WHERE name = 'Pricing fetch AI run' AND "userId" IN (SELECT id FROM "User" WHERE email = 'pricing-fetch@system.internal');
