// Server-only: reads/writes Model + ModelRoute, then invalidates the gateway config cache.
//
// HOW TO KEEP CUSTOMER PRICES IN SYNC (read this if you write admin/customer server actions)
// ------------------------------------------------------------------------------------------
// A model whose `pricingMode` is PERCENT_OF_OFFICIAL or MARKUP_OVER_COST has its customer ("sell") prices DERIVED:
//   PERCENT_OF_OFFICIAL : sell = official x pricingValue / 100
//   MARKUP_OVER_COST    : sell = primary-route cost x (1 + pricingValue / 100)
//   PERCENT_OF_COST     : sell = primary-route cost x pricingValue / 100
//   ... then + pricingAdjust (signed, per unit, never below 0)
// "Primary route" = the highest-priority ENABLED route (ties: higher weight, then oldest).
// Whenever one of the INPUTS of that derivation changes you MUST call
//
//     await onModelPricingInputsChanged(modelId)
//
// after the write has been committed. Inputs are: any `official*` column of the model, `pricingMode` / `pricingValue`,
// and, for any route of the model, its cost columns (`*Cost`), `enabled` or `priority` (creating / deleting a route
// counts too). The function re-derives the sell columns for every unit that has an official / cost basis (units
// without a basis keep their current value), writes them only when they changed and invalidates the gateway config
// cache, so the new prices are live within seconds. It is a no-op for FIXED models. It never throws (errors are logged).
//
// `recomputeModelPrices` is the same thing but lets errors propagate; `applyPricingRule` sets one rule on many models.
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Decimal, toDbString } from "@/lib/money";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { deriveSellUpdates } from "./fields";
import { validateRule, type PricingRule } from "./preview";

type Row = Record<string, unknown>;

export { deriveSellUpdates };

/** Re-derive a model's customer prices from its pricing rule (no-op for FIXED). */
export async function recomputeModelPrices(modelId: string): Promise<{ changed: boolean }> {
  const model = await db.model.findUnique({ where: { id: modelId } });
  if (!model || model.pricingMode === "FIXED") return { changed: false };
  const rule: PricingRule = { mode: model.pricingMode, value: model.pricingValue === null ? null : Number(model.pricingValue.toString()), adjust: model.pricingAdjust === null ? null : Number(model.pricingAdjust.toString()) };
  if (validateRule(rule)) return { changed: false };
  const route = await db.modelRoute.findFirst({ where: { modelId, enabled: true }, orderBy: [{ priority: "desc" }, { weight: "desc" }, { createdAt: "asc" }] });
  const updates = deriveSellUpdates(model as unknown as Row, route as unknown as Row | null, rule);
  if (!Object.keys(updates).length) return { changed: false };
  await db.model.update({ where: { id: modelId }, data: updates });
  await invalidateGatewayConfig("models", modelId);
  return { changed: true };
}

/** Hook for server actions: call after ANY change to a model's official prices / pricing rule or a route's cost / enabled / priority. Never throws. */
export async function onModelPricingInputsChanged(modelId: string): Promise<{ changed: boolean }> {
  try {
    return await recomputeModelPrices(modelId);
  } catch (err) {
    logger.error("pricing recompute failed", { modelId, err });
    return { changed: false };
  }
}

/** Set the pricing rule on many models at once and recompute their prices. */
export async function applyPricingRule(modelIds: string[], rule: PricingRule): Promise<{ updated: number }> {
  const ids = [...new Set(modelIds.filter(Boolean))];
  if (!ids.length) return { updated: 0 };
  const problem = validateRule(rule);
  if (problem) throw new Error(problem);
  const value = rule.mode === "FIXED" || rule.value === null ? null : toDbString(new Decimal(rule.value));
  const adjust = rule.mode === "FIXED" || rule.adjust === null || rule.adjust === undefined || rule.adjust === 0 ? null : toDbString(new Decimal(rule.adjust));
  const res = await db.model.updateMany({ where: { id: { in: ids } }, data: { pricingMode: rule.mode, pricingValue: value, ...(rule.adjust !== undefined ? { pricingAdjust: adjust } : {}) } });
  if (rule.mode !== "FIXED") {
    for (const id of ids) await recomputeModelPrices(id);
  }
  await invalidateGatewayConfig("models");
  return { updated: res.count };
}
