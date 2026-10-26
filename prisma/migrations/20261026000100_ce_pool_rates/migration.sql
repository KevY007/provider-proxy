-- Pools priced from the real Codex Everywhere bill (the owner's targets):
--   studio: customers pay 2x our CE cost and see a 50% saving ($80 spent = $160 regular price)
--   coding: customers pay 1.3x our CE cost and see a 30% saving
UPDATE "Group" SET "priceBasis" = 'cost', "priceMultiplier" = 2.0, "referenceSavingsPct" = 50 WHERE slug = 'studio';
UPDATE "Group" SET "priceBasis" = 'cost', "priceMultiplier" = 1.3, "referenceSavingsPct" = 30 WHERE slug = 'coding';

-- The direct OpenAI / Anthropic providers are not used (0 requests): disabled, not deleted (re-enable on the provider page)
UPDATE "Provider" SET status = 'DISABLED'
WHERE id IN ('c0b569edf460d77b4d3c00fab', 'c7db4881b51bbb90b27beda97')
  AND NOT EXISTS (SELECT 1 FROM "RequestLog" l WHERE l."providerId" IN ('c0b569edf460d77b4d3c00fab', 'c7db4881b51bbb90b27beda97'));

-- "standard" only routes to those direct providers: Studio becomes the default pool, standard is hidden and its
-- customers (and their default-pool keys, e.g. the playground) move to Studio
UPDATE "Group" SET "isDefault" = (slug = 'studio') WHERE slug IN ('studio', 'standard') AND EXISTS (SELECT 1 FROM "Group" WHERE slug = 'studio');
UPDATE "Group" SET "isPublic" = false WHERE slug = 'standard' AND EXISTS (SELECT 1 FROM "Group" WHERE slug = 'studio');
UPDATE "User" SET "groupId" = (SELECT id FROM "Group" WHERE slug = 'studio')
WHERE "groupId" = (SELECT id FROM "Group" WHERE slug = 'standard') AND EXISTS (SELECT 1 FROM "Group" WHERE slug = 'studio');
UPDATE "Setting" SET value = '"studio"'::jsonb WHERE key = 'defaultGroupSlug' AND EXISTS (SELECT 1 FROM "Group" WHERE slug = 'studio');
