// STUB created by lead — Backend (Phase 4) agent implements, keeping these signatures.
// Server-only: reads/writes Model + ModelRoute, then invalidates the gateway config cache.
import type { PricingRule } from "./preview";

/** Re-derive a model's customer prices from its pricing rule (no-op for FIXED). */
export async function recomputeModelPrices(modelId: string): Promise<{ changed: boolean }> {
  void modelId;
  return { changed: false };
}

/** Set the pricing rule on many models at once and recompute their prices. */
export async function applyPricingRule(modelIds: string[], rule: PricingRule): Promise<{ updated: number }> {
  void modelIds;
  void rule;
  return { updated: 0 };
}
