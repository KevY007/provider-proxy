-- Coding pool: customers pay 30% of the official Anthropic price (model basis), as set by the admin on 2026-10-28.
UPDATE "Group" SET "priceBasis" = 'model', "priceMultiplier" = 0.3, "referenceSavingsPct" = NULL,
  description = 'Claude models for coding tools (Claude Code etc.) at 30% of the official Anthropic price.'
WHERE slug = 'coding';
