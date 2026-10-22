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
    groups: groups.map((g) => ({ value: g.id, label: `${g.name} (${g.slug}, ${dstr0(g.priceMultiplier)}×)` })),
  };
}
