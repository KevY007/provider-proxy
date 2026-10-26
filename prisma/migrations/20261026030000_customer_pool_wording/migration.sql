-- Customer-facing pool and model wording: prices as a share of the official list price, never our cost or the supplier.
-- Studio: customers pay 50% of the official OpenAI price (model basis), as set on 2026-10-26.
UPDATE "Group" SET "priceBasis" = 'model', "priceMultiplier" = 0.5, "referenceSavingsPct" = NULL,
  description = 'GPT models and images at 50% of the official OpenAI price.'
WHERE slug = 'studio';
UPDATE "Group" SET description = 'Claude models for coding tools (Claude Code etc.) at about 10% of the official Anthropic price.' WHERE slug = 'coding';
UPDATE "Group" SET description = 'GPT and Claude models at the official price.' WHERE slug = 'standard';
UPDATE "Model" SET description = 'Text and image moderation (free).' WHERE description = 'Text and image moderation (free upstream).';
