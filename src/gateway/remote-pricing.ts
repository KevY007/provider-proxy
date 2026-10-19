import type { PriceTable } from "@/server/pricing/preview";
import { buildUpstreamHeaders, type AdapterProvider } from "./providers/adapters";
import type { JsonObject } from "./types";
import { readTextLimited, sendUpstream } from "./upstream";
import { isObject, safeJsonParse } from "./util";

/**
 * Prices a provider publishes through its own API: a starting point for the admin's route costs when a model is added
 * (a reseller / another proxy / OpenRouter tells us what it charges). Never authoritative - the admin confirms them.
 *
 * Understood shapes (per model entry, in lists under `data` / `models` / a top-level array / a map keyed by model id):
 *  - OpenRouter + ProviderProxy `/v1/models`: `pricing: { prompt, completion, input_cache_read, input_cache_write, image, request }`
 *    as USD per token (decimal strings)
 *  - ProviderProxy: `x_pricing.yours` / `pricing.yours` (USD per 1M tokens / per unit) and `.official`
 *  - LiteLLM `/model/info`: `model_info.input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`,
 *    `cache_creation_input_token_cost`, `output_cost_per_image`, `output_cost_per_second`, `input_cost_per_second`
 *    (also a bare map `{ "<model>": { input_cost_per_token ... } }` like LiteLLM's model_prices json)
 *  - Together / DeepInfra / Fireworks-style `pricing: { input, output }` (USD per 1M tokens; per token when tiny) and
 *    `pricing: { input_tokens, output_tokens }`
 * Context window / max output are taken along when present.
 */
export interface RemotePrice {
  /** What the provider charges (USD per 1M tokens; image / request / per second flat). */
  prices: PriceTable;
  /** The vendor's list price, when the upstream publishes one too (ProviderProxy `official`). */
  official?: PriceTable;
  contextWindow?: number;
  maxOutput?: number;
  source: string;
}

const PER_M = 1_000_000;

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}
/** Round away float noise (0.15000000000000002 -> 0.15). */
const clean = (n: number): number => Number(n.toPrecision(12));
const perToken = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : clean(n * PER_M);
};

function setIf(t: PriceTable, k: keyof PriceTable, v: number | null): void {
  if (v !== null && v >= 0) t[k] = v;
}

/** USD per 1M table from a ProviderProxy matrix (`{ input, output, cachedInput, ... }`, already per 1M / per unit). */
function fromMatrix(m: unknown): PriceTable | null {
  if (!isObject(m)) return null;
  const t: PriceTable = {};
  // ProviderProxy publishes snake_case unit keys (cached_input, per_1m_chars ...); camelCase accepted too
  const keys: Array<[keyof PriceTable, string]> = [
    ["input", "input"], ["output", "output"], ["cachedInput", "cached_input"], ["cacheWrite", "cache_write"], ["image", "image"], ["request", "request"],
    ["audioInput", "audio_input"], ["audioOutput", "audio_output"], ["perMinute", "per_minute"], ["perMillionChars", "per_1m_chars"], ["perSecond", "per_second"],
  ];
  for (const [k, snake] of keys) setIf(t, k, num(m[snake] ?? m[k]));
  return Object.keys(t).length ? t : null;
}

/** Prices of one model entry, or null when it carries none. */
export function priceOfEntry(e: JsonObject): Omit<RemotePrice, "source"> | null {
  let prices: PriceTable = {};
  let official: PriceTable | undefined;
  const xp = isObject(e.x_pricing) ? e.x_pricing : isObject(e.pricing) && isObject(e.pricing.yours) ? e.pricing : null;
  if (xp) {
    prices = fromMatrix(xp.yours) ?? {};
    official = fromMatrix(xp.official) ?? undefined;
  }
  const p = isObject(e.pricing) ? e.pricing : isObject(e.metadata) && isObject(e.metadata.pricing) ? e.metadata.pricing : null;
  if (!Object.keys(prices).length && p) {
    if (p.prompt !== undefined || p.completion !== undefined) {
      // OpenRouter: USD per token
      setIf(prices, "input", perToken(p.prompt));
      setIf(prices, "output", perToken(p.completion));
      setIf(prices, "cachedInput", num(p.input_cache_read) ? perToken(p.input_cache_read) : null);
      setIf(prices, "cacheWrite", num(p.input_cache_write) ? perToken(p.input_cache_write) : null);
      setIf(prices, "image", num(p.image) ? num(p.image) : null);
      setIf(prices, "request", num(p.request) ? num(p.request) : null);
    } else {
      const i = num(p.input ?? p.input_tokens ?? p.input_token);
      const o = num(p.output ?? p.output_tokens ?? p.output_token);
      // per-token values are tiny (< $0.001); per-1M values are not
      const scale = (v: number | null) => (v === null ? null : v > 0 && v < 0.001 ? clean(v * PER_M) : v);
      setIf(prices, "input", scale(i));
      setIf(prices, "output", scale(o));
      setIf(prices, "cachedInput", scale(num(p.cached_input ?? p.cache_read ?? p.input_cache_read)));
    }
  }
  const info = isObject(e.model_info) ? e.model_info : e;
  if (!Object.keys(prices).length && (info.input_cost_per_token !== undefined || info.output_cost_per_token !== undefined || info.output_cost_per_image !== undefined || info.output_cost_per_second !== undefined)) {
    setIf(prices, "input", perToken(info.input_cost_per_token));
    setIf(prices, "output", perToken(info.output_cost_per_token));
    setIf(prices, "cachedInput", num(info.cache_read_input_token_cost) ? perToken(info.cache_read_input_token_cost) : null);
    setIf(prices, "cacheWrite", num(info.cache_creation_input_token_cost) ? perToken(info.cache_creation_input_token_cost) : null);
    setIf(prices, "image", num(info.output_cost_per_image) ? num(info.output_cost_per_image) : null);
    setIf(prices, "perSecond", num(info.output_cost_per_second) ? num(info.output_cost_per_second) : null);
    const ips = num(info.input_cost_per_second);
    setIf(prices, "perMinute", ips ? clean(ips * 60) : null);
  }
  if (!Object.keys(prices).length) return null;
  const top = isObject(e.top_provider) ? e.top_provider : {};
  const ctx = num(e.context_length ?? e.context_window ?? info.max_input_tokens ?? top.context_length);
  const maxOut = num(e.max_output_tokens ?? info.max_output_tokens ?? top.max_completion_tokens);
  return { prices, ...(official ? { official } : {}), ...(ctx ? { contextWindow: ctx } : {}), ...(maxOut ? { maxOutput: maxOut } : {}) };
}

const idOf = (e: JsonObject): string | null => {
  for (const k of ["id", "model_name", "model", "name", "slug"] as const) {
    const v = e[k];
    if (typeof v === "string" && v.trim()) return v.trim().replace(/^models\//, "");
  }
  return null;
};

/** Model id -> price for every entry of a document that carries prices. */
export function parseRemotePricing(doc: unknown, source: string): Map<string, RemotePrice> {
  const out = new Map<string, RemotePrice>();
  const add = (id: string | null, e: unknown) => {
    if (!id || !isObject(e) || out.has(id)) return;
    const p = priceOfEntry(e);
    if (p) out.set(id, { ...p, source });
  };
  const list = Array.isArray(doc) ? doc : isObject(doc) ? (Array.isArray(doc.data) ? doc.data : Array.isArray(doc.models) ? doc.models : null) : null;
  if (list) {
    for (const e of list) if (isObject(e)) add(idOf(e), e);
    return out;
  }
  // a map keyed by model id (LiteLLM model_prices json)
  if (isObject(doc)) for (const [k, v] of Object.entries(doc)) if (isObject(v)) add(k, v);
  return out;
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/** URLs worth asking for prices, most specific first (all on the provider's own host, or the admin's `pricingUrl`). */
export function pricingCandidates(p: AdapterProvider): string[] {
  const s = p.settings;
  const custom = typeof s.pricingUrl === "string" && /^https?:\/\//i.test(s.pricingUrl) ? [s.pricingUrl] : [];
  const base = trimSlash(typeof s.openaiBaseUrl === "string" && s.openaiBaseUrl ? s.openaiBaseUrl : p.baseUrl);
  let origin = base;
  try {
    origin = new URL(base).origin;
  } catch {
    /* keep base */
  }
  const urls = [...custom, `${base}/models`, `${base}/model/info`, `${origin}/v1/model/info`, `${origin}/model/info`, `${origin}/api/v1/models`, `${origin}/api/pricing`];
  return [...new Set(urls)];
}

export interface RemotePricingResult {
  prices: Map<string, RemotePrice>;
  /** Every URL tried, with the HTTP status (0 = network error) and how many priced models it gave. */
  tried: Array<{ url: string; status: number; found: number }>;
}

/**
 * Ask the provider for its prices (best effort, a few seconds per URL). With a secret the provider's auth headers are
 * sent (gateway-style APIs need a key for `/models`); public price lists answer without.
 */
/** Official vendor APIs publish no prices (the built-in catalog covers them): only their own model list is read. */
export const NO_PRICE_API_PRESETS = new Set(["openai", "anthropic", "google", "azure", "xai", "groq", "deepseek", "mistral", "fal", "replicate"]);

export async function fetchRemotePricing(p: AdapterProvider, secret: string | null, keyExtra: JsonObject = {}, opts: { timeoutMs?: number; stopAfterFirst?: boolean; skipUrls?: string[] } = {}): Promise<RemotePricingResult> {
  const prices = new Map<string, RemotePrice>();
  const tried: RemotePricingResult["tried"] = [];
  const skip = new Set(opts.skipUrls ?? []);
  const headers = secret ? buildUpstreamHeaders({ provider: p, format: "openai_chat", secret, stream: false, keyExtra, hasBody: false }) : { accept: "application/json", "user-agent": "ProviderProxy/1.0", ...p.extraHeaders };
  for (const url0 of pricingCandidates(p)) {
    if (skip.has(url0)) continue;
    const url = secret && p.authStyle === "QUERY_KEY" ? `${url0}${url0.includes("?") ? "&" : "?"}key=${encodeURIComponent(secret)}` : url0;
    const shown = url0;
    let status = 0;
    let found = 0;
    try {
      const h = await sendUpstream({ url, method: "GET", headers, timeoutMs: opts.timeoutMs ?? 8_000 });
      status = h.res.status;
      try {
        if (status >= 200 && status < 300) {
          const doc = safeJsonParse<unknown>(await readTextLimited(h.res, 16 * 1024 * 1024));
          const source = new URL(url0).pathname;
          for (const [id, price] of parseRemotePricing(doc, source)) {
            if (!prices.has(id)) {
              prices.set(id, price);
              found++;
            }
          }
        }
      } finally {
        h.dispose();
      }
    } catch {
      status = 0;
    }
    tried.push({ url: shown, status, found });
    if (found && opts.stopAfterFirst) break;
  }
  return { prices, tried };
}
