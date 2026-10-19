import { describe, expect, it } from "vitest";
import { effectiveMultiplier, effectivePrices, estimateCost, formatMultiplier, formatSavings, groupAllowsModel, savingsPercent } from "@/server/customer/pricing";

describe("effective price calculation", () => {
  it("multiplies group x user multiplier (user override defaults to 1)", () => {
    expect(effectiveMultiplier("0.8").toString()).toBe("0.8");
    expect(effectiveMultiplier("0.8", null).toString()).toBe("0.8");
    expect(effectiveMultiplier("0.8", "0.5").toString()).toBe("0.4");
    expect(effectiveMultiplier("1", "1.25").toString()).toBe("1.25");
  });

  it("applies the multiplier to every price field and keeps nulls", () => {
    const p = effectivePrices({ inputPrice: "5", outputPrice: "25", cachedInputPrice: "0.5", imagePrice: "0.02" }, "0.8");
    expect(p.input).toBe("4");
    expect(p.output).toBe("20");
    expect(p.cachedInput).toBe("0.4");
    expect(p.image).toBe("0.016");
    expect(p.cacheWrite).toBeNull();
    expect(p.request).toBeNull();
  });

  it("computes savings vs official with a 3:1 input:output blend", () => {
    // official 10/50 -> blend 80, ours 5/25 -> blend 40 => 50% off
    expect(savingsPercent({ officialInputPrice: "10", officialOutputPrice: "50" }, { input: "5", output: "25" })).toBeCloseTo(50, 6);
    expect(savingsPercent({ officialInputPrice: null, officialOutputPrice: null }, { input: "5", output: "25" })).toBeNull();
    expect(savingsPercent({ officialInputPrice: "0", officialOutputPrice: "0" }, { input: "1", output: "1" })).toBeNull();
    expect(formatSavings(49.6)).toBe("50% off");
    expect(formatSavings(-5)).toBe("+5%");
    expect(formatSavings(null)).toBe("-");
  });

  it("estimates the cost of a usage report (cached tokens use the cached rate)", () => {
    const prices = { input: "2", output: "10", cachedInput: "0.2", image: null, request: null };
    // 900 uncached*2 + 100 cached*0.2 + 500 out*10 = 1800 + 20 + 5000 = 6820 per 1M
    expect(estimateCost({ inputTokens: 1000, outputTokens: 500, cachedTokens: 100 }, prices).toString()).toBe("0.00682");
    expect(estimateCost({ inputTokens: 0, outputTokens: 0, images: 2 }, { ...prices, image: "0.04" }).toString()).toBe("0.08");
  });

  it("filters models by group allow-list (empty = all) including aliases", () => {
    expect(groupAllowsModel({ allowedModels: [] }, "gpt-6")).toBe(true);
    expect(groupAllowsModel({ allowedModels: ["gpt-6"] }, "gpt-6")).toBe(true);
    expect(groupAllowsModel({ allowedModels: ["gpt-6"] }, "claude")).toBe(false);
    expect(groupAllowsModel({ allowedModels: ["alias"] }, "gpt-6", ["alias"])).toBe(true);
  });

  it("formats multipliers", () => {
    expect(formatMultiplier("0.8000")).toBe("0.8×");
    expect(formatMultiplier(1)).toBe("1×");
  });
});
