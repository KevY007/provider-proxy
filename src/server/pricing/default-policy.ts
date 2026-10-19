// DEFAULT customer-price policy (owner decision, report bug 9): models served through the maker's own API (our cost =
// the official list price) are sold at the official price - "match official", i.e. PERCENT_OF_OFFICIAL 100. A model with
// no official price cannot match an unknown number and keeps the old default, +30% over cost.
//
// The seed, `pnpm setup:live` and the admin "Add model" wizard all take their default from here; an admin can still pick
// any of the three rules for any model.
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { KnownPrice } from "@/gateway/price-catalog";
import type { PricingRule } from "./preview";
import { applyPricingRule } from "./rules";

/** Sell = official list price. */
export const MATCH_OFFICIAL_RULE: PricingRule = { mode: "PERCENT_OF_OFFICIAL", value: 100 };
/** For models with no official price: +30% over our cost (the former default for everything). */
export const MARKUP_FALLBACK_RULE: PricingRule = { mode: "MARKUP_OVER_COST", value: 30 };

/** Does the catalog entry carry any official price? */
export function hasOfficialPrice(k: Pick<KnownPrice, "official">): boolean {
  return Object.values(k.official).some((v) => typeof v === "number" && v > 0);
}

/** The default rule of a catalog model. */
export function defaultRuleForKnown(k: Pick<KnownPrice, "official">): PricingRule {
  return hasOfficialPrice(k) ? MATCH_OFFICIAL_RULE : MARKUP_FALLBACK_RULE;
}

const OFFICIAL_COLUMNS = [
  "officialInputPrice",
  "officialOutputPrice",
  "officialCachedPrice",
  "officialCacheWritePrice",
  "officialImagePrice",
  "officialRequestPrice",
  "officialAudioInputPrice",
  "officialAudioOutputPrice",
  "officialPerMinutePrice",
  "officialPerMillionChars",
  "officialPerSecondPrice",
] as const;

export interface MigrationResult {
  /** models switched from the old seeded default (MARKUP_OVER_COST 30) to "match official" */
  migrated: string[];
  /** models that carry the old default but were left alone (edited by an admin, or no official price to match) */
  kept: string[];
}

/**
 * Move models that still carry the OLD seeded default rule (MARKUP_OVER_COST +30%) to "match official", re-pricing them.
 * Only models that
 *   - have an official price (an unknown official cannot be matched), and
 *   - were never edited by an admin (no `model.*` AuditLog entry targets them)
 * are touched; everything else keeps its rule. Idempotent: a migrated model no longer matches.
 */
export async function migrateSeededMarkupRules(opts: { dryRun?: boolean; /** only consider these models (default: all) */ modelIds?: string[] } = {}): Promise<MigrationResult> {
  const candidates = await db.model.findMany({ where: { pricingMode: "MARKUP_OVER_COST", pricingValue: 30, ...(opts.modelIds ? { id: { in: opts.modelIds } } : {}) }, select: { id: true, slug: true, ...Object.fromEntries(OFFICIAL_COLUMNS.map((c) => [c, true])) } });
  if (!candidates.length) return { migrated: [], kept: [] };
  const edited = new Set(
    (
      await db.auditLog.findMany({
        where: { targetType: "Model", targetId: { in: candidates.map((c) => c.id) } },
        select: { targetId: true },
        distinct: ["targetId"],
      })
    ).map((a) => a.targetId),
  );
  const migrated: string[] = [];
  const kept: string[] = [];
  const ids: string[] = [];
  for (const m of candidates) {
    const row = m as unknown as Record<string, { toString(): string } | null>;
    const hasOfficial = OFFICIAL_COLUMNS.some((c) => row[c] !== null && Number(row[c]!.toString()) > 0);
    if (!hasOfficial || edited.has(m.id)) {
      kept.push(m.slug);
      continue;
    }
    migrated.push(m.slug);
    ids.push(m.id);
  }
  if (ids.length && !opts.dryRun) {
    try {
      await applyPricingRule(ids, MATCH_OFFICIAL_RULE);
    } catch (err) {
      logger.error("could not migrate the seeded pricing rule", { err });
      throw err;
    }
  }
  return { migrated, kept };
}
