import "server-only";
import { onModelPricingInputsChanged } from "@/server/pricing/rules";

/**
 * Call after saving a model's official prices / pricing rule, or after any route cost / enabled / priority change, so
 * rule-driven customer prices are re-derived (`onModelPricingInputsChanged` never throws and is a no-op for FIXED models).
 */
export async function afterPricingChange(modelId: string): Promise<void> {
  await onModelPricingInputsChanged(modelId);
}
