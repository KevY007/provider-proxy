import "server-only";
import { db } from "@/lib/db";
import { parseEffortRoutes, type EffortRoute } from "@/gateway/effort-route";
import { dstr0 } from "./serialize";

export interface GroupRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  priceMultiplier: string;
  priceBasis: "model" | "cost";
  /** shown saving %, "" = official list price */
  referenceSavingsPct: string;
  providerTags: string[];
  allowedModels: string[];
  isDefault: boolean;
  isPublic: boolean;
  rpmLimit: string;
  maxConcurrency: string;
  sortOrder: number;
  effortRoutes: EffortRoute[];
  users: number;
  apiKeys: number;
}

export async function getGroupRows(): Promise<GroupRow[]> {
  const groups = await db.group.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { users: true, apiKeys: true } } },
  });
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    slug: g.slug,
    description: g.description ?? "",
    priceMultiplier: dstr0(g.priceMultiplier),
    priceBasis: g.priceBasis === "cost" ? "cost" : "model",
    referenceSavingsPct: g.referenceSavingsPct === null ? "" : Number(g.referenceSavingsPct.toString()).toString(),
    providerTags: g.providerTags,
    allowedModels: g.allowedModels,
    isDefault: g.isDefault,
    isPublic: g.isPublic,
    rpmLimit: g.rpmLimit?.toString() ?? "",
    maxConcurrency: g.maxConcurrency?.toString() ?? "",
    sortOrder: g.sortOrder,
    effortRoutes: parseEffortRoutes(g.effortRoutes),
    users: g._count.users,
    apiKeys: g._count.apiKeys,
  }));
}

export async function getGroupFormOptions() {
  const [models, providers, groups] = await Promise.all([
    db.model.findMany({ orderBy: [{ sortOrder: "asc" }, { slug: "asc" }], select: { slug: true, displayName: true } }),
    db.provider.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, tags: true } }),
    db.group.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, slug: true, priceMultiplier: true } }),
  ]);
  return {
    models: models.map((m) => ({ value: m.slug, label: m.slug, hint: m.displayName })),
    providerTags: [...new Set(providers.flatMap((p) => p.tags))].sort(),
    providers: providers.map((p) => ({ value: p.id, label: p.name })),
    groups: groups.map((g) => ({ value: g.id, label: `${g.name} (${g.slug})` })),
  };
}

/** One model as the pool editor previews it: USD per 1M tokens (input / output / cached input). */
export interface PoolSampleModel {
  slug: string;
  /** model price (what a "model price" basis multiplies) */
  model: { input: number; output: number; cached: number | null };
  official: { input: number; output: number; cached: number | null } | null;
  /** primary route cost per pool slug (what a "cost" basis multiplies), null when the pool has no route */
  cost: Record<string, { input: number; output: number; cached: number | null } | null>;
}

/** Token prices of every active model, with the cost of the route each pool would use (for live pool previews). */
export async function getPoolPricingSamples(): Promise<PoolSampleModel[]> {
  const { getConfig } = await import("@/gateway/cache");
  const { primaryRoute } = await import("@/gateway/pool-prices");
  const snap = await getConfig();
  const n = (d: { toNumber(): number } | null | undefined) => (d ? d.toNumber() : null);
  const out: PoolSampleModel[] = [];
  for (const m of snap.modelsById.values()) {
    if (m.status !== "ACTIVE" || (m.sell.input.isZero() && m.sell.output.isZero())) continue;
    const cost: PoolSampleModel["cost"] = {};
    for (const g of snap.groupsById.values()) {
      if (g.allowedModels && !g.allowedModels.has(m.slug)) continue;
      const r = primaryRoute(snap, m, g);
      cost[g.slug] = r ? { input: r.cost.input.toNumber(), output: r.cost.output.toNumber(), cached: n(r.cost.cachedInput) } : null;
    }
    const oi = n(m.official.input);
    const oo = n(m.official.output);
    out.push({
      slug: m.slug,
      model: { input: m.sell.input.toNumber(), output: m.sell.output.toNumber(), cached: n(m.sell.cachedInput) },
      official: oi !== null && oo !== null ? { input: oi, output: oo, cached: n(m.official.cachedInput) } : null,
      cost,
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}
