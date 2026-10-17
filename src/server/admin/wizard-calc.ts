/**
 * Pure helpers for the guided "Add model" / "Add route" flow (no DB: safe in client code and tests).
 */
import type { PriceTable } from "@/server/pricing/preview";
import { MODEL_PRICE_PAIRS, toNum } from "./models-calc";

/** "models/gemini-3.1-pro" -> "gemini-3.1-pro"; lowercase; only [a-z0-9._:/-]; no leading/trailing dashes. */
export function slugifyModelId(id: string): string {
  const s = id
    .trim()
    .toLowerCase()
    .replace(/^models\//, "")
    .replace(/[^a-z0-9._:/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+|[-.:/]+$/g, "");
  return s.slice(0, 96);
}

/** base, base-2, base-3 ... first one not in `taken` (case-insensitive). */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((t) => t.toLowerCase()));
  if (!base) return base;
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const c = `${base}-${i}`;
    if (!set.has(c.toLowerCase())) return c;
  }
  return `${base}-${Date.now()}`;
}

const UPPER = new Set(["gpt", "llm", "tts", "ai", "gte", "glm", "qwq"]);

/** "claude-opus-4-5-20251101" -> "Claude Opus 4 5"; "gpt-4o-mini" -> "GPT 4o Mini". */
export function prettyModelName(id: string): string {
  const base = id
    .replace(/^models\//, "")
    .replace(/[-_.:]?(\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .split(/[-_/\s]+/)
    .filter(Boolean);
  return base
    .map((w) => (UPPER.has(w.toLowerCase()) ? w.toUpperCase() : /^[a-z]/.test(w) && w.length > 2 ? w[0].toUpperCase() + w.slice(1) : /^[a-z]$/.test(w) ? w.toUpperCase() : w))
    .join(" ");
}

type FieldKind = "official" | "cost" | "sell";

/** PriceTable (numbers per unit) -> form field strings (officialInputPrice / inputCost / inputPrice ...). Nulls are omitted. */
export function tableToFields(table: PriceTable | undefined | null, kind: FieldKind): Record<string, string> {
  const out: Record<string, string> = {};
  if (!table) return out;
  for (const p of MODEL_PRICE_PAIRS) {
    if (!p.unitKey) continue;
    const v = table[p.unitKey];
    const field = kind === "official" ? p.official : kind === "cost" ? p.cost : p.sell;
    if (field && v !== null && v !== undefined && Number.isFinite(v)) out[field] = String(v);
  }
  return out;
}

/** Cost mirrors the official price for direct providers (the maker's own API); blank otherwise. */
export function officialAsCost(official: PriceTable | undefined | null): Record<string, string> {
  return tableToFields(official, "cost");
}

/** Default rule (owner policy): match the official price (100%) when there is one, else 30% over cost, else fixed. */
export function defaultRule(values: Record<string, string>): { mode: "FIXED" | "PERCENT_OF_OFFICIAL" | "MARKUP_OVER_COST"; value: string } {
  const hasOfficial = MODEL_PRICE_PAIRS.some((p) => p.official && (toNum(values[p.official]) ?? 0) > 0);
  const hasCost = MODEL_PRICE_PAIRS.some((p) => (toNum(values[p.cost]) ?? 0) > 0);
  if (hasOfficial) return { mode: "PERCENT_OF_OFFICIAL", value: "100" };
  if (hasCost) return { mode: "MARKUP_OVER_COST", value: "30" };
  return { mode: "FIXED", value: "" };
}

/** "$2.50 in / $10 out per 1M" - one-line summary of a known official price. */
export function knownSummary(official: PriceTable | undefined | null): string {
  if (!official) return "";
  const money = (n: number) => (n >= 1 ? `$${Number(n.toFixed(2))}` : `$${Number(n.toPrecision(3))}`);
  const i = official.input;
  const o = official.output;
  if (i != null && o != null) return `${money(i)} in / ${money(o)} out per 1M`;
  if (official.image != null) return `${money(official.image)} per image`;
  if (official.perSecond != null) return `${money(official.perSecond)} per second`;
  if (official.perMinute != null) return `${money(official.perMinute)} per minute`;
  if (official.perMillionChars != null) return `${money(official.perMillionChars)} per 1M chars`;
  if (i != null) return `${money(i)} per 1M`;
  return "";
}

/** Which tab of the wizard owns a server field error (to jump the admin back to it). */
export function stepForField(key: string): 1 | 2 | 3 | 4 {
  if (key === "providerId") return 1;
  if (key === "upstreamModel") return 2;
  if (key === "pricingValue" || key === "pricingMode" || MODEL_PRICE_PAIRS.some((p) => p.sell === key)) return 4;
  return 3;
}

/** Validate step-3 names client-side so the admin gets a friendly message before the server round trip. */
export function validatePublicName(slug: string, taken: Iterable<string>): string | null {
  const s = slug.trim();
  if (!s) return "Enter the name customers will use in the `model` field";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(s)) return "Use letters, numbers and . _ : / - only";
  if ([...taken].some((t) => t.toLowerCase() === s.toLowerCase())) return "A model with this name already exists";
  return null;
}
