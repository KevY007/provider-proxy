import { Decimal } from "@/lib/money";
import type { ConfigSnapshot, GroupRec, ModelRec, RouteRec } from "./cache";
import { hasCost, type PriceTable } from "./pricing";

/**
 * The per-unit prices a pool's customers pay for a model, multiplier INCLUDED (for catalogs, the public pricing
 * document and the customer portal; billing itself uses `priceRequest`).
 *
 *   model-basis pool : model price x multiplier
 *   cost-basis pool  : the primary route's upstream cost x multiplier, each unit capped at the official list price
 *                      (the request is billed from the route that really serves it, so this is the typical price)
 */
export function poolPriceTable(snap: ConfigSnapshot, model: ModelRec, group: GroupRec | null, multiplier: Decimal): PriceTable {
  const route = group?.priceBasis === "cost" ? primaryRoute(snap, model, group) : null;
  if (!route || !hasCost(route.cost)) return scale(model.sell, multiplier);
  return scale(route.cost, multiplier, model);
}

/** Highest-priority enabled route on an active provider the pool may use (the cache holds enabled routes only). */
export function primaryRoute(snap: ConfigSnapshot, model: ModelRec, group: GroupRec | null): RouteRec | null {
  const all = (snap.routesByModel.get(model.id) ?? []).filter((r) => {
    if (r.provider.status !== "ACTIVE") return false;
    if (!group) return !r.groupSlugs.length;
    if (group.providerTags.length && !r.provider.tags.some((t) => group.providerTags.includes(t))) return false;
    return !r.groupSlugs.length || r.groupSlugs.includes(group.slug);
  });
  all.sort((a, b) => b.priority - a.priority || b.provider.priority - a.provider.priority || b.weight - a.weight);
  return all[0] ?? null;
}

type Unit = Exclude<keyof PriceTable, "tools">;
const UNITS: Unit[] = ["input", "output", "cachedInput", "cacheWrite", "cacheWrite1h", "image", "request", "audioInput", "audioOutput", "perMinute", "perMillionChars", "perSecond"];

/** table x multiplier; with `capBy`, each unit is capped at that model's official price (where one exists). */
function scale(t: PriceTable, m: Decimal, capBy?: ModelRec): PriceTable {
  const out = {} as PriceTable;
  for (const u of UNITS) {
    const v = t[u];
    let x = v ? v.times(m) : null;
    const cap = capBy?.official[u] ?? null;
    if (x && cap && cap.gt(0) && x.gt(cap)) x = cap;
    (out as unknown as Record<Unit, Decimal | null>)[u] = x;
  }
  out.input = out.input ?? new Decimal(0);
  out.output = out.output ?? new Decimal(0);
  const tools: Record<string, Decimal> = {};
  for (const [k, v] of Object.entries(t.tools ?? {})) {
    const cap = capBy?.official.tools?.[k];
    const x = v.times(m);
    tools[k] = cap && cap.gt(0) && x.gt(cap) ? cap : x;
  }
  out.tools = tools;
  return out;
}
