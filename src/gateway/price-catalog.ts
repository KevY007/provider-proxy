// STUB created by lead — Backend (Phase 4) agent fills the catalog, keeping these exports.
// Built-in known official list prices used to prefill the admin "Add model" flow.
import type { PriceTable } from "@/server/pricing/preview";

export type KnownPrice = {
  vendor: string; // "openai" | "anthropic" | "google" | "fal" | "replicate" | ...
  model: string; // upstream model id
  official: PriceTable;
  capabilities?: string[];
  contextWindow?: number;
  maxOutput?: number;
  source?: string; // where the number came from
  needsReview?: boolean; // true when the price is a best guess
};

export const KNOWN_PRICES: KnownPrice[] = [];

/** Find a known price by provider preset/vendor + upstream model id (tolerates date suffixes like -2025-08-07). */
export function lookupKnownPrice(presetOrVendor: string, upstreamModel: string): KnownPrice | null {
  void presetOrVendor;
  void upstreamModel;
  return null;
}
