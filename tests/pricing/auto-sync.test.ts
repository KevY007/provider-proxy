/**
 * Auto-updated prices: "% of our cost" + a signed adjustment, and route costs that follow the provider's published
 * price - refreshed lazily during calls (every N calls or after X hours), never on a timer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk, sleep } from "../gateway/harness";
import { deriveUnitPrice, previewPricing, validateRule } from "@/server/pricing/preview";
import { deriveSellUpdates } from "@/server/pricing/fields";
import { noteRouteCall, syncRouteCost, __resetAutoSyncForTests } from "@/server/pricing/auto-sync";
import { db } from "@/lib/db";

describe("% of our cost + adjustment (pure)", () => {
  it("deriveUnitPrice: percent of cost, then the signed adjustment, never below 0", () => {
    expect(deriveUnitPrice({ mode: "PERCENT_OF_COST", value: 50 }, null, 10)).toBe(5);
    expect(deriveUnitPrice({ mode: "PERCENT_OF_COST", value: 50, adjust: -0.05 }, null, 10)).toBe(4.95);
    expect(deriveUnitPrice({ mode: "PERCENT_OF_COST", value: 100, adjust: 0.25 }, null, 2)).toBe(2.25);
    expect(deriveUnitPrice({ mode: "MARKUP_OVER_COST", value: 30, adjust: -1 }, null, 10)).toBe(12);
    expect(deriveUnitPrice({ mode: "PERCENT_OF_OFFICIAL", value: 100, adjust: -0.1 }, 1, null)).toBe(0.9);
    expect(deriveUnitPrice({ mode: "PERCENT_OF_COST", value: 10, adjust: -5 }, null, 1)).toBe(0); // clamped
    expect(deriveUnitPrice({ mode: "PERCENT_OF_COST", value: 50 }, 3, null)).toBeNull(); // needs a cost
  });

  it("validation and preview", () => {
    expect(validateRule({ mode: "PERCENT_OF_COST", value: 0 })).toMatch(/between 0 and 10000/);
    expect(validateRule({ mode: "PERCENT_OF_COST", value: null })).toMatch(/percentage of our cost/);
    expect(validateRule({ mode: "PERCENT_OF_COST", value: 50, adjust: -0.05 })).toBeNull();
    const p = previewPricing({ rule: { mode: "PERCENT_OF_COST", value: 50, adjust: -0.05 }, official: {}, cost: { input: 2.5, output: 10 } });
    expect(p.customer).toMatchObject({ input: 1.2, output: 4.95 });
    expect(p.warnings.some((w) => /below our cost/.test(w))).toBe(true); // 50% of cost is a loss, and the preview says so
  });

  it("deriveSellUpdates writes the adjusted prices (server tools are not adjusted)", () => {
    const model = { inputPrice: "0", outputPrice: "0", toolPrices: {} };
    const route = { inputCost: "2.5", outputCost: "10", toolCosts: { web_search_call: "0.01" } };
    const out = deriveSellUpdates(model, route, { mode: "PERCENT_OF_COST", value: 50, adjust: -0.05 });
    expect(Number(out.inputPrice)).toBeCloseTo(1.2, 12);
    expect(Number(out.outputPrice)).toBeCloseTo(4.95, 12);
    expect(Number((out.toolPrices as Record<string, string>).web_search_call)).toBeCloseTo(0.005, 12);
  });
});

const h = createHarness("aps");

describe.skipIf(!dbOk)("auto-updated route cost (mock provider publishes LiteLLM prices)", () => {
  let routeId = "";
  let modelId = "";

  beforeAll(async () => {
    await h.start();
    __resetAutoSyncForTests();
    const p = await h.makeProvider("pp", { formats: ["openai_chat"], keys: [{ s: "k1" }] });
    const m = await h.makeModel("auto", { caps: ["chat"], providerId: p.id, upstream: "gpt-mock", model: { pricingMode: "PERCENT_OF_COST", pricingValue: "50", pricingAdjust: "-0.05" }, route: { autoCostSync: true } });
    modelId = m.id;
    routeId = (await db.modelRoute.findFirstOrThrow({ where: { modelId } })).id;
  }, 60_000);
  afterAll(() => h.cleanup(), 60_000);

  const priceListCalls = async () => ((await (await fetch(`${h.base}/__mock/stats`)).json()) as { byPath: Record<string, number> }).byPath["/v1/model/info"] ?? 0;

  it("a sync takes the provider's price as our cost and re-derives the customer price (50% - $0.05)", async () => {
    const r = await syncRouteCost(routeId, { force: true });
    expect(r.status).toBe("ok");
    const route = await db.modelRoute.findUniqueOrThrow({ where: { id: routeId } });
    expect(Number(route.inputCost)).toBe(2.5);
    expect(Number(route.outputCost)).toBe(10);
    expect(Number(route.cachedInputCost)).toBe(1.25);
    expect(route.autoCostStatus).toBe("ok");
    const model = await db.model.findUniqueOrThrow({ where: { id: modelId } });
    expect(Number(model.inputPrice)).toBeCloseTo(1.2, 12);
    expect(Number(model.outputPrice)).toBeCloseTo(4.95, 12);
    expect(await db.auditLog.count({ where: { action: "route.auto_cost_sync", targetId: routeId } })).toBe(1);
    expect((await syncRouteCost(routeId, { force: true })).status).toBe("unchanged");
  });

  it("refreshes only during calls: not before N calls / X hours, then once at the Nth call", async () => {
    __resetAutoSyncForTests();
    await db.modelRoute.update({ where: { id: routeId }, data: { autoCostSyncedAt: new Date(Date.now() - 5 * 60_000) } });
    const rec = { id: routeId, autoCostSync: true, autoCostSyncedAt: Date.now() - 5 * 60_000 };
    const settings = { autoPriceSyncHours: 6, autoPriceSyncCalls: 3 };
    const before = await priceListCalls();
    noteRouteCall(rec, settings);
    noteRouteCall(rec, settings);
    await sleep(300);
    expect(await priceListCalls()).toBe(before); // 2 calls, 5 minutes old: not due
    noteRouteCall(rec, settings); // 3rd call
    for (let i = 0; i < 50 && (await priceListCalls()) === before; i++) await sleep(50);
    expect(await priceListCalls()).toBe(before + 1);
    // the route is not refreshed again right away, whatever the call count
    for (let i = 0; i < 5; i++) noteRouteCall(rec, settings);
    await sleep(300);
    expect(await priceListCalls()).toBe(before + 1);
  });

  it("a route without auto-update never asks the provider", async () => {
    const before = await priceListCalls();
    for (let i = 0; i < 10; i++) noteRouteCall({ id: "x", autoCostSync: false, autoCostSyncedAt: null }, { autoPriceSyncHours: 0.1, autoPriceSyncCalls: 1 });
    await sleep(200);
    expect(await priceListCalls()).toBe(before);
  });

  it("an hours-old sync is refreshed by the next call", async () => {
    __resetAutoSyncForTests();
    await db.modelRoute.update({ where: { id: routeId }, data: { autoCostSyncedAt: new Date(Date.now() - 7 * 3_600_000) } });
    const before = await priceListCalls();
    noteRouteCall({ id: routeId, autoCostSync: true, autoCostSyncedAt: Date.now() - 7 * 3_600_000 }, { autoPriceSyncHours: 6, autoPriceSyncCalls: 100 });
    for (let i = 0; i < 50 && (await priceListCalls()) === before; i++) await sleep(50);
    expect(await priceListCalls()).toBe(before + 1);
  });
});
