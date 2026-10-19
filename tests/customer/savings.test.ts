import { describe, expect, it } from "vitest";
import { describeSavings, requestSaving, savingsPctOf, summarizeSavings } from "@/server/customer/savings";
import { PRICE_UNITS, relevantUnits } from "@/server/customer/price-units";
import { attemptStatusLabel, explainError, logStatusInfo, parseAttempts } from "@/server/customer/log-status";

describe("savings", () => {
  it("computes percent vs official", () => {
    expect(savingsPctOf("10", "3.8")).toBeCloseTo(62);
    expect(savingsPctOf("10", "11.5")).toBeCloseTo(-15);
    expect(savingsPctOf(null, "1")).toBeNull();
    expect(savingsPctOf("0", "1")).toBeNull();
    expect(savingsPctOf("10", null)).toBeNull();
  });

  it("labels savings green and premiums amber (never hidden)", () => {
    expect(describeSavings("10", "3.8")).toMatchObject({ tone: "saving", label: "−62% vs official" });
    expect(describeSavings("10", "11.5")).toMatchObject({ tone: "premium", label: "+15% vs official" });
    expect(describeSavings("10", "10").tone).toBe("same");
    expect(describeSavings(null, "10").tone).toBe("unknown");
  });

  it("summarizes a range as saved / paid more / even", () => {
    expect(summarizeSavings("12.5", "10")).toMatchObject({ kind: "saved", headline: "You saved $2.50 vs official prices" });
    expect(summarizeSavings("10", "11.2")).toMatchObject({ kind: "paid_more", headline: "You paid $1.20 more than official prices" });
    expect(summarizeSavings("5", "5").kind).toBe("even");
    expect(summarizeSavings("0", "0").kind).toBe("even");
  });

  it("per-request saving is signed and zero without an official price", () => {
    expect(requestSaving("0.5", "0.2")).toBe("0.3");
    expect(requestSaving("0.2", "0.5")).toBe("-0.3");
    expect(requestSaving("0", "0.5")).toBe("0");
  });
});

describe("price units", () => {
  it("covers per-second video and picks relevant units", () => {
    expect(PRICE_UNITS.some((u) => u.id === "perSecond" && u.cost === "perSecondCost")).toBe(true);
    const ids = relevantUnits({ inputPrice: "1", outputPrice: "2", perSecondPrice: "0.4", officialImagePrice: "0.04", cachedInputPrice: "" }).map((u) => u.id);
    expect(ids).toEqual(["input", "output", "image", "perSecond"]);
  });
});

describe("log status helpers", () => {
  it("maps statuses to clear pills", () => {
    expect(logStatusInfo("SUCCESS").label).toBe("Success");
    expect(logStatusInfo("CLIENT_ERROR").tone).toBe("warning");
    expect(logStatusInfo("UPSTREAM_ERROR").tone).toBe("danger");
    expect(logStatusInfo(undefined, 503).tone).toBe("danger");
  });

  it("explains errors with a docs link", () => {
    const e = explainError("insufficient_balance");
    expect(e?.docsHref).toBe("/docs/errors#insufficient_balance");
    expect(e?.fix).toMatch(/Billing/);
    expect(explainError("weird_code", "boom")?.meaning).toBe("boom");
    expect(explainError(null)).toBeNull();
  });

  it("parses attempts tolerant of odd shapes", () => {
    const a = parseAttempts([{ providerId: "p", providerKeyId: "k", status: 429, error: "rate", latencyMs: 12 }, { status: 200, latencyMs: 80 }, null]);
    expect(a).toHaveLength(3);
    expect(a[0]).toMatchObject({ status: 429, ok: false, latencyMs: 12 });
    expect(a[1].ok).toBe(true);
    expect(parseAttempts("nope")).toEqual([]);
    expect(attemptStatusLabel(0)).toMatch(/timeout/);
  });
});
