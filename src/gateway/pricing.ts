import { Decimal, ONE_MILLION, ZERO, roundDb, toDecimal, type MoneyLike } from "@/lib/money";
import type { Usage } from "./types";

/**
 * Pricing math (PLAN 6) - pure, no I/O. All prices are USD per 1M units unless noted.
 *
 *   effectiveMultiplier = (user.priceMultiplier ?? 1) x group.priceMultiplier
 *   uncachedInput = inputTokens - cachedTokens - cacheWriteTokens
 *   lc            = (longContextThreshold && inputTokens > threshold) ? longContextMultiplier : 1   (token components only;
 *                   output tokens use longContextOutputMultiplier when set)
 *   tokens$       = lc x ( uncachedInput x in + cached x (cachedIn ?? in) + cacheWrite5m x (cacheWrite ?? in)
 *                          + cacheWrite1h x (cacheWrite1h ?? cacheWrite ?? in) + output x out
 *                          + audioIn x audioInputPrice + audioOut x audioOutputPrice ) / 1e6
 *   flat$         = images x imagePrice + requestPrice + minutes x perMinute + chars x perMillionChars / 1e6
 *                   + videoSeconds x perSecond + sum(toolUsage[k] x tools[k])    (server tools: searches, container hours, calls)
 *   price         = multiplier x (tokens$ + flat$)        <- the group/user multiplier applies to everything the customer pays
 *   cost          = same formula with route cost fields, NO multiplier
 *   profit        = price - cost
 *
 * Notes
 *  - Audio tokens are a SUBSET of input/output tokens: when audioInputPrice/audioOutputPrice is set they are
 *    billed at that rate instead of the text rate (never both).
 *  - When an image model has a flat per-image price and images were generated, token usage is not billed in
 *    addition ("if imagePrice set bill per image, else bill token usage").
 *  - Results are rounded to the DB scale (12 dp) so what we log is exactly what we deduct.
 *  - Batch API results take `batchDiscountPct` off the TOKEN part only (server tools and flat prices are not discounted).
 */
export interface PriceTable {
  input: Decimal;
  output: Decimal;
  cachedInput: Decimal | null;
  cacheWrite: Decimal | null;
  cacheWrite1h: Decimal | null;
  image: Decimal | null;
  request: Decimal | null;
  audioInput: Decimal | null;
  audioOutput: Decimal | null;
  perMinute: Decimal | null;
  perMillionChars: Decimal | null;
  /** Video generation, USD per generated second. */
  perSecond: Decimal | null;
  /** Server tools, USD per unit (`web_search_request`, `code_execution_hour`, `web_search_call`, `file_search_call`, ...). */
  tools?: Record<string, Decimal>;
}

/** `{ "web_search_request": "0.01" }` (a Json column) -> decimals; anything that is not a non-negative number is ignored. */
export function toolTable(v: unknown): Record<string, Decimal> {
  const out: Record<string, Decimal> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === null || x === undefined || x === "") continue;
    const d = toDecimal(x as MoneyLike, NaN);
    if (d.isFinite() && d.gte(0)) out[k] = d;
  }
  return out;
}

export interface LongContext {
  threshold: number | null;
  multiplier: Decimal | null;
  /** Output tokens above the threshold (null/undefined: `multiplier`). */
  outputMultiplier?: Decimal | null;
}

const opt = (v: MoneyLike): Decimal | null => (v === null || v === undefined ? null : toDecimal(v));

/** Build a PriceTable from a Model row (sell prices). */
export function sellTable(m: {
  inputPrice: MoneyLike;
  outputPrice: MoneyLike;
  cachedInputPrice?: MoneyLike;
  cacheWritePrice?: MoneyLike;
  cacheWrite1hPrice?: MoneyLike;
  imagePrice?: MoneyLike;
  requestPrice?: MoneyLike;
  audioInputPrice?: MoneyLike;
  audioOutputPrice?: MoneyLike;
  perMinutePrice?: MoneyLike;
  perMillionChars?: MoneyLike;
  perSecondPrice?: MoneyLike;
  toolPrices?: unknown;
}): PriceTable {
  return {
    input: toDecimal(m.inputPrice),
    output: toDecimal(m.outputPrice),
    cachedInput: opt(m.cachedInputPrice),
    cacheWrite: opt(m.cacheWritePrice),
    cacheWrite1h: opt(m.cacheWrite1hPrice),
    image: opt(m.imagePrice),
    request: opt(m.requestPrice),
    audioInput: opt(m.audioInputPrice),
    audioOutput: opt(m.audioOutputPrice),
    perMinute: opt(m.perMinutePrice),
    perMillionChars: opt(m.perMillionChars),
    perSecond: opt(m.perSecondPrice),
    tools: toolTable(m.toolPrices),
  };
}

/** Build a PriceTable from a ModelRoute row (cost prices). */
export function costTable(r: {
  inputCost: MoneyLike;
  outputCost: MoneyLike;
  cachedInputCost?: MoneyLike;
  cacheWriteCost?: MoneyLike;
  cacheWrite1hCost?: MoneyLike;
  imageCost?: MoneyLike;
  requestCost?: MoneyLike;
  audioInputCost?: MoneyLike;
  audioOutputCost?: MoneyLike;
  perMinuteCost?: MoneyLike;
  perMillionCharsCost?: MoneyLike;
  perSecondCost?: MoneyLike;
  toolCosts?: unknown;
}): PriceTable {
  return {
    input: toDecimal(r.inputCost),
    output: toDecimal(r.outputCost),
    cachedInput: opt(r.cachedInputCost),
    cacheWrite: opt(r.cacheWriteCost),
    cacheWrite1h: opt(r.cacheWrite1hCost),
    image: opt(r.imageCost),
    request: opt(r.requestCost),
    audioInput: opt(r.audioInputCost),
    audioOutput: opt(r.audioOutputCost),
    perMinute: opt(r.perMinuteCost),
    perMillionChars: opt(r.perMillionCharsCost),
    perSecond: opt(r.perSecondCost),
    tools: toolTable(r.toolCosts),
  };
}

export function longContextFactor(inputTokens: number, lc: LongContext | null | undefined, part: "input" | "output" = "input"): Decimal {
  if (!lc || !lc.threshold || !lc.multiplier || inputTokens <= lc.threshold) return new Decimal(1);
  return part === "output" && lc.outputMultiplier ? lc.outputMultiplier : lc.multiplier;
}

export function effectiveMultiplier(userMultiplier: MoneyLike, groupMultiplier: MoneyLike): Decimal {
  const u = userMultiplier === null || userMultiplier === undefined ? new Decimal(1) : toDecimal(userMultiplier, 1);
  const g = groupMultiplier === null || groupMultiplier === undefined ? new Decimal(1) : toDecimal(groupMultiplier, 1);
  return u.times(g);
}

const perM = (units: number, price: Decimal | null): Decimal => (price && units > 0 ? price.times(units).div(ONE_MILLION) : ZERO);

/** Unrounded token components (before long-context): input side (incl. cache reads / writes) and output side. */
function tokenAmount(u: Usage, t: PriceTable): { input: Decimal; output: Decimal } {
  const cached = Math.max(0, Math.min(u.cachedTokens, u.inputTokens));
  const cw = Math.max(0, Math.min(u.cacheWriteTokens, u.inputTokens - cached));
  const cw1h = Math.max(0, Math.min(u.cacheWrite1hTokens, cw));
  const cw5m = cw - cw1h;
  let uncached = u.inputTokens - cached - cw;
  // audio tokens are a subset; bill them at the audio rate only when one is configured
  const audioIn = t.audioInput ? Math.max(0, Math.min(u.audioInputTokens, uncached)) : 0;
  uncached -= audioIn;
  let out = u.outputTokens; // includes reasoning
  const audioOut = t.audioOutput ? Math.max(0, Math.min(u.audioOutputTokens, out)) : 0;
  out -= audioOut;

  return {
    input: perM(uncached, t.input)
      .plus(perM(cached, t.cachedInput ?? t.input))
      .plus(perM(cw5m, t.cacheWrite ?? t.input))
      .plus(perM(cw1h, t.cacheWrite1h ?? t.cacheWrite ?? t.input))
      .plus(perM(audioIn, t.audioInput)),
    output: perM(out, t.output).plus(perM(audioOut, t.audioOutput)),
  };
}

function flatAmount(u: Usage, t: PriceTable, billRequest: boolean): Decimal {
  let sum = ZERO;
  if (t.image && u.imageCount > 0) sum = sum.plus(t.image.times(u.imageCount));
  if (billRequest && t.request) sum = sum.plus(t.request);
  if (t.perMinute && u.audioSeconds > 0) sum = sum.plus(t.perMinute.times(u.audioSeconds).div(60));
  if (t.perMillionChars && u.characters > 0) sum = sum.plus(perM(u.characters, t.perMillionChars));
  if (t.perSecond && u.videoSeconds > 0) sum = sum.plus(t.perSecond.times(u.videoSeconds));
  return sum.plus(toolAmount(u, t));
}

/** Server tools the request used x their unit prices (a tool without a price is free: nothing is invented). */
function toolAmount(u: Usage, t: PriceTable): Decimal {
  let sum = ZERO;
  if (!u.toolUsage || !t.tools) return sum;
  for (const [k, units] of Object.entries(u.toolUsage)) {
    const price = t.tools[k];
    if (price && units > 0) sum = sum.plus(price.times(units));
  }
  return sum;
}

export interface PriceOptions {
  /** Add the flat per-request price (successful requests only). Default true. */
  billRequest?: boolean;
  longContext?: LongContext | null;
  /** Multiplier for customer price (omit for cost). */
  multiplier?: MoneyLike;
  /** Batch API: percent taken off the token part (0-100). */
  tokenDiscountPct?: MoneyLike;
}

/** The discount factor (1 - pct/100) of a batch discount, clamped to [0, 1]. */
export function discountFactor(pct: MoneyLike): Decimal {
  const d = toDecimal(pct, 0);
  if (!d.isFinite() || d.lte(0)) return new Decimal(1);
  if (d.gte(100)) return ZERO;
  return new Decimal(1).minus(d.div(100));
}

/** The vendors' own Batch API discount (Anthropic and OpenAI: 50% off input and output tokens). */
export const DEFAULT_BATCH_DISCOUNT_PCT = 50;

/** Amount for `usage` under `table` (used for both price and cost). Rounded to 12 dp. */
export function computeAmount(usage: Usage, table: PriceTable, opts: PriceOptions = {}): Decimal {
  const flatImages = !!table.image && usage.imageCount > 0;
  let tokens = ZERO;
  if (!flatImages) {
    const t = tokenAmount(usage, table);
    tokens = t.input.times(longContextFactor(usage.inputTokens, opts.longContext)).plus(t.output.times(longContextFactor(usage.inputTokens, opts.longContext, "output")));
  }
  if (opts.tokenDiscountPct !== undefined && opts.tokenDiscountPct !== null) tokens = tokens.times(discountFactor(opts.tokenDiscountPct));
  let total = tokens.plus(flatAmount(usage, table, opts.billRequest ?? true));
  if (opts.multiplier !== undefined && opts.multiplier !== null) total = total.times(toDecimal(opts.multiplier, 1));
  return roundDb(total);
}

/** Per-unit nullable prices (an "official" price list: any unit may be unknown). */
export type OptTable = { [K in Exclude<keyof PriceTable, "tools">]: Decimal | null } & { tools?: Record<string, Decimal> };

/** Build the OFFICIAL price list of a Model row (null = the model has no official price for that unit). */
export function officialTable(m: {
  officialInputPrice?: MoneyLike;
  officialOutputPrice?: MoneyLike;
  officialCachedPrice?: MoneyLike;
  officialCacheWritePrice?: MoneyLike;
  officialImagePrice?: MoneyLike;
  officialRequestPrice?: MoneyLike;
  officialAudioInputPrice?: MoneyLike;
  officialAudioOutputPrice?: MoneyLike;
  officialPerMinutePrice?: MoneyLike;
  officialPerMillionChars?: MoneyLike;
  officialPerSecondPrice?: MoneyLike;
  officialToolPrices?: unknown;
}): OptTable {
  return {
    input: opt(m.officialInputPrice),
    output: opt(m.officialOutputPrice),
    cachedInput: opt(m.officialCachedPrice),
    cacheWrite: opt(m.officialCacheWritePrice),
    cacheWrite1h: null,
    image: opt(m.officialImagePrice),
    request: opt(m.officialRequestPrice),
    audioInput: opt(m.officialAudioInputPrice),
    audioOutput: opt(m.officialAudioOutputPrice),
    perMinute: opt(m.officialPerMinutePrice),
    perMillionChars: opt(m.officialPerMillionChars),
    perSecond: opt(m.officialPerSecondPrice),
    tools: toolTable(m.officialToolPrices),
  };
}

const scaled = (v: Decimal | null, mult: Decimal): Decimal | null => (v ? v.times(mult) : null);

/**
 * The price list the SAME usage would have cost at official prices. A unit without an official price is priced at what
 * the customer pays for it (sell x multiplier), so its savings are exactly 0. The multiplier is baked into those
 * fallbacks (official prices themselves are never multiplied), so callers compute the amount WITHOUT a multiplier.
 * A unit the customer is billed flat (image) stays flat here too, so both sides bill the same way.
 */
export function effectiveOfficial(official: OptTable | null | undefined, sell: PriceTable, multiplier: MoneyLike): PriceTable {
  const m = toDecimal(multiplier, 1);
  const o = official ?? ({} as OptTable);
  return {
    input: o.input ?? sell.input.times(m),
    output: o.output ?? sell.output.times(m),
    cachedInput: o.cachedInput ?? scaled(sell.cachedInput, m),
    cacheWrite: o.cacheWrite ?? scaled(sell.cacheWrite, m),
    cacheWrite1h: o.cacheWrite1h ?? scaled(sell.cacheWrite1h, m),
    image: sell.image ? (o.image ?? sell.image.times(m)) : null,
    request: o.request ?? scaled(sell.request, m),
    audioInput: o.audioInput ?? scaled(sell.audioInput, m),
    audioOutput: o.audioOutput ?? scaled(sell.audioOutput, m),
    perMinute: o.perMinute ?? scaled(sell.perMinute, m),
    perMillionChars: o.perMillionChars ?? scaled(sell.perMillionChars, m),
    perSecond: o.perSecond ?? scaled(sell.perSecond, m),
    tools: effectiveOfficialTools(o.tools, sell.tools, m),
  };
}

/** Server tools: the official unit price where one exists, else what the customer pays for it (sell x multiplier). */
function effectiveOfficialTools(official: Record<string, Decimal> | undefined, sell: Record<string, Decimal> | undefined, mult: Decimal): Record<string, Decimal> {
  const out: Record<string, Decimal> = {};
  for (const [k, v] of Object.entries(sell ?? {})) out[k] = v.times(mult);
  for (const [k, v] of Object.entries(official ?? {})) out[k] = v;
  return out;
}

export interface PriceBreakdown {
  price: Decimal;
  cost: Decimal;
  profit: Decimal;
  multiplier: Decimal;
  /** What the same usage costs at official prices (== price when the model has no official prices). */
  official: Decimal;
}

/** Batch API discounts (percent off the token part): what the customer is charged, what we pay, and the vendor's own batch price. */
export interface BatchDiscounts {
  /** Model.batchDiscountPct (null/undefined = the vendors' 50) */
  sellPct: MoneyLike;
  /** ModelRoute.batchCostDiscountPct */
  costPct: MoneyLike;
}

/** price (with multiplier) + cost (without) + profit (+ official-price equivalent) for one request. */
export function priceRequest(
  usage: Usage,
  sell: PriceTable,
  cost: PriceTable | null,
  multiplier: MoneyLike,
  longContext: LongContext | null | undefined,
  billRequest = true,
  official?: OptTable | null,
  batch?: BatchDiscounts | null,
): PriceBreakdown {
  const mult = toDecimal(multiplier, 1);
  const sellPct = batch ? (batch.sellPct === null || batch.sellPct === undefined ? DEFAULT_BATCH_DISCOUNT_PCT : batch.sellPct) : undefined;
  const costPct = batch ? (batch.costPct === null || batch.costPct === undefined ? DEFAULT_BATCH_DISCOUNT_PCT : batch.costPct) : undefined;
  const price = computeAmount(usage, sell, { multiplier: mult, longContext, billRequest, tokenDiscountPct: sellPct });
  const c = cost ? computeAmount(usage, cost, { longContext, billRequest, tokenDiscountPct: costPct }) : ZERO;
  // the official equivalent of a batch result is the vendor's own batch price (the vendors discount their list price by 50%)
  const off = official ? computeAmount(usage, effectiveOfficial(official, sell, mult), { longContext, billRequest, tokenDiscountPct: batch ? DEFAULT_BATCH_DISCOUNT_PCT : undefined }) : price;
  return { price, cost: c, profit: roundDb(price.minus(c)), multiplier: mult, official: off };
}

/**
 * Worst-case-ish price used by the pre-flight balance check:
 * input estimate x input price + output estimate x output price (+ flat request price), x multiplier.
 */
export function estimatePrice(inputTokensEst: number, maxOutputEst: number, sell: PriceTable, multiplier: MoneyLike): Decimal {
  const base = perM(inputTokensEst, sell.input).plus(perM(maxOutputEst, sell.output)).plus(sell.request ?? ZERO);
  return base.times(toDecimal(multiplier, 1));
}
