"use server";
import { sealHeaders, sealKeyExtra } from "@/lib/secret-headers";

import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { decrypt, encrypt, secretHint } from "@/lib/crypto";
import { slugify } from "@/lib/utils";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { checkProvider, checkProviderKey, type HealthResult } from "@/gateway/health";
import { probeProvider, type ProbeResult } from "@/gateway/upstream-models";
import { getSlotSnapshot, type SlotSnapshot } from "@/gateway/slots";
import { ActionFail, adminAction, jsonObjectText, optDecimal, optInt, parseInput, slugSchema } from "./action";
import { parseBulkKeys } from "./bulk-keys";
import { ALL_FORMATS, AUTH_STYLES } from "./provider-presets";

// ---------------------------------------------------------------- providers

const headersObject = jsonObjectText.superRefine((v, ctx) => {
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") ctx.addIssue({ code: "custom", message: `Header "${k}" must be a string value` });
  }
});

/** A base URL `new URL()` accepts (an unparseable one would make every upstream error quote the full URL, query key included). */
function validUrl(v: string): boolean {
  try {
    return /^https?:$/.test(new URL(v).protocol);
  } catch {
    return false;
  }
}

const providerSchema = z.object({
  name: z.string().trim().min(1, "Required").max(80),
  slug: slugSchema.optional().or(z.literal("")),
  preset: z.string().trim().min(1).max(40).default("custom"),
  baseUrl: z
    .string()
    .trim()
    .min(1, "Required")
    .refine((v) => /^https?:\/\/\S+$/i.test(v) && validUrl(v), "Must be an http(s) URL"),
  authStyle: z.enum(AUTH_STYLES),
  formats: z.array(z.string()).min(1, "Select at least one format").refine((a) => a.every((f) => ALL_FORMATS.includes(f)), "Unknown format"),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  extraHeaders: headersObject,
  settings: jsonObjectText,
  status: z.enum(["ACTIVE", "DISABLED"]).default("ACTIVE"),
  timeoutMs: z.coerce.number().int().min(1000, "Min 1000ms").max(3_600_000, "Max 3600000ms").default(600000),
  priority: z.coerce.number().int().min(-1000).max(1000).default(0),
  maxConcurrency: optInt(1, 1_000_000),
  notes: z.string().max(2000).optional().nullable(),
});

export async function createProvider(input: unknown) {
  return adminAction<{ id: string }>({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(providerSchema, input);
    const slug = d.slug || slugify(d.name);
    if (!slug) throw new ActionFail("Could not derive a slug", { name: "Name must contain letters or digits" });
    const created = await db.provider.create({
      data: {
        name: d.name, slug, preset: d.preset, baseUrl: d.baseUrl.replace(/\/+$/, ""), authStyle: d.authStyle,
        formats: d.formats, tags: d.tags, extraHeaders: sealHeaders(d.extraHeaders) as never, settings: d.settings as never,
        status: d.status, timeoutMs: d.timeoutMs, priority: d.priority, maxConcurrency: d.maxConcurrency,
        notes: d.notes?.trim() || null,
      },
    });
    await audit(admin.id, "provider.create", { type: "Provider", id: created.id }, { name: d.name, preset: d.preset, baseUrl: d.baseUrl }, ip);
    await invalidateGatewayConfig("providers", created.id);
    return { data: { id: created.id }, message: `Provider "${d.name}" created` };
  });
}

export async function updateProvider(id: string, input: unknown) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(providerSchema, input);
    const existing = await db.provider.findUnique({ where: { id }, select: { slug: true, extraHeaders: true } });
    if (!existing) throw new ActionFail("Provider not found");
    await db.provider.update({
      where: { id },
      data: {
        name: d.name, slug: d.slug || existing.slug, preset: d.preset, baseUrl: d.baseUrl.replace(/\/+$/, ""),
        authStyle: d.authStyle, formats: d.formats, tags: d.tags, extraHeaders: sealHeaders(d.extraHeaders, existing.extraHeaders) as never,
        settings: d.settings as never, status: d.status, timeoutMs: d.timeoutMs, priority: d.priority,
        maxConcurrency: d.maxConcurrency, notes: d.notes?.trim() || null,
      },
    });
    await audit(admin.id, "provider.update", { type: "Provider", id }, { name: d.name, status: d.status, baseUrl: d.baseUrl }, ip);
    await invalidateGatewayConfig("providers", id);
    return { message: "Provider saved" };
  });
}

export async function setProviderStatus(id: string, status: "ACTIVE" | "DISABLED") {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const s = parseInput(z.enum(["ACTIVE", "DISABLED"]), status);
    await db.provider.update({ where: { id }, data: { status: s } });
    await audit(admin.id, "provider.status", { type: "Provider", id }, { status: s }, ip);
    await invalidateGatewayConfig("providers", id);
    return { message: s === "ACTIVE" ? "Provider enabled" : "Provider disabled" };
  });
}

export async function deleteProvider(id: string) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const p = await db.provider.findUnique({ where: { id }, select: { name: true, _count: { select: { routes: true, keys: true } } } });
    if (!p) throw new ActionFail("Provider not found");
    await db.provider.delete({ where: { id } });
    await audit(admin.id, "provider.delete", { type: "Provider", id }, { name: p.name, routes: p._count.routes, keys: p._count.keys }, ip);
    await invalidateGatewayConfig("providers", id);
    return { message: `Provider "${p.name}" deleted` };
  });
}

// ---------------------------------------------------------------- provider keys

const keyBase = {
  weight: z.coerce.number().int().min(0).max(10_000).default(1),
  priority: z.coerce.number().int().min(-1000).max(1000).default(0),
  rpmLimit: optInt(1),
  tpmLimit: optInt(1),
  maxConcurrency: optInt(1, 1_000_000),
  dailyBudget: optDecimal,
};

const addKeySchema = z.object({
  providerId: z.string().min(1),
  label: z.string().trim().min(1, "Required").max(80),
  secret: z.string().trim().min(8, "Secret looks too short"),
  extra: jsonObjectText,
  ...keyBase,
});

export async function addProviderKey(input: unknown) {
  return adminAction<{ id: string }>({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(addKeySchema, input);
    const key = await db.providerKey.create({
      data: {
        providerId: d.providerId, label: d.label, secretEncrypted: encrypt(d.secret), secretHint: secretHint(d.secret),
        weight: d.weight, priority: d.priority, rpmLimit: d.rpmLimit, tpmLimit: d.tpmLimit, maxConcurrency: d.maxConcurrency,
        dailyBudget: d.dailyBudget, extra: sealKeyExtra(d.extra) as never,
      },
      select: { id: true },
    });
    await audit(admin.id, "providerKey.create", { type: "ProviderKey", id: key.id }, { providerId: d.providerId, label: d.label }, ip);
    await invalidateGatewayConfig("providers", d.providerId);
    return { data: { id: key.id }, message: `Key "${d.label}" added` };
  });
}

const bulkSchema = z.object({
  providerId: z.string().min(1),
  text: z.string().min(1, "Paste at least one key"),
  weight: z.coerce.number().int().min(0).max(10_000).default(1),
  priority: z.coerce.number().int().min(-1000).max(1000).default(0),
  maxConcurrency: optInt(1, 1_000_000),
});

export interface BulkAddResult {
  added: number;
  skipped: Array<{ line: number; reason: string; preview: string }>;
}

export async function bulkAddProviderKeys(input: unknown) {
  return adminAction<BulkAddResult>({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(bulkSchema, input);
    const existing = await db.providerKey.findMany({ where: { providerId: d.providerId }, select: { label: true, secretEncrypted: true } });
    const existingSecrets: string[] = [];
    for (const e of existing) {
      try {
        existingSecrets.push(decrypt(e.secretEncrypted));
      } catch {
        /* unreadable secret (rotated ENCRYPTION_KEY) - cannot dedupe against it */
      }
    }
    const parsed = parseBulkKeys(d.text, {
      startIndex: existing.length,
      existingLabels: existing.map((e) => e.label),
      existingSecrets,
    });
    if (parsed.entries.length === 0) {
      throw new ActionFail(parsed.skipped[0] ? `No keys added: ${parsed.skipped[0].reason} (line ${parsed.skipped[0].line})` : "No keys found", { text: "No valid keys found" });
    }
    await db.providerKey.createMany({
      data: parsed.entries.map((e) => ({
        providerId: d.providerId, label: e.label, secretEncrypted: encrypt(e.secret), secretHint: secretHint(e.secret),
        weight: d.weight, priority: d.priority, maxConcurrency: d.maxConcurrency,
      })),
    });
    await audit(admin.id, "providerKey.bulkCreate", { type: "Provider", id: d.providerId }, { added: parsed.entries.length, skipped: parsed.skipped.length }, ip);
    await invalidateGatewayConfig("providers", d.providerId);
    return {
      data: { added: parsed.entries.length, skipped: parsed.skipped },
      message: `Added ${parsed.entries.length} key${parsed.entries.length === 1 ? "" : "s"}${parsed.skipped.length ? `, skipped ${parsed.skipped.length}` : ""}`,
    };
  });
}

const updateKeySchema = z.object({
  label: z.string().trim().min(1, "Required").max(80),
  status: z.enum(["ACTIVE", "DISABLED", "COOLDOWN", "INVALID", "EXHAUSTED"]),
  extra: jsonObjectText,
  ...keyBase,
});

async function keyProvider(id: string): Promise<{ providerId: string; label: string }> {
  const k = await db.providerKey.findUnique({ where: { id }, select: { providerId: true, label: true } });
  if (!k) throw new ActionFail("Key not found");
  return k;
}

export async function updateProviderKey(id: string, input: unknown) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(updateKeySchema, input);
    const k = await keyProvider(id);
    const prevExtra = (await db.providerKey.findUnique({ where: { id }, select: { extra: true } }))?.extra;
    await db.providerKey.update({
      where: { id },
      data: {
        label: d.label, status: d.status, weight: d.weight, priority: d.priority, rpmLimit: d.rpmLimit,
        tpmLimit: d.tpmLimit, maxConcurrency: d.maxConcurrency, dailyBudget: d.dailyBudget, extra: sealKeyExtra(d.extra, prevExtra) as never,
        ...(d.status === "ACTIVE" ? { cooldownUntil: null } : {}),
      },
    });
    await audit(admin.id, "providerKey.update", { type: "ProviderKey", id }, { label: d.label, status: d.status }, ip);
    await invalidateGatewayConfig("providers", k.providerId);
    return { message: "Key saved" };
  });
}

export async function rotateProviderKeySecret(id: string, input: unknown) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(z.object({ secret: z.string().trim().min(8, "Secret looks too short") }), input);
    const k = await keyProvider(id);
    await db.providerKey.update({
      where: { id },
      data: {
        secretEncrypted: encrypt(d.secret), secretHint: secretHint(d.secret), status: "ACTIVE",
        cooldownUntil: null, consecutiveFailures: 0, lastError: null,
      },
    });
    await audit(admin.id, "providerKey.rotate", { type: "ProviderKey", id }, { label: k.label }, ip);
    await invalidateGatewayConfig("providers", k.providerId);
    return { message: "Secret rotated and key re-enabled" };
  });
}

export async function setProviderKeysStatus(ids: string[], status: "ACTIVE" | "DISABLED") {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(z.object({ ids: z.array(z.string()).min(1).max(1000), status: z.enum(["ACTIVE", "DISABLED"]) }), { ids, status });
    const keys = await db.providerKey.findMany({ where: { id: { in: d.ids } }, select: { providerId: true } });
    await db.providerKey.updateMany({
      where: { id: { in: d.ids } },
      data: d.status === "ACTIVE" ? { status: "ACTIVE", cooldownUntil: null, consecutiveFailures: 0 } : { status: "DISABLED" },
    });
    await audit(admin.id, d.status === "ACTIVE" ? "providerKey.enable" : "providerKey.disable", { type: "ProviderKey", id: d.ids[0] }, { ids: d.ids }, ip);
    for (const pid of new Set(keys.map((k) => k.providerId))) await invalidateGatewayConfig("providers", pid);
    return { message: `${d.ids.length} key${d.ids.length === 1 ? "" : "s"} ${d.status === "ACTIVE" ? "enabled" : "disabled"}` };
  });
}

export async function resetProviderKey(id: string) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const k = await keyProvider(id);
    await db.providerKey.update({ where: { id }, data: { status: "ACTIVE", cooldownUntil: null, consecutiveFailures: 0, lastError: null } });
    await audit(admin.id, "providerKey.reset", { type: "ProviderKey", id }, { label: k.label }, ip);
    await invalidateGatewayConfig("providers", k.providerId);
    return { message: "Cooldown and failures reset" };
  });
}

export async function deleteProviderKeys(ids: string[]) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(z.array(z.string()).min(1).max(1000), ids);
    const keys = await db.providerKey.findMany({ where: { id: { in: d } }, select: { providerId: true, label: true } });
    await db.providerKey.deleteMany({ where: { id: { in: d } } });
    await audit(admin.id, "providerKey.delete", { type: "ProviderKey", id: d[0] }, { ids: d, labels: keys.map((k) => k.label) }, ip);
    for (const pid of new Set(keys.map((k) => k.providerId))) await invalidateGatewayConfig("providers", pid);
    return { message: `${d.length} key${d.length === 1 ? "" : "s"} deleted` };
  });
}

// ---------------------------------------------------------------- health tests & slots

export async function testProviderKey(id: string) {
  return adminAction<HealthResult>({}, async ({ admin, ip }) => {
    const k = await keyProvider(id);
    const res = await checkProviderKey(id);
    await audit(admin.id, "providerKey.test", { type: "ProviderKey", id }, { label: k.label, ok: res.ok, latencyMs: res.latencyMs }, ip);
    await invalidateGatewayConfig("providers", k.providerId);
    return { data: res, message: res.ok ? `"${k.label}" OK${res.latencyMs != null ? ` (${res.latencyMs}ms)` : ""}` : undefined };
  });
}

export async function testAllProviderKeys(providerId: string) {
  return adminAction<{ total: number; ok: number; failed: number }>({}, async ({ admin, ip }) => {
    const results = await checkProvider(providerId);
    const ok = results.filter((r) => r.ok).length;
    await audit(admin.id, "provider.testAll", { type: "Provider", id: providerId }, { total: results.length, ok }, ip);
    await invalidateGatewayConfig("providers", providerId);
    return {
      data: { total: results.length, ok, failed: results.length - ok },
      message: results.length === 0 ? "No active keys to test" : `${ok}/${results.length} checks passed`,
    };
  });
}

/** Polling endpoint for the live slot panels (auth-checked). */
export async function fetchSlotSnapshot() {
  return adminAction<SlotSnapshot>({}, async () => ({ data: await getSlotSnapshot() }));
}

// ---------------------------------------------------------------- test connection / fetch pricing (saved or draft)

const probeSchema = z.object({
  providerId: z.string().optional().nullable(),
  what: z.enum(["test", "pricing", "both"]).default("both"),
  /** An API key typed just for this test (never stored). Empty = use the provider's first usable key. */
  secret: z.string().trim().max(4000).optional().nullable(),
  draft: z.object({
    preset: z.string().trim().min(1).max(40).default("custom"),
    baseUrl: z
      .string()
      .trim()
      .min(1, "Enter the base URL first")
      .refine((v) => /^https?:\/\/\S+$/i.test(v) && validUrl(v), "Must be an http(s) URL"),
    authStyle: z.enum(AUTH_STYLES),
    formats: z.array(z.string()).default(["openai_chat"]),
    extraHeaders: headersObject.optional(),
    settings: jsonObjectText.optional(),
  }),
});

/**
 * "Test connection" and "Fetch pricing" on the provider form - works before the provider is saved (draft values +
 * a key typed for the test) and for saved providers (their first usable key when none is typed). Lists the models
 * the key can see and reads the prices the provider publishes through its API (OpenRouter / LiteLLM / reseller /
 * ProviderProxy shapes, or `settings.pricingUrl`). Read-only: nothing is stored.
 */
export async function probeProviderAction(input: unknown) {
  return adminAction<ProbeResult>({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(probeSchema, input);
    const saved = d.providerId ? await db.provider.findUnique({ where: { id: d.providerId }, include: { keys: true } }) : null;
    if (d.providerId && !saved) throw new ActionFail("Provider not found");
    let secret = d.secret || null;
    let keyExtra: Record<string, unknown> = {};
    if (!secret && saved) {
      const now = Date.now();
      const key = saved.keys
        .filter((k) => k.status === "ACTIVE" || (k.status === "COOLDOWN" && (!k.cooldownUntil || k.cooldownUntil.getTime() <= now)))
        .sort((a, b) => b.priority - a.priority)[0];
      if (key) {
        try {
          secret = decrypt(key.secretEncrypted);
          keyExtra = (key.extra && typeof key.extra === "object" ? key.extra : {}) as Record<string, unknown>;
        } catch {
          throw new ActionFail("The provider key could not be decrypted (ENCRYPTION_KEY changed?)");
        }
      }
    }
    const draft = {
      slug: saved?.slug ?? "draft",
      preset: d.draft.preset,
      baseUrl: d.draft.baseUrl.replace(/\/+$/, ""),
      authStyle: d.draft.authStyle,
      tags: saved?.tags ?? [],
      // masked ([encrypted]) values in the form keep the stored ones
      extraHeaders: sealHeaders(d.draft.extraHeaders ?? {}, saved?.extraHeaders),
      settings: (d.draft.settings ?? {}) as never,
      formats: d.draft.formats,
    };
    const res = await probeProvider(draft as never, secret, keyExtra as never, { models: d.what !== "pricing", pricing: d.what !== "test" });
    await audit(admin.id, "provider.probe", saved ? { type: "Provider", id: saved.id } : null, { baseUrl: draft.baseUrl, what: d.what, models: res.models.count, prices: res.pricing.count }, ip);
    const parts = [
      d.what !== "pricing" ? (res.models.ok ? `Connected: ${res.models.count} model(s) in ${res.latencyMs} ms` : `Connection failed: ${res.models.error ?? "unknown error"}`) : null,
      d.what !== "test" ? (res.pricing.count ? `Prices found for ${res.pricing.count} model(s)` : "This provider does not publish prices through its API") : null,
    ].filter(Boolean);
    return { data: res, message: parts.join(" | ") };
  });
}

