import "server-only";
import { db } from "@/lib/db";
import { getSlotSnapshot } from "@/gateway/slots";
import { getProviderKeyWindowStats, getProviderWindowStats } from "@/server/analytics/queries";
import { dstr, dstr0, iso } from "./serialize";

export interface ProviderListRow {
  id: string;
  name: string;
  slug: string;
  preset: string;
  baseUrl: string;
  status: string;
  healthStatus: string;
  lastCheckAt: string | null;
  lastLatencyMs: number | null;
  maxConcurrency: number | null;
  keysTotal: number;
  keysActive: number;
  routes: number;
  req24h: number;
  err24h: number;
  cost24h: number;
}

const DAY = 24 * 3600_000;

export async function listProviders(): Promise<ProviderListRow[]> {
  const since = new Date(Date.now() - DAY);
  const [providers, stats, keyGroups] = await Promise.all([
    db.provider.findMany({
      orderBy: [{ status: "asc" }, { priority: "desc" }, { name: "asc" }],
      select: {
        id: true, name: true, slug: true, preset: true, baseUrl: true, status: true, healthStatus: true,
        lastCheckAt: true, lastLatencyMs: true, maxConcurrency: true,
        _count: { select: { routes: true } },
      },
    }),
    getProviderWindowStats(since).catch(() => new Map()),
    db.providerKey.groupBy({ by: ["providerId", "status"], _count: { _all: true } }),
  ]);
  const keysTotal = new Map<string, number>();
  const keysActive = new Map<string, number>();
  for (const g of keyGroups) {
    keysTotal.set(g.providerId, (keysTotal.get(g.providerId) ?? 0) + g._count._all);
    if (g.status === "ACTIVE") keysActive.set(g.providerId, g._count._all);
  }
  return providers.map((p) => {
    const s = stats.get(p.id);
    return {
      id: p.id, name: p.name, slug: p.slug, preset: p.preset, baseUrl: p.baseUrl, status: p.status,
      healthStatus: p.healthStatus, lastCheckAt: iso(p.lastCheckAt), lastLatencyMs: p.lastLatencyMs,
      maxConcurrency: p.maxConcurrency,
      keysTotal: keysTotal.get(p.id) ?? 0, keysActive: keysActive.get(p.id) ?? 0, routes: p._count.routes,
      req24h: s?.requests ?? 0, err24h: s?.errors ?? 0, cost24h: s?.cost ?? 0,
    };
  });
}

export interface ProviderKeyRow {
  id: string;
  label: string;
  secretHint: string;
  status: string;
  weight: number;
  priority: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  maxConcurrency: number | null;
  dailyBudget: string | null;
  cooldownUntil: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastUsedAt: string | null;
  totalRequests: number;
  totalCost: string;
  extra: string;
  req24h: number;
  err24h: number;
  cost24h: number;
}

export async function getProviderDetail(id: string) {
  const provider = await db.provider.findUnique({ where: { id } });
  if (!provider) return null;
  const since = new Date(Date.now() - DAY);
  const [keys, keyStats, checks, routes, slots] = await Promise.all([
    // explicit select: never fetch secretEncrypted
    db.providerKey.findMany({
      where: { providerId: id },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      select: {
        id: true, label: true, secretHint: true, status: true, weight: true, priority: true, rpmLimit: true,
        tpmLimit: true, maxConcurrency: true, dailyBudget: true, cooldownUntil: true, consecutiveFailures: true,
        lastError: true, lastUsedAt: true, totalRequests: true, totalCost: true, extra: true,
      },
    }),
    getProviderKeyWindowStats(since, new Date(), id).catch(() => new Map()),
    db.healthCheck.findMany({
      where: { providerId: id },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, ok: true, latencyMs: true, error: true, createdAt: true, providerKeyId: true },
    }),
    db.modelRoute.findMany({
      where: { providerId: id },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      select: {
        id: true, upstreamModel: true, enabled: true, priority: true, weight: true, groupSlugs: true,
        inputCost: true, outputCost: true, model: { select: { id: true, slug: true, displayName: true } },
      },
    }),
    getSlotSnapshot().catch(() => ({ providerKeys: [], providers: [], customers: [], queued: 0, at: new Date().toISOString() })),
  ]);
  const keyLabel = new Map(keys.map((k) => [k.id, k.label]));
  const keyRows: ProviderKeyRow[] = keys.map((k) => {
    const s = keyStats.get(k.id);
    return {
      id: k.id, label: k.label, secretHint: k.secretHint, status: k.status, weight: k.weight, priority: k.priority,
      rpmLimit: k.rpmLimit, tpmLimit: k.tpmLimit, maxConcurrency: k.maxConcurrency, dailyBudget: dstr(k.dailyBudget),
      cooldownUntil: iso(k.cooldownUntil), consecutiveFailures: k.consecutiveFailures, lastError: k.lastError,
      lastUsedAt: iso(k.lastUsedAt), totalRequests: k.totalRequests, totalCost: dstr0(k.totalCost),
      extra: JSON.stringify(k.extra ?? {}, null, 2),
      req24h: s?.requests ?? 0, err24h: s?.errors ?? 0, cost24h: s?.cost ?? 0,
    };
  });
  return {
    provider: {
      id: provider.id, name: provider.name, slug: provider.slug, preset: provider.preset, baseUrl: provider.baseUrl,
      authStyle: provider.authStyle, formats: provider.formats, tags: provider.tags,
      extraHeaders: JSON.stringify(provider.extraHeaders ?? {}, null, 2),
      settings: JSON.stringify(provider.settings ?? {}, null, 2),
      status: provider.status, timeoutMs: provider.timeoutMs, priority: provider.priority,
      maxConcurrency: provider.maxConcurrency, healthStatus: provider.healthStatus,
      lastCheckAt: iso(provider.lastCheckAt), lastLatencyMs: provider.lastLatencyMs, notes: provider.notes ?? "",
      createdAt: provider.createdAt.toISOString(),
    },
    keys: keyRows,
    checks: checks.map((c) => ({
      id: c.id, ok: c.ok, latencyMs: c.latencyMs, error: c.error, createdAt: c.createdAt.toISOString(),
      keyLabel: c.providerKeyId ? (keyLabel.get(c.providerKeyId) ?? "(deleted key)") : "provider",
    })),
    routes: routes.map((r) => ({
      id: r.id, upstreamModel: r.upstreamModel, enabled: r.enabled, priority: r.priority, weight: r.weight,
      groupSlugs: r.groupSlugs, inputCost: dstr0(r.inputCost), outputCost: dstr0(r.outputCost),
      modelId: r.model.id, modelSlug: r.model.slug, modelName: r.model.displayName,
    })),
    slots,
  };
}

export type ProviderDetail = NonNullable<Awaited<ReturnType<typeof getProviderDetail>>>;
