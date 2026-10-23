import "server-only";
import { db } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/types";
import { getCatalogModels, getDefaultGroup, getPublicGroups, type CatalogGroup, type CatalogModel } from "./catalog";
import { effectiveMultiplier, effectivePrices, groupAllowsModel, type EffectivePrices } from "./pricing";

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
  allowedModels: string[];
  ipAllowlist: string[];
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
  /** Group multiplier x the customer's personal multiplier. */
  multiplier: string;
  isDefault: boolean;
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
  }));
  const currentId = own?.id ?? def?.id ?? null;
  const current = pools.find((p) => p.id === currentId) ?? (def ? { id: def.id, slug: def.slug, name: def.name, description: def.description, multiplier: effectiveMultiplier(def.priceMultiplier, user.priceMultiplier).toString(), isDefault: def.isDefault } : null);
  return { pools, current };
}

export async function getKeysPageData(user: SessionUser) {
  const [rows, { pools, current }, models, list] = await Promise.all([
    db.apiKey.findMany({ where: { userId: user.id, isPlayground: false }, include: { group: { select: { name: true, priceMultiplier: true } } }, orderBy: { createdAt: "desc" } }),
    getSelectablePools(user),
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
    allowedModels: k.allowedModels,
    ipAllowlist: k.ipAllowlist,
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
}

/** Models the customer can use, priced for every pool they could pick. */
export async function getModelsForUser(user: SessionUser) {
  const [models, { pools, current }] = await Promise.all([getCatalogModels(), getSelectablePools(user)]);
  const groups = await db.group.findMany({ where: { id: { in: pools.map((p) => p.id) } }, select: { id: true, allowedModels: true } });
  const allowed = new Map(groups.map((g) => [g.id, g.allowedModels]));
  const out: UserModel[] = [];
  for (const m of models) {
    const prices: Record<string, EffectivePrices> = {};
    for (const p of pools) {
      if (groupAllowsModel({ allowedModels: allowed.get(p.id) ?? [] }, m.slug, m.aliases)) prices[p.slug] = effectivePrices(m, p.multiplier);
    }
    if (Object.keys(prices).length) out.push({ ...m, prices });
  }
  return { models: out, pools, currentPool: current };
}
