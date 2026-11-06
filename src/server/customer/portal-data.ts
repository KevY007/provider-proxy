import "server-only";
import { db } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/types";
import { getCatalogModels, getDefaultGroup, getPublicGroups, type CatalogGroup, type CatalogModel } from "./catalog";
import { effectiveMultiplier, effectivePrices, groupAllowsModel, type EffectivePrices } from "./pricing";
import { Decimal } from "@/lib/money";
import { getConfig } from "@/gateway/cache";
import { poolPriceTable } from "@/gateway/pool-prices";
import type { PriceTable } from "@/gateway/pricing";
import type { UnitPriceMap } from "./price-rows";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  status: "ACTIVE" | "DISABLED" | "REVOKED";
  expired: boolean;
  groupId: string | null;
  groupName: string | null;
  groupMultiplier: string | null;
  /** saving of the key's pool vs the official list price (shown instead of the multiplier) */
  groupSavingsPct: number | null;
  allowedModels: string[];
  ipAllowlist: string[];
  /** user-agent this key presents upstream (preset id or text); null = the caller's own */
  userAgent: string | null;
  /** upstream request headers this key strips */
  stripHeaders: string[];
  rpmLimit: number | null;
  tpmLimit: number | null;
  maxConcurrency: number | null;
  spendLimit: string | null;
  spent: string;
  /** what this key's requests would have cost at official list prices (requests that recorded one); null = none yet */
  listPrice: string | null;
  /** what was paid for those same requests (the comparable part of `spent`) */
  listComparablePaid: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface PoolOption {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** Group multiplier x the customer's personal multiplier (internal: customer pages show `savingsPct`, never this). */
  multiplier: string;
  /** Typical saving vs the official list price across the pool's models (input:output 3:1), null when unknown. */
  savingsPct?: number | null;
  isDefault: boolean;
  /** model slugs the pool allows (empty = all) */
  allowedModels: string[];
}

/**
 * Pools a customer may pick: public groups + their assigned pool + private pools an admin allowed for them + the pools
 * their existing keys are already in (so an edit dialog always shows the key's current pool).
 */
export async function getSelectablePools(user: SessionUser): Promise<{ pools: PoolOption[]; current: PoolOption | null }> {
  const [pub, def, keyGroups] = await Promise.all([
    getPublicGroups(),
    getDefaultGroup(),
    db.apiKey.findMany({ where: { userId: user.id, status: { not: "REVOKED" }, groupId: { not: null } }, select: { groupId: true }, distinct: ["groupId"] }),
  ]);
  const privateIds = [...new Set([user.groupId, ...(user.extraGroupIds ?? []), ...keyGroups.map((k) => k.groupId)].filter((id): id is string => !!id))];
  const extra = privateIds.length ? await db.group.findMany({ where: { id: { in: privateIds } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }) : [];
  const own = extra.find((g) => g.id === user.groupId) ?? null;
  const all: CatalogGroup[] = [...pub];
  for (const g of extra) {
    if (!all.some((x) => x.id === g.id)) {
      all.push({ id: g.id, slug: g.slug, name: g.name, description: g.description, priceMultiplier: g.priceMultiplier.toString(), allowedModels: g.allowedModels, isDefault: g.isDefault, isPublic: g.isPublic, sortOrder: g.sortOrder });
    }
  }
  const pools = all.map((g) => ({
    id: g.id,
    slug: g.slug,
    name: g.name,
    description: g.description,
    multiplier: effectiveMultiplier(g.priceMultiplier, user.priceMultiplier).toString(),
    isDefault: g.isDefault,
    allowedModels: g.allowedModels,
  }));
  const currentId = own?.id ?? def?.id ?? null;
  const current = pools.find((p) => p.id === currentId) ?? (def ? { id: def.id, slug: def.slug, name: def.name, description: def.description, multiplier: effectiveMultiplier(def.priceMultiplier, user.priceMultiplier).toString(), isDefault: def.isDefault, allowedModels: def.allowedModels } : null);
  return { pools, current };
}

/** Pools with their typical saving vs the official list price (what the customer pages show instead of multipliers). */
export async function getSelectablePoolsWithSavings(user: SessionUser): Promise<{ pools: PoolOption[]; current: PoolOption | null }> {
  const { pools, currentPool } = await getModelsForUser(user);
  return { pools, current: currentPool };
}

export async function getKeysPageData(user: SessionUser) {
  const [rows, { pools, current }, models, list] = await Promise.all([
    db.apiKey.findMany({ where: { userId: user.id, isPlayground: false }, include: { group: { select: { name: true, priceMultiplier: true } } }, orderBy: { createdAt: "desc" } }),
    getSelectablePoolsWithSavings(user),
    getCatalogModels(),
    db.requestLog.groupBy({ by: ["apiKeyId"], where: { userId: user.id, apiKeyId: { not: null }, officialPrice: { gt: 0 } }, _sum: { officialPrice: true, price: true } }),
  ]);
  const listByKey = new Map(list.map((r) => [r.apiKeyId, r._sum]));
  const now = Date.now();
  const keys: KeyRow[] = rows.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    status: k.status,
    expired: !!k.expiresAt && k.expiresAt.getTime() <= now,
    groupId: k.groupId,
    groupName: k.group?.name ?? null,
    groupMultiplier: k.group ? effectiveMultiplier(k.group.priceMultiplier, user.priceMultiplier).toString() : null,
    groupSavingsPct: k.groupId ? (pools.find((p) => p.id === k.groupId)?.savingsPct ?? null) : null,
    allowedModels: k.allowedModels,
    ipAllowlist: k.ipAllowlist,
    userAgent: k.userAgent,
    stripHeaders: k.stripHeaders,
    rpmLimit: k.rpmLimit,
    tpmLimit: k.tpmLimit,
    maxConcurrency: k.maxConcurrency,
    spendLimit: k.spendLimit?.toString() ?? null,
    spent: k.spent.toString(),
    listPrice: listByKey.get(k.id)?.officialPrice?.toString() ?? null,
    listComparablePaid: listByKey.get(k.id)?.price?.toString() ?? null,
    expiresAt: iso(k.expiresAt),
    lastUsedAt: iso(k.lastUsedAt),
    createdAt: k.createdAt.toISOString(),
  }));
  return {
    keys,
    pools,
    currentPool: current,
    models: models.map((m) => ({ slug: m.slug, displayName: m.displayName, vendor: m.vendor, capabilities: m.capabilities })),
  };
}

export interface UserModel extends CatalogModel {
  /** Effective prices per pool slug (only pools that allow this model). */
  prices: Record<string, EffectivePrices>;
  /** The "regular price" a pool compares against (its shown saving), per pool slug; absent = the official price. */
  reference: Record<string, UnitPriceMap>;
}

/** Models the customer can use, priced for every pool they could pick (exactly what the gateway charges). */
export async function getModelsForUser(user: SessionUser) {
  const [models, { pools, current }, snap] = await Promise.all([getCatalogModels(), getSelectablePools(user), getConfig()]);
  const groups = await db.group.findMany({ where: { id: { in: pools.map((p) => p.id) } }, select: { id: true, allowedModels: true } });
  const allowed = new Map(groups.map((g) => [g.id, g.allowedModels]));
  const out: UserModel[] = [];
  const blends = new Map<string, { off: Decimal; ours: Decimal }>();
  for (const m of models) {
    const prices: Record<string, EffectivePrices> = {};
    const reference: Record<string, UnitPriceMap> = {};
    const rec = snap.modelsById.get(m.id);
    for (const p of pools) {
      if (!groupAllowsModel({ allowedModels: allowed.get(p.id) ?? [] }, m.slug, m.aliases)) continue;
      const group = snap.groupsById.get(p.id) ?? null;
      const ep = rec && group?.priceBasis === "cost" ? fromTable(poolPriceTable(snap, rec, group, new Decimal(p.multiplier))) : effectivePrices(m, p.multiplier);
      prices[p.slug] = ep;
      const pct = group?.referenceSavingsPct ?? null;
      if (pct) reference[p.slug] = scaleMap(ep, 1 / (1 - pct / 100));
      // pool saving: blend input:output 3:1 over the models that have a reference price
      const refIn = pct ? Number(ep.input) / (1 - pct / 100) : m.officialInputPrice ? Number(m.officialInputPrice) : null;
      const refOut = pct ? Number(ep.output) / (1 - pct / 100) : m.officialOutputPrice ? Number(m.officialOutputPrice) : null;
      if (refIn !== null && refOut !== null) {
        const b = blends.get(p.slug) ?? { off: new Decimal(0), ours: new Decimal(0) };
        b.off = b.off.plus(new Decimal(refIn).times(3)).plus(refOut);
        b.ours = b.ours.plus(new Decimal(ep.input).times(3)).plus(ep.output);
        blends.set(p.slug, b);
      }
    }
    if (Object.keys(prices).length) out.push({ ...m, prices, reference });
  }
  applySavings(pools, blends);
  if (current) current.savingsPct = pools.find((p) => p.id === current.id)?.savingsPct ?? null;
  return { models: out, pools, currentPool: current };
}

function applySavings(pools: PoolOption[], blends: Map<string, { off: Decimal; ours: Decimal }>) {
  for (const p of pools) {
    const b = blends.get(p.slug);
    p.savingsPct = b && b.off.gt(0) ? Math.round(new Decimal(1).minus(b.ours.div(b.off)).times(100).toNumber()) : null;
  }
}

const ds = (d: Decimal | null | undefined) => (d ? d.toString() : null);

/** Unit prices x factor, keyed like the catalog's unit maps. */
function scaleMap(ep: EffectivePrices, f: number): UnitPriceMap {
  const out: UnitPriceMap = {};
  for (const [k, v] of Object.entries(ep)) out[k as keyof UnitPriceMap] = v === null ? null : new Decimal(v).times(f).toDecimalPlaces(8).toString();
  return out;
}
function fromTable(t: PriceTable): EffectivePrices {
  return {
    input: t.input.toString(),
    output: t.output.toString(),
    cachedInput: ds(t.cachedInput),
    cacheWrite: ds(t.cacheWrite),
    image: ds(t.image),
    request: ds(t.request),
    audioInput: ds(t.audioInput),
    audioOutput: ds(t.audioOutput),
    perMinute: ds(t.perMinute),
    perMillionChars: ds(t.perMillionChars),
    perSecond: ds(t.perSecond),
  };
}
