// Auto-updated route costs: a route with `autoCostSync` takes its cost from the price its provider publishes through
// its own API (see gateway/remote-pricing.ts). The model's pricing rule (e.g. "% of our cost" + a +/- adjustment) then
// re-derives the customer price, so "50% of the provider's price" or "the provider's price minus 5 cents" stay correct
// when the provider changes its prices.
//
// NO TIMERS: a refresh is only ever triggered by a real call on the route (`noteRouteCall`, from the gateway's request
// log hook) - when the last refresh is older than `autoPriceSyncHours` or `autoPriceSyncCalls` calls happened since -
// or by an admin ("Sync now"). A route nobody calls never makes a request.
import { decrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Decimal, toDbString } from "@/lib/money";
import { audit } from "@/lib/audit";
import { invalidateGatewayConfig, type RouteRec } from "@/gateway/cache";
import { toAdapter } from "@/gateway/health";
import { fetchRemotePricing, type RemotePrice } from "@/gateway/remote-pricing";
import type { JsonObject } from "@/gateway/types";
import { UNIT_FIELDS } from "./fields";
import { recomputeModelPrices } from "./rules";

const MIN_GAP_MS = 60_000; // two refreshes of one route are at least a minute apart (all instances)
const PROVIDER_CACHE_MS = 5 * 60_000;

const g = globalThis as unknown as { __ppAutoSync?: { counters: Map<string, number>; inflight: Set<string>; lastSync: Map<string, number>; prices: Map<string, { at: number; prices: Map<string, RemotePrice> }> } };
const state = (g.__ppAutoSync ??= { counters: new Map(), inflight: new Set(), lastSync: new Map(), prices: new Map() });

/** Called for every successful request served by `route` (cheap; at most one refresh in flight per route). */
export function noteRouteCall(route: Pick<RouteRec, "id" | "autoCostSync" | "autoCostSyncedAt">, settings: { autoPriceSyncHours: number; autoPriceSyncCalls: number }): void {
  if (!route.autoCostSync) return;
  const n = (state.counters.get(route.id) ?? 0) + 1;
  state.counters.set(route.id, n);
  // (the cached route may lag behind a refresh another call just did: the local note wins when newer)
  const last = Math.max(route.autoCostSyncedAt ?? 0, state.lastSync.get(route.id) ?? 0);
  const age = last ? Date.now() - last : Infinity;
  const due = age >= settings.autoPriceSyncHours * 3_600_000 || n >= settings.autoPriceSyncCalls;
  if (!due || state.inflight.has(route.id)) return;
  state.counters.set(route.id, 0);
  state.inflight.add(route.id);
  state.lastSync.set(route.id, Date.now());
  void syncRouteCost(route.id, { reason: age === Infinity ? "first call" : n >= settings.autoPriceSyncCalls ? `${n} calls` : "interval" })
    .catch((err) => logger.warn("auto price sync failed", { routeId: route.id, err }))
    .finally(() => state.inflight.delete(route.id));
}

export interface SyncResult {
  status: "ok" | "unchanged" | "not published" | "no key" | "provider unreachable" | "skipped";
  changed: string[];
  price?: RemotePrice;
}

async function providerPrices(providerId: string, force: boolean): Promise<Map<string, RemotePrice> | null> {
  const hit = state.prices.get(providerId);
  if (!force && hit && Date.now() - hit.at < PROVIDER_CACHE_MS) return hit.prices;
  const provider = await db.provider.findUnique({ where: { id: providerId }, include: { keys: true } });
  if (!provider) return null;
  const now = Date.now();
  const key = provider.keys
    .filter((k) => k.status === "ACTIVE" || (k.status === "COOLDOWN" && (!k.cooldownUntil || k.cooldownUntil.getTime() <= now)))
    .sort((a, b) => b.priority - a.priority)[0];
  let secret: string | null = null;
  try {
    secret = key ? decrypt(key.secretEncrypted) : null;
  } catch {
    secret = null;
  }
  const r = await fetchRemotePricing(toAdapter(provider), secret, (key?.extra && typeof key.extra === "object" ? key.extra : {}) as JsonObject, { timeoutMs: 8_000, stopAfterFirst: true });
  if (!r.tried.some((t) => t.status >= 200 && t.status < 300)) return null;
  state.prices.set(providerId, { at: Date.now(), prices: r.prices });
  return r.prices;
}

/**
 * Re-read one route's cost from its provider's published prices and re-derive the model's customer prices.
 * `force` (admin "Sync now") ignores the minimum gap and the provider price cache.
 */
export async function syncRouteCost(routeId: string, opts: { force?: boolean; reason?: string; actorId?: string | null } = {}): Promise<SyncResult> {
  const now = new Date();
  // claim (all instances): one refresh per route per minute
  const claimed = await db.modelRoute.updateMany({
    where: { id: routeId, ...(opts.force ? {} : { autoCostSync: true, OR: [{ autoCostSyncedAt: null }, { autoCostSyncedAt: { lt: new Date(now.getTime() - MIN_GAP_MS) } }] }) },
    data: { autoCostSyncedAt: now },
  });
  if (!claimed.count) return { status: "skipped", changed: [] };
  const route = await db.modelRoute.findUniqueOrThrow({ where: { id: routeId } });
  const prices = await providerPrices(route.providerId, !!opts.force);
  const finish = async (status: SyncResult["status"], changed: string[] = [], price?: RemotePrice): Promise<SyncResult> => {
    await db.modelRoute.update({ where: { id: routeId }, data: { autoCostStatus: status } });
    await invalidateGatewayConfig("models", route.modelId); // every instance picks up the new sync time
    return { status, changed, price };
  };
  if (!prices) return finish("provider unreachable");
  const price = prices.get(route.autoCostSourceModel || route.upstreamModel);
  if (!price) return finish("not published");

  const row = route as unknown as Record<string, unknown>;
  const data: Record<string, string> = {};
  for (const f of UNIT_FIELDS) {
    const v = price.prices[f.unit];
    if (v === null || v === undefined) continue;
    const next = new Decimal(String(v));
    const cur = row[f.cost] === null || row[f.cost] === undefined ? null : new Decimal(String(row[f.cost]));
    if (!cur || !cur.equals(next)) data[f.cost] = toDbString(next);
  }
  if (!Object.keys(data).length) return finish("unchanged", [], price);
  await db.modelRoute.update({ where: { id: routeId }, data: { ...data, autoCostStatus: "ok" } });
  await recomputeModelPrices(route.modelId);
  await invalidateGatewayConfig("models", route.modelId);
  await audit(opts.actorId ?? null, "route.auto_cost_sync", { type: "ModelRoute", id: routeId }, {
    reason: opts.reason ?? (opts.force ? "manual" : "auto"),
    source: price.source,
    changed: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { from: row[k] === null || row[k] === undefined ? null : String(row[k]), to: v }])),
  });
  logger.info("route cost auto-updated from the provider's published prices", { routeId, changed: Object.keys(data) });
  return { status: "ok", changed: Object.keys(data), price };
}

/** Test hook. */
export function __resetAutoSyncForTests(): void {
  state.counters.clear();
  state.inflight.clear();
  state.lastSync.clear();
  state.prices.clear();
}
