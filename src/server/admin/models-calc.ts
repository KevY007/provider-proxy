/**
 * Pure helpers for the admin Models / Routes UI (no DB, no server-only: importable from client + tests).
 *
 *   marginPctOf(sell, cost)            -> (sell-cost)/sell*100, null when sell is 0/blank or cost blank
 *   routeMargins(sell, cost)           -> { input, output, cached } margins (cached falls back to input on both sides)
 *   trafficShares(routes)              -> id -> { tier, sharePct } (enabled routes only; tier 1 is tried first)
 *   bestRouteCost(routes)              -> cheapest enabled route { input, output } or null
 *   parseModelImport(text)             -> per-item validation of a bulk JSON import
 *   modelToExport(model, routes)       -> JSON-friendly export shape (providers by slug)
 *   parseToolPriceMap / toolPricesForForm / previewToolPrices -> server-tool unit prices ({ web_search_request: "0.01" })
 *   MODEL_PRICE_PAIRS, MODEL_CAPABILITIES, ...
 */
import { z } from "zod";
import { Decimal } from "@/lib/money";
import type { PriceTable, PriceUnitKey } from "@/server/pricing/preview";

export const MODEL_CAPABILITIES = [
  "chat",
  "responses",
  "completions",
  "embeddings",
  "images",
  "audio_speech",
  "audio_transcription",
  "moderation",
  "vision",
  "tools",
  "reasoning",
  "video",
] as const;

export const MODEL_STATUSES = ["ACTIVE", "HIDDEN", "DISABLED"] as const;

/** One row per billable dimension: sell field on Model <-> cost field on ModelRoute. */
export interface PricePair {
  sell: string;
  cost: string;
  /** Model field holding the Official price for this unit (none for cache write 1h). */
  official: string | null;
  /** Matches PriceUnitKey in @/server/pricing/preview (null = not part of the live preview). */
  unitKey: PriceUnitKey | null;
  label: string;
  unit: string;
}

export const MODEL_PRICE_PAIRS: PricePair[] = [
  { sell: "inputPrice", cost: "inputCost", official: "officialInputPrice", unitKey: "input", label: "Input", unit: "USD / 1M tokens" },
  { sell: "outputPrice", cost: "outputCost", official: "officialOutputPrice", unitKey: "output", label: "Output", unit: "USD / 1M tokens" },
  { sell: "cachedInputPrice", cost: "cachedInputCost", official: "officialCachedPrice", unitKey: "cachedInput", label: "Cached input", unit: "USD / 1M tokens (blank = input price)" },
  { sell: "cacheWritePrice", cost: "cacheWriteCost", official: "officialCacheWritePrice", unitKey: "cacheWrite", label: "Cache write (5m)", unit: "USD / 1M tokens (blank = input price)" },
  { sell: "cacheWrite1hPrice", cost: "cacheWrite1hCost", official: null, unitKey: null, label: "Cache write (1h)", unit: "USD / 1M tokens" },
  { sell: "imagePrice", cost: "imageCost", official: "officialImagePrice", unitKey: "image", label: "Per image", unit: "USD / image (flat; blank = bill image tokens)" },
  { sell: "perSecondPrice", cost: "perSecondCost", official: "officialPerSecondPrice", unitKey: "perSecond", label: "Per second (video)", unit: "USD / second of generated video" },
  { sell: "requestPrice", cost: "requestCost", official: "officialRequestPrice", unitKey: "request", label: "Per request", unit: "USD flat per request" },
  { sell: "audioInputPrice", cost: "audioInputCost", official: "officialAudioInputPrice", unitKey: "audioInput", label: "Audio input", unit: "USD / 1M audio tokens" },
  { sell: "audioOutputPrice", cost: "audioOutputCost", official: "officialAudioOutputPrice", unitKey: "audioOutput", label: "Audio output", unit: "USD / 1M audio tokens" },
  { sell: "perMinutePrice", cost: "perMinuteCost", official: "officialPerMinutePrice", unitKey: "perMinute", label: "Per minute (transcription)", unit: "USD / minute" },
  { sell: "perMillionChars", cost: "perMillionCharsCost", official: "officialPerMillionChars", unitKey: "perMillionChars", label: "Per 1M characters (speech)", unit: "USD / 1M chars" },
];

/** Every Official price field (one per billable unit), for forms and schemas. */
export const OFFICIAL_PRICE_FIELDS = MODEL_PRICE_PAIRS.filter((p) => p.official).map((p) => ({
  key: p.official as string,
  label: `Official ${p.label.toLowerCase()}`,
  unit: p.unit,
}));

export const PRICING_MODES = ["FIXED", "PERCENT_OF_OFFICIAL", "MARKUP_OVER_COST", "PERCENT_OF_COST"] as const;
export type PricingModeId = (typeof PRICING_MODES)[number];

export const PRICING_MODE_LABELS: Record<PricingModeId, { label: string; hint: string; valueLabel: string; valueHint: string }> = {
  FIXED: { label: "Fixed prices", hint: "You type the customer price for every unit.", valueLabel: "", valueHint: "" },
  PERCENT_OF_OFFICIAL: {
    label: "% of official price",
    hint: "Customer price = Official price × value%. 70 means 30% cheaper than the provider's own list price.",
    valueLabel: "Percent of official",
    valueHint: "70 = customers pay 70% of the official price (30% off). 100 = same as official.",
  },
  MARKUP_OVER_COST: {
    label: "Markup over our cost",
    hint: "Customer price = Our cost × (1 + value%). Follows your cost automatically when it changes.",
    valueLabel: "Markup over our cost",
    valueHint: "30 = we charge 30% more than we pay our supplier.",
  },
  PERCENT_OF_COST: {
    label: "% of our cost",
    hint: "Customer price = Our cost × value%. With an auto-updated route cost, the price follows the provider's own price.",
    valueLabel: "Percent of our cost",
    valueHint: "50 = customers pay half of what the provider charges us. 100 = the provider's price as it is.",
  },
};

/** "70% of official", "+30% over cost", "50% of cost" (+ "-$0.05" when an adjustment is set). */
export function ruleSummary(mode: string, value: string | null | undefined, adjust?: string | null): string {
  const v = value ?? "?";
  const base = mode === "PERCENT_OF_OFFICIAL" ? `${v}% of official` : mode === "PERCENT_OF_COST" ? `${v}% of cost` : mode === "MARKUP_OVER_COST" ? `+${v}% over cost` : "fixed";
  const a = toNum(adjust ?? null);
  return a ? `${base} ${a > 0 ? "+" : "-"}$${Math.abs(a)}` : base;
}

// ---------------------------------------------------------------------------
// numbers

export type Num = string | number | null | undefined;

export function toNum(v: Num): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** (sell - cost) / sell * 100. null when sell is blank/0 or cost is blank. */
export function marginPctOf(sell: Num, cost: Num): number | null {
  const s = toNum(sell);
  const c = toNum(cost);
  if (s === null || c === null || s === 0) return null;
  return ((s - c) / s) * 100;
}

export interface SellPrices {
  inputPrice: Num;
  outputPrice: Num;
  cachedInputPrice?: Num;
}
export interface RouteCosts {
  inputCost: Num;
  outputCost: Num;
  cachedInputCost?: Num;
}

const blank = (v: Num) => toNum(v) === null;

export function routeMargins(sell: SellPrices, cost: RouteCosts): { input: number | null; output: number | null; cached: number | null } {
  const sellCached = blank(sell.cachedInputPrice) ? sell.inputPrice : sell.cachedInputPrice;
  const costCached = blank(cost.cachedInputCost) ? cost.inputCost : cost.cachedInputCost;
  return {
    input: marginPctOf(sell.inputPrice, cost.inputCost),
    output: marginPctOf(sell.outputPrice, cost.outputCost),
    cached: marginPctOf(sellCached, costCached),
  };
}

export function formatMargin(m: number | null): string {
  return m === null ? "-" : `${m.toFixed(1)}%`;
}

/** Tailwind text colour for a margin. */
export function marginTone(m: number | null): string {
  if (m === null) return "text-muted-foreground";
  if (m < 0) return "text-red-500";
  if (m < 10) return "text-amber-500";
  return "text-emerald-500";
}

// ---------------------------------------------------------------------------
// routing

export interface RouteLike {
  id: string;
  enabled: boolean;
  priority: number;
  weight: number;
}

/**
 * Traffic split: routes are tried by priority desc (tier 1 = highest priority); inside a tier traffic is
 * weighted-random so a route's share = weight / sum(weights in tier). Disabled routes get tier 0 / 0%.
 * (Group restrictions / unavailable keys shift the real split at runtime; this is the nominal one.)
 */
export function trafficShares(routes: RouteLike[]): Record<string, { tier: number; sharePct: number }> {
  const out: Record<string, { tier: number; sharePct: number }> = {};
  const enabled = routes.filter((r) => r.enabled);
  const priorities = [...new Set(enabled.map((r) => r.priority))].sort((a, b) => b - a);
  for (const r of routes) if (!r.enabled) out[r.id] = { tier: 0, sharePct: 0 };
  priorities.forEach((p, i) => {
    const tier = enabled.filter((r) => r.priority === p);
    const total = tier.reduce((s, r) => s + Math.max(0, r.weight), 0);
    for (const r of tier) {
      out[r.id] = { tier: i + 1, sharePct: total > 0 ? (Math.max(0, r.weight) / total) * 100 : 100 / tier.length };
    }
  });
  return out;
}

export function bestRouteCost(routes: Array<{ enabled: boolean; inputCost: Num; outputCost: Num }>): { input: number; output: number } | null {
  let best: { input: number; output: number } | null = null;
  for (const r of routes) {
    if (!r.enabled) continue;
    const input = toNum(r.inputCost) ?? 0;
    const output = toNum(r.outputCost) ?? 0;
    if (!best || input + output < best.input + best.output) best = { input, output };
  }
  return best;
}

// ---------------------------------------------------------------------------
// zod schemas (forms send strings; JSON import sends numbers or strings)

/** Numbers (e.g. 1e-7 from JSON) -> plain decimal strings; everything else untouched. */
function plainDecimal(v: unknown): unknown {
  return typeof v === "number" && Number.isFinite(v) ? new Decimal(v).toFixed() : v;
}

const signedDecOpt = z.unknown().transform((raw0, ctx): string | null => {
  const raw = plainDecimal(raw0);
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return null;
  const s = String(raw).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s) || Math.abs(Number(s)) > 1_000_000) {
    ctx.addIssue({ code: "custom", message: "Must be a number (negative to lower the price)" });
    return z.NEVER;
  }
  return Number(s) === 0 ? null : s;
}).default(null);

const decOpt = z.unknown().transform((raw, ctx): string | null => {
  const v = plainDecimal(raw);
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  const s = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    ctx.addIssue({ code: "custom", message: "Must be a non-negative number" });
    return z.NEVER;
  }
  return s;
}).default(null);

const decReq = z.unknown().transform((raw, ctx) => {
  const v = plainDecimal(raw);
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return "0";
  const s = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    ctx.addIssue({ code: "custom", message: "Must be a non-negative number" });
    return z.NEVER;
  }
  return s;
}).default("0");

const intOpt = (min = 0, max = 2_147_483_647) =>
  z.unknown().transform((v, ctx): number | null => {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      ctx.addIssue({ code: "custom", message: `Must be a whole number between ${min} and ${max}` });
      return z.NEVER;
    }
    return n;
  }).default(null);

const intReq = (dflt: number, min = -1_000_000, max = 1_000_000) =>
  z.unknown().transform((v, ctx) => {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      ctx.addIssue({ code: "custom", message: `Must be a whole number between ${min} and ${max}` });
      return z.NEVER;
    }
    return n;
  }).default(dflt);

const jsonObj = z.unknown().transform((v, ctx) => {
  if (v === null || v === undefined) return {} as Record<string, unknown>;
  if (typeof v !== "string") {
    if (typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    ctx.addIssue({ code: "custom", message: "Must be a JSON object" });
    return z.NEVER;
  }
  if (!v.trim()) return {} as Record<string, unknown>;
  try {
    const p = JSON.parse(v);
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("not an object");
    return p as Record<string, unknown>;
  } catch {
    ctx.addIssue({ code: "custom", message: "Must be a valid JSON object" });
    return z.NEVER;
  }
}).default({});

// ---------------------------------------------------------------------------
// server tools (Json columns Model.toolPrices / officialToolPrices, ModelRoute.toolCosts): { key: USD per unit }

/** Price keys the gateway meters today (free-form keys are allowed too). */
export const TOOL_KEY_SUGGESTIONS: ReadonlyArray<{ key: string; hint: string }> = [
  { key: "web_search_request", hint: "Anthropic web search, USD per search" },
  { key: "code_execution_hour", hint: "Anthropic code execution, USD per container hour" },
  { key: "web_search_call", hint: "OpenAI Responses web search, USD per call" },
  { key: "file_search_call", hint: "OpenAI Responses file search, USD per call" },
];

export const TOOL_KEY_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;

/**
 * `{ key: number | "decimal" }` (an object, or JSON text of one) -> `{ key: "decimal" }`. Blank values are dropped
 * (= no price for that tool). Errors name the offending key.
 */
export function parseToolPriceMap(raw: unknown): { value: Record<string, string>; error?: undefined } | { error: string; value?: undefined } {
  let v = raw;
  if (v === null || v === undefined) return { value: {} };
  if (typeof v === "string") {
    if (!v.trim()) return { value: {} };
    try {
      v = JSON.parse(v);
    } catch {
      return { error: "Must be a JSON object like {\"web_search_request\": 0.01}" };
    }
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { error: "Must be an object of tool key -> USD per unit" };
  const out: Record<string, string> = {};
  for (const [rawKey, x] of Object.entries(v as Record<string, unknown>)) {
    const key = rawKey.trim();
    const n = plainDecimal(x);
    if (n === null || n === undefined || (typeof n === "string" && n.trim() === "")) continue;
    if (!TOOL_KEY_RE.test(key)) return { error: `"${rawKey}" is not a valid tool key (letters, numbers, _ . : - only)` };
    const str = String(n).trim();
    if (!/^\d+(\.\d+)?$/.test(str)) return { error: `${key}: must be a non-negative number` };
    out[key] = str;
  }
  return { value: out };
}

/** Optional: undefined stays undefined (= leave the column alone), anything else is parsed. */
const toolMapOpt = z.unknown().transform((raw, ctx): Record<string, string> | undefined => {
  if (raw === undefined) return undefined;
  const r = parseToolPriceMap(raw);
  if (r.error !== undefined) {
    ctx.addIssue({ code: "custom", message: r.error });
    return z.NEVER;
  }
  return r.value;
}).optional();

/** A percent 0-100. undefined stays undefined (leave alone); blank -> `blank`. */
const pctOpt = <B extends string | null>(blankValue: B) =>
  z.unknown().transform((raw, ctx): string | B | undefined => {
    if (raw === undefined) return undefined;
    const v = plainDecimal(raw);
    if (v === null || (typeof v === "string" && v.trim() === "")) return blankValue;
    const s = String(v).trim();
    if (!/^\d+(\.\d+)?$/.test(s) || Number(s) > 100) {
      ctx.addIssue({ code: "custom", message: "Must be a percent between 0 and 100" });
      return z.NEVER;
    }
    return s;
  }).optional();

/** A Json tool-price column (DB strings like "0.010000000000") -> plain decimal strings for forms ("0.01"). */
export function toolPricesForForm(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === null || x === undefined || x === "") continue;
    try {
      const d = new Decimal(String(x));
      if (d.isFinite() && d.gte(0)) out[k] = d.toFixed();
    } catch {
      /* not a number: skip */
    }
  }
  return out;
}

/**
 * Customer price per tool under a pricing rule (mirrors the server's `deriveSellUpdates`): % of official -> official x pct,
 * markup -> our cost x (1 + pct); keys without a basis keep their typed (fixed) price.
 */
export function previewToolPrices(
  mode: string,
  ruleValue: Num,
  official: Record<string, string>,
  cost: Record<string, string>,
  fixed: Record<string, string>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(fixed)) out[k] = toNum(v);
  const value = toNum(ruleValue);
  if (mode === "FIXED" || value === null || value <= 0) return out;
  const basis = mode === "PERCENT_OF_OFFICIAL" ? official : cost;
  const factor = mode === "MARKUP_OVER_COST" ? new Decimal(value).div(100).plus(1) : new Decimal(value).div(100);
  for (const [k, v] of Object.entries(basis)) {
    const b = toNum(v);
    if (b !== null) out[k] = new Decimal(String(v)).times(factor).toNumber();
  }
  return out;
}

const strList = z
  .array(z.string())
  .nullish()
  .transform((a) => [...new Set((a ?? []).map((s) => s.trim()).filter(Boolean))])
  .default([]);

export const modelSlugSchema = z
  .string()
  .trim()
  .min(1, "Required")
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/, "Letters, numbers, . _ : / - only");

const optText = z
  .string()
  .nullish()
  .transform((v) => (v === null || v === undefined || v.trim() === "" ? null : v.trim()));

/** "YYYY-MM-DD" (or full ISO) from a date input -> Date; blank -> null. */
const dateOpt = z.unknown().transform((v, ctx): Date | null => {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  const d = v instanceof Date ? v : new Date(String(v).trim());
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: "custom", message: "Enter a valid date" });
    return z.NEVER;
  }
  return d;
}).default(null);

const modelFieldsBase = z.object({
  slug: modelSlugSchema,
  aliases: strList,
  displayName: z.string().trim().min(1, "Required").max(120),
  vendor: z.string().trim().min(1, "Required").max(64),
  description: optText,
  capabilities: strList.refine((a) => a.every((c) => (MODEL_CAPABILITIES as readonly string[]).includes(c)), "Unknown capability"),
  contextWindow: intOpt(1),
  maxOutput: intOpt(1),
  status: z.enum(MODEL_STATUSES).default("ACTIVE"),
  sortOrder: intReq(0),
  maskUpstreamModel: z.boolean().default(true),
  inputPrice: decReq,
  outputPrice: decReq,
  cachedInputPrice: decOpt,
  cacheWritePrice: decOpt,
  cacheWrite1hPrice: decOpt,
  imagePrice: decOpt,
  requestPrice: decOpt,
  audioInputPrice: decOpt,
  audioOutputPrice: decOpt,
  perMinutePrice: decOpt,
  perMillionChars: decOpt,
  perSecondPrice: decOpt,
  longContextThreshold: intOpt(1),
  longContextMultiplier: decOpt,
  officialInputPrice: decOpt,
  officialOutputPrice: decOpt,
  officialCachedPrice: decOpt,
  officialCacheWritePrice: decOpt,
  officialImagePrice: decOpt,
  officialRequestPrice: decOpt,
  officialAudioInputPrice: decOpt,
  officialAudioOutputPrice: decOpt,
  officialPerMinutePrice: decOpt,
  officialPerMillionChars: decOpt,
  officialPerSecondPrice: decOpt,
  toolPrices: toolMapOpt,
  officialToolPrices: toolMapOpt,
  /** Batch API: percent off the token price for customers (blank = the vendors' 50). */
  batchDiscountPct: pctOpt(null),
  pricingMode: z.enum(PRICING_MODES).default("FIXED"),
  pricingValue: decOpt,
  /** signed per-unit adjustment after the rule (USD per 1M tokens / per unit); blank = none */
  pricingAdjust: signedDecOpt,
  retiresAt: dateOpt,
});
function refinePricingRule(m: { pricingMode: string; pricingValue: string | null }, ctx: z.RefinementCtx) {
  if (m.pricingMode !== "FIXED" && (m.pricingValue === null || Number(m.pricingValue) <= 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["pricingValue"],
      message: m.pricingMode === "PERCENT_OF_OFFICIAL" ? "Enter a percent of the official price, e.g. 70" : m.pricingMode === "PERCENT_OF_COST" ? "Enter a percent of our cost, e.g. 50" : "Enter a markup percent, e.g. 30",
    });
  }
}
export const modelFieldsSchema = modelFieldsBase.superRefine(refinePricingRule);
export type ModelFields = z.output<typeof modelFieldsSchema>;

export const routeFieldsSchema = z.object({
  upstreamModel: z.string().trim().min(1, "Required").max(200),
  label: optText,
  enabled: z.boolean().default(true),
  priority: intReq(0),
  weight: intReq(1, 0, 100000),
  groupSlugs: strList,
  paramOverrides: jsonObj,
  maxOutputTokens: intOpt(1),
  inputCost: decReq,
  outputCost: decReq,
  cachedInputCost: decOpt,
  cacheWriteCost: decOpt,
  cacheWrite1hCost: decOpt,
  imageCost: decOpt,
  requestCost: decOpt,
  audioInputCost: decOpt,
  audioOutputCost: decOpt,
  perMinuteCost: decOpt,
  perMillionCharsCost: decOpt,
  perSecondCost: decOpt,
  toolCosts: toolMapOpt,
  /** Batch API: what the supplier takes off its token prices (blank = 50). */
  batchCostDiscountPct: pctOpt("50"),
  /** the cost follows the provider's published price (refreshed lazily during calls) */
  autoCostSync: z.boolean().optional(),
  autoCostSourceModel: optText,
});
export type RouteFields = z.output<typeof routeFieldsSchema>;

export const routeFormSchema = routeFieldsSchema.extend({ providerId: z.string().min(1, "Choose a provider") });

export const routeImportSchema = routeFieldsSchema.extend({ provider: z.string().trim().min(1, "provider (slug) required") });
export const modelImportSchema = modelFieldsBase.extend({ routes: z.array(routeImportSchema).optional() }).superRefine(refinePricingRule);
export type ModelImportItem = z.output<typeof modelImportSchema>;

export type ImportParseResult =
  | { fatal: string; items?: undefined }
  | { fatal?: undefined; items: Array<{ index: number; slug: string; ok: true; data: ModelImportItem } | { index: number; slug: string; ok: false; error: string }> };

/** Accepts `[ {...model, routes:[...]} ]` or `{ "models": [...] }`. Validates each item independently. */
export function parseModelImport(text: string): ImportParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { fatal: `Invalid JSON: ${e instanceof Error ? e.message : "parse error"}` };
  }
  const arr = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { models?: unknown }).models) ? (raw as { models: unknown[] }).models : null;
  if (!arr) return { fatal: "Expected a JSON array of models (or an object with a \"models\" array)." };
  if (arr.length === 0) return { fatal: "The array is empty." };
  if (arr.length > 500) return { fatal: "At most 500 models per import." };
  const seen = new Set<string>();
  const items = arr.map((item, index) => {
    const slug = typeof (item as { slug?: unknown })?.slug === "string" ? String((item as { slug: string }).slug) : `#${index + 1}`;
    const res = modelImportSchema.safeParse(item);
    if (!res.success) {
      const issue = res.error.issues[0];
      return { index, slug, ok: false as const, error: `${issue.path.join(".") || "item"}: ${issue.message}` };
    }
    if (seen.has(res.data.slug)) return { index, slug, ok: false as const, error: "Duplicate slug in import" };
    seen.add(res.data.slug);
    return { index, slug, ok: true as const, data: res.data };
  });
  return { items };
}

// ---------------------------------------------------------------------------
// export

type Rec = Record<string, unknown>;

/** Strips ids/timestamps and null prices so the export is compact and re-importable. */
export function modelToExport(model: Rec, routes: Array<Rec & { providerSlug: string }>): Rec {
  const drop = new Set(["id", "createdAt", "updatedAt", "routes"]);
  const clean = (o: Rec, extraDrop: string[] = []) => {
    const out: Rec = {};
    for (const [k, v] of Object.entries(o)) {
      if (drop.has(k) || extraDrop.includes(k) || v === null || v === undefined) continue;
      out[k] = v;
    }
    return out;
  };
  return {
    ...clean(model),
    routes: routes.map((r) => {
      const { providerSlug, ...rest } = r;
      return { provider: providerSlug, ...clean(rest, ["modelId", "providerId", "provider"]) };
    }),
  };
}

// ---------------------------------------------------------------------------
// per-dimension margin (used by the route editor table)

/** Sell fields that bill at the input price when left blank (same for the cost side). */
const FALLBACK_TO_INPUT = new Set(["cachedInputPrice", "cacheWritePrice"]);

/**
 * Margin for one billable dimension given the model's sell values and a route's cost values (string maps).
 * Blank cached / cache-write fall back to input on each side. Returns null when it can't be computed.
 */
export function pairMargin(pair: PricePair, sell: Record<string, Num>, cost: Record<string, Num>): number | null {
  const fb = FALLBACK_TO_INPUT.has(pair.sell);
  const s = fb && toNum(sell[pair.sell]) === null ? sell.inputPrice : sell[pair.sell];
  const c = fb && toNum(cost[pair.cost]) === null ? cost.inputCost : cost[pair.cost];
  return marginPctOf(s, c);
}

// ---------------------------------------------------------------------------
// pricing summaries (Official / Our cost / Customer price / Savings / Margin) - PLAN 9c

type Rec2 = Record<string, Num>;

/** Pick `field(pair)` from a string/number record into a PriceTable keyed by unit (blank -> null). */
export function toPriceTable(rec: Rec2, field: (p: PricePair) => string | null): PriceTable {
  const out: PriceTable = {};
  for (const p of MODEL_PRICE_PAIRS) {
    if (!p.unitKey) continue;
    const f = field(p);
    out[p.unitKey] = f ? toNum(rec[f]) : null;
  }
  return out;
}
export const officialTable = (model: Rec2) => toPriceTable(model, (p) => p.official);
export const sellTable = (model: Rec2) => toPriceTable(model, (p) => p.sell);
export const costTable = (route: Rec2) => toPriceTable(route, (p) => p.cost);

/**
 * The route whose cost prices are based on (same rule as the server's rules.ts): the highest-priority ENABLED route;
 * ties go to the higher weight, then the first in list order (oldest). This is "Our cost" everywhere in the admin UI.
 */
export function primaryEnabledRoute<T extends { enabled: boolean; priority: number; weight: number }>(routes: T[]): T | null {
  let best: T | null = null;
  for (const r of routes) {
    if (!r.enabled) continue;
    if (!best || r.priority > best.priority || (r.priority === best.priority && r.weight > best.weight)) best = r;
  }
  return best;
}

export interface RowUnit {
  key: PriceUnitKey;
  label: string;
  per: string;
  price: number | null;
  official: number | null;
  cost: number | null;
}

const PER: Record<string, string> = { image: "/img", perSecond: "/sec", perMinute: "/min", perMillionChars: "/1M chars", request: "/req" };

/** Units worth listing for a model row: any with a customer price, official price or cost (input/output first). */
export function rowUnits(model: Rec2, route: Rec2 | null): RowUnit[] {
  const out: RowUnit[] = [];
  for (const p of MODEL_PRICE_PAIRS) {
    if (!p.unitKey) continue;
    const price = toNum(model[p.sell]);
    const official = p.official ? toNum(model[p.official]) : null;
    const cost = route ? toNum(route[p.cost]) : null;
    const always = p.unitKey === "input" || p.unitKey === "output";
    if (!always && !(price ?? 0) && !(official ?? 0) && !(cost ?? 0)) continue;
    out.push({ key: p.unitKey, label: p.label, per: PER[p.unitKey] ?? "/1M", price, official, cost });
  }
  // models billed per image / second / minute / chars with no token prices: hide the empty token rows
  const hasOther = out.some((u) => !["input", "output", "cachedInput", "cacheWrite"].includes(u.key) && ((u.price ?? 0) > 0 || (u.official ?? 0) > 0));
  return hasOther ? out.filter((u) => (u.price ?? 0) > 0 || (u.official ?? 0) > 0 || (u.cost ?? 0) > 0) : out;
}

export interface RowSummary {
  /** Worst (lowest) margin % across units that have both a price and a cost; null when unknown. */
  marginPct: number | null;
  /** Savings % vs official: blended 3:1 input:output when both exist, else the first unit with an official price. */
  savingsPct: number | null;
  /** Any unit where the customer price is below our cost. */
  loss: boolean;
}

export function summarizeRow(units: RowUnit[]): RowSummary {
  let marginPct: number | null = null;
  let loss = false;
  for (const u of units) {
    if (u.price === null || u.cost === null || u.price === 0) {
      if (u.price !== null && u.price === 0 && (u.cost ?? 0) > 0) loss = true;
      continue;
    }
    const m = ((u.price - u.cost) / u.price) * 100;
    if (marginPct === null || m < marginPct) marginPct = m;
    if (u.price < u.cost) loss = true;
  }
  const byKey = new Map(units.map((u) => [u.key, u]));
  const i = byKey.get("input");
  const o = byKey.get("output");
  let savingsPct: number | null = null;
  if (i && o && i.official && o.official && i.price !== null && o.price !== null) {
    const off = i.official * 3 + o.official;
    savingsPct = off > 0 ? (1 - (i.price * 3 + o.price) / off) * 100 : null;
  } else {
    const u = units.find((x) => x.official && x.price !== null);
    savingsPct = u && u.official ? ((u.official - (u.price as number)) / u.official) * 100 : null;
  }
  return { marginPct, savingsPct, loss };
}

/** "$2.50 / $10.00" for token models, "$0.04 /img" otherwise: compact one-liner of the headline units. */
export function compactUnits(units: RowUnit[], pick: "price" | "official" | "cost"): { text: string; any: boolean } {
  const fmt = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${Number(n.toPrecision(3))}`);
  const val = (u: RowUnit | undefined) => (u ? u[pick] : null);
  const i = units.find((u) => u.key === "input");
  const o = units.find((u) => u.key === "output");
  if (i && o && (val(i) !== null || val(o) !== null)) {
    return { text: `${val(i) === null ? "-" : fmt(val(i) as number)} / ${val(o) === null ? "-" : fmt(val(o) as number)}`, any: true };
  }
  const u = units.find((x) => val(x) !== null);
  return u ? { text: `${fmt(val(u) as number)} ${u.per}`, any: true } : { text: "-", any: false };
}

/** Format a % (margin/savings) for badges: "62%" / "-5%". */
export function fmtPct(p: number | null, digits = 0): string {
  return p === null || Number.isNaN(p) ? "-" : `${p.toFixed(digits)}%`;
}
