import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbOk } from "../gateway/harness";
import { deriveSellUpdates, knownCostFields, knownOfficialFields, knownSellFields } from "@/server/pricing/fields";
import { applyPricingRule, onModelPricingInputsChanged, recomputeModelPrices } from "@/server/pricing/rules";
import { lookupKnownPrice } from "@/gateway/price-catalog";
import { db } from "@/lib/db";

describe("deriveSellUpdates (pure)", () => {
  const model = { inputPrice: "9", outputPrice: "9", cachedInputPrice: null, officialInputPrice: "10", officialOutputPrice: "50", officialCachedPrice: "1", officialImagePrice: "0.04" };
  const route = { inputCost: "3", outputCost: "20", cachedInputCost: "0.3", cacheWriteCost: "3.75", cacheWrite1hCost: "6", imageCost: null, perSecondCost: "0.05" };

  it("PERCENT_OF_OFFICIAL prices every unit that has an official price and leaves the others alone", () => {
    const u = deriveSellUpdates(model, route, { mode: "PERCENT_OF_OFFICIAL", value: 40 });
    expect(u).toEqual({ inputPrice: "4.000000000000", outputPrice: "20.000000000000", cachedInputPrice: "0.400000000000", imagePrice: "0.016000000000" });
  });

  it("MARKUP_OVER_COST prices every unit that has a cost (incl. the 1h cache write) and leaves the others alone", () => {
    const u = deriveSellUpdates(model, route, { mode: "MARKUP_OVER_COST", value: 30 });
    expect(u).toEqual({
      inputPrice: "3.900000000000",
      outputPrice: "26.000000000000",
      cachedInputPrice: "0.390000000000",
      cacheWritePrice: "4.875000000000",
      cacheWrite1hPrice: "7.800000000000",
      perSecondPrice: "0.065000000000",
    });
  });

  it("returns only what changes, and nothing for FIXED / a missing value / no primary route", () => {
    expect(deriveSellUpdates({ inputPrice: "3.9", outputPrice: "26" }, { inputCost: "3", outputCost: "20" }, { mode: "MARKUP_OVER_COST", value: 30 })).toEqual({});
    expect(deriveSellUpdates(model, route, { mode: "FIXED", value: null })).toEqual({});
    expect(deriveSellUpdates(model, route, { mode: "MARKUP_OVER_COST", value: null })).toEqual({});
    expect(deriveSellUpdates(model, null, { mode: "MARKUP_OVER_COST", value: 30 })).toEqual({});
  });

  it("is exact (no float noise)", () => {
    const u = deriveSellUpdates({}, { inputCost: "0.15", outputCost: "0.6" }, { mode: "MARKUP_OVER_COST", value: 30 });
    expect(u.inputPrice).toBe("0.195000000000");
    expect(u.outputPrice).toBe("0.780000000000");
  });
});

describe("known price -> columns", () => {
  it("maps the catalog onto official / cost / sell columns", () => {
    const k = lookupKnownPrice("anthropic", "claude-haiku-4-5-20251001")!;
    expect(knownOfficialFields(k)).toMatchObject({ officialInputPrice: "1.000000000000", officialOutputPrice: "5.000000000000", officialCachedPrice: "0.100000000000", officialCacheWritePrice: "1.250000000000", officialImagePrice: null });
    expect(knownCostFields(k)).toMatchObject({ inputCost: "1.000000000000", cacheWriteCost: "1.250000000000", cacheWrite1hCost: "2.000000000000", imageCost: null });
    expect(knownSellFields(k, { mode: "MARKUP_OVER_COST", value: 30 })).toMatchObject({ inputPrice: "1.300000000000", outputPrice: "6.500000000000", cacheWrite1hPrice: "2.600000000000" });
    const img = lookupKnownPrice("fal", "fal-ai/flux/schnell")!;
    expect(knownCostFields(img)).toMatchObject({ inputCost: "0.000000000000", outputCost: "0.000000000000", imageCost: "0.003000000000" });
    expect(knownSellFields(img, { mode: "MARKUP_OVER_COST", value: 30 }).imagePrice).toBe("0.003900000000");
  });
});

describe.skipIf(!dbOk)("recomputeModelPrices / applyPricingRule (database)", () => {
  const sfx = Math.random().toString(36).slice(2, 8);
  const ids = { models: [] as string[], providers: [] as string[] };
  let providerId = "";

  async function model(tag: string, data: Record<string, unknown> = {}) {
    const m = await db.model.create({
      data: { slug: `pr-${tag}-${sfx}`, displayName: tag, vendor: "t", capabilities: ["chat"], officialInputPrice: "10", officialOutputPrice: "40", pricingMode: "MARKUP_OVER_COST", pricingValue: "30", inputPrice: "0", outputPrice: "0", ...data } as never,
    });
    ids.models.push(m.id);
    return m;
  }
  const route = (modelId: string, upstream: string, data: Record<string, unknown> = {}) =>
    db.modelRoute.create({ data: { modelId, providerId, upstreamModel: upstream, inputCost: "2", outputCost: "8", ...data } as never });

  beforeAll(async () => {
    const p = await db.provider.create({ data: { name: `pr-${sfx}`, slug: `pr-${sfx}`, preset: "custom", baseUrl: "http://127.0.0.1:1/v1", formats: ["openai_chat"] } });
    providerId = p.id;
    ids.providers.push(p.id);
  });

  afterAll(async () => {
    await db.modelRoute.deleteMany({ where: { modelId: { in: ids.models } } });
    await db.model.deleteMany({ where: { id: { in: ids.models } } });
    await db.provider.deleteMany({ where: { id: { in: ids.providers } } });
  });

  it("derives the prices from the PRIMARY route (highest priority, enabled) and leaves units without a basis untouched", async () => {
    const m = await model("primary", { imagePrice: "0.5" });
    await route(m.id, "low", { priority: 1, inputCost: "100", outputCost: "100" });
    await route(m.id, "primary", { priority: 5, inputCost: "2", outputCost: "8" });
    await route(m.id, "disabled", { priority: 9, enabled: false, inputCost: "1000", outputCost: "1000" });
    expect(await recomputeModelPrices(m.id)).toEqual({ changed: true });
    const row = await db.model.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.inputPrice.toString()).toBe("2.6");
    expect(row.outputPrice.toString()).toBe("10.4");
    expect(row.imagePrice?.toString()).toBe("0.5"); // no image cost -> untouched
    expect(await recomputeModelPrices(m.id)).toEqual({ changed: false }); // idempotent
  });

  it("follows a cost change (the hook UI actions call) and an official-price change for PERCENT_OF_OFFICIAL", async () => {
    const m = await model("follow");
    const r = await route(m.id, "r1", { inputCost: "2", outputCost: "8" });
    await onModelPricingInputsChanged(m.id);
    expect((await db.model.findUniqueOrThrow({ where: { id: m.id } })).inputPrice.toString()).toBe("2.6");
    await db.modelRoute.update({ where: { id: r.id }, data: { inputCost: "4" } });
    expect(await onModelPricingInputsChanged(m.id)).toEqual({ changed: true });
    expect((await db.model.findUniqueOrThrow({ where: { id: m.id } })).inputPrice.toString()).toBe("5.2");

    await db.model.update({ where: { id: m.id }, data: { pricingMode: "PERCENT_OF_OFFICIAL", pricingValue: "50", officialInputPrice: "12" } });
    await onModelPricingInputsChanged(m.id);
    const row = await db.model.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.inputPrice.toString()).toBe("6");
    expect(row.outputPrice.toString()).toBe("20");
  });

  it("FIXED models are never touched", async () => {
    const m = await model("fixed", { pricingMode: "FIXED", pricingValue: null, inputPrice: "7", outputPrice: "9" });
    await route(m.id, "r", { inputCost: "1", outputCost: "1" });
    expect(await recomputeModelPrices(m.id)).toEqual({ changed: false });
    expect((await db.model.findUniqueOrThrow({ where: { id: m.id } })).inputPrice.toString()).toBe("7");
  });

  it("applyPricingRule sets the rule on many models and recomputes them; FIXED just records the mode", async () => {
    const a = await model("bulk-a", { pricingMode: "FIXED", pricingValue: null });
    const b = await model("bulk-b", { pricingMode: "FIXED", pricingValue: null });
    await route(a.id, "ra", { inputCost: "1", outputCost: "2" });
    await route(b.id, "rb", { inputCost: "3", outputCost: "4" });
    expect(await applyPricingRule([a.id, b.id, "no-such-id"], { mode: "MARKUP_OVER_COST", value: 50 })).toEqual({ updated: 2 });
    const [ra, rb] = await Promise.all([db.model.findUniqueOrThrow({ where: { id: a.id } }), db.model.findUniqueOrThrow({ where: { id: b.id } })]);
    expect([ra.pricingMode, ra.pricingValue?.toString(), ra.inputPrice.toString(), ra.outputPrice.toString()]).toEqual(["MARKUP_OVER_COST", "50", "1.5", "3"]);
    expect([rb.inputPrice.toString(), rb.outputPrice.toString()]).toEqual(["4.5", "6"]);

    expect(await applyPricingRule([a.id], { mode: "PERCENT_OF_OFFICIAL", value: 70 })).toEqual({ updated: 1 });
    expect((await db.model.findUniqueOrThrow({ where: { id: a.id } })).inputPrice.toString()).toBe("7"); // 70% of official 10

    expect(await applyPricingRule([a.id], { mode: "FIXED", value: null })).toEqual({ updated: 1 });
    const fixed = await db.model.findUniqueOrThrow({ where: { id: a.id } });
    expect([fixed.pricingMode, fixed.pricingValue, fixed.inputPrice.toString()]).toEqual(["FIXED", null, "7"]);

    await expect(applyPricingRule([a.id], { mode: "MARKUP_OVER_COST", value: null })).rejects.toThrow(/markup/i);
    expect(await applyPricingRule([], { mode: "FIXED", value: null })).toEqual({ updated: 0 });
  });

  it("the hook never throws, even for a model that does not exist", async () => {
    expect(await onModelPricingInputsChanged("does-not-exist")).toEqual({ changed: false });
  });
});
