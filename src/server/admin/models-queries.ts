import "server-only";
import { db } from "@/lib/db";
import { getBreakdown, getTotals } from "@/server/analytics/queries";
import { dstr, dstr0, iso } from "./serialize";
import { primaryEnabledRoute, rowUnits, summarizeRow, toolPricesForForm, type RowUnit } from "./models-calc";

export interface ModelRow {
  id: string;
  slug: string;
  displayName: string;
  vendor: string;
  capabilities: string[];
  status: string;
  /** Units with Customer price / Official / Our cost (best route) for the row. */
  units: RowUnit[];
  marginPct: number | null;
  savingsPct: number | null;
  loss: boolean;
  pricingMode: string;
  pricingValue: string | null;
  pricingAdjust: string | null;
  retiresAt: string | null;
  routesTotal: number;
  routesEnabled: number;
  requests24h: number;
  revenue24h: number;
}

export async function getModelRows(): Promise<ModelRow[]> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const [models, usage] = await Promise.all([
    db.model.findMany({
      orderBy: [{ sortOrder: "asc" }, { slug: "asc" }],
      include: { routes: true },
    }),
    getBreakdown("model", { from: since, to: new Date() }, { limit: 1000 }).catch(() => []),
  ]);
  const usageBySlug = new Map(usage.map((u) => [u.key, u]));
  return models.map((m) => {
    const routeRecs = m.routes.map((r) => ({ ...flat(r), enabled: r.enabled, priority: r.priority, weight: r.weight }));
    const best = primaryEnabledRoute(routeRecs);
    const units = rowUnits(flat(m), best as Record<string, string | number | null> | null);
    const sum = summarizeRow(units);
    const u = usageBySlug.get(m.slug);
    return {
      id: m.id,
      slug: m.slug,
      displayName: m.displayName,
      vendor: m.vendor,
      capabilities: m.capabilities,
      status: m.status,
      units,
      marginPct: best ? sum.marginPct : null,
      savingsPct: sum.savingsPct,
      loss: best ? sum.loss : false,
      pricingMode: m.pricingMode,
      pricingValue: dstr(m.pricingValue),
      pricingAdjust: dstr(m.pricingAdjust),
      retiresAt: iso(m.retiresAt),
      routesTotal: m.routes.length,
      routesEnabled: m.routes.filter((r) => r.enabled).length,
      requests24h: u?.requests ?? 0,
      revenue24h: u?.revenue ?? 0,
    };
  });
}

/** Prisma row -> record of plain decimal strings (Decimal fields) for the pure calc helpers. */
function flat(row: object): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) out[k] = null;
    else if (typeof v === "number") out[k] = v;
    else if (typeof v === "object" && typeof (v as { toFixed?: unknown }).toFixed === "function") out[k] = (v as { toFixed(): string }).toFixed();
    else if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** All Model scalar/decimal fields as plain strings/numbers for the editor. */
export function serializeModel(m: NonNullable<Awaited<ReturnType<typeof db.model.findUnique>>>) {
  return {
    id: m.id,
    slug: m.slug,
    aliases: m.aliases,
    displayName: m.displayName,
    vendor: m.vendor,
    description: m.description ?? "",
    capabilities: m.capabilities,
    contextWindow: m.contextWindow?.toString() ?? "",
    maxOutput: m.maxOutput?.toString() ?? "",
    status: m.status as string,
    sortOrder: String(m.sortOrder),
    maskUpstreamModel: m.maskUpstreamModel,
    inputPrice: dstr0(m.inputPrice),
    outputPrice: dstr0(m.outputPrice),
    cachedInputPrice: dstr(m.cachedInputPrice) ?? "",
    cacheWritePrice: dstr(m.cacheWritePrice) ?? "",
    cacheWrite1hPrice: dstr(m.cacheWrite1hPrice) ?? "",
    imagePrice: dstr(m.imagePrice) ?? "",
    requestPrice: dstr(m.requestPrice) ?? "",
    audioInputPrice: dstr(m.audioInputPrice) ?? "",
    audioOutputPrice: dstr(m.audioOutputPrice) ?? "",
    perMinutePrice: dstr(m.perMinutePrice) ?? "",
    perMillionChars: dstr(m.perMillionChars) ?? "",
    perSecondPrice: dstr(m.perSecondPrice) ?? "",
    longContextThreshold: m.longContextThreshold?.toString() ?? "",
    longContextMultiplier: dstr(m.longContextMultiplier) ?? "",
    longContextOutputMultiplier: dstr(m.longContextOutputMultiplier) ?? "",
    officialInputPrice: dstr(m.officialInputPrice) ?? "",
    officialOutputPrice: dstr(m.officialOutputPrice) ?? "",
    officialCachedPrice: dstr(m.officialCachedPrice) ?? "",
    officialCacheWritePrice: dstr(m.officialCacheWritePrice) ?? "",
    officialImagePrice: dstr(m.officialImagePrice) ?? "",
    officialRequestPrice: dstr(m.officialRequestPrice) ?? "",
    officialAudioInputPrice: dstr(m.officialAudioInputPrice) ?? "",
    officialAudioOutputPrice: dstr(m.officialAudioOutputPrice) ?? "",
    officialPerMinutePrice: dstr(m.officialPerMinutePrice) ?? "",
    officialPerMillionChars: dstr(m.officialPerMillionChars) ?? "",
    officialPerSecondPrice: dstr(m.officialPerSecondPrice) ?? "",
    /** server tools: { key: USD per unit } */
    toolPrices: toolPricesForForm(m.toolPrices),
    officialToolPrices: toolPricesForForm(m.officialToolPrices),
    batchDiscountPct: dstr(m.batchDiscountPct) ?? "",
    pricingMode: m.pricingMode as string,
    pricingValue: dstr(m.pricingValue) ?? "",
    pricingAdjust: dstr(m.pricingAdjust) ?? "",
    retiresAt: m.retiresAt ? m.retiresAt.toISOString().slice(0, 10) : "",
  };
}
export type ModelForm = ReturnType<typeof serializeModel>;

export interface RouteRow {
  id: string;
  providerId: string;
  providerName: string;
  providerStatus: string;
  providerHealth: string;
  upstreamModel: string;
  label: string;
  enabled: boolean;
  priority: number;
  weight: number;
  groupSlugs: string[];
  paramOverrides: string; // JSON text
  maxOutputTokens: string;
  inputCost: string;
  outputCost: string;
  cachedInputCost: string;
  cacheWriteCost: string;
  cacheWrite1hCost: string;
  imageCost: string;
  requestCost: string;
  audioInputCost: string;
  audioOutputCost: string;
  perMinuteCost: string;
  perMillionCharsCost: string;
  perSecondCost: string;
  /** server tools: { key: USD per unit } */
  toolCosts: Record<string, string>;
  batchCostDiscountPct: string;
  autoCostSync: boolean;
  autoCostSourceModel: string;
  autoCostSyncedAt: string | null;
  autoCostStatus: string | null;
}

export async function getModelDetail(id: string) {
  const model = await db.model.findUnique({
    where: { id },
    include: { routes: { include: { provider: { select: { id: true, name: true, status: true, healthStatus: true } } }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] } },
  });
  if (!model) return null;
  const now = new Date();
  const [providers, groups, totals] = await Promise.all([
    db.provider.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, slug: true, status: true } }),
    db.group.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { slug: true, name: true, priceMultiplier: true, priceBasis: true, allowedModels: true } }).then((gs) =>
      gs.map((g) => ({ slug: g.slug, name: g.name, multiplier: Number(g.priceMultiplier.toString()), basis: g.priceBasis === "cost" ? ("cost" as const) : ("model" as const), allowed: g.allowedModels.length === 0 || g.allowedModels.includes(model.slug) })),
    ),
    getTotals({ from: new Date(now.getTime() - 24 * 3600_000), to: now, modelSlug: model.slug }).catch(() => null),
  ]);
  const routes: RouteRow[] = model.routes.map((r) => ({
    id: r.id,
    providerId: r.providerId,
    providerName: r.provider.name,
    providerStatus: r.provider.status,
    providerHealth: r.provider.healthStatus,
    upstreamModel: r.upstreamModel,
    label: r.label ?? "",
    enabled: r.enabled,
    priority: r.priority,
    weight: r.weight,
    groupSlugs: r.groupSlugs,
    paramOverrides: JSON.stringify(r.paramOverrides ?? {}, null, 2),
    maxOutputTokens: r.maxOutputTokens?.toString() ?? "",
    inputCost: dstr0(r.inputCost),
    outputCost: dstr0(r.outputCost),
    cachedInputCost: dstr(r.cachedInputCost) ?? "",
    cacheWriteCost: dstr(r.cacheWriteCost) ?? "",
    cacheWrite1hCost: dstr(r.cacheWrite1hCost) ?? "",
    imageCost: dstr(r.imageCost) ?? "",
    requestCost: dstr(r.requestCost) ?? "",
    audioInputCost: dstr(r.audioInputCost) ?? "",
    audioOutputCost: dstr(r.audioOutputCost) ?? "",
    perMinuteCost: dstr(r.perMinuteCost) ?? "",
    perMillionCharsCost: dstr(r.perMillionCharsCost) ?? "",
    perSecondCost: dstr(r.perSecondCost) ?? "",
    toolCosts: toolPricesForForm(r.toolCosts),
    batchCostDiscountPct: dstr0(r.batchCostDiscountPct),
    autoCostSync: r.autoCostSync,
    autoCostSourceModel: r.autoCostSourceModel ?? "",
    autoCostSyncedAt: r.autoCostSyncedAt ? r.autoCostSyncedAt.toISOString() : null,
    autoCostStatus: r.autoCostStatus,
  }));
  return { model: serializeModel(model), routes, providers, groups, totals };
}

export interface WizardProvider {
  id: string;
  name: string;
  slug: string;
  preset: string;
  status: string;
  healthStatus: string;
  lastLatencyMs: number | null;
  keysActive: number;
  keysTotal: number;
}

/** Providers for the guided Add model / Add route flow (with key counts + health). */
export async function getWizardProviders(): Promise<WizardProvider[]> {
  const [providers, keys] = await Promise.all([
    db.provider.findMany({
      orderBy: [{ status: "asc" }, { priority: "desc" }, { name: "asc" }],
      select: { id: true, name: true, slug: true, preset: true, status: true, healthStatus: true, lastLatencyMs: true },
    }),
    db.providerKey.groupBy({ by: ["providerId", "status"], _count: { _all: true } }),
  ]);
  const total = new Map<string, number>();
  const active = new Map<string, number>();
  for (const g of keys) {
    total.set(g.providerId, (total.get(g.providerId) ?? 0) + g._count._all);
    if (g.status === "ACTIVE") active.set(g.providerId, g._count._all);
  }
  return providers.map((p) => ({ ...p, keysActive: active.get(p.id) ?? 0, keysTotal: total.get(p.id) ?? 0 }));
}

/** Every slug and alias already in use (the wizard suggests a free public name). */
export async function getTakenModelNames(): Promise<string[]> {
  const rows = await db.model.findMany({ select: { slug: true, aliases: true } });
  return rows.flatMap((r) => [r.slug, ...r.aliases]);
}

export async function getVendorOptions(): Promise<string[]> {
  const rows = await db.model.findMany({ distinct: ["vendor"], select: { vendor: true }, orderBy: { vendor: "asc" } });
  return rows.map((r) => r.vendor);
}
