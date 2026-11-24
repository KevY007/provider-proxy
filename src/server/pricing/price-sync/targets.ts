import { z } from "zod";

export const MAX_PRICING_TARGETS = 8;
export const pricingTargetsSchema = z.array(z.object({
  pool: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(128),
}).strict()).min(1, "Select at least one pool and model.").max(MAX_PRICING_TARGETS).refine(
  (targets) => new Set(targets.map(({ pool, model }) => JSON.stringify([pool, model]))).size === targets.length,
  "Each pool and model pair must be unique.",
);
export type PricingTarget = z.infer<typeof pricingTargetsSchema>[number];
export type PricingPoolOption = { pool: string; models: string[] };

export function unavailablePricingTarget(targets: PricingTarget[], options: PricingPoolOption[]): PricingTarget | undefined {
  return targets.find((target) => !options.some(({ pool, models }) => pool === target.pool && models.includes(target.model)));
}

/** Until an admin saves a list, keep using this installation's existing settings. */
export function pricingTargets(s: { priceSyncTargets: PricingTarget[] | null; priceSyncPool: string; priceSyncModel: string }): PricingTarget[] {
  return s.priceSyncTargets ?? [{ pool: s.priceSyncPool, model: s.priceSyncModel }];
}

/** Try each configured route in order; retain metering IDs even when an earlier route fails. */
export async function tryPricingTargets<T extends { requestId: string | null }>(
  targets: PricingTarget[],
  attempt: (target: PricingTarget) => Promise<T>,
): Promise<T & { requestIds: string[] }> {
  const requestIds: string[] = [];
  const failures: string[] = [];
  for (const target of targets) {
    try {
      const answer = await attempt(target);
      if (answer.requestId) requestIds.push(answer.requestId);
      return { ...answer, requestIds };
    } catch (err) {
      const id = (err as { requestId?: string } | null)?.requestId;
      if (id) requestIds.push(id);
      failures.push(`${target.pool} / ${target.model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw Object.assign(new Error(`Price sync AI routes failed: ${failures.join("; ")}`), { requestIds });
}
