-- Customers compare with the official OpenAI / Anthropic list price again (pricing stays 2x / 1.3x of the CE bill).
UPDATE "Group" SET "referenceSavingsPct" = NULL WHERE slug IN ('studio', 'coding');
