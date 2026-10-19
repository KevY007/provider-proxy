/**
 * Every billable unit with the Model sell field, Model official field and ModelRoute cost field (PLAN 9c).
 * Pure; shared by the customer pricing tables and the admin model editor.
 */
export type PriceUnitId =
  | "input"
  | "output"
  | "cachedInput"
  | "cacheWrite"
  | "image"
  | "request"
  | "audioInput"
  | "audioOutput"
  | "perMinute"
  | "perMillionChars"
  | "perSecond";

export interface PriceUnitDef {
  id: PriceUnitId;
  /** Short label, e.g. "Input". */
  label: string;
  /** Unit suffix, e.g. "/ 1M tokens". */
  per: string;
  /** Model field holding the customer (sell) price. */
  price: string;
  /** Model field holding the official price. */
  official: string;
  /** ModelRoute field holding our cost. */
  cost: string;
  /** Falls back to the input price when blank (cached / cache write). */
  fallbackToInput?: boolean;
}

export const PRICE_UNITS: PriceUnitDef[] = [
  { id: "input", label: "Input", per: "/ 1M tokens", price: "inputPrice", official: "officialInputPrice", cost: "inputCost" },
  { id: "output", label: "Output", per: "/ 1M tokens", price: "outputPrice", official: "officialOutputPrice", cost: "outputCost" },
  { id: "cachedInput", label: "Cached input", per: "/ 1M tokens", price: "cachedInputPrice", official: "officialCachedPrice", cost: "cachedInputCost", fallbackToInput: true },
  { id: "cacheWrite", label: "Cache write", per: "/ 1M tokens", price: "cacheWritePrice", official: "officialCacheWritePrice", cost: "cacheWriteCost", fallbackToInput: true },
  { id: "image", label: "Per image", per: "/ image", price: "imagePrice", official: "officialImagePrice", cost: "imageCost" },
  { id: "perSecond", label: "Per second (video)", per: "/ second", price: "perSecondPrice", official: "officialPerSecondPrice", cost: "perSecondCost" },
  { id: "perMinute", label: "Per minute (transcription)", per: "/ minute", price: "perMinutePrice", official: "officialPerMinutePrice", cost: "perMinuteCost" },
  { id: "perMillionChars", label: "Per 1M characters (speech)", per: "/ 1M chars", price: "perMillionChars", official: "officialPerMillionChars", cost: "perMillionCharsCost" },
  { id: "audioInput", label: "Audio input", per: "/ 1M audio tokens", price: "audioInputPrice", official: "officialAudioInputPrice", cost: "audioInputCost" },
  { id: "audioOutput", label: "Audio output", per: "/ 1M audio tokens", price: "audioOutputPrice", official: "officialAudioOutputPrice", cost: "audioOutputCost" },
  { id: "request", label: "Per request", per: "/ request", price: "requestPrice", official: "officialRequestPrice", cost: "requestCost" },
];

export const PRICE_UNIT_BY_ID: Record<PriceUnitId, PriceUnitDef> = Object.fromEntries(PRICE_UNITS.map((u) => [u.id, u])) as Record<PriceUnitId, PriceUnitDef>;

const has = (v: unknown) => v !== null && v !== undefined && v !== "" && Number(v) !== 0;

/** Units worth showing for a model: those with a customer price or an official price (record keyed by the field names above). */
export function relevantUnits(rec: Record<string, string | number | null | undefined>): PriceUnitDef[] {
  return PRICE_UNITS.filter((u) => has(rec[u.price]) || has(rec[u.official]));
}
