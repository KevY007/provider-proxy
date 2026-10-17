import type { ConfigSnapshot, GroupRec, ModelRec } from "./cache";
import type { Ctx } from "./context";
import { GatewayError } from "./errors";
import { eligibleRoutes } from "./select";
import { ENDPOINT_FORMATS } from "./providers/presets";
import type { Json } from "./types";

/** Models this key may see: group/key allow-lists applied, ACTIVE only, and at least one usable route. */
export function visibleModels(snap: ConfigSnapshot, ctx: Ctx, includeHidden = false): ModelRec[] {
  const auth = ctx.auth!;
  const group: GroupRec | null = ctx.group;
  const out: ModelRec[] = [];
  for (const m of snap.modelsById.values()) {
    if (m.status === "DISABLED") continue;
    if (m.status === "HIDDEN" && !includeHidden) continue;
    if (auth.key.allowedModels && !auth.key.allowedModels.has(m.slug)) continue;
    if (group?.allowedModels && !group.allowedModels.has(m.slug)) continue;
    const routable = ENDPOINT_FORMATS.some((f) => eligibleRoutes(snap, m, group, f).length > 0);
    if (!routable) continue;
    out.push(m);
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug));
}

const created = (m: ModelRec) => Math.floor(m.createdAt / 1000);

function openaiModel(m: ModelRec): Json {
  return { id: m.slug, object: "model", created: created(m), owned_by: m.vendor };
}

function anthropicModel(m: ModelRec): Json {
  return { type: "model", id: m.slug, display_name: m.displayName, created_at: new Date(m.createdAt).toISOString() };
}

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

/** `GET /v1/models`, `/v1/models/{id}`, `/v1beta/models`, `/v1beta/models/{id}`. */
export function catalogResponse(ctx: Ctx): { body: Json } {
  const snap = ctx.snap!;
  const p = ctx.path!;
  const anthropic = !!ctx.req.headers.get("anthropic-version");

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
      return { body: { object: "list", data: models.map(openaiModel) } };
    }
    case "model_get": {
      const m = lookup(p.model ?? "");
      return { body: anthropic ? anthropicModel(m) : openaiModel(m) };
    }
    case "gemini_models_list":
      return { body: { models: visibleModels(snap, ctx).map(geminiModel) } };
    case "gemini_model_get":
      return { body: geminiModel(lookup(p.model ?? "")) };
    default:
      throw new GatewayError("not_found");
  }
}
