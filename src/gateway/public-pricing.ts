import { Decimal } from "@/lib/money";
import { getConfig, type GroupRec, type ModelRec } from "./cache";
import { effectiveGroup } from "./auth";
import type { AuthRecord } from "./cache";
import { modalities, plainNumber, priceMatrix } from "./price-view";
import { effectiveMultiplier, type PriceTable } from "./pricing";
import { poolPriceTable } from "./pool-prices";

/**
 * Price list (`GET /api/pricing`, public or with an API key): every ACTIVE model that can actually be served, with the
 * official price, the price a customer of the (default or requested public) group pays and the saving, per billable
 * unit. Never contains costs, provider names or upstream model ids.
 */
export interface PublicPricing {
  object: "pricing";
  currency: "USD";
  updated_at: string;
  group: { slug: string; name: string; multiplier: number };
  groups: Array<{ slug: string; name: string; multiplier: number }>;
  units: Record<string, string>;
  data: Array<Record<string, unknown>>;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; body: PublicPricing }>();

const groupView = (g: GroupRec) => ({ slug: g.slug, name: g.name, multiplier: plainNumber(g.priceMultiplier) ?? 1 });

function modelView(m: ModelRec, sell: PriceTable): Record<string, unknown> {
  const matrix = priceMatrix(sell, m.official, new Decimal(1));
  return {
    id: m.slug,
    name: m.displayName,
    vendor: m.vendor,
    description: m.description,
    capabilities: [...m.capabilities].sort(),
    ...modalities(m.capabilities),
    context_length: m.contextWindow,
    max_output_tokens: m.maxOutput,
    retires_at: m.retiresAt ? new Date(m.retiresAt).toISOString() : null,
    pricing: {
      unit: matrix.unit,
      yours: matrix.yours,
      official: matrix.official,
      savings_pct: matrix.savings_pct,
      // server tools, USD per unit (search / container hour / call)
      ...(Object.keys(matrix.tools).length ? { tools: matrix.tools } : {}),
    },
  };
}

/**
 * Returns the document, or null when `groupSlug` is not a public group. With `viewer` (an authenticated API key) and
 * no `groupSlug`, the prices and models are that key's own: its group, the customer multiplier and the key's model
 * allow-list (never cached across viewers).
 */
export async function getPublicPricing(groupSlug?: string | null, viewer?: AuthRecord | null): Promise<PublicPricing | null> {
  if (viewer && !groupSlug) {
    const snap = await getConfig();
    return buildPricing(snap, effectiveGroup(snap, viewer), viewer);
  }
  const key = groupSlug || "";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;

  const snap = await getConfig();
  const group = groupSlug ? (snap.groupsBySlug.get(groupSlug) ?? null) : snap.defaultGroup;
  if (groupSlug && (!group || !group.isPublic)) return null;
  const body = buildPricing(snap, group, null);
  cache.set(key, { at: Date.now(), body });
  if (cache.size > 50) cache.clear();
  return body;
}

function buildPricing(snap: Awaited<ReturnType<typeof getConfig>>, group: GroupRec | null, viewer: AuthRecord | null): PublicPricing {
  const models: ModelRec[] = [];
  for (const m of snap.modelsById.values()) {
    if (m.status !== "ACTIVE") continue;
    if (group?.allowedModels && !group.allowedModels.has(m.slug)) continue;
    if (viewer?.key.allowedModels && !viewer.key.allowedModels.has(m.slug)) continue;
    const routable = (snap.routesByModel.get(m.id) ?? []).some((r) => r.provider.status === "ACTIVE");
    if (routable) models.push(m);
  }
  models.sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug));
  const mult = viewer ? effectiveMultiplier(viewer.user.priceMultiplier, group?.priceMultiplier) : (group?.priceMultiplier ?? new Decimal(1));
  return {
    object: "pricing",
    currency: "USD",
    updated_at: new Date().toISOString(),
    group: group ? { ...groupView(group), ...(viewer ? { multiplier: plainNumber(mult) ?? 1 } : {}) } : { slug: "", name: "Default", multiplier: plainNumber(mult) ?? 1 },
    groups: [...snap.groupsById.values()].filter((g) => g.isPublic).map(groupView),
    units: {
      usd_per_1m_tokens: "US dollars per one million tokens",
      usd_per_image: "US dollars per generated image",
      usd_per_request: "US dollars per request",
      usd_per_second: "US dollars per generated second",
      usd_per_minute: "US dollars per audio minute",
      usd_per_1m_characters: "US dollars per one million input characters",
    },
    data: models.map((m) => modelView(m, poolPriceTable(snap, m, group, mult))),
  };
}

export function __resetPublicPricingForTests(): void {
  cache.clear();
}
