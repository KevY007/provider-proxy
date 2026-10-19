import { describe, expect, it } from "vitest";
import { cleanNumber, deriveUnitPrice, previewPricing, validateRule } from "@/server/pricing/preview";

describe("previewPricing", () => {
  it("MARKUP_OVER_COST: customer = cost x (1 + value/100), savings vs official, margin on the customer price", () => {
    const p = previewPricing({
      rule: { mode: "MARKUP_OVER_COST", value: 30 },
      official: { input: 2.5, output: 10 },
      cost: { input: 2.5, output: 10 },
    });
    expect(p.customer).toEqual({ input: 3.25, output: 13 });
    expect(p.savingsPct.input).toBeCloseTo(-30, 9); // above the official price: negative, never hidden
    expect(p.marginPct.input).toBeCloseTo(23.0769230769, 6);
    expect(p.warnings).toContain("Input: customer price is above the official price");
  });

  it("PERCENT_OF_OFFICIAL: customer = official x value/100 (savings = 100 - value)", () => {
    const p = previewPricing({ rule: { mode: "PERCENT_OF_OFFICIAL", value: 40 }, official: { input: 10, output: 50 }, cost: { input: 3, output: 20 } });
    expect(p.customer).toEqual({ input: 4, output: 20 });
    expect(p.savingsPct.input).toBe(60);
    expect(p.savingsPct.output).toBe(60);
    expect(p.marginPct.input).toBeCloseTo(25, 9); // (4 - 3) / 4
    expect(p.marginPct.output).toBe(0);
    expect(p.warnings.join("\n")).toMatch(/Output: customer price equals our cost/);
  });

  it("FIXED uses the typed prices", () => {
    const p = previewPricing({ rule: { mode: "FIXED", value: null }, official: { input: 2, output: 8 }, cost: { input: 1, output: 4 }, fixed: { input: 1.5, output: 6 } });
    expect(p.customer).toEqual({ input: 1.5, output: 6 });
    expect(p.savingsPct).toEqual({ input: 25, output: 25 });
    expect(p.marginPct.input).toBeCloseTo(33.3333, 3);
  });

  it("applies the group x customer multiplier to the customer price (and to savings / margin)", () => {
    const p = previewPricing({ rule: { mode: "FIXED", value: null }, official: { input: 10 }, cost: { input: 4 }, fixed: { input: 8 }, multiplier: 0.5 });
    expect(p.customer.input).toBe(4);
    expect(p.savingsPct.input).toBe(60);
    expect(p.marginPct.input).toBe(0);
  });

  it("warns on a loss", () => {
    const p = previewPricing({ rule: { mode: "FIXED", value: null }, official: { output: 10 }, cost: { output: 8 }, fixed: { output: 5 } });
    expect(p.warnings).toContain("Output: customer price is below our cost (loss)");
    expect(p.marginPct.output).toBe(-60);
  });

  it("warns about a missing official price and a missing cost", () => {
    const noOfficial = previewPricing({ rule: { mode: "FIXED", value: null }, official: {}, cost: { input: 1 }, fixed: { input: 2 } });
    expect(noOfficial.savingsPct.input).toBeNull();
    expect(noOfficial.warnings).toContain("Input: no official price set, savings cannot be shown");
    const noCost = previewPricing({ rule: { mode: "FIXED", value: null }, official: { input: 3 }, cost: {}, fixed: { input: 2 } });
    expect(noCost.marginPct.input).toBeNull();
    expect(noCost.warnings).toContain("Input: no cost on the primary route, margin unknown");
  });

  it("a rule without a basis for a unit keeps the typed price and says so", () => {
    const p = previewPricing({ rule: { mode: "PERCENT_OF_OFFICIAL", value: 50 }, official: { input: 4 }, cost: { input: 1, image: 0.01 }, fixed: { image: 0.03 } });
    expect(p.customer).toEqual({ input: 2, image: 0.03 });
    expect(p.warnings.join("\n")).toMatch(/Image: no official price, so the rule cannot price this unit/);
  });

  it("covers per-second / per-image / per-request units", () => {
    const p = previewPricing({ rule: { mode: "MARKUP_OVER_COST", value: 30 }, official: { perSecond: 0.1, image: 0.04, request: 0.001 }, cost: { perSecond: 0.1, image: 0.04, request: 0.001 } });
    expect(p.customer).toEqual({ perSecond: 0.13, image: 0.052, request: 0.0013 });
  });

  it("an invalid rule yields a warning and no rule-based price", () => {
    const p = previewPricing({ rule: { mode: "MARKUP_OVER_COST", value: null }, official: { input: 1 }, cost: { input: 1 } });
    expect(p.customer.input).toBeNull();
    expect(p.warnings[0]).toMatch(/markup/i);
  });

  it("flags a zero price for a unit that has a cost", () => {
    const p = previewPricing({ rule: { mode: "FIXED", value: null }, official: { input: 1 }, cost: { input: 0.5 }, fixed: { input: 0 } });
    expect(p.warnings.join("\n")).toMatch(/zero/);
  });

  it("is free of float noise", () => {
    expect(cleanNumber(0.15 * 1.3)).toBe(0.195);
    expect(deriveUnitPrice({ mode: "MARKUP_OVER_COST", value: 30 }, null, 0.15)).toBe(0.195);
    expect(deriveUnitPrice({ mode: "PERCENT_OF_OFFICIAL", value: 33 }, 3, null)).toBe(0.99);
  });

  it("validates rules", () => {
    expect(validateRule({ mode: "FIXED", value: null })).toBeNull();
    expect(validateRule({ mode: "PERCENT_OF_OFFICIAL", value: 0 })).toMatch(/between/);
    expect(validateRule({ mode: "PERCENT_OF_OFFICIAL", value: 60 })).toBeNull();
    expect(validateRule({ mode: "MARKUP_OVER_COST", value: -100 })).toMatch(/greater than -100/);
    expect(validateRule({ mode: "MARKUP_OVER_COST", value: -20 })).toBeNull();
    expect(validateRule({ mode: "MARKUP_OVER_COST", value: null })).toMatch(/Enter/);
  });
});
