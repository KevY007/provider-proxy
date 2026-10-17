/**
 * Pure helpers turning official + customer price maps into display rows (Official / Your price / Savings per unit).
 * Safe in server + client code.
 */
import { formatPricePerMillion, formatUSD, toDecimal, type MoneyLike } from "@/lib/money";
import { PRICE_UNITS, type PriceUnitDef, type PriceUnitId } from "./price-units";
import { savingsPctOf } from "./savings";

export type UnitPriceMap = Partial<Record<PriceUnitId, string | null | undefined>>;

export interface UnitPriceRow {
  unit: PriceUnitDef;
  official: string | null;
  /** Your price after multipliers (cached / cache-write fall back to the input price when blank). */
  price: string | null;
  /** (official - price) / official * 100, null without an official price. */
  savingsPct: number | null;
}

const present = (v: MoneyLike) => v !== null && v !== undefined && v !== "" && !toDecimal(v).isZero();
const orNull = (v: string | null | undefined) => (v === undefined || v === "" ? null : v);

/** Multiply every price in a map (nulls stay null). */
export function applyMultiplierToMap(map: UnitPriceMap, multiplier: MoneyLike): UnitPriceMap {
  const m = toDecimal(multiplier, 1);
  const out: UnitPriceMap = {};
  for (const u of PRICE_UNITS) {
    const v = orNull(map[u.id]);
    out[u.id] = v === null ? null : toDecimal(v).times(m).toString();
  }
  return out;
}

/** One row per unit that has a customer price or an official price. Order follows PRICE_UNITS. */
export function buildUnitRows(official: UnitPriceMap, price: UnitPriceMap): UnitPriceRow[] {
  const rows: UnitPriceRow[] = [];
  for (const unit of PRICE_UNITS) {
    const off = orNull(official[unit.id]);
    let p = orNull(price[unit.id]);
    if (!present(off) && !present(p)) continue;
    if (p === null && unit.fallbackToInput) p = orNull(price.input);
    rows.push({ unit, official: off, price: p, savingsPct: savingsPctOf(off, p) });
  }
  return rows;
}

/** Units whose price is quoted per 1M (tokens, audio tokens, characters). */
const PER_MILLION = new Set<PriceUnitId>(["input", "output", "cachedInput", "cacheWrite", "audioInput", "audioOutput", "perMillionChars"]);

/** "$2.50" style display for a unit price (per-1M units use the compact per-million format, others full USD precision). */
export function formatUnitPrice(unit: PriceUnitDef | PriceUnitId, v: MoneyLike): string {
  if (v === null || v === undefined || v === "") return "-";
  const id = typeof unit === "string" ? unit : unit.id;
  return PER_MILLION.has(id) ? formatPricePerMillion(v) : formatUSD(v);
}

/**
 * Headline savings for a model: blended 3:1 input:output when both exist, otherwise the first unit with an official price.
 * Used for sorting and the landing page; null when nothing can be compared.
 */
export function headlineSavings(rows: UnitPriceRow[]): number | null {
  const inp = rows.find((r) => r.unit.id === "input");
  const out = rows.find((r) => r.unit.id === "output");
  if (inp && out && present(inp.official) && present(out.official) && inp.price !== null && out.price !== null) {
    const off = toDecimal(inp.official).times(3).plus(toDecimal(out.official));
    const ours = toDecimal(inp.price).times(3).plus(toDecimal(out.price));
    return savingsPctOf(off, ours);
  }
  return rows.find((r) => r.savingsPct !== null)?.savingsPct ?? null;
}

/** "Mar 4, 2027" for a retirement date (ISO string or Date). */
export function formatRetireDate(v: string | Date): string {
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Structural subset of a catalog model needed by the price tables (so this file stays free of server-only imports). */
export interface PriceModelSource {
  slug: string;
  displayName: string;
  vendor: string;
  capabilities: string[];
  contextWindow: number | null;
  retiresAt: string | null;
  sell: UnitPriceMap;
  official: UnitPriceMap;
}

export function toPriceModel(m: PriceModelSource): PriceModelSource {
  return {
    slug: m.slug,
    displayName: m.displayName,
    vendor: m.vendor,
    capabilities: m.capabilities,
    contextWindow: m.contextWindow,
    retiresAt: m.retiresAt,
    sell: m.sell,
    official: m.official,
  };
}
