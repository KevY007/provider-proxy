import type { ConfigSnapshot, GroupRec, KeyRec, ModelRec, RouteRec } from "./cache";
import { isKeyUsable } from "./cache";
import { planTranslation, type FormatPlan } from "./translate";
import type { InboundFormat } from "./types";
import { weightedShuffle } from "./util";

/**
 * Route + upstream-key selection (PLAN 5 steps 7-8). Pure given (snapshot, rand, now) so it is unit-testable.
 *
 * Route order:  route.priority desc -> native-format first -> provider.priority desc -> weighted random (route.weight).
 * Key order  :  usable keys only (ACTIVE / cooled-down), key.priority desc -> weighted random (key.weight).
 * The pipeline then walks (route, key) pairs in this order and takes the first one with a free concurrency slot.
 */
export interface RoutePlan {
  route: RouteRec;
  plan: FormatPlan;
}

export interface Candidate extends RoutePlan {
  key: KeyRec;
}

/** Routes of `model` that this group may use and that can serve `inbound`. */
export function eligibleRoutes(snap: ConfigSnapshot, model: ModelRec, group: GroupRec | null, inbound: InboundFormat): RoutePlan[] {
  const all = snap.routesByModel.get(model.id) ?? [];
  const out: RoutePlan[] = [];
  for (const route of all) {
    const p = route.provider;
    if (p.status !== "ACTIVE") continue;
    if (group) {
      if (group.providerTags.length && !p.tags.some((t) => group.providerTags.includes(t))) continue;
      if (route.groupSlugs.length && !route.groupSlugs.includes(group.slug)) continue;
    } else if (route.groupSlugs.length) continue;
    const plan = planTranslation(inbound, p.formats);
    if (!plan) continue;
    out.push({ route, plan });
  }
  return out;
}

/** Order routes: priority desc, native before translated, provider priority desc, weighted shuffle within ties. */
export function orderRoutes(routes: RoutePlan[], rand: () => number = Math.random): RoutePlan[] {
  const tier = (r: RoutePlan) => `${r.route.priority}|${r.plan.mode === "native" ? 0 : 1}|${r.route.provider.priority}`;
  const groups = new Map<string, RoutePlan[]>();
  for (const r of routes) {
    const k = tier(r);
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }
  const sorted = [...groups.entries()].sort((a, b) => {
    const [ap, an, apr] = a[0].split("|").map(Number);
    const [bp, bn, bpr] = b[0].split("|").map(Number);
    return bp - ap || an - bn || bpr - apr;
  });
  return sorted.flatMap(([, arr]) => weightedShuffle(arr, (x) => x.route.weight, rand));
}

/** Usable keys of a provider in attempt order. */
export function orderKeys(keys: readonly KeyRec[], now: number = Date.now(), rand: () => number = Math.random): KeyRec[] {
  const usable = keys.filter((k) => isKeyUsable(k, now));
  const byPriority = new Map<number, KeyRec[]>();
  for (const k of usable) {
    const arr = byPriority.get(k.priority);
    if (arr) arr.push(k);
    else byPriority.set(k.priority, [k]);
  }
  return [...byPriority.entries()].sort((a, b) => b[0] - a[0]).flatMap(([, arr]) => weightedShuffle(arr, (k) => k.weight, rand));
}

/**
 * Flatten routes x keys into the ordered attempt list. `failures` (keyId -> count of failed attempts in this
 * request) pushes already-failed keys behind untried ones while preserving priority order inside each class.
 * `pinKeyId` restricts to one upstream key (Responses-API stickiness).
 */
export function buildCandidates(
  snap: ConfigSnapshot,
  routes: RoutePlan[],
  opts: { now?: number; rand?: () => number; failures?: ReadonlyMap<string, number>; pinKeyId?: string | null } = {},
): Candidate[] {
  const now = opts.now ?? Date.now();
  const out: Candidate[] = [];
  for (const rp of routes) {
    const keys = snap.keysByProvider.get(rp.route.providerId) ?? [];
    const pool = opts.pinKeyId ? keys.filter((k) => k.id === opts.pinKeyId) : keys;
    for (const key of orderKeys(pool, now, opts.rand)) out.push({ ...rp, key });
  }
  const f = opts.failures;
  if (!f || f.size === 0) return out;
  const fresh = out.filter((c) => !f.get(c.key.id));
  const retried = out.filter((c) => f.get(c.key.id));
  retried.sort((a, b) => (f.get(a.key.id) ?? 0) - (f.get(b.key.id) ?? 0));
  return [...fresh, ...retried];
}
