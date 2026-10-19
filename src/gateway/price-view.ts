import { Decimal, ONE_MILLION, ZERO } from "@/lib/money";
import type { OptTable, PriceTable } from "./pricing";

/**
 * Price presentation shared by the catalog endpoints (`/v1/models`, `/v1/model/info`) and the public `/api/pricing`
 * document. Everything is derived from the same numbers the gateway bills with, at the caller's effective price
 * (group x customer multiplier). Never exposes costs, providers or upstream model ids.
 */

/** Decimal -> plain decimal string: no exponent, no trailing zeros ("0.00000015", "0"). */
export function decimalString(d: Decimal): string {
  return d.toDecimalPlaces(18).toFixed();
}

/** USD per 1M tokens -> USD per token as a decimal string. */
export function perTokenString(perMillion: Decimal | null | undefined): string {
  return perMillion ? decimalString(perMillion.div(ONE_MILLION)) : "0";
}

export const plainNumber = (d: Decimal | null | undefined): number | null => (d ? Number(decimalString(d)) : null);

/** Public unit keys in display order, with their unit of measure. */
export const PUBLIC_UNITS = [
  { key: "input", unit: "usd_per_1m_tokens" },
  { key: "output", unit: "usd_per_1m_tokens" },
  { key: "cached_input", unit: "usd_per_1m_tokens" },
  { key: "cache_write", unit: "usd_per_1m_tokens" },
  { key: "audio_input", unit: "usd_per_1m_tokens" },
  { key: "audio_output", unit: "usd_per_1m_tokens" },
  { key: "image", unit: "usd_per_image" },
  { key: "request", unit: "usd_per_request" },
  { key: "per_second", unit: "usd_per_second" },
  { key: "per_minute", unit: "usd_per_minute" },
  { key: "per_1m_chars", unit: "usd_per_1m_characters" },
] as const;
export type PublicUnitKey = (typeof PUBLIC_UNITS)[number]["key"];

const FIELD_OF: Record<PublicUnitKey, Exclude<keyof PriceTable, "tools">> = {
  input: "input",
  output: "output",
  cached_input: "cachedInput",
  cache_write: "cacheWrite",
  audio_input: "audioInput",
  audio_output: "audioOutput",
  image: "image",
  request: "request",
  per_second: "perSecond",
  per_minute: "perMinute",
  per_1m_chars: "perMillionChars",
};

/** Units that exist for a model: input/output only count when the model bills tokens. */
function relevant(key: PublicUnitKey, sell: PriceTable, official: OptTable | null): boolean {
  const f = FIELD_OF[key];
  if (key === "input" || key === "output") {
    // a pure image / per-second / per-minute model shows no token prices
    const flatOnly = (sell.image || sell.perSecond || sell.perMinute || sell.perMillionChars) && sell.input.isZero() && sell.output.isZero();
    return !flatOnly;
  }
  return !!sell[f] || !!official?.[f];
}

export interface PriceMatrix {
  unit: Partial<Record<PublicUnitKey, string>>;
  yours: Partial<Record<PublicUnitKey, number>>;
  official: Partial<Record<PublicUnitKey, number>>;
  savings_pct: Partial<Record<PublicUnitKey, number>>;
  /** Server tools (USD per unit: search / container hour / call), by price key. Empty when the model prices none. */
  tools: Record<string, { yours: number; official?: number; savings_pct?: number }>;
}

/**
 * Per unit: your price (sell x multiplier), the official price and the saving. A unit without an official price has no
 * `official` / `savings_pct` entry. `savings_pct` is negative when we are above the official price (never hidden).
 */
export function priceMatrix(sell: PriceTable, official: OptTable | null, multiplier: Decimal): PriceMatrix {
  const out: PriceMatrix = { unit: {}, yours: {}, official: {}, savings_pct: {}, tools: {} };
  for (const k of Object.keys(sell.tools ?? {}).sort()) {
    const mine = sell.tools![k].times(multiplier);
    const off = official?.tools?.[k] ?? null;
    out.tools[k] = { yours: plainNumber(mine)! };
    if (off) {
      out.tools[k].official = plainNumber(off)!;
      if (off.gt(0)) out.tools[k].savings_pct = Number(off.minus(mine).div(off).times(100).toDecimalPlaces(2).toFixed());
    }
  }
  for (const u of PUBLIC_UNITS) {
    if (!relevant(u.key, sell, official)) continue;
    const f = FIELD_OF[u.key];
    const mine = sell[f]?.times(multiplier) ?? null;
    if (!mine) continue;
    out.unit[u.key] = u.unit;
    out.yours[u.key] = plainNumber(mine)!;
    const off = official?.[f] ?? null;
    if (off) {
      out.official[u.key] = plainNumber(off)!;
      if (off.gt(0)) out.savings_pct[u.key] = Number(off.minus(mine).div(off).times(100).toDecimalPlaces(2).toFixed());
    }
  }
  return out;
}

/** OpenRouter-compatible `pricing` object: decimal STRINGS, USD per token (per request / per image for those two). */
export function openRouterPricing(sell: PriceTable, multiplier: Decimal): Record<string, string> {
  const m = (v: Decimal | null | undefined) => (v ? v.times(multiplier) : null);
  const perToken = (v: Decimal | null | undefined) => perTokenString(m(v));
  const flat = (v: Decimal | null | undefined) => decimalString(m(v) ?? ZERO);
  return {
    prompt: perToken(sell.input),
    completion: perToken(sell.output),
    request: flat(sell.request),
    image: flat(sell.image),
    input_cache_read: perToken(sell.cachedInput),
    input_cache_write: perToken(sell.cacheWrite),
    internal_reasoning: "0",
  };
}

/** Modalities from a model's capability list (OpenRouter `architecture`). */
export function modalities(caps: Iterable<string>): { input_modalities: string[]; output_modalities: string[] } {
  const c = new Set(caps);
  const input = new Set<string>();
  const output = new Set<string>();
  if (c.has("chat") || c.has("responses") || c.has("completions") || c.has("reasoning") || c.has("tools")) {
    input.add("text");
    output.add("text");
  }
  if (c.has("vision")) input.add("image");
  if (c.has("images")) {
    input.add("text");
    output.add("image");
  }
  if (c.has("audio_speech")) {
    input.add("text");
    output.add("audio");
  }
  if (c.has("audio_transcription")) {
    input.add("audio");
    output.add("text");
  }
  if (c.has("video")) {
    input.add("text");
    output.add("video");
  }
  if (c.has("embeddings")) {
    input.add("text");
    output.add("embeddings");
  }
  if (c.has("moderation")) {
    input.add("text");
    output.add("text");
  }
  if (!input.size) input.add("text");
  if (!output.size) output.add("text");
  return { input_modalities: [...input], output_modalities: [...output] };
}

/** LiteLLM `mode` for a model. */
export function liteLLMMode(caps: Iterable<string>): string {
  const c = new Set(caps);
  if (c.has("video")) return "video_generation";
  if (c.has("images") && !c.has("chat")) return "image_generation";
  if (c.has("audio_speech") && !c.has("chat")) return "audio_speech";
  if (c.has("audio_transcription") && !c.has("chat")) return "audio_transcription";
  if (c.has("embeddings") && !c.has("chat")) return "embedding";
  if (c.has("moderation") && !c.has("chat")) return "moderation";
  if (c.has("chat") || c.has("responses")) return "chat";
  if (c.has("completions")) return "completion";
  return "chat";
}
