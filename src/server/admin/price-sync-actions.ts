"use server";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { applyPriceSyncRun, getPriceSyncConfig, runPriceSync } from "@/server/pricing/price-sync/engine";
import { ActionFail, adminAction, parseInput } from "./action";
import { getPriceSyncPanel, type PriceSyncPanel } from "./price-sync-queries";

const configSchema = z.object({
  providerId: z.string().min(1),
  sources: z.string().max(4000),
  basis: z.enum(["official", "pool"]),
  poolName: z.string().trim().max(120).optional().nullable(),
  auto: z.boolean(),
  intervalHours: z.coerce.number().int().min(1, "At least 1 hour").max(720),
  maxAutoChangePct: z.coerce.number().int().min(1).max(1000),
});

function parseUrls(text: string): Array<{ url: string }> {
  const out: Array<{ url: string }> = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(line);
    } catch {
      throw new ActionFail(`Not a URL: ${line}`, { sources: `Not a URL: ${line}` });
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new ActionFail(`Only http(s) pages: ${line}`, { sources: "Only http(s) pages" });
    if (!out.some((o) => o.url === u.toString())) out.push({ url: u.toString() });
  }
  if (out.length > 10) throw new ActionFail("At most 10 pages", { sources: "At most 10 pages" });
  return out;
}

export async function savePriceSyncConfigAction(input: unknown) {
  return adminAction<PriceSyncPanel>({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(configSchema, input);
    const sources = parseUrls(d.sources);
    if (d.basis === "pool" && !d.poolName) throw new ActionFail("Name the pool as the page writes it", { poolName: "Required for a pool" });
    if (d.auto && !sources.length) throw new ActionFail("Add a pricing page before turning on automatic updates", { sources: "Required" });
    if (!(await db.provider.findUnique({ where: { id: d.providerId }, select: { id: true } }))) throw new ActionFail("Provider not found");
    const data = { sources, basis: d.basis, poolName: d.basis === "pool" ? d.poolName : null, auto: d.auto, intervalHours: d.intervalHours, maxAutoChangePct: d.maxAutoChangePct };
    await db.priceSync.upsert({ where: { providerId: d.providerId }, create: { providerId: d.providerId, ...data }, update: data });
    await audit(admin.id, "pricing.price_sync_config", { type: "Provider", id: d.providerId }, data, ip);
    return { data: (await getPriceSyncPanel(d.providerId))!, message: "Price sync settings saved" };
  });
}

export async function setPriceSyncModelSourceAction(input: unknown) {
  return adminAction<PriceSyncPanel>({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(z.object({ providerId: z.string().min(1), routeId: z.string().min(1), source: z.string().max(2000) }), input);
    const cfg = await getPriceSyncConfig(d.providerId);
    if (!cfg) throw new ActionFail("Provider not found");
    const route = await db.modelRoute.findFirst({ where: { id: d.routeId, providerId: d.providerId }, select: { id: true } });
    if (!route) throw new ActionFail("Route not found");
    if (d.source && d.source !== "off" && !cfg.sources.some((s) => s.url === d.source)) throw new ActionFail("Pick one of the configured pages");
    const modelSources = { ...cfg.modelSources };
    if (!d.source) delete modelSources[d.routeId];
    else modelSources[d.routeId] = d.source;
    await db.priceSync.upsert({
      where: { providerId: d.providerId },
      create: { providerId: d.providerId, sources: cfg.sources, basis: cfg.basis, poolName: cfg.poolName, modelSources },
      update: { modelSources },
    });
    await audit(admin.id, "pricing.price_sync_model_source", { type: "ModelRoute", id: d.routeId }, { source: d.source || "all pages" }, ip);
    return { data: (await getPriceSyncPanel(d.providerId))!, message: d.source === "off" ? "Excluded from price sync" : "Saved" };
  });
}

export async function runPriceSyncAction(input: unknown) {
  return adminAction<PriceSyncPanel>({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(z.object({ providerId: z.string().min(1) }), input);
    const runId = await runPriceSync(d.providerId, { trigger: "manual", actorId: admin.id });
    const run = await db.priceSyncRun.findUnique({ where: { id: runId }, select: { status: true, error: true } });
    await audit(admin.id, "pricing.price_sync_run", { type: "Provider", id: d.providerId }, { runId, status: run?.status }, ip);
    const panel = (await getPriceSyncPanel(d.providerId))!;
    if (run?.status !== "ok") throw new ActionFail(`Price check failed: ${run?.error ?? "unknown error"}`);
    const changes = panel.run?.proposals.filter((p) => p.status === "update" || p.status === "review").length ?? 0;
    return { data: panel, message: changes ? `${changes} model(s) with a price change to review` : "Prices checked: everything matches the page" };
  });
}

export async function applyPriceSyncAction(input: unknown) {
  return adminAction<PriceSyncPanel>({ adminOnly: true }, async ({ admin }) => {
    const d = parseInput(z.object({ runId: z.string().min(1), routeIds: z.array(z.string().min(1)).min(1, "Select at least one model").max(500) }), input);
    const run = await db.priceSyncRun.findUnique({ where: { id: d.runId }, select: { providerId: true } });
    if (!run) throw new ActionFail("Run not found");
    let res: { applied: number };
    try {
      res = await applyPriceSyncRun(d.runId, d.routeIds, { actorId: admin.id });
    } catch (err) {
      throw new ActionFail(err instanceof Error ? err.message : String(err));
    }
    return { data: (await getPriceSyncPanel(run.providerId))!, message: res.applied ? `Updated ${res.applied} model(s)` : "Nothing to change" };
  });
}
