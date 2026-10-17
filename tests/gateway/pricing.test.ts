import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/money";
import { computeAmount, costTable, effectiveMultiplier, estimatePrice, longContextFactor, priceRequest, sellTable } from "@/gateway/pricing";
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
