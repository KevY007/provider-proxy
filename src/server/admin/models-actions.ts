"use server";

import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { lookupKnownPrice, type KnownPrice } from "@/gateway/price-catalog";
import { listUpstreamModels, type UpstreamModel } from "@/gateway/upstream-models";
import { applyPricingRule } from "@/server/pricing/rules";
import { afterPricingChange } from "./pricing-hooks";
import { ActionFail, adminAction, parseInput, zodFieldErrors } from "./action";
import {
  modelFieldsSchema,
  PRICING_MODES,
  modelToExport,
  parseModelImport,
  toolPricesForForm,
  routeFormSchema,
  type ModelFields,
  type RouteFields,
} from "./models-calc";
import { dstr } from "./serialize";

/** A parsed tool-price map as a Json column value (undefined = leave the column alone). */
const toolJson = (v: Record<string, string> | undefined) => (v === undefined ? undefined : (v as Prisma.InputJsonValue));

function modelData(f: ModelFields) {
  return {
    slug: f.slug,
    aliases: f.aliases,
    displayName: f.displayName,
    vendor: f.vendor,
    description: f.description,
    capabilities: f.capabilities,
    contextWindow: f.contextWindow,
    maxOutput: f.maxOutput,
    status: f.status,
    sortOrder: f.sortOrder,
    maskUpstreamModel: f.maskUpstreamModel,
    inputPrice: f.inputPrice,
    outputPrice: f.outputPrice,
    cachedInputPrice: f.cachedInputPrice,
    cacheWritePrice: f.cacheWritePrice,
    cacheWrite1hPrice: f.cacheWrite1hPrice,
    imagePrice: f.imagePrice,
    requestPrice: f.requestPrice,
    audioInputPrice: f.audioInputPrice,
    audioOutputPrice: f.audioOutputPrice,
    perMinutePrice: f.perMinutePrice,
    perMillionChars: f.perMillionChars,
    perSecondPrice: f.perSecondPrice,
    longContextThreshold: f.longContextThreshold,
    longContextMultiplier: f.longContextMultiplier,
    officialInputPrice: f.officialInputPrice,
    officialOutputPrice: f.officialOutputPrice,
    officialCachedPrice: f.officialCachedPrice,
    officialCacheWritePrice: f.officialCacheWritePrice,
    officialImagePrice: f.officialImagePrice,
    officialRequestPrice: f.officialRequestPrice,
    officialAudioInputPrice: f.officialAudioInputPrice,
    officialAudioOutputPrice: f.officialAudioOutputPrice,
    officialPerMinutePrice: f.officialPerMinutePrice,
    officialPerMillionChars: f.officialPerMillionChars,
    officialPerSecondPrice: f.officialPerSecondPrice,
    toolPrices: toolJson(f.toolPrices),
    officialToolPrices: toolJson(f.officialToolPrices),
    batchDiscountPct: f.batchDiscountPct,
    pricingMode: f.pricingMode,
    pricingValue: f.pricingValue,
    ...(f.pricingAdjust !== undefined ? { pricingAdjust: f.pricingMode === "FIXED" ? null : f.pricingAdjust } : {}),
    retiresAt: f.retiresAt,
  };
}

function routeData(f: RouteFields) {
  return {
    upstreamModel: f.upstreamModel,
    label: f.label,
    enabled: f.enabled,
    priority: f.priority,
    weight: f.weight,
    groupSlugs: f.groupSlugs,
    paramOverrides: f.paramOverrides as Prisma.InputJsonValue,
    maxOutputTokens: f.maxOutputTokens,
    inputCost: f.inputCost,
    outputCost: f.outputCost,
    cachedInputCost: f.cachedInputCost,
    cacheWriteCost: f.cacheWriteCost,
    cacheWrite1hCost: f.cacheWrite1hCost,
    imageCost: f.imageCost,
    requestCost: f.requestCost,
    audioInputCost: f.audioInputCost,
    audioOutputCost: f.audioOutputCost,
    perMinuteCost: f.perMinuteCost,
    perMillionCharsCost: f.perMillionCharsCost,
    perSecondCost: f.perSecondCost,
    toolCosts: toolJson(f.toolCosts),
    batchCostDiscountPct: f.batchCostDiscountPct,
    ...(f.autoCostSync !== undefined ? { autoCostSync: f.autoCostSync } : {}),
    ...(f.autoCostSourceModel !== undefined ? { autoCostSourceModel: f.autoCostSourceModel } : {}),
  };
}

/** Comparable text of a model column for the audit "changed" list (Json tool maps by value, not "[object Object]"). */
function auditText(v: unknown): string {
  if (v !== null && typeof v === "object" && typeof (v as { toFixed?: unknown }).toFixed !== "function" && !(v instanceof Date)) {
    return JSON.stringify(Object.entries(toolPricesForForm(v)).sort(([a], [b]) => a.localeCompare(b)));
  }
  return String(v ?? "");
}

async function assertNamesFree(slug: string, aliases: string[], excludeId?: string) {
  const names = [slug, ...aliases];
  const clash = await db.model.findFirst({
    where: { ...(excludeId ? { id: { not: excludeId } } : {}), OR: [{ slug: { in: names } }, { aliases: { hasSome: names } }] },
    select: { slug: true, aliases: true },
  });
  if (clash) {
    const hit = names.find((n) => n === clash.slug || clash.aliases.includes(n)) ?? slug;
    throw new ActionFail(`"${hit}" is already used by model "${clash.slug}"`, { [hit === slug ? "slug" : "aliases"]: "Already in use" });
  }
}

function routeConflict(err: unknown): never {
  if ((err as { code?: string } | null)?.code === "P2002") {
    throw new ActionFail("This model already has a route for that provider with the same upstream model. Change the upstream model or edit the existing route.", {
      upstreamModel: "Duplicate of an existing route on this provider",
    });
  }
  throw err;
}

// ---------------------------------------------------------------------------
// models

export async function createModel(input: unknown) {
  return adminAction<{ id: string }>({ adminOnly: true }, async ({ admin, ip }) => {
    const f = parseInput(modelFieldsSchema, input);
    await assertNamesFree(f.slug, f.aliases);
    const m = await db.model.create({ data: modelData(f), select: { id: true } });
    await audit(admin.id, "model.create", { type: "Model", id: m.id }, { slug: f.slug }, ip);
    await afterPricingChange(m.id);
    await invalidateGatewayConfig("models", m.id);
    return { data: { id: m.id }, message: `Model ${f.slug} created` };
  });
}

export async function updateModel(id: string, input: unknown) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const f = parseInput(modelFieldsSchema, input);
    const before = await db.model.findUnique({ where: { id } });
    if (!before) throw new ActionFail("Model not found");
    await assertNamesFree(f.slug, f.aliases, id);
    await db.$transaction(async (tx) => {
      await tx.model.update({ where: { id }, data: modelData(f) });
      if (before.slug !== f.slug) {
        // keep pool/key allow-lists pointing at the renamed model
        await tx.$executeRaw`UPDATE "Group" SET "allowedModels" = array_replace("allowedModels", ${before.slug}, ${f.slug}) WHERE ${before.slug} = ANY("allowedModels")`;
        await tx.$executeRaw`UPDATE "ApiKey" SET "allowedModels" = array_replace("allowedModels", ${before.slug}, ${f.slug}) WHERE ${before.slug} = ANY("allowedModels")`;
      }
    });
    const next = modelData(f) as Record<string, unknown>;
    const changed = Object.keys(next).filter((k) => next[k] !== undefined && auditText((before as Record<string, unknown>)[k]) !== auditText(next[k]));
    await audit(admin.id, "model.update", { type: "Model", id }, { slug: f.slug, changed, prevSlug: before.slug }, ip);
    await afterPricingChange(id);
    await invalidateGatewayConfig("models", id);
    return { message: "Model saved" };
  });
}

export async function deleteModel(id: string) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const m = await db.model.findUnique({ where: { id }, select: { slug: true, _count: { select: { routes: true } } } });
    if (!m) throw new ActionFail("Model not found");
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "Group" SET "allowedModels" = array_remove("allowedModels", ${m.slug}) WHERE ${m.slug} = ANY("allowedModels")`;
      await tx.$executeRaw`UPDATE "ApiKey" SET "allowedModels" = array_remove("allowedModels", ${m.slug}) WHERE ${m.slug} = ANY("allowedModels")`;
      await tx.model.delete({ where: { id } });
    });
    await audit(admin.id, "model.delete", { type: "Model", id }, { slug: m.slug, routes: m._count.routes }, ip);
    await invalidateGatewayConfig("models", id);
    return { message: `Model ${m.slug} deleted` };
  });
}

export async function duplicateModel(id: string, newSlug: string) {
  return adminAction<{ id: string }>({ adminOnly: true }, async ({ admin, ip }) => {
    const slug = parseInput(modelFieldsSchema.shape.slug, newSlug);
    const src = await db.model.findUnique({ where: { id }, include: { routes: true } });
    if (!src) throw new ActionFail("Model not found");
    await assertNamesFree(slug, []);
    const created = await db.model.create({
      data: {
        ...modelData(parseInput(modelFieldsSchema, serializeForClone(src))),
        slug,
        aliases: [],
        displayName: `${src.displayName} (copy)`,
        status: "HIDDEN",
        routes: {
          create: src.routes.map((r) => ({
            providerId: r.providerId,
            upstreamModel: r.upstreamModel,
            label: r.label,
            enabled: r.enabled,
            priority: r.priority,
            weight: r.weight,
            groupSlugs: r.groupSlugs,
            paramOverrides: (r.paramOverrides ?? {}) as Prisma.InputJsonValue,
            maxOutputTokens: r.maxOutputTokens,
            inputCost: r.inputCost,
            outputCost: r.outputCost,
            cachedInputCost: r.cachedInputCost,
            cacheWriteCost: r.cacheWriteCost,
            cacheWrite1hCost: r.cacheWrite1hCost,
            imageCost: r.imageCost,
            requestCost: r.requestCost,
            audioInputCost: r.audioInputCost,
            audioOutputCost: r.audioOutputCost,
            perMinuteCost: r.perMinuteCost,
            perMillionCharsCost: r.perMillionCharsCost,
            perSecondCost: r.perSecondCost,
            toolCosts: (r.toolCosts ?? {}) as Prisma.InputJsonValue,
            batchCostDiscountPct: r.batchCostDiscountPct,
          })),
        },
      },
      select: { id: true },
    });
    await audit(admin.id, "model.duplicate", { type: "Model", id: created.id }, { from: src.slug, slug, routes: src.routes.length }, ip);
    await afterPricingChange(created.id);
    await invalidateGatewayConfig("models", created.id);
    return { data: { id: created.id }, message: `Duplicated as ${slug} (hidden)` };
  });
}

/** Turn a DB model row into input accepted by modelFieldsSchema (decimals as strings). */
function serializeForClone(m: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === "routes" || k === "id" || k === "createdAt" || k === "updatedAt") continue;
    const isDecimal = v !== null && typeof v === "object" && typeof (v as { toFixed?: unknown }).toFixed === "function";
    out[k] = isDecimal ? dstr(v as never) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// routes

export async function createRoute(modelId: string, input: unknown) {
  return adminAction<{ id: string }>({ adminOnly: true }, async ({ admin, ip }) => {
    const f = parseInput(routeFormSchema, input);
    const model = await db.model.findUnique({ where: { id: modelId }, select: { slug: true } });
    if (!model) throw new ActionFail("Model not found");
    const provider = await db.provider.findUnique({ where: { id: f.providerId }, select: { id: true } });
    if (!provider) throw new ActionFail("Provider not found", { providerId: "Choose a provider" });
    const { providerId, ...rest } = f;
    const r = await db.modelRoute.create({ data: { modelId, providerId, ...routeData(rest) }, select: { id: true } }).catch(routeConflict);
    await audit(admin.id, "route.create", { type: "ModelRoute", id: r.id }, { model: model.slug, providerId, upstreamModel: f.upstreamModel }, ip);
    await afterPricingChange(modelId);
    await invalidateGatewayConfig("models", modelId);
    if (rest.autoCostSync) await firstAutoSync(r.id, admin.id);
    return { data: { id: r.id }, message: "Route added" };
  });
}

export async function updateRoute(routeId: string, input: unknown) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const f = parseInput(routeFormSchema, input);
    const existing = await db.modelRoute.findUnique({ where: { id: routeId }, select: { modelId: true } });
    if (!existing) throw new ActionFail("Route not found");
    const { providerId, ...rest } = f;
    await db.modelRoute.update({ where: { id: routeId }, data: { providerId, ...routeData(rest) } }).catch(routeConflict);
    await audit(admin.id, "route.update", { type: "ModelRoute", id: routeId }, { modelId: existing.modelId, providerId, upstreamModel: f.upstreamModel }, ip);
    await afterPricingChange(existing.modelId);
    await invalidateGatewayConfig("models", existing.modelId);
    if (rest.autoCostSync) await firstAutoSync(routeId, admin.id);
    return { message: "Route saved" };
  });
}

export async function toggleRoute(routeId: string, enabled: boolean) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const r = await db.modelRoute.update({ where: { id: routeId }, data: { enabled: z.boolean().parse(enabled) }, select: { modelId: true } });
    await audit(admin.id, enabled ? "route.enable" : "route.disable", { type: "ModelRoute", id: routeId }, {}, ip);
    await afterPricingChange(r.modelId);
    await invalidateGatewayConfig("models", r.modelId);
    return { message: enabled ? "Route enabled" : "Route disabled" };
  });
}

export async function deleteRoute(routeId: string) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const r = await db.modelRoute.delete({ where: { id: routeId }, select: { modelId: true, upstreamModel: true, providerId: true } });
    await audit(admin.id, "route.delete", { type: "ModelRoute", id: routeId }, { upstreamModel: r.upstreamModel, providerId: r.providerId }, ip);
    await afterPricingChange(r.modelId);
    await invalidateGatewayConfig("models", r.modelId);
    return { message: "Route deleted" };
  });
}

export async function duplicateRoute(routeId: string) {
  return adminAction<{ id: string }>({ adminOnly: true }, async ({ admin, ip }) => {
    const src = await db.modelRoute.findUnique({ where: { id: routeId } });
    if (!src) throw new ActionFail("Route not found");
    const taken = new Set((await db.modelRoute.findMany({ where: { modelId: src.modelId, providerId: src.providerId }, select: { upstreamModel: true } })).map((r) => r.upstreamModel));
    let name = `${src.upstreamModel}-copy`;
    for (let i = 2; taken.has(name); i++) name = `${src.upstreamModel}-copy${i}`;
    const { id: _id, createdAt: _c, ...rest } = src;
    void _id;
    void _c;
    const created = await db.modelRoute.create({
      data: { ...rest, upstreamModel: name, enabled: false, paramOverrides: (rest.paramOverrides ?? {}) as Prisma.InputJsonValue, toolCosts: (rest.toolCosts ?? {}) as Prisma.InputJsonValue },
      select: { id: true },
    });
    await audit(admin.id, "route.duplicate", { type: "ModelRoute", id: created.id }, { from: routeId, upstreamModel: name }, ip);
    await afterPricingChange(src.modelId);
    await invalidateGatewayConfig("models", src.modelId);
    return { data: { id: created.id }, message: `Route duplicated as ${name} (disabled)` };
  });
}

// ---------------------------------------------------------------------------
// bulk import / export

export interface ImportItemResult {
  slug: string;
  ok: boolean;
  action?: "create" | "update";
  routes?: number;
  error?: string;
}

export async function importModels(text: string, dryRun: boolean) {
  return adminAction<{ results: ImportItemResult[]; dryRun: boolean }>({ adminOnly: true }, async ({ admin, ip }) => {
    if (typeof text !== "string" || text.length > 5_000_000) throw new ActionFail("Import is too large");
    const parsed = parseModelImport(text);
    if (parsed.fatal !== undefined) throw new ActionFail(parsed.fatal);
    const providers = new Map((await db.provider.findMany({ select: { id: true, slug: true } })).map((p) => [p.slug, p.id]));
    const results: ImportItemResult[] = [];
    for (const item of parsed.items) {
      if (!item.ok) {
        results.push({ slug: item.slug, ok: false, error: item.error });
        continue;
      }
      const { routes = [], ...fields } = item.data;
      const missing = routes.find((r) => !providers.has(r.provider));
      if (missing) {
        results.push({ slug: fields.slug, ok: false, error: `Unknown provider slug "${missing.provider}"` });
        continue;
      }
      try {
        const existing = await db.model.findUnique({ where: { slug: fields.slug }, select: { id: true } });
        const clash = await db.model.findFirst({
          where: { ...(existing ? { id: { not: existing.id } } : {}), OR: [{ slug: { in: fields.aliases } }, { aliases: { hasSome: [fields.slug, ...fields.aliases] } }] },
          select: { slug: true },
        });
        if (clash) throw new Error(`Slug/alias collides with model "${clash.slug}"`);
        if (!dryRun) {
          await db.$transaction(async (tx) => {
            const m = existing
              ? await tx.model.update({ where: { id: existing.id }, data: modelData(fields), select: { id: true } })
              : await tx.model.create({ data: modelData(fields), select: { id: true } });
            for (const r of routes) {
              const { provider, ...rf } = r;
              const providerId = providers.get(provider)!;
              await tx.modelRoute.upsert({
                where: { modelId_providerId_upstreamModel: { modelId: m.id, providerId, upstreamModel: rf.upstreamModel } },
                create: { modelId: m.id, providerId, ...routeData(rf) },
                update: routeData(rf),
              });
            }
          });
        }
        results.push({ slug: fields.slug, ok: true, action: existing ? "update" : "create", routes: routes.length });
      } catch (err) {
        results.push({ slug: fields.slug, ok: false, error: err instanceof Error ? err.message : "Failed" });
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    if (!dryRun && okCount > 0) {
      const slugs = results.filter((r) => r.ok).map((r) => r.slug);
      const ids = await db.model.findMany({ where: { slug: { in: slugs } }, select: { id: true } });
      for (const m of ids) await afterPricingChange(m.id);
      await audit(admin.id, "model.import", null, { ok: okCount, failed: results.length - okCount }, ip);
      await invalidateGatewayConfig("models");
    }
    return {
      data: { results, dryRun },
      message: dryRun ? `Dry run: ${okCount} of ${results.length} valid` : `Imported ${okCount} of ${results.length} models`,
    };
  });
}

export async function exportModels() {
  return adminAction<{ json: string; count: number }>({ adminOnly: true }, async ({ admin, ip }) => {
    const models = await db.model.findMany({ orderBy: [{ sortOrder: "asc" }, { slug: "asc" }], include: { routes: { include: { provider: { select: { slug: true } } }, orderBy: { priority: "desc" } } } });
    const out = models.map((m) => {
      const { routes, ...rest } = m;
      return modelToExport(
        serializeForClone(rest),
        routes.map(({ provider, ...r }) => ({ ...serializeForClone(r), providerSlug: provider.slug })),
      );
    });
    await audit(admin.id, "model.export", null, { count: out.length }, ip);
    return { data: { json: JSON.stringify(out, null, 2), count: out.length } };
  });
}

// ---------------------------------------------------------------------------
// guided "Add model" flow (provider -> real model -> names & prices -> pricing rule)

export interface ProviderModelsResult {
  models: UpstreamModel[];
  /** Set when the provider could not be listed (we still let the admin type a model id). */
  error?: string;
}

/** Step 2: the real models a provider offers (live /models list + known prices + "already added"). */
export async function listProviderModels(providerId: string) {
  return adminAction<ProviderModelsResult>({ adminOnly: true }, async () => {
    const id = parseInput(z.string().min(1, "Choose a provider"), providerId);
    try {
      const models = await listUpstreamModels(id);
      return { data: { models } };
    } catch (err) {
      return { data: { models: [], error: err instanceof Error ? err.message : "Could not list this provider's models" } };
    }
  });
}

const VENDOR_BY_PREFIX: Array<[RegExp, string]> = [
  [/^(gpt|o\d|chatgpt|text-embedding|dall-e|whisper|tts|sora|codex)/i, "openai"],
  [/^claude/i, "anthropic"],
  [/^(gemini|imagen|veo|gemma)/i, "google"],
  [/^grok/i, "xai"],
];

export interface KnownLookup {
  known: KnownPrice | null;
  /** The provider is the model maker itself (OpenAI key for an OpenAI model): our cost = official price. */
  direct: boolean;
  vendor: string | null;
}

/** For a custom / typed model id: find the built-in known price and whether this provider is the maker itself. */
export async function lookupKnownForProvider(providerId: string, upstreamModel: string) {
  return adminAction<KnownLookup>({ adminOnly: true }, async () => {
    const provider = await db.provider.findUnique({ where: { id: providerId }, select: { preset: true, slug: true } });
    if (!provider) throw new ActionFail("Provider not found");
    const id = upstreamModel.trim();
    let known = id ? lookupKnownPrice(provider.preset, id) : null;
    let vendor: string | null = known?.vendor ?? null;
    if (!known && id) {
      vendor = VENDOR_BY_PREFIX.find(([re]) => re.test(id))?.[1] ?? null;
      known = vendor ? lookupKnownPrice(vendor, id) : null;
    }
    return { data: { known, vendor, direct: !!known && (known.vendor === provider.preset || known.vendor === provider.slug) } };
  });
}

export async function bulkApplyPricingRule(modelIds: string[], rule: { mode: string; value: unknown }) {
  return adminAction<{ updated: number }>({ adminOnly: true }, async ({ admin, ip }) => {
    const ids = parseInput(z.array(z.string().min(1)).min(1, "Select at least one model").max(500), modelIds);
    const mode = parseInput(z.enum(PRICING_MODES, { error: "Choose how prices are set" }), rule.mode);
    let value: number | null = null;
    if (mode !== "FIXED") {
      value = Number(rule.value);
      if (!Number.isFinite(value) || value <= 0) {
        throw new ActionFail(mode === "PERCENT_OF_OFFICIAL" ? "Enter a percent of the official price, e.g. 70" : "Enter a markup percent, e.g. 30", { value: "Enter a number above 0" });
      }
    }
    const res = await applyPricingRule(ids, { mode, value });
    await audit(admin.id, "model.bulk_pricing_rule", null, { mode, value, models: ids.length, updated: res.updated }, ip);
    await invalidateGatewayConfig("models");
    return { data: { updated: res.updated }, message: `Pricing rule applied to ${res.updated} model${res.updated === 1 ? "" : "s"}` };
  });
}

/** Step 4: create the Model and its first ModelRoute in one go, then derive prices from the rule. */
export async function createModelWithRoute(input: unknown) {
  return adminAction<{ id: string }>({ adminOnly: true }, async ({ admin, ip }) => {
    const raw = (input ?? {}) as { providerId?: unknown; upstreamModel?: unknown; model?: unknown; costs?: unknown };
    const modelRes = modelFieldsSchema.safeParse(raw.model ?? {});
    const routeRes = routeFormSchema.safeParse({ ...(raw.costs as object), providerId: raw.providerId, upstreamModel: raw.upstreamModel });
    if (!modelRes.success || !routeRes.success) {
      const fieldErrors = {
        ...(routeRes.success ? {} : zodFieldErrors(routeRes.error)),
        ...(modelRes.success ? {} : zodFieldErrors(modelRes.error)),
      };
      const first = Object.entries(fieldErrors)[0];
      throw new ActionFail(first ? `${first[0]}: ${first[1]}` : "Invalid input", fieldErrors);
    }
    const f = modelRes.data;
    const { providerId, ...rest } = routeRes.data;
    const provider = await db.provider.findUnique({ where: { id: providerId }, select: { id: true, name: true } });
    if (!provider) throw new ActionFail("Provider not found", { providerId: "Choose a provider" });
    await assertNamesFree(f.slug, f.aliases);
    const m = await db.model.create({
      data: { ...modelData(f), routes: { create: { providerId, ...routeData(rest) } } },
      select: { id: true },
    });
    await audit(admin.id, "model.create", { type: "Model", id: m.id }, { slug: f.slug, via: "guided", provider: provider.name, upstreamModel: rest.upstreamModel, pricingMode: f.pricingMode }, ip);
    await afterPricingChange(m.id);
    await invalidateGatewayConfig("models", m.id);
    return { data: { id: m.id }, message: `Model ${f.slug} is ready` };
  });
}

/** "Sync now" on a route with an auto-updated cost: re-read the provider's published price and re-derive the customer prices. */
export async function syncRouteCostNow(routeId: string) {
  return adminAction<{ status: string; changed: string[] }>({ adminOnly: true }, async ({ admin }) => {
    const route = await db.modelRoute.findUnique({ where: { id: routeId }, select: { id: true } });
    if (!route) throw new ActionFail("Route not found");
    const { syncRouteCost } = await import("@/server/pricing/auto-sync");
    const r = await syncRouteCost(routeId, { force: true, actorId: admin.id, reason: "manual" });
    const message =
      r.status === "ok" ? `Cost updated from the provider's price (${r.changed.length} field${r.changed.length === 1 ? "" : "s"})` :
      r.status === "unchanged" ? "The provider's price is unchanged" :
      r.status === "not published" ? "The provider does not publish a price for this model (set the provider's model id if it differs)" :
      r.status === "provider unreachable" ? "The provider's price list could not be read" : `Sync: ${r.status}`;
    if (r.status === "not published" || r.status === "provider unreachable") throw new ActionFail(message);
    return { data: { status: r.status, changed: r.changed }, message };
  });
}

/** A route switched to an auto-updated cost gets its first price at once (later refreshes happen during calls). Never throws. */
async function firstAutoSync(routeId: string, actorId: string): Promise<void> {
  try {
    const r = await db.modelRoute.findUnique({ where: { id: routeId }, select: { autoCostSyncedAt: true } });
    if (r && !r.autoCostSyncedAt) {
      const { syncRouteCost } = await import("@/server/pricing/auto-sync");
      await syncRouteCost(routeId, { force: true, actorId, reason: "enabled" });
    }
  } catch {
    /* the next call on the route retries */
  }
}

