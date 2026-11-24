import { Decimal } from "@/lib/money";
import type { ConfigSnapshot, GroupRec, ModelRec } from "./cache";
import type { Ctx } from "./context";
import { GatewayError } from "./errors";
import { liteLLMMode, modalities, openRouterPricing, plainNumber, priceMatrix } from "./price-view";
import { effectiveMultiplier, type PriceTable } from "./pricing";
import { poolPriceTable } from "./pool-prices";

const ONE = new Decimal(1);
import { eligibleRoutes } from "./select";
import { ENDPOINT_FORMATS } from "./providers/presets";
import type { Json } from "./types";

/** Pool-level visibility shared by /models and the customer setup guides. */
export function hasCatalogRoute(snap: ConfigSnapshot, m: ModelRec, group: GroupRec | null): boolean {
  return (!group?.allowedModels || group.allowedModels.has(m.slug)) && ENDPOINT_FORMATS.some((f) => eligibleRoutes(snap, m, group, f).length > 0);
}

/** Models this key may see: group/key allow-lists applied, ACTIVE only, and at least one usable route. */
export function visibleModels(snap: ConfigSnapshot, ctx: Ctx, includeHidden = false): ModelRec[] {
  const auth = ctx.auth!;
  const group: GroupRec | null = ctx.group;
  const out: ModelRec[] = [];
  for (const m of snap.modelsById.values()) {
    if (m.status === "DISABLED") continue;
    if (m.status === "HIDDEN" && !includeHidden) continue;
    if (auth.key.allowedModels && !auth.key.allowedModels.has(m.slug)) continue;
    if (!hasCatalogRoute(snap, m, group)) continue;
    out.push(m);
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug));
}

const created = (m: ModelRec) => Math.floor(m.createdAt / 1000);

/**
 * OpenAI shape (`id/object/created/owned_by`) + the de-facto pricing fields clients already understand
 * (OpenRouter: `name`, `context_length`, `pricing` as decimal strings per token, `top_provider`, `architecture`)
 * + our extension `x_pricing` (per-1M-token / per-image / per-second units with official price and savings).
 * Prices are the CALLER's effective prices (model price x group x customer multiplier).
 */
export function openaiModel(m: ModelRec, mult: Decimal, sell: PriceTable = m.sell): Json {
  const matrix = priceMatrix(sell, m.official, mult);
  return {
    id: m.slug,
    object: "model",
    created: created(m),
    owned_by: m.vendor,
    name: m.displayName,
    ...(m.description ? { description: m.description } : {}),
    context_length: m.contextWindow,
    pricing: openRouterPricing(sell, mult),
    top_provider: { context_length: m.contextWindow, max_completion_tokens: m.maxOutput, is_moderated: false },
    architecture: modalities(m.capabilities),
    x_pricing: { unit: "usd_per_1m", currency: "USD", yours: matrix.yours, official: matrix.official, savings_pct: matrix.savings_pct, units: matrix.unit, ...(Object.keys(matrix.tools).length ? { tools: matrix.tools } : {}) },
    ...(m.retiresAt ? { x_retires_at: new Date(m.retiresAt).toISOString() } : {}),
  };
}

/** Anthropic shape: spec-pure. */
function anthropicModel(m: ModelRec): Json {
  return { type: "model", id: m.slug, display_name: m.displayName, created_at: new Date(m.createdAt).toISOString() };
}

/** Gemini shape: native fields only. */
function geminiModel(m: ModelRec): Json {
  const methods: string[] = [];
  if (m.capabilities.has("chat") || m.capabilities.has("responses") || m.capabilities.has("completions")) methods.push("generateContent", "streamGenerateContent", "countTokens");
  if (m.capabilities.has("embeddings")) methods.push("embedContent", "batchEmbedContents");
  return {
    name: `models/${m.slug}`,
    version: "001",
    displayName: m.displayName,
    description: m.description ?? "",
    inputTokenLimit: m.contextWindow ?? 0,
    outputTokenLimit: m.maxOutput ?? 0,
    supportedGenerationMethods: methods,
  };
}

/** LiteLLM `model_info` for one model at the caller's price (USD per token / image / second). */
export function liteLLMEntry(m: ModelRec, mult: Decimal, t: PriceTable = m.sell): Json {
  const per = (v: Decimal | null | undefined) => plainNumber(v ? v.times(mult).div(1_000_000) : null) ?? 0;
  const flat = (v: Decimal | null | undefined) => plainNumber(v ? v.times(mult) : null) ?? 0;
  const caps = m.capabilities;
  const info: Record<string, Json> = {
    input_cost_per_token: per(t.input),
    output_cost_per_token: per(t.output),
    cache_read_input_token_cost: t.cachedInput ? per(t.cachedInput) : null,
    cache_creation_input_token_cost: t.cacheWrite ? per(t.cacheWrite) : null,
    output_cost_per_image: t.image ? flat(t.image) : null,
    output_cost_per_second: t.perSecond ? flat(t.perSecond) : null,
    input_cost_per_second: t.perMinute ? plainNumber(t.perMinute.times(mult).div(60)) : null,
    max_tokens: m.maxOutput ?? m.contextWindow ?? null,
    max_input_tokens: m.contextWindow,
    max_output_tokens: m.maxOutput,
    mode: liteLLMMode(caps),
    supports_function_calling: caps.has("tools"),
    supports_vision: caps.has("vision"),
    supports_reasoning: caps.has("reasoning"),
  };
  return { model_name: m.slug, litellm_params: { model: m.slug }, model_info: info };
}

/** `GET /v1/models`, `/v1/models/{id}`, `/v1/model/info`, `/v1beta/models`, `/v1beta/models/{id}`. */
export function catalogResponse(ctx: Ctx): { body: Json } {
  const snap = ctx.snap!;
  const p = ctx.path!;
  const anthropic = !!ctx.req.headers.get("anthropic-version");
  const { user } = ctx.auth!;
  const mult = effectiveMultiplier(user.priceMultiplier, ctx.group?.priceMultiplier);

  const lookup = (name: string): ModelRec => {
    const key = name.startsWith("models/") ? name.slice(7) : name;
    const m = snap.modelsBySlug.get(key) ?? snap.modelsByAlias.get(key.toLowerCase());
    if (!m || !visibleModels(snap, ctx, true).includes(m)) {
      throw new GatewayError("model_not_found", `The model '${name}' does not exist or you do not have access to it.`);
    }
    return m;
  };

  switch (p.op) {
    case "models_list": {
      const models = visibleModels(snap, ctx);
      if (anthropic) {
        return { body: { data: models.map(anthropicModel), has_more: false, first_id: models[0]?.slug ?? null, last_id: models[models.length - 1]?.slug ?? null } };
      }
      return { body: { object: "list", data: models.map((m) => openaiModel(m, ONE, poolPriceTable(snap, m, ctx.group, mult))) } };
    }
    case "model_get": {
      const m = lookup(p.model ?? "");
      return { body: anthropic ? anthropicModel(m) : openaiModel(m, ONE, poolPriceTable(snap, m, ctx.group, mult)) };
    }
    case "model_info":
      return { body: { data: visibleModels(snap, ctx).map((m) => liteLLMEntry(m, ONE, poolPriceTable(snap, m, ctx.group, mult))) } };
    case "gemini_models_list":
      return { body: { models: visibleModels(snap, ctx).map(geminiModel) } };
    case "gemini_model_get":
      return { body: geminiModel(lookup(p.model ?? "")) };
    default:
      throw new GatewayError("not_found");
  }
}
