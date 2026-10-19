import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbOk } from "../gateway/harness";
import { MARKUP_FALLBACK_RULE, MATCH_OFFICIAL_RULE, defaultRuleForKnown, hasOfficialPrice, migrateSeededMarkupRules } from "@/server/pricing/default-policy";
import { lookupKnownPrice } from "@/gateway/price-catalog";
import { db } from "@/lib/db";

describe("defaultRuleForKnown (pure)", () => {
  it("matches the official price when the catalog has one", () => {
    expect(defaultRuleForKnown({ official: { input: 1, output: 5 } })).toEqual({ mode: "PERCENT_OF_OFFICIAL", value: 100 });
    expect(defaultRuleForKnown({ official: { image: 0.04 } })).toBe(MATCH_OFFICIAL_RULE);
    const k = lookupKnownPrice("anthropic", "claude-haiku-4-5-20251001")!;
    expect(defaultRuleForKnown(k)).toBe(MATCH_OFFICIAL_RULE);
  });

  it("falls back to +30% over cost without an official price (zero / missing do not count)", () => {
    expect(defaultRuleForKnown({ official: {} })).toEqual({ mode: "MARKUP_OVER_COST", value: 30 });
    expect(defaultRuleForKnown({ official: { input: 0, output: 0 } })).toBe(MARKUP_FALLBACK_RULE);
    expect(hasOfficialPrice({ official: { input: 0, output: 0.01 } })).toBe(true);
  });
});

describe.skipIf(!dbOk)("migrateSeededMarkupRules (database)", () => {
  const sfx = Math.random().toString(36).slice(2, 8);
  const ids = { models: [] as string[], providers: [] as string[] };
  let providerId = "";

  async function model(tag: string, data: Record<string, unknown> = {}) {
    const m = await db.model.create({
      data: {
        slug: `dp-${tag}-${sfx}`,
        displayName: tag,
        vendor: "t",
        capabilities: ["chat"],
        officialInputPrice: "10",
        officialOutputPrice: "40",
        pricingMode: "MARKUP_OVER_COST",
        pricingValue: "30",
        inputPrice: "2.6",
        outputPrice: "10.4",
        ...data,
      } as never,
    });
    ids.models.push(m.id);
    await db.modelRoute.create({ data: { modelId: m.id, providerId, upstreamModel: `up-${tag}`, inputCost: "2", outputCost: "8" } as never });
    return m;
  }

  beforeAll(async () => {
    const p = await db.provider.create({ data: { name: `dp-${sfx}`, slug: `dp-${sfx}`, preset: "custom", baseUrl: "http://127.0.0.1:1/v1", formats: ["openai_chat"] } });
    providerId = p.id;
    ids.providers.push(p.id);
  });

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { targetType: "Model", targetId: { in: ids.models } } });
    await db.modelRoute.deleteMany({ where: { modelId: { in: ids.models } } });
    await db.model.deleteMany({ where: { id: { in: ids.models } } });
    await db.provider.deleteMany({ where: { id: { in: ids.providers } } });
  });

  it("migrates untouched models with an official price; keeps audited models and models without one", async () => {
    const fresh = await model("fresh");
    const audited = await model("audited");
    const noOfficial = await model("noofficial", { officialInputPrice: null, officialOutputPrice: null });
    const zeroOfficial = await model("zero", { officialInputPrice: "0", officialOutputPrice: "0" });
    const otherRule = await model("other", { pricingValue: "50" });
    await db.auditLog.create({ data: { action: "model.update", targetType: "Model", targetId: audited.id } });
    const scope = [fresh.id, audited.id, noOfficial.id, zeroOfficial.id, otherRule.id];

    // dry run: classification only, nothing written
    const dry = await migrateSeededMarkupRules({ dryRun: true, modelIds: scope });
    expect(dry.migrated).toEqual([fresh.slug]);
    expect([...dry.kept].sort()).toEqual([audited.slug, noOfficial.slug, zeroOfficial.slug].sort());
    expect((await db.model.findUniqueOrThrow({ where: { id: fresh.id } })).pricingMode).toBe("MARKUP_OVER_COST");

    const res = await migrateSeededMarkupRules({ modelIds: scope });
    expect(res.migrated).toEqual([fresh.slug]);

    const after = await db.model.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(after.pricingMode).toBe("PERCENT_OF_OFFICIAL");
    expect(Number(after.pricingValue)).toBe(100);
    expect(after.inputPrice.toString()).toBe("10");
    expect(after.outputPrice.toString()).toBe("40");

    for (const id of [audited.id, noOfficial.id, zeroOfficial.id]) {
      const m = await db.model.findUniqueOrThrow({ where: { id } });
      expect(m.pricingMode).toBe("MARKUP_OVER_COST");
      expect(m.inputPrice.toString()).toBe("2.6");
    }
    const other = await db.model.findUniqueOrThrow({ where: { id: otherRule.id } });
    expect(Number(other.pricingValue)).toBe(50); // not the seeded default: never a candidate

    // idempotent: nothing left to migrate
    const again = await migrateSeededMarkupRules({ modelIds: scope });
    expect(again.migrated).toEqual([]);
  });
});
