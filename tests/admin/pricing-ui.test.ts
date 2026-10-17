import { describe, expect, it } from "vitest";
import { primaryEnabledRoute, compactUnits, fmtPct, modelFieldsSchema, MODEL_PRICE_PAIRS, OFFICIAL_PRICE_FIELDS, rowUnits, summarizeRow, toPriceTable } from "@/server/admin/models-calc";
import { defaultRule, knownSummary, officialAsCost, prettyModelName, slugifyModelId, stepForField, tableToFields, uniqueName, validatePublicName } from "@/server/admin/wizard-calc";
import { deriveQuickStart } from "@/server/admin/quickstart";
import { addCreditSchema, creditDescription, creditLabelFromDescription, grantCreditsSchema } from "@/server/admin/credits";
import { friendlySettingIssue } from "@/server/admin/settings-calc";

const base = { slug: "m", displayName: "M", vendor: "v", capabilities: ["chat"] };

describe("model schema (9c fields)", () => {
  it("accepts per-second, all official fields, rule and retire date", () => {
    const r = modelFieldsSchema.parse({ ...base, perSecondPrice: "0.4", officialPerSecondPrice: 0.5, officialImagePrice: "0.04", pricingMode: "PERCENT_OF_OFFICIAL", pricingValue: "70", retiresAt: "2026-12-01" });
    expect(r.perSecondPrice).toBe("0.4");
    expect(r.officialPerSecondPrice).toBe("0.5");
    expect(r.retiresAt).toBeInstanceOf(Date);
    expect(r.retiresAt?.toISOString().slice(0, 10)).toBe("2026-12-01");
  });

  it("accepts the video capability and tiny numeric prices", () => {
    expect(modelFieldsSchema.safeParse({ ...base, capabilities: ["video"], inputPrice: 1e-7 }).success).toBe(true);
  });

  it("requires a value for percent / markup rules with a friendly message", () => {
    const bad = modelFieldsSchema.safeParse({ ...base, pricingMode: "MARKUP_OVER_COST" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].message).toMatch(/markup percent/);
    expect(modelFieldsSchema.safeParse({ ...base, pricingMode: "FIXED" }).success).toBe(true);
    expect(modelFieldsSchema.safeParse({ ...base, retiresAt: "not a date" }).success).toBe(false);
  });

  it("has an official field for every unit that can be billed", () => {
    const official = OFFICIAL_PRICE_FIELDS.map((f) => f.key);
    for (const k of ["officialInputPrice", "officialImagePrice", "officialPerSecondPrice", "officialPerMinutePrice", "officialPerMillionChars", "officialAudioInputPrice", "officialCacheWritePrice", "officialRequestPrice"]) {
      expect(official).toContain(k);
    }
    expect(MODEL_PRICE_PAIRS.find((p) => p.cost === "perSecondCost")?.sell).toBe("perSecondPrice");
  });
});

describe("row summaries (Official / Our cost / Customer price / Savings / Margin)", () => {
  const model = { inputPrice: "3", outputPrice: "12", officialInputPrice: "5", officialOutputPrice: "20" };
  const route = { inputCost: "2", outputCost: "10" };

  it("computes worst margin and blended savings", () => {
    const units = rowUnits(model, route);
    const s = summarizeRow(units);
    expect(s.loss).toBe(false);
    expect(s.marginPct).toBeCloseTo(((12 - 10) / 12) * 100, 5); // output (16.7%) is worse than input (33.3%)
  });

  it("flags a loss when the customer price is below our cost", () => {
    const s = summarizeRow(rowUnits({ ...model, outputPrice: "8" }, route));
    expect(s.loss).toBe(true);
    expect(s.marginPct).toBeLessThan(0);
  });

  it("savings is blended 3:1 and negative when we are more expensive", () => {
    const cheap = summarizeRow(rowUnits(model, route));
    expect(cheap.savingsPct).toBeCloseTo((1 - (3 * 3 + 12) / (5 * 3 + 20)) * 100, 5);
    const dear = summarizeRow(rowUnits({ ...model, inputPrice: "6", outputPrice: "24" }, route));
    expect(dear.savingsPct).toBeLessThan(0);
  });

  it("video models are listed by the per-second unit only", () => {
    const units = rowUnits({ perSecondPrice: "0.4", officialPerSecondPrice: "0.5" }, { perSecondCost: "0.3" });
    expect(units.map((u) => u.key)).toEqual(["perSecond"]);
    expect(compactUnits(units, "price").text).toBe("$0.4 /sec");
    expect(summarizeRow(units).marginPct).toBeCloseTo(25);
  });

  it("formats compact prices and percentages", () => {
    expect(compactUnits(rowUnits(model, route), "official").text).toBe("$5.00 / $20.00");
    expect(compactUnits(rowUnits({}, null), "price").any).toBe(false);
    expect(fmtPct(null)).toBe("-");
    expect(fmtPct(12.345, 1)).toBe("12.3%");
  });

  it("picks the primary route: highest priority enabled, then weight (matches the server rule)", () => {
    const r = primaryEnabledRoute([
      { id: "a", enabled: false, priority: 9, weight: 1 },
      { id: "b", enabled: true, priority: 1, weight: 1 },
      { id: "c", enabled: true, priority: 5, weight: 1 },
      { id: "d", enabled: true, priority: 5, weight: 3 },
      { id: "e", enabled: true, priority: 5, weight: 3 },
    ]);
    expect(r?.id).toBe("d");
    expect(primaryEnabledRoute([{ id: "a", enabled: false, priority: 0, weight: 1 }])).toBeNull();
  });

  it("maps form records to price tables", () => {
    const t = toPriceTable({ officialInputPrice: "5", officialPerSecondPrice: "", officialOutputPrice: null }, (p) => p.official);
    expect(t.input).toBe(5);
    expect(t.perSecond).toBeNull();
    expect(t.output).toBeNull();
  });
});

describe("add-model wizard helpers", () => {
  it("slugifies upstream ids and keeps names unique", () => {
    expect(slugifyModelId("models/Gemini 3.1 Pro")).toBe("gemini-3.1-pro");
    expect(slugifyModelId("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(uniqueName("gpt-4o", ["GPT-4o", "gpt-4o-2"])).toBe("gpt-4o-3");
    expect(uniqueName("fresh", ["x"])).toBe("fresh");
  });

  it("makes readable display names", () => {
    expect(prettyModelName("gpt-4o-mini")).toBe("GPT 4o Mini");
    expect(prettyModelName("claude-opus-4-5-20251101")).toBe("Claude Opus 4 5");
  });

  it("prefills official prices and (for direct providers) cost from the catalog", () => {
    const official = { input: 2.5, output: 10, cachedInput: 1.25, image: 0.04 };
    expect(tableToFields(official, "official")).toMatchObject({ officialInputPrice: "2.5", officialOutputPrice: "10", officialCachedPrice: "1.25", officialImagePrice: "0.04" });
    expect(officialAsCost(official)).toMatchObject({ inputCost: "2.5", outputCost: "10", cachedInputCost: "1.25", imageCost: "0.04" });
    expect(tableToFields(null, "cost")).toEqual({});
  });

  it("chooses a default pricing rule", () => {
    expect(defaultRule({ officialInputPrice: "5" })).toEqual({ mode: "PERCENT_OF_OFFICIAL", value: "100" });
    expect(defaultRule({ inputCost: "1" })).toEqual({ mode: "MARKUP_OVER_COST", value: "30" });
    expect(defaultRule({}).mode).toBe("FIXED");
  });

  it("summarises known prices and validates the public name", () => {
    expect(knownSummary({ input: 2.5, output: 10 })).toBe("$2.5 in / $10 out per 1M");
    expect(knownSummary({ perSecond: 0.4 })).toBe("$0.4 per second");
    expect(validatePublicName("", [])).toMatch(/Enter/);
    expect(validatePublicName("bad name", [])).toMatch(/letters/i);
    expect(validatePublicName("Taken", ["taken"])).toMatch(/already exists/);
    expect(validatePublicName("fine-name", ["taken"])).toBeNull();
  });

  it("jumps back to the step that owns a server field error", () => {
    expect(stepForField("providerId")).toBe(1);
    expect(stepForField("upstreamModel")).toBe(2);
    expect(stepForField("slug")).toBe(3);
    expect(stepForField("inputCost")).toBe(3);
    expect(stepForField("pricingValue")).toBe(4);
    expect(stepForField("perSecondPrice")).toBe(4);
  });
});

describe("admin quick start checklist", () => {
  const empty = { activeKeys: 0, testedProviders: 0, liveModels: 0, pricedModels: 0, customerRequests: 0 };

  it("starts at step 1 and ticks each step from DB state", () => {
    const s0 = deriveQuickStart(empty);
    expect(s0.doneCount).toBe(0);
    expect(s0.next?.id).toBe("key");
    const s2 = deriveQuickStart({ ...empty, activeKeys: 1, testedProviders: 1 });
    expect(s2.steps.map((s) => s.done)).toEqual([true, true, false, false, false]);
    expect(s2.next?.id).toBe("models");
  });

  it("is hidden (allDone) when everything is set up", () => {
    const all = deriveQuickStart({ activeKeys: 3, testedProviders: 1, liveModels: 4, pricedModels: 4, customerRequests: 10 });
    expect(all.allDone).toBe(true);
    expect(all.next).toBeNull();
    expect(deriveQuickStart({ activeKeys: 3, testedProviders: 1, liveModels: 4, pricedModels: 0, customerRequests: 10 }).allDone).toBe(false);
  });
});

describe("admin credits", () => {
  it("labels credits clearly in billing history", () => {
    expect(creditLabelFromDescription("ADJUSTMENT", creditDescription("promotional", "Launch bonus"))).toBe("Promotional credit");
    expect(creditLabelFromDescription("REFUND", creditDescription("refund", "Failed request"))).toBe("Refund credit");
    expect(creditLabelFromDescription("ADJUSTMENT", creditDescription("correction", "Double charge"))).toBe("Correction");
    expect(creditLabelFromDescription("ADJUSTMENT", "Manual top up")).toBeNull();
    expect(creditLabelFromDescription("REFUND", "Promotional credit: x")).toBeNull();
  });

  it("validates amount sign per kind and requires a reason", () => {
    expect(addCreditSchema.safeParse({ userId: "u", kind: "promotional", amount: "25", reason: "Launch" }).success).toBe(true);
    const neg = addCreditSchema.safeParse({ userId: "u", kind: "promotional", amount: "-5", reason: "Launch" });
    expect(neg.success).toBe(false);
    expect(addCreditSchema.safeParse({ userId: "u", kind: "correction", amount: "-5", reason: "Oops" }).success).toBe(true);
    const short = addCreditSchema.safeParse({ userId: "u", kind: "refund", amount: "5", reason: "x" });
    expect(short.success).toBe(false);
    if (!short.success) expect(short.error.issues[0].message).toMatch(/reason/);
    expect(addCreditSchema.safeParse({ userId: "u", kind: "refund", amount: "9999999", reason: "too much" }).success).toBe(false);
  });

  it("bulk grants need at least one customer", () => {
    expect(grantCreditsSchema.safeParse({ userIds: [], kind: "promotional", amount: "5", reason: "Hello" }).success).toBe(false);
    expect(grantCreditsSchema.safeParse({ userIds: ["a", "b"], kind: "promotional", amount: "5", reason: "Hello" }).success).toBe(true);
  });
});

describe("friendly settings validation", () => {
  it("replaces raw zod text with plain sentences", () => {
    expect(friendlySettingIssue("Max upstream attempts", { code: "too_small", minimum: 1, origin: "number" })).toBe("Max upstream attempts must be at least 1.");
    expect(friendlySettingIssue("Minimum top-up (USD)", { code: "too_big", maximum: 100000, origin: "number" })).toBe("Minimum top-up (USD) must be at most 100,000.");
    expect(friendlySettingIssue("Site name", { code: "too_small", minimum: 1, origin: "string" })).toBe("Site name can't be empty.");
    expect(friendlySettingIssue("Max upstream attempts", { code: "invalid_type", expected: "int" })).toMatch(/whole number/);
    expect(friendlySettingIssue("X", { code: "invalid_type", expected: "number" })).toBe("X must be a number.");
    expect(friendlySettingIssue("X", undefined)).toMatch(/isn't valid/);
  });
});
