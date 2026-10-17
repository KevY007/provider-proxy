/**
 * Pure pricing helpers for the customer portal and public site (no DB, safe in server + client code).
 * Mirrors PLAN section 6: effective multiplier = (user.priceMultiplier ?? 1) x group.priceMultiplier.
 * All prices are USD per 1M units unless noted; Decimals travel as strings.
 */
import { Decimal, toDecimal, type MoneyLike } from "@/lib/money";

export interface ModelSellPrices {
  inputPrice: MoneyLike;
  outputPrice: MoneyLike;
  cachedInputPrice?: MoneyLike;
  cacheWritePrice?: MoneyLike;
  imagePrice?: MoneyLike;
  requestPrice?: MoneyLike;
}

export interface OfficialPrices {
  officialInputPrice?: MoneyLike;
  officialOutputPrice?: MoneyLike;
  officialCachedPrice?: MoneyLike;
}

export interface EffectivePrices {
  input: string;
  output: string;
  cachedInput: string | null;
  cacheWrite: string | null;
  /** USD per generated image. */
  image: string | null;
  /** USD flat per request. */
  request: string | null;
}

/** (user override ?? 1) x group multiplier. */
export function effectiveMultiplier(groupMultiplier: MoneyLike, userMultiplier?: MoneyLike): Decimal {
  const g = toDecimal(groupMultiplier, 1);
  const u = userMultiplier === null || userMultiplier === undefined ? new Decimal(1) : toDecimal(userMultiplier, 1);
  return g.times(u);
}

const mul = (v: MoneyLike, m: Decimal): string | null =>
  v === null || v === undefined ? null : toDecimal(v).times(m).toString();

/** What the customer actually pays for a model under a multiplier. */
export function effectivePrices(model: ModelSellPrices, multiplier: MoneyLike): EffectivePrices {
  const m = toDecimal(multiplier, 1);
  return {
    input: toDecimal(model.inputPrice).times(m).toString(),
    output: toDecimal(model.outputPrice).times(m).toString(),
    cachedInput: mul(model.cachedInputPrice, m),
    cacheWrite: mul(model.cacheWritePrice, m),
    image: mul(model.imagePrice, m),
    request: mul(model.requestPrice, m),
  };
}

/**
 * Percentage saved vs the official price (0..100, may be negative), blending input:output 3:1 like a typical
 * chat workload. Returns null when no official reference exists.
 */
export function savingsPercent(official: OfficialPrices, ours: { input: MoneyLike; output: MoneyLike }): number | null {
  if (official.officialInputPrice == null || official.officialOutputPrice == null) return null;
  const offBlend = toDecimal(official.officialInputPrice).times(3).plus(toDecimal(official.officialOutputPrice));
  if (offBlend.isZero()) return null;
  const ourBlend = toDecimal(ours.input).times(3).plus(toDecimal(ours.output));
  return new Decimal(1).minus(ourBlend.div(offBlend)).times(100).toNumber();
}

/** "48% off" / "+5%" / "-" label for a savings value. */
export function formatSavings(pct: number | null): string {
  if (pct === null || Number.isNaN(pct)) return "-";
  const r = Math.round(pct);
  if (r === 0) return "0%";
  return r > 0 ? `${r}% off` : `+${Math.abs(r)}%`;
}

export interface GroupLike {
  id: string;
  slug: string;
  name: string;
  priceMultiplier: MoneyLike;
  allowedModels: string[];
  isDefault: boolean;
  isPublic: boolean;
  sortOrder: number;
}

/** Whether a group lets a model slug through (empty allow-list = every public model). */
export function groupAllowsModel(group: Pick<GroupLike, "allowedModels">, slug: string, aliases: string[] = []): boolean {
  if (group.allowedModels.length === 0) return true;
  return group.allowedModels.includes(slug) || aliases.some((a) => group.allowedModels.includes(a));
}

/** Format a multiplier for UI: 0.8 -> "0.8x". */
export function formatMultiplier(m: MoneyLike): string {
  return `${toDecimal(m, 1).toDecimalPlaces(4).toString()}×`;
}

/** Cost of a usage report under effective per-million prices (inputTokens is the TOTAL prompt tokens incl. cached). */
export function estimateCost(
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number; images?: number },
  prices: Pick<EffectivePrices, "input" | "output" | "cachedInput" | "image" | "request">,
): Decimal {
  const cached = Math.min(usage.cachedTokens ?? 0, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const million = new Decimal(1_000_000);
  let total = toDecimal(prices.input).times(uncached)
    .plus(toDecimal(prices.cachedInput ?? prices.input).times(cached))
    .plus(toDecimal(prices.output).times(usage.outputTokens))
    .div(million);
  if (usage.images && prices.image) total = total.plus(toDecimal(prices.image).times(usage.images));
  if (prices.request) total = total.plus(toDecimal(prices.request));
  return total;
}
