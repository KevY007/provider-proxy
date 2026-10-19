// Pure and client-safe (no db / node imports): the admin UI uses it for live previews, the server rules reuse the labels.
//
// Vocabulary (PLAN 9c): Official price = the maker's public list price · Customer price ("Your price") = what we charge
// (after multipliers) · Our cost = what we pay our supplier · Savings = official - customer · Margin = customer - cost.

export type PricingModeValue = "FIXED" | "PERCENT_OF_OFFICIAL" | "MARKUP_OVER_COST" | "PERCENT_OF_COST";
/**
 * `adjust` (optional, signed) is added to every unit price the rule derives, in that unit's own terms (USD per 1M tokens
 * for token units, per image / request / second / minute for flat units). The result never goes below 0.
 */
export type PricingRule = { mode: PricingModeValue; value: number | null; adjust?: number | null };

/** Modes whose basis is the primary route's cost (auto-updated costs flow through these). */
export const COST_BASED_MODES: ReadonlySet<PricingModeValue> = new Set(["MARKUP_OVER_COST", "PERCENT_OF_COST"]);

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

/** All units in display order. */
export const PRICE_UNITS: readonly PriceUnitKey[] = [
  "input",
  "output",
  "cachedInput",
  "cacheWrite",
  "image",
  "request",
  "audioInput",
  "audioOutput",
  "perMinute",
  "perMillionChars",
  "perSecond",
] as const;

/** Human label of a unit, used in warnings and by the admin UI. */
export const PRICE_UNIT_LABELS: Record<PriceUnitKey, string> = {
  input: "Input",
  output: "Output",
  cachedInput: "Cached input",
  cacheWrite: "Cache write",
  image: "Image",
  request: "Request",
  audioInput: "Audio input",
  audioOutput: "Audio output",
  perMinute: "Per minute",
  perMillionChars: "Per 1M characters",
  perSecond: "Per second",
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Round away binary float noise (0.15 * 1.3 = 0.19500000000000001) without losing real precision. */
export function cleanNumber(n: number): number {
  return Number(n.toPrecision(12));
}

/** Customer price of one unit under a rule, BEFORE the multiplier. null = the rule has no basis for this unit. */
export function deriveUnitPrice(rule: PricingRule, official: number | null | undefined, cost: number | null | undefined): number | null {
  let base: number | null = null;
  if (rule.mode === "PERCENT_OF_OFFICIAL") {
    if (!isNum(official) || !isNum(rule.value)) return null;
    base = (official * rule.value) / 100;
  } else if (rule.mode === "MARKUP_OVER_COST") {
    if (!isNum(cost) || !isNum(rule.value)) return null;
    base = cost * (1 + rule.value / 100);
  } else if (rule.mode === "PERCENT_OF_COST") {
    if (!isNum(cost) || !isNum(rule.value)) return null;
    base = (cost * rule.value) / 100;
  }
  if (base === null) return null;
  const adj = isNum(rule.adjust) ? rule.adjust : 0;
  return cleanNumber(Math.max(0, base + adj));
}

/** Validation message for a rule, or null when it is usable. */
export function validateRule(rule: PricingRule): string | null {
  if (rule.mode === "FIXED") return null;
  if (!isNum(rule.value)) return rule.mode === "PERCENT_OF_OFFICIAL" ? "Enter the percentage of the official price to charge." : rule.mode === "PERCENT_OF_COST" ? "Enter the percentage of our cost to charge." : "Enter the markup percentage over our cost.";
  if (rule.mode === "PERCENT_OF_OFFICIAL" && (rule.value <= 0 || rule.value > 1000)) return "Percent of official must be between 0 and 1000.";
  if (rule.mode === "MARKUP_OVER_COST" && (rule.value <= -100 || rule.value > 10000)) return "Markup must be greater than -100% and at most 10000%.";
  if (rule.mode === "PERCENT_OF_COST" && (rule.value <= 0 || rule.value > 10000)) return "Percent of our cost must be between 0 and 10000.";
  if (rule.adjust !== undefined && rule.adjust !== null && (!isNum(rule.adjust) || Math.abs(rule.adjust) > 1_000_000)) return "The adjustment must be a number (it can be negative).";
  return null;
}

/** Live preview of Your price, Savings and Margin for a pricing rule (pure). */
export function previewPricing(input: PricingPreviewInput): PricingPreview {
  const mult = isNum(input.multiplier) && input.multiplier > 0 ? input.multiplier : 1;
  const units = new Set<PriceUnitKey>();
  for (const t of [input.official, input.cost, input.fixed]) for (const k of Object.keys(t ?? {}) as PriceUnitKey[]) if (PRICE_UNITS.includes(k)) units.add(k);

  const customer: PriceTable = {};
  const savingsPct: PriceTable = {};
  const marginPct: PriceTable = {};
  const warnings: string[] = [];
  const ruleProblem = validateRule(input.rule);
  if (ruleProblem) warnings.push(ruleProblem);

  for (const unit of PRICE_UNITS) {
    if (!units.has(unit)) continue;
    const label = PRICE_UNIT_LABELS[unit];
    const off = input.official[unit];
    const cost = input.cost[unit];
    const typed = input.fixed?.[unit];

    let base: number | null;
    if (input.rule.mode === "FIXED") base = isNum(typed) ? typed : null;
    else {
      base = ruleProblem ? null : deriveUnitPrice(input.rule, off, cost);
      if (base === null && !ruleProblem) {
        const missing = input.rule.mode === "PERCENT_OF_OFFICIAL" ? "official" : "cost";
        if (isNum(typed)) {
          warnings.push(`${label}: no ${missing} price, so the rule cannot price this unit - keeping the typed customer price.`);
          base = typed;
        } else if (isNum(off) || isNum(cost)) {
          warnings.push(`${label}: no ${missing} price, so the rule cannot price this unit - set it or switch to a fixed price.`);
        }
      }
    }
    const price = base === null ? null : cleanNumber(base * mult);
    customer[unit] = price;

    savingsPct[unit] = isNum(price) && isNum(off) && off > 0 ? cleanNumber(((off - price) / off) * 100) : null;
    marginPct[unit] = isNum(price) && price > 0 && isNum(cost) ? cleanNumber(((price - cost) / price) * 100) : null;

    if (isNum(price)) {
      if (isNum(cost) && price < cost) warnings.push(`${label}: customer price is below our cost (loss)`);
      else if (isNum(cost) && price === cost && cost > 0) warnings.push(`${label}: customer price equals our cost (no margin)`);
      if (!isNum(off) && price > 0) warnings.push(`${label}: no official price set, savings cannot be shown`);
      if (!isNum(cost) && price > 0 && !COST_BASED_MODES.has(input.rule.mode)) warnings.push(`${label}: no cost on the primary route, margin unknown`);
      if (price === 0 && ((isNum(cost) && cost > 0) || (isNum(off) && off > 0))) warnings.push(`${label}: customer price is zero - this unit would be free`);
      if (isNum(off) && off > 0 && price > off) warnings.push(`${label}: customer price is above the official price`);
    } else if (isNum(off) && off > 0 && input.rule.mode === "FIXED") {
      warnings.push(`${label}: no customer price set (official ${off}).`);
    }
  }
  return { customer, savingsPct, marginPct, warnings };
}
