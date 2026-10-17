// STUB created by lead — Backend (Phase 4) agent implements, keeping these exports & types.
// Pure and client-safe (no db / node imports): the admin UI uses it for live previews.

export type PricingModeValue = "FIXED" | "PERCENT_OF_OFFICIAL" | "MARKUP_OVER_COST";
export type PricingRule = { mode: PricingModeValue; value: number | null };

/** Billable units. Token units are USD per 1M; image/request = USD each; perSecond/perMinute = USD per second/minute; perMillionChars = USD per 1M chars. */
export type PriceUnitKey =
  | "input"
  | "output"
  | "cachedInput"
  | "cacheWrite"
  | "image"
  | "request"
  | "audioInput"
  | "audioOutput"
  | "perMinute"
  | "perMillionChars"
  | "perSecond";
export type PriceTable = Partial<Record<PriceUnitKey, number | null>>;

export type PricingPreviewInput = {
  rule: PricingRule;
  official: PriceTable; // Official price
  cost: PriceTable; // Our cost (primary route)
  fixed?: PriceTable; // Customer price as typed (used when rule.mode === "FIXED")
  multiplier?: number; // group × customer multiplier, default 1
};

export type PricingPreview = {
  customer: PriceTable; // Customer price ("Your price") per unit after rule (+ multiplier)
  savingsPct: PriceTable; // (official - customer) / official × 100; null when no official
  marginPct: PriceTable; // (customer - cost) / customer × 100; null when no customer price
  warnings: string[]; // e.g. "Output: customer price is below our cost (loss)"
};

export function previewPricing(input: PricingPreviewInput): PricingPreview {
  void input;
  return { customer: {}, savingsPct: {}, marginPct: {}, warnings: [] };
}
