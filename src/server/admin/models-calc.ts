/**
 * Pure helpers for the admin Models / Routes UI (no DB, no server-only: importable from client + tests).
 *
 *   marginPctOf(sell, cost)            -> (sell-cost)/sell*100, null when sell is 0/blank or cost blank
 *   routeMargins(sell, cost)           -> { input, output, cached } margins (cached falls back to input on both sides)
 *   trafficShares(routes)              -> id -> { tier, sharePct } (enabled routes only; tier 1 is tried first)
 *   bestRouteCost(routes)              -> cheapest enabled route { input, output } or null
 *   parseModelImport(text)             -> per-item validation of a bulk JSON import
 *   modelToExport(model, routes)       -> JSON-friendly export shape (providers by slug)
 *   MODEL_PRICE_PAIRS, MODEL_CAPABILITIES, ...
 */
import { z } from "zod";

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
] as const;

export const MODEL_STATUSES = ["ACTIVE", "HIDDEN", "DISABLED"] as const;

/** One row per billable dimension: sell field on Model <-> cost field on ModelRoute. */
export interface PricePair {
  sell: string;
  cost: string;
  label: string;
  unit: string;
}

export const MODEL_PRICE_PAIRS: PricePair[] = [
  { sell: "inputPrice", cost: "inputCost", label: "Input", unit: "USD / 1M tokens" },
  { sell: "outputPrice", cost: "outputCost", label: "Output", unit: "USD / 1M tokens" },
  { sell: "cachedInputPrice", cost: "cachedInputCost", label: "Cached input", unit: "USD / 1M tokens (blank = input price)" },
  { sell: "cacheWritePrice", cost: "cacheWriteCost", label: "Cache write (5m)", unit: "USD / 1M tokens (blank = input price)" },
  { sell: "cacheWrite1hPrice", cost: "cacheWrite1hCost", label: "Cache write (1h)", unit: "USD / 1M tokens" },
  { sell: "imagePrice", cost: "imageCost", label: "Per image", unit: "USD / image (flat; blank = bill image tokens)" },
  { sell: "requestPrice", cost: "requestCost", label: "Per request", unit: "USD flat per request" },
  { sell: "audioInputPrice", cost: "audioInputCost", label: "Audio input", unit: "USD / 1M audio tokens" },
  { sell: "audioOutputPrice", cost: "audioOutputCost", label: "Audio output", unit: "USD / 1M audio tokens" },
  { sell: "perMinutePrice", cost: "perMinuteCost", label: "Per minute (transcription)", unit: "USD / minute" },
  { sell: "perMillionChars", cost: "perMillionCharsCost", label: "Per 1M characters (TTS)", unit: "USD / 1M chars" },
];

export const OFFICIAL_PRICE_FIELDS = [
  { key: "officialInputPrice", label: "Official input", unit: "USD / 1M tokens" },
  { key: "officialOutputPrice", label: "Official output", unit: "USD / 1M tokens" },
  { key: "officialCachedPrice", label: "Official cached input", unit: "USD / 1M tokens" },
] as const;

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

const decOpt = z.unknown().transform((v, ctx): string | null => {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  const s = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    ctx.addIssue({ code: "custom", message: "Must be a non-negative number" });
    return z.NEVER;
  }
  return s;
}).default(null);

const decReq = z.unknown().transform((v, ctx) => {
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

export const modelFieldsSchema = z.object({
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
  longContextThreshold: intOpt(1),
  longContextMultiplier: decOpt,
  officialInputPrice: decOpt,
  officialOutputPrice: decOpt,
  officialCachedPrice: decOpt,
});
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
});
export type RouteFields = z.output<typeof routeFieldsSchema>;

export const routeFormSchema = routeFieldsSchema.extend({ providerId: z.string().min(1, "Choose a provider") });

export const routeImportSchema = routeFieldsSchema.extend({ provider: z.string().trim().min(1, "provider (slug) required") });
export const modelImportSchema = modelFieldsSchema.extend({ routes: z.array(routeImportSchema).optional() });
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
