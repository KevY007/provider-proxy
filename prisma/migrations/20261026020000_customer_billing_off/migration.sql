-- Internal tracking dashboard: customers see their balance but no Billing / Add funds pages (admins set balances).
INSERT INTO "Setting" (key, value, "updatedAt") VALUES ('customerBilling', 'false'::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb, "updatedAt" = now();
