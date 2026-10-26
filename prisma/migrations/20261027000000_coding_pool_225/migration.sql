-- Coding pool: customers pay 2.25x our Codex Everywhere cost (was 1.3x). CE charges 8% of the official Anthropic
-- price, so this is 18% of official. Past requests keep the price they were billed at.
UPDATE "Group" SET "priceBasis" = 'cost', "priceMultiplier" = 2.25,
  description = 'Claude models for coding tools (Claude Code etc.) at about 18% of the official Anthropic price.'
WHERE slug = 'coding';
