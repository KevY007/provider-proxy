import type { ModelOption } from "./snippet-tabs";

export type PoolModel = ModelOption & { poolSlugs: string[] };

/** poolSlugs comes from the gateway's pool allowlist and route eligibility checks. */
export function modelsForKey(models: PoolModel[], poolSlug?: string, allowed: string[] = []): PoolModel[] {
  if (!poolSlug) return [];
  return models.filter((m) => m.poolSlugs.includes(poolSlug) && (!allowed.length || allowed.includes(m.slug)));
}

export function modelCopyValue(model: ModelOption, claudeCode: boolean): string {
  return claudeCode && model.capabilities.some((c) => c === "chat" || c === "responses") ? `/model ${model.claudeCodeAlias ?? model.slug}` : model.slug;
}
