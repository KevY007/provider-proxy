import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/money";
import {
  DEFAULT_BATCH_DISCOUNT_PCT,
  computeAmount,
  costTable,
  discountFactor,
  effectiveMultiplier,
  effectiveOfficial,
  estimatePrice,
  longContextFactor,
  officialTable,
  priceRequest,
  sellTable,
  toolTable,
} from "@/gateway/pricing";
import { deriveSellUpdates } from "@/server/pricing/fields";
import { emptyUsage, type Usage } from "@/gateway/types";

const usage = (p: Partial<Usage>): Usage => ({ ...emptyUsage(), ...p });

const sell = sellTable({
  inputPrice: "3",
  outputPrice: "15",
  cachedInputPrice: "0.3",
  cacheWritePrice: "3.75",
  cacheWrite1hPrice: "6",
});

describe("pricing", () => {
  it("bills plain input/output per 1M tokens", () => {
    const s = sellTable({ inputPrice: "1", outputPrice: "2" });
    const p = computeAmount(usage({ inputTokens: 1000, outputTokens: 500 }), s);
    expect(p.toString()).toBe("0.002");
  });

  it("applies the effective multiplier (user x group) to the price but never to the cost", () => {
    const mult = effectiveMultiplier("0.5", "0.8"); // 0.4
    expect(mult.toString()).toBe("0.4");
    const s = sellTable({ inputPrice: "1", outputPrice: "2" });
    const c = costTable({ inputCost: "0.5", outputCost: "1" });
    const b = priceRequest(usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), s, c, mult, null);
    expect(b.price.toString()).toBe("1.2"); // (1+2) * 0.4
    expect(b.cost.toString()).toBe("1.5"); // (0.5+1), no multiplier
    expect(b.profit.toString()).toBe("-0.3");
  });

  it("treats a missing user multiplier as 1", () => {
    expect(effectiveMultiplier(null, "0.8").toString()).toBe("0.8");
    expect(effectiveMultiplier(undefined, undefined).toString()).toBe("1");
  });

  it("prices cached reads and cache writes separately from uncached input", () => {
    // inputTokens is the TOTAL prompt: 1000 = 600 uncached + 300 cached + 100 cache-write
    const p = computeAmount(usage({ inputTokens: 1000, cachedTokens: 300, cacheWriteTokens: 100, outputTokens: 0 }), sell);
    const expected = new Decimal(600).times(3).plus(new Decimal(300).times(0.3)).plus(new Decimal(100).times(3.75)).div(1e6);
    expect(p.toString()).toBe(expected.toDecimalPlaces(12).toString());
  });

  it("bills the 1h cache-write portion at the 1h rate", () => {
    const p = computeAmount(usage({ inputTokens: 200, cacheWriteTokens: 200, cacheWrite1hTokens: 50 }), sell);
    const expected = new Decimal(150).times(3.75).plus(new Decimal(50).times(6)).div(1e6);
    expect(p.toString()).toBe(expected.toString());
  });

  it("falls back to the input price when cached / cache-write prices are null", () => {
    const s = sellTable({ inputPrice: "2", outputPrice: "0" });
    const p = computeAmount(usage({ inputTokens: 1_000_000, cachedTokens: 400_000, cacheWriteTokens: 100_000 }), s);
    expect(p.toString()).toBe("2");
  });

  it("includes reasoning tokens in output (they are part of outputTokens)", () => {
    const s = sellTable({ inputPrice: "0", outputPrice: "10" });
    const p = computeAmount(usage({ outputTokens: 1_000, reasoningTokens: 400 }), s);
    expect(p.toString()).toBe("0.01");
  });

  it("applies the long-context multiplier above the threshold to token components only", () => {
    const s = sellTable({ inputPrice: "2", outputPrice: "12", requestPrice: "0.01" });
    const lc = { threshold: 200_000, multiplier: new Decimal(2) };
    const small = computeAmount(usage({ inputTokens: 100_000, outputTokens: 1000 }), s, { longContext: lc });
    const big = computeAmount(usage({ inputTokens: 300_000, outputTokens: 1000 }), s, { longContext: lc });
    // small: 0.2 + 0.012 + 0.01 ; big: (0.6 + 0.012) * 2 + 0.01
    expect(small.toString()).toBe("0.222");
    expect(big.toString()).toBe("1.234");
    expect(longContextFactor(200_000, lc).toString()).toBe("1"); // strictly greater than
    expect(longContextFactor(200_001, lc).toString()).toBe("2");
  });

  it("long context with a separate output multiplier (OpenAI above 272K: input and cache reads 2x, output 1.5x)", () => {
    const s = sellTable({ inputPrice: "2", outputPrice: "10", cachedInputPrice: "0.2" });
    const lc = { threshold: 272_000, multiplier: new Decimal(2), outputMultiplier: new Decimal("1.5") };
    // 300K input (100K of it cached), 10K output: input 200K x 2 = 0.4, cached 100K x 0.2 = 0.02, output 10K x 10 = 0.1
    const big = computeAmount(usage({ inputTokens: 300_000, cachedTokens: 100_000, outputTokens: 10_000 }), s, { longContext: lc });
    expect(big.toString()).toBe(new Decimal("0.4").plus("0.02").times(2).plus(new Decimal("0.1").times("1.5")).toString()); // 0.99
    expect(longContextFactor(300_000, lc, "output").toString()).toBe("1.5");
    expect(longContextFactor(300_000, lc, "input").toString()).toBe("2");
    expect(longContextFactor(100_000, lc, "output").toString()).toBe("1");
    // no output multiplier: output follows the input multiplier (as before)
    expect(longContextFactor(300_000, { threshold: 272_000, multiplier: new Decimal(2) }, "output").toString()).toBe("2");
  });

  it("bills flat per-image prices instead of tokens, scaled by the multiplier", () => {
    const s = sellTable({ inputPrice: "10", outputPrice: "40", imagePrice: "0.04" });
    const p = computeAmount(usage({ imageCount: 3, inputTokens: 5000, outputTokens: 9000 }), s, { multiplier: "0.5" });
    expect(p.toString()).toBe("0.06");
  });

  it("bills image tokens when there is no per-image price", () => {
    const s = sellTable({ inputPrice: "5", outputPrice: "40" });
    const p = computeAmount(usage({ imageCount: 1, inputTokens: 1000, outputTokens: 1000 }), s);
    expect(p.toString()).toBe("0.045");
  });

  it("adds the flat request price only when billRequest is true", () => {
    const s = sellTable({ inputPrice: "0", outputPrice: "0", requestPrice: "0.005" });
    expect(computeAmount(usage({}), s).toString()).toBe("0.005");
    expect(computeAmount(usage({}), s, { billRequest: false }).toString()).toBe("0");
  });

  it("bills transcription per minute and TTS per million characters", () => {
    const s = sellTable({ inputPrice: "0", outputPrice: "0", perMinutePrice: "0.006", perMillionChars: "15" });
    expect(computeAmount(usage({ audioSeconds: 90 }), s).toString()).toBe("0.009");
    expect(computeAmount(usage({ characters: 2000 }), s).toString()).toBe("0.03");
  });

  it("bills audio tokens at the audio rate instead of the text rate", () => {
    const s = sellTable({ inputPrice: "2", outputPrice: "8", audioInputPrice: "20", audioOutputPrice: "80" });
    const p = computeAmount(usage({ inputTokens: 1000, audioInputTokens: 400, outputTokens: 500, audioOutputTokens: 100 }), s);
    // text in 600*2 + audio in 400*20 + text out 400*8 + audio out 100*80 = 1200+8000+3200+8000 = 20400 /1e6
    expect(p.toString()).toBe("0.0204");
  });

  it("rounds to 12 decimal places so logged price == deducted price", () => {
    const s = sellTable({ inputPrice: "0.333333333333", outputPrice: "0" });
    const p = computeAmount(usage({ inputTokens: 7 }), s, { multiplier: "0.3333" });
    expect(p.decimalPlaces()).toBeLessThanOrEqual(12);
  });

  it("clamps nonsense usage (cached > input) instead of going negative", () => {
    const s = sellTable({ inputPrice: "1", outputPrice: "0", cachedInputPrice: "0.1" });
    const p = computeAmount(usage({ inputTokens: 100, cachedTokens: 500 }), s);
    expect(p.isNegative()).toBe(false);
    expect(p.toString()).toBe("0.00001"); // 100 cached tokens * 0.1 / 1e6
  });

  it("estimatePrice is input*price + output*price (+request) times the multiplier", () => {
    const s = sellTable({ inputPrice: "1", outputPrice: "2", requestPrice: "0.001" });
    expect(estimatePrice(1000, 4096, s, "2").toString()).toBe(new Decimal("0.001").plus(new Decimal(4096).times(2).div(1e6)).plus("0.001").times(2).toString());
  });
});

describe("pricing: server tools", () => {
  const s = sellTable({ inputPrice: "0", outputPrice: "0", toolPrices: { web_search_request: "0.01", code_execution_hour: "0.05" } });
  const c = costTable({ inputCost: "0", outputCost: "0", toolCosts: { web_search_request: "0.008", code_execution_hour: "0.05" } });

  it("toolTable keeps non-negative numbers and drops everything else", () => {
    const t = toolTable({ a: "0.01", b: 2, c: -1, d: "x", e: null, f: "" });
    expect(Object.keys(t).sort()).toEqual(["a", "b"]);
    expect(t.a.toString()).toBe("0.01");
    expect(toolTable(null)).toEqual({});
    expect(toolTable([1, 2])).toEqual({});
    expect(toolTable("nope")).toEqual({});
  });

  it("prices each tool per unit; unknown/unpriced tools are free", () => {
    const u = usage({ toolUsage: { web_search_request: 3, code_execution_hour: 0.5, mystery_tool: 7 } });
    // 3 x 0.01 + 0.5 x 0.05
    expect(computeAmount(u, s).toString()).toBe("0.055");
    expect(computeAmount(usage({ toolUsage: { web_search_request: 0 } }), s).toString()).toBe("0");
  });

  it("adds tools on top of tokens and flat prices", () => {
    const t = sellTable({ inputPrice: "1", outputPrice: "2", requestPrice: "0.001", toolPrices: { web_search_request: "0.01" } });
    const p = computeAmount(usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, toolUsage: { web_search_request: 2 } }), t);
    expect(p.toString()).toBe("3.021");
  });

  it("the multiplier applies to the tool price but never to the tool cost", () => {
    const b = priceRequest(usage({ toolUsage: { web_search_request: 10 } }), s, c, "1.5", null);
    expect(b.price.toString()).toBe("0.15"); // 10 x 0.01 x 1.5
    expect(b.cost.toString()).toBe("0.08"); // 10 x 0.008
    expect(b.profit.toString()).toBe("0.07");
  });

  it("official tool price falls back to sell x multiplier per tool", () => {
    const off = officialTable({ officialInputPrice: "0", officialOutputPrice: "0", officialToolPrices: { web_search_request: "0.02" } });
    const eff = effectiveOfficial(off, s, "2");
    expect(eff.tools!.web_search_request.toString()).toBe("0.02"); // official wins, never multiplied
    expect(eff.tools!.code_execution_hour.toString()).toBe("0.1"); // no official -> sell 0.05 x 2
    const b = priceRequest(usage({ toolUsage: { web_search_request: 1, code_execution_hour: 1 } }), s, c, "2", null, true, off);
    expect(b.price.toString()).toBe("0.12"); // (0.01 + 0.05) x 2
    expect(b.official.toString()).toBe("0.12"); // 0.02 + 0.1
  });
});

describe("pricing: batch discount", () => {
  it("discountFactor clamps to [0, 1]", () => {
    expect(discountFactor(50).toString()).toBe("0.5");
    expect(discountFactor(0).toString()).toBe("1");
    expect(discountFactor(-10).toString()).toBe("1");
    expect(discountFactor(150).toString()).toBe("0");
    expect(discountFactor(null).toString()).toBe("1");
    expect(DEFAULT_BATCH_DISCOUNT_PCT).toBe(50);
  });

  it("tokenDiscountPct takes the discount off tokens only (not flat request or tool prices)", () => {
    const t = sellTable({ inputPrice: "2", outputPrice: "8", requestPrice: "0.01", toolPrices: { web_search_request: "0.01" } });
    const u = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, toolUsage: { web_search_request: 1 } });
    expect(computeAmount(u, t).toString()).toBe("10.02");
    // tokens 10 x 0.5 = 5, + request 0.01 + tool 0.01
    expect(computeAmount(u, t, { tokenDiscountPct: 50 }).toString()).toBe("5.02");
    // multiplier applies after the discount, to everything
    expect(computeAmount(u, t, { tokenDiscountPct: 50, multiplier: 2 }).toString()).toBe("10.04");
  });

  it("applies the long-context factor first, THEN the batch discount", () => {
    const t = sellTable({ inputPrice: "1", outputPrice: "0", requestPrice: "0.5" });
    const lc = { threshold: 100_000, multiplier: new Decimal(5) };
    // 200k x 1 / 1e6 = 0.2 -> x5 = 1 -> x0.5 = 0.5 ; + 0.5 flat (neither scaled nor discounted)
    expect(computeAmount(usage({ inputTokens: 200_000 }), t, { longContext: lc, tokenDiscountPct: 50 }).toString()).toBe("1");
    expect(computeAmount(usage({ inputTokens: 200_000 }), t, { longContext: lc }).toString()).toBe("1.5");
  });

  it("priceRequest(..., batch) uses the model / route discounts, defaulting to 50, and the vendors' 50 for official", () => {
    const t = sellTable({ inputPrice: "4", outputPrice: "0", toolPrices: { web_search_request: "0.01" } });
    const co = costTable({ inputCost: "2", outputCost: "0", toolCosts: { web_search_request: "0.01" } });
    const off = officialTable({ officialInputPrice: "4", officialOutputPrice: "0" });
    const u = usage({ inputTokens: 1_000_000, toolUsage: { web_search_request: 1 } });

    const def = priceRequest(u, t, co, 1, null, true, off, { sellPct: null, costPct: undefined });
    expect(def.price.toString()).toBe("2.01");
    expect(def.cost.toString()).toBe("1.01");
    expect(def.official.toString()).toBe("2.01");

    const custom = priceRequest(u, t, co, 1, null, true, off, { sellPct: 25, costPct: 60 });
    expect(custom.price.toString()).toBe("3.01"); // 4 x 0.75 + 0.01
    expect(custom.cost.toString()).toBe("0.81"); // 2 x 0.4 + 0.01
    expect(custom.official.toString()).toBe("2.01"); // the vendor's own batch price stays 50% off
    expect(custom.profit.toString()).toBe("2.2");

    const noBatch = priceRequest(u, t, co, 1, null, true, off);
    expect(noBatch.price.toString()).toBe("4.01");
    expect(noBatch.official.toString()).toBe("4.01");
  });
});

describe("deriveSellUpdates: server tools", () => {
  it("PERCENT_OF_OFFICIAL: official tool price x percent", () => {
    const u = deriveSellUpdates({ officialToolPrices: { web_search_request: "0.01", code_execution_hour: "0.05" } }, null, { mode: "PERCENT_OF_OFFICIAL", value: 100 });
    expect(u.toolPrices).toEqual({ web_search_request: "0.010000000000", code_execution_hour: "0.050000000000" });
    const half = deriveSellUpdates({ officialToolPrices: { web_search_request: "0.01" } }, null, { mode: "PERCENT_OF_OFFICIAL", value: 50 });
    expect(half.toolPrices).toEqual({ web_search_request: "0.005000000000" });
  });

  it("MARKUP_OVER_COST: route tool cost x (1 + markup), keeping sell-only keys", () => {
    const u = deriveSellUpdates({ toolPrices: { custom_tool: "1" } }, { toolCosts: { web_search_call: "0.01" } }, { mode: "MARKUP_OVER_COST", value: 30 });
    expect(u.toolPrices).toEqual({ custom_tool: "1.000000000000", web_search_call: "0.013000000000" });
  });

  it("returns no toolPrices when nothing changes, there is no basis, or the rule is FIXED", () => {
    expect(deriveSellUpdates({ toolPrices: { web_search_request: "0.01" }, officialToolPrices: { web_search_request: "0.01" } }, null, { mode: "PERCENT_OF_OFFICIAL", value: 100 })).not.toHaveProperty("toolPrices");
    expect(deriveSellUpdates({ toolPrices: {} }, { toolCosts: {} }, { mode: "MARKUP_OVER_COST", value: 30 })).not.toHaveProperty("toolPrices");
    expect(deriveSellUpdates({ toolPrices: {} }, null, { mode: "MARKUP_OVER_COST", value: 30 })).not.toHaveProperty("toolPrices");
    expect(deriveSellUpdates({ officialToolPrices: { web_search_request: "0.01" } }, null, { mode: "FIXED", value: 1 })).toEqual({});
  });
});
