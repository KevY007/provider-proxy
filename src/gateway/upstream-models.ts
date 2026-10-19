// Lists the models a provider's first healthy key can see upstream (cached ~5 min), enriched with known prices.
// Powers the admin "Add model" flow ("choose the real model from the provider's live list") and `pnpm setup:live`.
// Never returns or logs secrets; errors carry a short, secret-free message.
import { decrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { buildUpstreamHeaders } from "./providers/adapters";
import { toAdapter } from "./health";
import { KNOWN_PRICES, lookupKnownPrice, type KnownPrice } from "./price-catalog";
import { NO_PRICE_API_PRESETS, fetchRemotePricing, parseRemotePricing, type RemotePrice, type RemotePricingResult } from "./remote-pricing";
import type { JsonObject } from "./types";
import { ClientAbortError, UpstreamTimeoutError, readTextLimited, sendUpstream, type UpstreamResponse } from "./upstream";
import { isObject, safeJsonParse } from "./util";

export type UpstreamModel = {
  id: string;
  /** What the provider itself says it charges for this model (its own price API), when it publishes prices. */
  remote?: RemotePrice | null;
  ownedBy?: string;
  shutdownDate?: string | null; // ISO date when the upstream announces retirement
  known?: KnownPrice | null;
  alreadyRouted?: boolean; // a ModelRoute for this provider + upstream model already exists
};

const CACHE_MS = 5 * 60_000;
const LIST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 12;
const MAX_BODY = 8 * 1024 * 1024;

const g = globalThis as unknown as { __ppUpstreamModels?: Map<string, { at: number; items: UpstreamModel[] }> };
const cache = (g.__ppUpstreamModels ??= new Map<string, { at: number; items: UpstreamModel[] }>());

/** The provider row fields the listing needs (a saved provider, or an unsaved draft from the admin form). */
export type ProviderLike = Parameters<typeof toAdapter>[0] & { formats: string[] };

const trimSlash = (s: string) => s.replace(/\/+$/, "");
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** ISO date (YYYY-MM-DD or full timestamp) from an upstream value: ISO string or unix seconds. */
function isoDate(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v * 1000).toISOString().slice(0, 10);
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? (/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : new Date(t).toISOString()) : null;
  }
  return null;
}

class ListError extends Error {}

/**
 * The provider's own short error text (e.g. "INSUFFICIENT_BALANCE: Insufficient account balance"), so an admin sees why
 * a key was refused. JSON bodies only (never an HTML page), at most 200 chars, anything key-shaped redacted.
 */
async function upstreamMessage(res: UpstreamResponse): Promise<string | null> {
  try {
    const j = safeJsonParse<unknown>(await readTextLimited(res, 64 * 1024));
    if (!isObject(j)) return null;
    const e = isObject(j.error) ? j.error : j;
    const msg = typeof e.message === "string" ? e.message : typeof j.error === "string" ? j.error : typeof j.detail === "string" ? j.detail : null;
    const code = typeof e.code === "string" ? e.code : typeof e.type === "string" ? e.type : null;
    const text = [code && !msg?.includes(code) ? code : null, msg].filter(Boolean).join(": ");
    if (!text) return null;
    return text.replace(/[A-Za-z0-9_\-]{24,}/g, "[redacted]").replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return null;
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<JsonObject> {
  let h;
  try {
    h = await sendUpstream({ url, method: "GET", headers, timeoutMs: LIST_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof UpstreamTimeoutError) throw new ListError("The provider did not answer in time.");
    if (err instanceof ClientAbortError) throw new ListError("The request was aborted.");
    throw new ListError("The provider could not be reached.");
  }
  try {
    if (h.res.status < 200 || h.res.status >= 300) {
      const s = h.res.status;
      const said = await upstreamMessage(h.res);
      throw new ListError(
        s === 401 || s === 403
          ? `The provider rejected the key (HTTP ${s})${said ? ` - it says: ${said}` : ". Test the key and fix it first."}`
          : s === 404 || s === 405
            ? "This provider does not offer a model list; type the model id instead."
            : `The provider answered HTTP ${s}${said ? `: ${said}` : "."}`,
      );
    }
    const text = await readTextLimited(h.res, MAX_BODY);
    const j = safeJsonParse<unknown>(text);
    if (!isObject(j)) throw new ListError("The provider's model list was not understood.");
    return j;
  } finally {
    h.dispose();
  }
}

/** The vendor's catalog entries (fal.ai / Replicate have no cheap list endpoint). */
function catalogFor(vendor: string): UpstreamModel[] {
  return KNOWN_PRICES.filter((k) => k.vendor === vendor).map((k) => ({ id: k.model, ownedBy: vendor, shutdownDate: k.retiresAt ?? null }));
}

async function fetchList(provider: ProviderLike, secret: string, keyExtra: JsonObject, seen?: { url?: string; doc?: JsonObject }): Promise<UpstreamModel[]> {
  const adapter = toAdapter(provider);
  const s = adapter.settings;
  const formats = provider.formats;
  const hdr = (format: Parameters<typeof buildUpstreamHeaders>[0]["format"]) => buildUpstreamHeaders({ provider: adapter, format, secret, stream: false, keyExtra, hasBody: false });
  const withKey = (url: string) => (adapter.authStyle === "QUERY_KEY" ? `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(secret)}` : url);

  if (adapter.preset === "fal" || adapter.preset === "replicate") return catalogFor(adapter.preset);

  const out: UpstreamModel[] = [];
  const hasOpenAI = formats.some((f) => f.startsWith("openai_"));

  if (adapter.preset === "google" || (!hasOpenAI && !formats.includes("anthropic_messages") && formats.includes("gemini"))) {
    const root = trimSlash(str(s.geminiBaseUrl) ?? adapter.baseUrl).replace(/\/v1(beta)?$/, "");
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = withKey(`${root}/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
      const j = await getJson(url, hdr("gemini"));
      for (const m of Array.isArray(j.models) ? j.models : []) {
        if (!isObject(m) || typeof m.name !== "string") continue;
        out.push({ id: m.name.replace(/^models\//, ""), ownedBy: "google" });
      }
      token = str(j.nextPageToken);
      if (!token) break;
    }
    return out;
  }

  if (!hasOpenAI && formats.includes("anthropic_messages")) {
    const root = trimSlash(str(s.anthropicBaseUrl) ?? adapter.baseUrl).replace(/\/v1$/, "");
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const j = await getJson(withKey(`${root}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`), hdr("anthropic_messages"));
      const data = Array.isArray(j.data) ? j.data : [];
      for (const m of data) if (isObject(m) && typeof m.id === "string") out.push({ id: m.id, ownedBy: "anthropic" });
      after = j.has_more === true ? str(j.last_id) : undefined;
      if (!after) break;
    }
    return out;
  }

  const root = adapter.authStyle === "AZURE_API_KEY" || adapter.preset === "azure" ? `${adapter.baseUrl}/openai` : (str(s.openaiBaseUrl) ?? adapter.baseUrl);
  const url = withKey(adapter.preset === "azure" ? `${root}/models?api-version=${encodeURIComponent(str(s.azureApiVersion) ?? "2025-04-01-preview")}` : `${trimSlash(root)}/models`);
  const j = await getJson(url, hdr("openai_chat"));
  if (seen) {
    seen.url = adapter.preset === "azure" ? undefined : `${trimSlash(root)}/models`;
    seen.doc = j; // (prices published on the list itself are read from here, without a second request)
  }
  for (const m of Array.isArray(j.data) ? j.data : []) {
    if (!isObject(m) || typeof m.id !== "string") continue;
    out.push({ id: m.id, ownedBy: str(m.owned_by), shutdownDate: isoDate(m.shutdown_date) });
  }
  return out;
}

async function loadProvider(providerId: string) {
  return db.provider.findUnique({ where: { id: providerId }, include: { keys: true } });
}

/** The first healthy key: ACTIVE (best priority first), else a cooled-down key whose cooldown elapsed. */
function pickKey<T extends { status: string; priority: number; cooldownUntil: Date | null; lastUsedAt: Date | null }>(keys: T[]): T | null {
  const now = Date.now();
  const usable = keys.filter((k) => k.status === "ACTIVE" || (k.status === "COOLDOWN" && (!k.cooldownUntil || k.cooldownUntil.getTime() <= now)));
  usable.sort((a, b) => b.priority - a.priority || (a.status === "ACTIVE" ? 0 : 1) - (b.status === "ACTIVE" ? 0 : 1));
  return usable[0] ?? null;
}

export async function listUpstreamModels(providerId: string): Promise<UpstreamModel[]> {
  const provider = await loadProvider(providerId);
  if (!provider) throw new Error("Provider not found.");

  let raw = cache.get(providerId);
  if (!raw || Date.now() - raw.at > CACHE_MS) {
    const key = pickKey(provider.keys);
    let items: UpstreamModel[];
    if (provider.preset === "fal" || provider.preset === "replicate") items = catalogFor(provider.preset);
    else {
      if (!key) throw new Error("This provider has no usable key. Add a key (and test it) to list its models.");
      let secret: string;
      try {
        secret = decrypt(key.secretEncrypted);
      } catch {
        throw new Error("The provider key could not be decrypted (ENCRYPTION_KEY changed?).");
      }
      const keyExtra = (isObject(key.extra) ? key.extra : {}) as JsonObject;
      const seen: { url?: string; doc?: JsonObject } = {};
      try {
        items = await fetchList(provider, secret, keyExtra, seen);
      } catch (err) {
        if (err instanceof ListError) throw new Error(err.message);
        logger.warn("listing upstream models failed", { providerId, err: err instanceof Error ? err.message : "unknown" });
        throw new Error("The provider's model list could not be fetched.");
      }
      // the provider's own published prices (resellers, other proxies, OpenRouter ...): a starting point for Our cost
      const prices = seen.doc ? parseRemotePricing(seen.doc, "/models") : new Map<string, RemotePrice>();
      if (!NO_PRICE_API_PRESETS.has(provider.preset)) {
        const more = await fetchRemotePricing(toAdapter(provider), secret, keyExtra, { timeoutMs: 6_000, skipUrls: seen.url ? [seen.url] : [] }).catch(() => null);
        for (const [id, p] of more?.prices ?? []) if (!prices.has(id)) prices.set(id, p);
      }
      if (prices.size) items = items.map((m) => ({ ...m, remote: prices.get(m.id) ?? null }));
    }
    items.sort((a, b) => a.id.localeCompare(b.id));
    raw = { at: Date.now(), items };
    cache.set(providerId, raw);
  }

  const routed = new Set((await db.modelRoute.findMany({ where: { providerId }, select: { upstreamModel: true } })).map((r) => r.upstreamModel));
  return raw.items.map((m) => {
    const known = lookupKnownPrice(provider.preset, m.id);
    return { ...m, shutdownDate: m.shutdownDate ?? known?.retiresAt ?? null, known, alreadyRouted: routed.has(m.id) };
  });
}

export interface ProbeResult {
  latencyMs: number;
  models: { ok: boolean; count: number; sample: string[]; error?: string };
  pricing: { count: number; rows: Array<{ id: string } & RemotePrice>; tried: RemotePricingResult["tried"] };
}

/**
 * "Test connection" / "Fetch pricing" for a provider - saved or still a draft in the admin form: list the models with
 * the given credential and read the provider's published prices. Never returns the secret; errors are secret-free.
 */
export async function probeProvider(provider: ProviderLike, secret: string | null, keyExtra: JsonObject = {}, opts: { pricing?: boolean; models?: boolean } = {}): Promise<ProbeResult> {
  const t0 = Date.now();
  const res: ProbeResult = { latencyMs: 0, models: { ok: false, count: 0, sample: [] }, pricing: { count: 0, rows: [], tried: [] } };
  if (opts.models !== false) {
    if (!secret && provider.preset !== "fal" && provider.preset !== "replicate") res.models.error = "Enter an API key (or add one to the provider) to test the connection.";
    else {
      try {
        const items = await fetchList(provider, secret ?? "", keyExtra);
        res.models = { ok: true, count: items.length, sample: items.slice(0, 12).map((m) => m.id) };
      } catch (err) {
        res.models.error = err instanceof ListError ? err.message : "The provider could not be reached.";
      }
    }
    res.latencyMs = Date.now() - t0;
  }
  if (opts.pricing !== false) {
    const r = await fetchRemotePricing(toAdapter(provider), secret, keyExtra, { timeoutMs: 8_000 });
    res.pricing = { count: r.prices.size, rows: [...r.prices.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 500).map(([id, p]) => ({ id, ...p })), tried: r.tried };
  }
  return res;
}

export function __resetUpstreamModelsCacheForTests(): void {
  cache.clear();
}
