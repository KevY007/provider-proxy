// Server-side mapping between the pricing "units" and the Prisma columns (Model sell/official fields, ModelRoute cost fields),
// plus the pure rule -> sell-price derivation. Shared by the pricing rules, the seed and the live setup script so the
// column names live in ONE place.
import { Decimal, toDbString } from "@/lib/money";
import type { KnownPrice } from "@/gateway/price-catalog";
import type { PriceUnitKey, PricingRule } from "./preview";

export interface UnitFields {
  unit: PriceUnitKey;
  /** Model column holding the customer (sell) price */
  sell: string;
  /** Model column holding the official price (null = none exists) */
  official: string | null;
  /** ModelRoute column holding our cost */
  cost: string;
  /** sell/cost columns are NOT NULL (input/output default to 0) */
  required?: boolean;
}

export const UNIT_FIELDS: readonly UnitFields[] = [
  { unit: "input", sell: "inputPrice", official: "officialInputPrice", cost: "inputCost", required: true },
  { unit: "output", sell: "outputPrice", official: "officialOutputPrice", cost: "outputCost", required: true },
  { unit: "cachedInput", sell: "cachedInputPrice", official: "officialCachedPrice", cost: "cachedInputCost" },
  { unit: "cacheWrite", sell: "cacheWritePrice", official: "officialCacheWritePrice", cost: "cacheWriteCost" },
  { unit: "image", sell: "imagePrice", official: "officialImagePrice", cost: "imageCost" },
  { unit: "request", sell: "requestPrice", official: "officialRequestPrice", cost: "requestCost" },
  { unit: "audioInput", sell: "audioInputPrice", official: "officialAudioInputPrice", cost: "audioInputCost" },
  { unit: "audioOutput", sell: "audioOutputPrice", official: "officialAudioOutputPrice", cost: "audioOutputCost" },
  { unit: "perMinute", sell: "perMinutePrice", official: "officialPerMinutePrice", cost: "perMinuteCost" },
  { unit: "perMillionChars", sell: "perMillionChars", official: "officialPerMillionChars", cost: "perMillionCharsCost" },
  { unit: "perSecond", sell: "perSecondPrice", official: "officialPerSecondPrice", cost: "perSecondCost" },
] as const;

/** Extra columns with no unit of their own (the 1h cache write follows the 5m one). */
export const CACHE_WRITE_1H = { sell: "cacheWrite1hPrice", cost: "cacheWrite1hCost" } as const;

type Row = Record<string, unknown>;

export const toDec = (v: unknown): Decimal | null => {
  if (v === null || v === undefined) return null;
  try {
    const d = new Decimal(String(v));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
};

/**
 * Sell-column updates (DB strings) a pricing rule produces for `model`, given the primary route's cost row. Only columns
 * whose value would CHANGE are returned; units without an official / cost basis are left alone.
 */
export function deriveSellUpdates(model: Row, route: Row | null, rule: PricingRule): Record<string, string> {
  const out: Record<string, string> = {};
  if (rule.mode === "FIXED" || rule.value === null || rule.value === undefined) return out;
  const value = new Decimal(rule.value);
  const factor = rule.mode === "PERCENT_OF_OFFICIAL" ? value.div(100) : value.div(100).plus(1);

  const apply = (sellCol: string, basis: Decimal | null) => {
    if (!basis) return;
    const next = basis.times(factor);
    const cur = toDec(model[sellCol]);
    if (!cur || !cur.equals(next)) out[sellCol] = toDbString(next);
  };

  for (const f of UNIT_FIELDS) {
    if (rule.mode === "PERCENT_OF_OFFICIAL") apply(f.sell, f.official ? toDec(model[f.official]) : null);
    else if (route) apply(f.sell, toDec(route[f.cost]));
  }
  if (rule.mode === "MARKUP_OVER_COST" && route) apply(CACHE_WRITE_1H.sell, toDec(route[CACHE_WRITE_1H.cost]));
  return out;
}

// ------------------------------------------------------------------------------------------------ catalog -> columns
const money = (n: number | null | undefined): string | null => (n === null || n === undefined ? null : toDbString(new Decimal(String(n))));

/** `official*` Model columns of a known price (null = no official price for that unit). */
export function knownOfficialFields(k: KnownPrice): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of UNIT_FIELDS) if (f.official) out[f.official] = money(k.official[f.unit]);
  return out;
}

/**
 * ModelRoute cost columns when we buy at the official list price (a direct supplier). input / output are required
 * columns and default to 0; every other unit is null unless the catalog has it.
 */
export function knownCostFields(k: KnownPrice): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of UNIT_FIELDS) out[f.cost] = money(k.official[f.unit]) ?? (f.required ? "0.000000000000" : null);
  out[CACHE_WRITE_1H.cost] = money(k.cacheWrite1h);
  return out;
}

/** Customer (sell) columns for a known price under a rule, computed from the cost columns (a fresh model has none yet). */
export function knownSellFields(k: KnownPrice, rule: PricingRule): Record<string, string> {
  return deriveSellUpdates({}, knownCostFields(k), rule);
}
