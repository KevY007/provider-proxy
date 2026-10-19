import "server-only";
import { db } from "@/lib/db";
import { effectiveMultiplier, groupAllowsModel, type GroupLike } from "./pricing";
import { PRICE_UNITS } from "./price-units";
import type { UnitPriceMap } from "./price-rows";

/** Serializable (strings for Decimals) model row for catalog views. Never includes cost/route/provider info. */
export interface CatalogModel {
  id: string;
  slug: string;
  aliases: string[];
  displayName: string;
  vendor: string;
  description: string | null;
  capabilities: string[];
  contextWindow: number | null;
  maxOutput: number | null;
  inputPrice: string;
  outputPrice: string;
  cachedInputPrice: string | null;
  cacheWritePrice: string | null;
  imagePrice: string | null;
  requestPrice: string | null;
  longContextThreshold: number | null;
  longContextMultiplier: string | null;
  officialInputPrice: string | null;
  officialOutputPrice: string | null;
  officialCachedPrice: string | null;
  /** Base customer prices for every unit (before multipliers), keyed by unit id. */
  sell: UnitPriceMap;
  /** Official prices for every unit, keyed by unit id. */
  official: UnitPriceMap;
  /** ISO date when the model is retired (shown as a "retiring" badge). */
  retiresAt: string | null;
}

export interface CatalogGroup {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceMultiplier: string;
  allowedModels: string[];
  isDefault: boolean;
  isPublic: boolean;
  sortOrder: number;
}

const s = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? null : v.toString());

/** Active public models, ordered. */
export async function getCatalogModels(): Promise<CatalogModel[]> {
  const rows = await db.model.findMany({ where: { status: "ACTIVE" }, orderBy: [{ sortOrder: "asc" }, { displayName: "asc" }] });
  return rows.map((m) => {
    const rec = m as unknown as Record<string, { toString(): string } | null | undefined>;
    const sell: UnitPriceMap = {};
    const official: UnitPriceMap = {};
    for (const u of PRICE_UNITS) {
      sell[u.id] = s(rec[u.price]);
      official[u.id] = s(rec[u.official]);
    }
    return {
    id: m.id,
    slug: m.slug,
    aliases: m.aliases,
    displayName: m.displayName,
    vendor: m.vendor,
    description: m.description,
    capabilities: m.capabilities,
    contextWindow: m.contextWindow,
    maxOutput: m.maxOutput,
    inputPrice: m.inputPrice.toString(),
    outputPrice: m.outputPrice.toString(),
    cachedInputPrice: s(m.cachedInputPrice),
    cacheWritePrice: s(m.cacheWritePrice),
    imagePrice: s(m.imagePrice),
    requestPrice: s(m.requestPrice),
    longContextThreshold: m.longContextThreshold,
    longContextMultiplier: s(m.longContextMultiplier),
    officialInputPrice: s(m.officialInputPrice),
    officialOutputPrice: s(m.officialOutputPrice),
    officialCachedPrice: s(m.officialCachedPrice),
    sell,
    official,
    retiresAt: m.retiresAt ? m.retiresAt.toISOString() : null,
  };
  });
}

/** Public groups (pools) customers can pick, default first by sortOrder. */
export async function getPublicGroups(): Promise<CatalogGroup[]> {
  const rows = await db.group.findMany({ where: { isPublic: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return rows.map(toCatalogGroup);
}

export async function getDefaultGroup(): Promise<CatalogGroup | null> {
  const row = (await db.group.findFirst({ where: { isDefault: true } })) ?? (await db.group.findFirst({ orderBy: { sortOrder: "asc" } }));
  return row ? toCatalogGroup(row) : null;
}

function toCatalogGroup(g: { id: string; slug: string; name: string; description: string | null; priceMultiplier: { toString(): string }; allowedModels: string[]; isDefault: boolean; isPublic: boolean; sortOrder: number }): CatalogGroup {
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    description: g.description,
    priceMultiplier: g.priceMultiplier.toString(),
    allowedModels: g.allowedModels,
    isDefault: g.isDefault,
    isPublic: g.isPublic,
    sortOrder: g.sortOrder,
  };
}

export { effectiveMultiplier, groupAllowsModel };
export type { GroupLike };
