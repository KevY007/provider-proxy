import { describe, expect, it } from "vitest";
import {
  bestRouteCost,
  marginPctOf,
  modelFieldsSchema,
  modelToExport,
  parseModelImport,
  routeMargins,
  trafficShares,
} from "@/server/admin/models-calc";

describe("marginPctOf", () => {
  it("computes (sell-cost)/sell", () => {
    expect(marginPctOf("10", "4")).toBeCloseTo(60);
    expect(marginPctOf(2, 1)).toBeCloseTo(50);
  });
  it("is null for zero/blank sell or blank cost", () => {
    expect(marginPctOf("0", "1")).toBeNull();
    expect(marginPctOf("", "1")).toBeNull();
    expect(marginPctOf("5", "")).toBeNull();
    expect(marginPctOf(null, null)).toBeNull();
  });
  it("is negative when selling below cost", () => {
    expect(marginPctOf("1", "1.5")).toBeCloseTo(-50);
  });
});

describe("routeMargins", () => {
  it("falls back to input price/cost for cached when null", () => {
    const m = routeMargins({ inputPrice: "10", outputPrice: "20", cachedInputPrice: null }, { inputCost: "5", outputCost: "10", cachedInputCost: null });
    expect(m.input).toBeCloseTo(50);
    expect(m.output).toBeCloseTo(50);
    expect(m.cached).toBeCloseTo(50);
  });
  it("uses explicit cached values on each side independently", () => {
    const m = routeMargins({ inputPrice: "10", outputPrice: "20", cachedInputPrice: "1" }, { inputCost: "5", outputCost: "10", cachedInputCost: null });
    expect(m.cached).toBeCloseTo(-400); // sell 1 vs cost falls back to input 5
  });
  it("handles zero sell price", () => {
    const m = routeMargins({ inputPrice: "0", outputPrice: "0" }, { inputCost: "1", outputCost: "1" });
    expect(m).toEqual({ input: null, output: null, cached: null });
  });
});

describe("trafficShares", () => {
  it("splits by weight inside the top tier and orders tiers by priority", () => {
    const s = trafficShares([
      { id: "a", enabled: true, priority: 10, weight: 3 },
      { id: "b", enabled: true, priority: 10, weight: 1 },
      { id: "c", enabled: true, priority: 0, weight: 5 },
      { id: "d", enabled: false, priority: 10, weight: 9 },
    ]);
    expect(s.a).toEqual({ tier: 1, sharePct: 75 });
    expect(s.b).toEqual({ tier: 1, sharePct: 25 });
    expect(s.c).toEqual({ tier: 2, sharePct: 100 });
    expect(s.d).toEqual({ tier: 0, sharePct: 0 });
  });
  it("splits equally when all weights are zero", () => {
    const s = trafficShares([
      { id: "a", enabled: true, priority: 0, weight: 0 },
      { id: "b", enabled: true, priority: 0, weight: 0 },
    ]);
    expect(s.a.sharePct).toBe(50);
  });
});

describe("bestRouteCost", () => {
  it("picks the cheapest enabled route", () => {
    expect(
      bestRouteCost([
        { enabled: true, inputCost: "5", outputCost: "10" },
        { enabled: true, inputCost: "1", outputCost: "2" },
        { enabled: false, inputCost: "0", outputCost: "0" },
      ]),
    ).toEqual({ input: 1, output: 2 });
    expect(bestRouteCost([])).toBeNull();
  });
});

describe("model schema + import", () => {
  it("normalises form strings", () => {
    const r = modelFieldsSchema.parse({
      slug: "gpt-x",
      displayName: "GPT X",
      vendor: "openai",
      capabilities: ["chat", "chat"],
      inputPrice: "2.5",
      outputPrice: 10,
      cachedInputPrice: "",
      contextWindow: "128000",
    });
    expect(r.cachedInputPrice).toBeNull();
    expect(r.outputPrice).toBe("10");
    expect(r.contextWindow).toBe(128000);
    expect(r.capabilities).toEqual(["chat"]);
    expect(r.status).toBe("ACTIVE");
    expect(r.maskUpstreamModel).toBe(true);
  });
  it("rejects bad numbers and unknown capabilities", () => {
    expect(modelFieldsSchema.safeParse({ slug: "a", displayName: "A", vendor: "v", capabilities: ["nope"] }).success).toBe(false);
    expect(modelFieldsSchema.safeParse({ slug: "a", displayName: "A", vendor: "v", capabilities: [], inputPrice: "abc" }).success).toBe(false);
  });
  it("validates import items independently", () => {
    const res = parseModelImport(
      JSON.stringify([
        { slug: "ok", displayName: "Ok", vendor: "x", capabilities: ["chat"], routes: [{ provider: "openai", upstreamModel: "m", inputCost: 1, outputCost: 2 }] },
        { slug: "bad slug!", displayName: "Bad", vendor: "x", capabilities: [] },
        { slug: "ok", displayName: "Dup", vendor: "x", capabilities: [] },
      ]),
    );
    expect(res.fatal).toBeUndefined();
    const items = res.items!;
    expect(items[0].ok).toBe(true);
    expect(items[1].ok).toBe(false);
    expect(items[2].ok).toBe(false);
  });
  it("reports fatal errors", () => {
    expect(parseModelImport("{").fatal).toMatch(/Invalid JSON/);
    expect(parseModelImport("{}").fatal).toBeTruthy();
  });
  it("exports routes with provider slug and drops nulls/ids", () => {
    const out = modelToExport({ id: "1", slug: "m", cachedInputPrice: null, inputPrice: "1" }, [{ providerSlug: "openai", id: "r", modelId: "1", providerId: "p", upstreamModel: "u", imageCost: null, inputCost: "1" }]);
    expect(out).toEqual({ slug: "m", inputPrice: "1", routes: [{ provider: "openai", upstreamModel: "u", inputCost: "1" }] });
  });
});
