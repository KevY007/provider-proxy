import { describe, expect, it } from "vitest";
import {
  bestRouteCost,
  marginPctOf,
  modelFieldsSchema,
  modelToExport,
  parseModelImport,
  parseToolPriceMap,
  previewToolPrices,
  routeFieldsSchema,
  routeMargins,
  TOOL_KEY_SUGGESTIONS,
  toolPricesForForm,
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

describe("server tools (admin)", () => {
  const base = { slug: "a", displayName: "A", vendor: "v", capabilities: ["chat"] };

  it("parseToolPriceMap accepts objects and JSON text, drops blanks, normalizes numbers", () => {
    expect(parseToolPriceMap({ web_search_request: 0.01, code_execution_hour: "0.05", file_search_call: "" })).toEqual({ value: { web_search_request: "0.01", code_execution_hour: "0.05" } });
    expect(parseToolPriceMap('{"web_search_call": 1e-7}')).toEqual({ value: { web_search_call: "0.0000001" } });
    expect(parseToolPriceMap(" ")).toEqual({ value: {} });
    expect(parseToolPriceMap(null)).toEqual({ value: {} });
    expect(parseToolPriceMap({ " web_search_request ": "1" })).toEqual({ value: { web_search_request: "1" } });
  });

  it("parseToolPriceMap rejects bad keys, negative / non-numeric values and non-objects", () => {
    expect(parseToolPriceMap({ "bad key": 1 }).error).toMatch(/not a valid tool key/);
    expect(parseToolPriceMap({ web_search_request: -1 }).error).toMatch(/web_search_request/);
    expect(parseToolPriceMap({ web_search_request: "abc" }).error).toMatch(/non-negative/);
    expect(parseToolPriceMap([1]).error).toBeTruthy();
    expect(parseToolPriceMap("{nope").error).toMatch(/JSON/);
    expect(TOOL_KEY_SUGGESTIONS.map((t) => t.key)).toEqual(["web_search_request", "code_execution_hour", "web_search_call", "file_search_call"]);
  });

  it("model schema: tool maps and batch discount are optional (undefined = leave alone)", () => {
    const r = modelFieldsSchema.parse(base);
    expect(r.toolPrices).toBeUndefined();
    expect(r.officialToolPrices).toBeUndefined();
    expect(r.batchDiscountPct).toBeUndefined();
    const s = modelFieldsSchema.parse({ ...base, toolPrices: { web_search_request: "0.01" }, officialToolPrices: {}, batchDiscountPct: "" });
    expect(s.toolPrices).toEqual({ web_search_request: "0.01" });
    expect(s.officialToolPrices).toEqual({});
    expect(s.batchDiscountPct).toBeNull();
    expect(modelFieldsSchema.parse({ ...base, batchDiscountPct: 40 }).batchDiscountPct).toBe("40");
    expect(modelFieldsSchema.safeParse({ ...base, batchDiscountPct: "101" }).success).toBe(false);
    expect(modelFieldsSchema.safeParse({ ...base, toolPrices: { x: "-1" } }).success).toBe(false);
  });

  it("route schema: tool costs + batch cost discount (blank = 50)", () => {
    const r = routeFieldsSchema.parse({ upstreamModel: "m", toolCosts: '{"web_search_call":0.01}', batchCostDiscountPct: "" });
    expect(r.toolCosts).toEqual({ web_search_call: "0.01" });
    expect(r.batchCostDiscountPct).toBe("50");
    const d = routeFieldsSchema.parse({ upstreamModel: "m" });
    expect(d.toolCosts).toBeUndefined();
    expect(d.batchCostDiscountPct).toBeUndefined();
    expect(routeFieldsSchema.safeParse({ upstreamModel: "m", batchCostDiscountPct: "-5" }).success).toBe(false);
  });

  it("import accepts tool prices and batch discounts on models and routes", () => {
    const res = parseModelImport(
      JSON.stringify([
        {
          ...base,
          toolPrices: { web_search_request: 0.01 },
          officialToolPrices: { web_search_request: 0.01 },
          batchDiscountPct: 50,
          routes: [{ provider: "anthropic", upstreamModel: "m", toolCosts: { web_search_request: 0.01 }, batchCostDiscountPct: 50 }],
        },
      ]),
    );
    const item = res.items![0];
    expect(item.ok).toBe(true);
    if (!item.ok) return;
    expect(item.data.toolPrices).toEqual({ web_search_request: "0.01" });
    expect(item.data.batchDiscountPct).toBe("50");
    expect(item.data.routes![0].toolCosts).toEqual({ web_search_request: "0.01" });
    expect(item.data.routes![0].batchCostDiscountPct).toBe("50");
  });

  it("export keeps tool maps (re-importable)", () => {
    const out = modelToExport({ id: "1", slug: "m", toolPrices: { web_search_request: "0.01" }, batchDiscountPct: null }, [{ providerSlug: "anthropic", upstreamModel: "u", toolCosts: { web_search_request: "0.01" }, batchCostDiscountPct: "50" }]);
    expect(out).toEqual({ slug: "m", toolPrices: { web_search_request: "0.01" }, routes: [{ provider: "anthropic", upstreamModel: "u", toolCosts: { web_search_request: "0.01" }, batchCostDiscountPct: "50" }] });
  });

  it("toolPricesForForm turns DB strings into plain decimals and skips junk", () => {
    expect(toolPricesForForm({ web_search_request: "0.010000000000", code_execution_hour: 0.05, bad: "x", neg: "-1", nil: null })).toEqual({ web_search_request: "0.01", code_execution_hour: "0.05" });
    expect(toolPricesForForm(null)).toEqual({});
    expect(toolPricesForForm([1])).toEqual({});
  });

  it("previewToolPrices mirrors the pricing rule", () => {
    const official = { web_search_request: "0.01" };
    const cost = { web_search_request: "0.008", code_execution_hour: "0.05" };
    const fixed = { web_search_request: "0.02", custom: "1" };
    expect(previewToolPrices("FIXED", "", official, cost, fixed)).toEqual({ web_search_request: 0.02, custom: 1 });
    expect(previewToolPrices("PERCENT_OF_OFFICIAL", "50", official, cost, fixed)).toEqual({ web_search_request: 0.005, custom: 1 });
    expect(previewToolPrices("MARKUP_OVER_COST", "25", official, cost, {})).toEqual({ web_search_request: 0.01, code_execution_hour: 0.0625 });
    expect(previewToolPrices("MARKUP_OVER_COST", "", official, cost, fixed)).toEqual({ web_search_request: 0.02, custom: 1 });
  });
});
