import "server-only";
import { db } from "@/lib/db";
import { getBreakdown, getTotals } from "@/server/analytics/queries";
import { dstr, dstr0 } from "./serialize";
import { bestRouteCost, marginPctOf } from "./models-calc";

export interface ModelRow {
  id: string;
  slug: string;
  displayName: string;
  vendor: string;
  capabilities: string[];
  status: string;
  inputPrice: string;
  outputPrice: string;
  cachedInputPrice: string | null;
  routesTotal: number;
  routesEnabled: number;
  bestCostIn: number | null;
  bestCostOut: number | null;
  marginIn: number | null;
  marginOut: number | null;
  requests24h: number;
  revenue24h: number;
}

export async function getModelRows(): Promise<ModelRow[]> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const [models, usage] = await Promise.all([
    db.model.findMany({
      orderBy: [{ sortOrder: "asc" }, { slug: "asc" }],
      include: { routes: { select: { enabled: true, inputCost: true, outputCost: true } } },
    }),
    getBreakdown("model", { from: since, to: new Date() }, { limit: 1000 }).catch(() => []),
  ]);
  const usageBySlug = new Map(usage.map((u) => [u.key, u]));
  return models.map((m) => {
    const best = bestRouteCost(m.routes.map((r) => ({ enabled: r.enabled, inputCost: dstr0(r.inputCost), outputCost: dstr0(r.outputCost) })));
    const u = usageBySlug.get(m.slug);
    return {
      id: m.id,
      slug: m.slug,
      displayName: m.displayName,
      vendor: m.vendor,
      capabilities: m.capabilities,
      status: m.status,
      inputPrice: dstr0(m.inputPrice),
      outputPrice: dstr0(m.outputPrice),
      cachedInputPrice: dstr(m.cachedInputPrice),
      routesTotal: m.routes.length,
      routesEnabled: m.routes.filter((r) => r.enabled).length,
      bestCostIn: best?.input ?? null,
      bestCostOut: best?.output ?? null,
      marginIn: best ? marginPctOf(dstr0(m.inputPrice), best.input) : null,
      marginOut: best ? marginPctOf(dstr0(m.outputPrice), best.output) : null,
      requests24h: u?.requests ?? 0,
      revenue24h: u?.revenue ?? 0,
    };
  });
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
    longContextThreshold: m.longContextThreshold?.toString() ?? "",
    longContextMultiplier: dstr(m.longContextMultiplier) ?? "",
    officialInputPrice: dstr(m.officialInputPrice) ?? "",
    officialOutputPrice: dstr(m.officialOutputPrice) ?? "",
    officialCachedPrice: dstr(m.officialCachedPrice) ?? "",
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
    db.group.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { slug: true, name: true } }),
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
  }));
  return { model: serializeModel(model), routes, providers, groups, totals };
}

export async function getVendorOptions(): Promise<string[]> {
  const rows = await db.model.findMany({ distinct: ["vendor"], select: { vendor: true }, orderBy: { vendor: "asc" } });
  return rows.map((r) => r.vendor);
}
