import "server-only";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { getConfig } from "@/gateway/cache";
import { eligibleRoutes } from "@/gateway/select";
import { pricingTargets, type PricingPoolOption, type PricingTarget } from "@/server/pricing/price-sync/targets";
import { getPriceSyncConfig, type PoolFinding, type PriceSyncConfig, type Proposal } from "@/server/pricing/price-sync/engine";

/** Configured chat routes, independent of transient key cooldowns. No upstream calls. */
export async function getPricingPoolOptions(): Promise<PricingPoolOption[]> {
  const snap = await getConfig();
  const chat = [...snap.modelsById.values()].filter((m) => m.status !== "DISABLED" && m.capabilities.has("chat"));
  return [...snap.groupsBySlug.values()].map((g) => ({
    pool: g.slug,
    models: chat.filter((m) => (!g.allowedModels || g.allowedModels.has(m.slug)) && eligibleRoutes(snap, m, g, "openai_chat").length > 0).map((m) => m.slug).sort(),
  })).filter((g) => g.models.length).sort((a, b) => a.pool.localeCompare(b.pool));
}

export interface PriceSyncRunView {
  id: string;
  trigger: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  proposals: Proposal[];
  pool: PoolFinding | null;
  sources: Array<{ url: string; ok: boolean; chars: number; error?: string }>;
  /** what the AI call(s) cost us upstream (USD) */
  costUsd: number;
  applied: { at: string; by: string | null; items: Array<{ routeId: string; modelSlug: string }> } | null;
}

export interface PriceSyncPanel {
  config: PriceSyncConfig;
  ai: PricingTarget[];
  /** global automatic-update schedule (Settings > Monitoring) */
  schedule: { enabled: boolean; minutes: number };
  routes: Array<{ id: string; modelSlug: string; upstreamModel: string; enabled: boolean }>;
  run: PriceSyncRunView | null;
  history: Array<{ id: string; trigger: string; status: string; createdAt: string; changes: number; applied: number; costUsd: number }>;
}

async function costOf(requestIds: string[][]): Promise<Map<string, number>> {
  const ids = [...new Set(requestIds.flat())];
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = await db.requestLog.findMany({ where: { id: { in: ids } }, select: { id: true, cost: true } });
  for (const r of rows) out.set(r.id, Number(r.cost.toString()));
  return out;
}

export async function getPriceSyncPanel(providerId: string): Promise<PriceSyncPanel | null> {
  const config = await getPriceSyncConfig(providerId);
  if (!config) return null;
  const [s, routes, runs] = await Promise.all([
    getSettings(),
    db.modelRoute.findMany({ where: { providerId }, orderBy: { upstreamModel: "asc" }, select: { id: true, upstreamModel: true, enabled: true, model: { select: { slug: true } } } }),
    db.priceSyncRun.findMany({ where: { providerId }, orderBy: { createdAt: "desc" }, take: 8 }),
  ]);
  const costs = await costOf(runs.map((r) => r.requestIds));
  const sum = (ids: string[]) => ids.reduce((a, id) => a + (costs.get(id) ?? 0), 0);
  const latest = runs.find((r) => r.status !== "running") ?? runs[0] ?? null;
  const run: PriceSyncRunView | null = latest
    ? {
        id: latest.id,
        trigger: latest.trigger,
        status: latest.status,
        createdAt: latest.createdAt.toISOString(),
        finishedAt: latest.finishedAt?.toISOString() ?? null,
        error: latest.error,
        proposals: (latest.proposals as unknown as Proposal[]) ?? [],
        pool: (latest.pool as unknown as PoolFinding | null) ?? null,
        sources: (latest.sources as unknown as PriceSyncRunView["sources"]) ?? [],
        costUsd: sum(latest.requestIds),
        applied: (latest.applied as unknown as PriceSyncRunView["applied"]) ?? null,
      }
    : null;
  return {
    config,
    ai: pricingTargets(s),
    schedule: { enabled: s.priceSyncAuto, minutes: s.priceSyncIntervalMin },
    routes: routes.map((r) => ({ id: r.id, modelSlug: r.model.slug, upstreamModel: r.upstreamModel, enabled: r.enabled })),
    run,
    history: runs.map((r) => {
      const props = (r.proposals as unknown as Proposal[]) ?? [];
      return {
        id: r.id,
        trigger: r.trigger,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        changes: props.filter((p) => p.status === "update" || p.status === "review").length,
        applied: ((r.applied as { items?: unknown[] } | null)?.items ?? []).length,
        costUsd: sum(r.requestIds),
      };
    }),
  };
}
