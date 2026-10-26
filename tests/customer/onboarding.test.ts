import { describe, expect, it } from "vitest";
import { deriveOnboarding } from "@/server/customer/onboarding";
import { applyMultiplierToMap, buildUnitRows, formatUnitPrice, headlineSavings } from "@/server/customer/price-rows";
import { estimateSaving } from "@/server/customer/pricing";

describe("deriveOnboarding", () => {
  const base = { emailVerified: false, balance: "0", everFunded: false, keyCount: 0, requestCount: 0 };

  it("drops the balance step when customer billing pages are off", () => {
    const s = deriveOnboarding({ ...base, customerBilling: false, emailVerified: true, keyCount: 1, requestCount: 1 });
    expect(s.steps.map((x) => x.id)).toEqual(["verify", "key", "request"]);
    expect(s.total).toBe(3);
    expect(s.allDone).toBe(true);
  });

  it("starts with everything open and the first step as next", () => {
    const s = deriveOnboarding(base);
    expect(s.doneCount).toBe(0);
    expect(s.allDone).toBe(false);
    expect(s.next?.id).toBe("verify");
    expect(s.steps.map((x) => x.id)).toEqual(["verify", "balance", "key", "request"]);
  });

  it("ticks steps independently from DB state", () => {
    const s = deriveOnboarding({ ...base, emailVerified: true, balance: "5", keyCount: 1 });
    expect(s.steps.map((x) => x.done)).toEqual([true, true, true, false]);
    expect(s.next?.id).toBe("request");
  });

  it("counts a past top-up as balance even when the balance is now zero", () => {
    expect(deriveOnboarding({ ...base, everFunded: true }).steps[1].done).toBe(true);
    expect(deriveOnboarding({ ...base, balance: 0 }).steps[1].done).toBe(false);
  });

  it("is allDone (checklist hidden) when every step is complete", () => {
    const s = deriveOnboarding({ emailVerified: true, balance: "1", everFunded: true, keyCount: 2, requestCount: 3 });
    expect(s.allDone).toBe(true);
    expect(s.next).toBeNull();
  });
});

describe("price rows", () => {
  const official = { input: "10", output: "40", cachedInput: "1", perSecond: "0.5", image: null };
  const sell = { input: "3.8", output: "15.2", cachedInput: null, perSecond: "0.575", image: null };

  it("builds only relevant units and applies fallbacks", () => {
    const rows = buildUnitRows(official, sell);
    expect(rows.map((r) => r.unit.id)).toEqual(["input", "output", "cachedInput", "perSecond"]);
    const cached = rows.find((r) => r.unit.id === "cachedInput")!;
    expect(cached.price).toBe("3.8"); // blank cached price falls back to input
    expect(rows[0].savingsPct).toBeCloseTo(62);
    expect(rows.find((r) => r.unit.id === "perSecond")!.savingsPct).toBeCloseTo(-15);
  });

  it("applies a multiplier to every unit and keeps nulls", () => {
    const m = applyMultiplierToMap(sell, "0.5");
    expect(m.input).toBe("1.9");
    expect(m.image).toBeNull();
  });

  it("computes headline savings from the blended input/output price", () => {
    expect(headlineSavings(buildUnitRows(official, sell))).toBeCloseTo(62);
    expect(headlineSavings([])).toBeNull();
  });

  it("formats per-1M vs per-unit prices", () => {
    expect(formatUnitPrice("input", "2.5")).toBe("$2.50");
    expect(formatUnitPrice("perSecond", "0.5")).toBe("$0.50");
    expect(formatUnitPrice("image", null)).toBe("-");
  });
});

describe("estimateSaving", () => {
  const prices = { input: "4", output: "20", cachedInput: null, image: null, request: null };
  it("is official cost minus your cost, signed", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateSaving(usage, { input: "5", output: "25" }, prices)).toBe("6");
    expect(estimateSaving(usage, { input: "3", output: "10" }, prices)).toBe("-11");
  });
  it("is null without usable official prices", () => {
    expect(estimateSaving({ inputTokens: 10, outputTokens: 10 }, {}, prices)).toBeNull();
    expect(estimateSaving({ inputTokens: 10, outputTokens: 10 }, null, prices)).toBeNull();
    expect(estimateSaving({ inputTokens: 0, outputTokens: 0 }, { input: "1", output: "1" }, prices)).toBeNull();
  });
});
