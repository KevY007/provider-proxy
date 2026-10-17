import { Decimal, ONE_MILLION, ZERO, roundDb, toDecimal, type MoneyLike } from "@/lib/money";
import type { Usage } from "./types";

/**
 * Pricing math (PLAN 6) - pure, no I/O. All prices are USD per 1M units unless noted.
 *
 *   effectiveMultiplier = (user.priceMultiplier ?? 1) x group.priceMultiplier
 *   uncachedInput = inputTokens - cachedTokens - cacheWriteTokens
 *   lc            = (longContextThreshold && inputTokens > threshold) ? longContextMultiplier : 1   (token components only)
 *   tokens$       = lc x ( uncachedInput x in + cached x (cachedIn ?? in) + cacheWrite5m x (cacheWrite ?? in)
 *                          + cacheWrite1h x (cacheWrite1h ?? cacheWrite ?? in) + output x out
 *                          + audioIn x audioInputPrice + audioOut x audioOutputPrice ) / 1e6
 *   flat$         = images x imagePrice + requestPrice + minutes x perMinute + chars x perMillionChars / 1e6
 *                   + videoSeconds x perSecond
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
}

export interface LongContext {
  threshold: number | null;
  multiplier: Decimal | null;
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
  };
}

export function longContextFactor(inputTokens: number, lc: LongContext | null | undefined): Decimal {
  if (!lc || !lc.threshold || !lc.multiplier) return new Decimal(1);
  return inputTokens > lc.threshold ? lc.multiplier : new Decimal(1);
}

export function effectiveMultiplier(userMultiplier: MoneyLike, groupMultiplier: MoneyLike): Decimal {
  const u = userMultiplier === null || userMultiplier === undefined ? new Decimal(1) : toDecimal(userMultiplier, 1);
  const g = groupMultiplier === null || groupMultiplier === undefined ? new Decimal(1) : toDecimal(groupMultiplier, 1);
  return u.times(g);
}

const perM = (units: number, price: Decimal | null): Decimal => (price && units > 0 ? price.times(units).div(ONE_MILLION) : ZERO);

/** Unrounded token component (before long-context). */
function tokenAmount(u: Usage, t: PriceTable): Decimal {
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

  return perM(uncached, t.input)
    .plus(perM(cached, t.cachedInput ?? t.input))
    .plus(perM(cw5m, t.cacheWrite ?? t.input))
    .plus(perM(cw1h, t.cacheWrite1h ?? t.cacheWrite ?? t.input))
    .plus(perM(out, t.output))
    .plus(perM(audioIn, t.audioInput))
    .plus(perM(audioOut, t.audioOutput));
}

function flatAmount(u: Usage, t: PriceTable, billRequest: boolean): Decimal {
  let sum = ZERO;
  if (t.image && u.imageCount > 0) sum = sum.plus(t.image.times(u.imageCount));
  if (billRequest && t.request) sum = sum.plus(t.request);
  if (t.perMinute && u.audioSeconds > 0) sum = sum.plus(t.perMinute.times(u.audioSeconds).div(60));
  if (t.perMillionChars && u.characters > 0) sum = sum.plus(perM(u.characters, t.perMillionChars));
  if (t.perSecond && u.videoSeconds > 0) sum = sum.plus(t.perSecond.times(u.videoSeconds));
  return sum;
}

export interface PriceOptions {
  /** Add the flat per-request price (successful requests only). Default true. */
  billRequest?: boolean;
  longContext?: LongContext | null;
  /** Multiplier for customer price (omit for cost). */
  multiplier?: MoneyLike;
}

/** Amount for `usage` under `table` (used for both price and cost). Rounded to 12 dp. */
export function computeAmount(usage: Usage, table: PriceTable, opts: PriceOptions = {}): Decimal {
  const flatImages = !!table.image && usage.imageCount > 0;
  let tokens = flatImages ? ZERO : tokenAmount(usage, table);
  tokens = tokens.times(longContextFactor(usage.inputTokens, opts.longContext));
  let total = tokens.plus(flatAmount(usage, table, opts.billRequest ?? true));
  if (opts.multiplier !== undefined && opts.multiplier !== null) total = total.times(toDecimal(opts.multiplier, 1));
  return roundDb(total);
}

export interface PriceBreakdown {
  price: Decimal;
  cost: Decimal;
  profit: Decimal;
  multiplier: Decimal;
}

/** price (with multiplier) + cost (without) + profit for one request. */
export function priceRequest(
  usage: Usage,
  sell: PriceTable,
  cost: PriceTable | null,
  multiplier: MoneyLike,
  longContext: LongContext | null | undefined,
  billRequest = true,
): PriceBreakdown {
  const mult = toDecimal(multiplier, 1);
  const price = computeAmount(usage, sell, { multiplier: mult, longContext, billRequest });
  const c = cost ? computeAmount(usage, cost, { longContext, billRequest }) : ZERO;
  return { price, cost: c, profit: roundDb(price.minus(c)), multiplier: mult };
}

/**
 * Worst-case-ish price used by the pre-flight balance check:
 * input estimate x input price + output estimate x output price (+ flat request price), x multiplier.
 */
export function estimatePrice(inputTokensEst: number, maxOutputEst: number, sell: PriceTable, multiplier: MoneyLike): Decimal {
  const base = perM(inputTokensEst, sell.input).plus(perM(maxOutputEst, sell.output)).plus(sell.request ?? ZERO);
  return base.times(toDecimal(multiplier, 1));
}
