/**
 * AI price sync: page text helpers, the verification / proposal rules (pure), a full run + apply against the database
 * with an injected AI and pages, and the real AI call through the gateway (billed at our cost, price 0).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk } from "../gateway/harness";
import { htmlToText, nameOnPage, numbersIn } from "@/server/pricing/price-sync/text";
import { applyPriceSyncRun, buildProposals, parseAiJson, poolNameFromProvider, runPriceSync, type AiResult } from "@/server/pricing/price-sync/engine";
import { PRICING_BOT_EMAIL, askPricingAi } from "@/server/pricing/price-sync/ai";
import { flushMeter } from "@/gateway/meter-writer";
import { getSetting, invalidateSettingsCache, setSetting, type SettingValues } from "@/lib/settings";
import { db } from "@/lib/db";

const page = (url: string, text: string) => ({ url, ok: true, text, chars: text.length });

describe("page text", () => {
  it("turns HTML tables into readable rows and drops scripts", () => {
    const t = htmlToText("<html><script>var x=1</script><table><tr><td>gpt-6-astra</td><td>$10.00</td></tr></table><p>A&amp;B</p></html>");
    expect(t).toContain("gpt-6-astra | $10.00 |");
    expect(t).toContain("A&B");
    expect(t).not.toContain("var x");
  });
  it("collects every number written on the page", () => {
    const n = numbersIn("Input $1,234.50 · 0.05x · 5% · $0.015 per image");
    for (const v of [1234.5, 0.05, 5, 0.015]) expect(n.has(v)).toBe(true);
    expect(n.has(0.5)).toBe(false);
  });
  it("finds model names as whole tokens only", () => {
    expect(nameOnPage("gpt-5.6-sol", "| gpt-5.6-sol* | $5 |")).toBe(true);
    expect(nameOnPage("gpt-6-sol", "gpt-6-sol-mini only")).toBe(false);
    expect(nameOnPage("Relay Pro Pool", "Relay Plus Pool 0.03x · Relay Pro Pool 0.05x")).toBe(true);
  });
  it("derives the pool name from a provider name", () => {
    expect(poolNameFromProvider("Relay Pro Pool (0.05x)")).toBe("Relay Pro Pool");
    // the short relay prefix the regex strips (a matched token, not display text)
    expect(poolNameFromProvider("CE Relay Max Pool (0.08x)")).toBe("Relay Max Pool");
  });
  it("reads the AI's JSON even with prose / code fences around it", () => {
    const r = parseAiJson('Here you go:\n```json\n{"models":[{"id":"m1","found":true,"input":"$2.00","output":10}]}\n```');
    expect(r.models[0]).toMatchObject({ id: "m1", input: 2, output: 10 });
    expect(() => parseAiJson("no json")).toThrow();
    // trailing notes with braces after the answer (seen live) and braces inside strings
    const r2 = parseAiJson('{"models":[{"id":"m2","found":true,"note":"tier {standard}","input":1}]}\n\nNotes: {pool} uses {x}');
    expect(r2.models[0]).toMatchObject({ id: "m2", input: 1, note: "tier {standard}" });
  });
});

// ---------------------------------------------------------------------------------------------------- pure rules
const route = (id: string, up: string, cost: Record<string, string | null>, model: Record<string, unknown> = {}) => ({
  id,
  upstreamModel: up,
  enabled: true,
  inputCost: null,
  outputCost: null,
  cachedInputCost: null,
  cacheWriteCost: null,
  cacheWrite1hCost: null,
  imageCost: null,
  ...cost,
  model: { id: `m-${id}`, slug: up, displayName: up, vendor: "openai", capabilities: ["chat"], officialInputPrice: null, officialOutputPrice: null, officialCachedPrice: null, officialCacheWritePrice: null, ...model },
});

const OFFICIAL_PAGE = page("https://p/official", "| gpt-a | $10.00 | $50.00 | $1.00 |\n| gpt-b | $2.00 | $8.00 |\n| gpt-promo | $4.00 | $20.00 |");
const ai = (models: AiResult["models"], pool: AiResult["pool"] = null): AiResult => ({ models, pool });
const m = (id: string, o: Record<string, unknown>) => ({ id, found: true, page_model: id, source: null, promotional: false, note: null, ...o }) as AiResult["models"][number];

describe("buildProposals: official basis", () => {
  const routes = [
    route("r1", "gpt-a", { inputCost: "9", outputCost: "50", cachedInputCost: "1" }, { officialInputPrice: "9", officialOutputPrice: "50", officialCachedPrice: "1" }),
    route("r2", "gpt-b", { inputCost: "1", outputCost: "8" }),
    route("r3", "gpt-promo", { inputCost: "5", outputCost: "30" }),
    route("r4", "gpt-gone", { inputCost: "1", outputCost: "1" }),
    route("r5", "gpt-same", { inputCost: "2", outputCost: "8" }),
    route("r6", "gpt-off", { inputCost: "2", outputCost: "8" }),
  ];
  const res = buildProposals({
    basis: "official",
    providerPreset: "openai",
    maxAutoChangePct: 50,
    routes: routes as never,
    modelSources: { r6: "off" },
    pages: [OFFICIAL_PAGE],
    ai: ai([
      m("gpt-a", { input: 10, output: 50, cached_input: 1, cache_write_1h: 25 }),
      m("gpt-b", { input: 2, output: 8 }),
      m("gpt-promo", { input: 4, output: 20, promotional: true }),
      m("gpt-gone", { found: false }),
      m("gpt-same", { input: 2, output: 8, cached_input: 0.123 }),
    ]),
  });
  const by = (id: string) => res.proposals.find((p) => p.routeId === id)!;

  it("a small verified change is a clean update, and updates the official price of the vendor's own models", () => {
    const p = by("r1");
    expect(p.status).toBe("update");
    expect(p.updatesOfficial).toBe(true);
    const input = p.units.find((u) => u.unit === "input")!;
    expect(input).toMatchObject({ current: "9", next: "10.000000000000", currentOfficial: "9", nextOfficial: "10.000000000000", verified: true });
    expect(p.units.find((u) => u.unit === "output")!.next).toBeNull(); // unchanged
    expect(p.units.some((u) => u.unit === "cacheWrite1h")).toBe(false); // 1h only for Anthropic
  });
  it("a change bigger than the limit waits for review", () => {
    expect(by("r2").status).toBe("review");
    expect(by("r2").reasons.join()).toMatch(/bigger than 50%/);
  });
  it("promotional prices are never used", () => {
    expect(by("r3")).toMatchObject({ status: "same", units: [] });
    expect(by("r3").reasons[0]).toMatch(/promotional/);
  });
  it("a number that is not on the page is never a clean update", () => {
    expect(by("r5").status).toBe("review");
    expect(by("r5").reasons.join()).toMatch(/not written on the page/);
  });
  it("missing and excluded models", () => {
    expect(by("r4").status).toBe("missing");
    expect(by("r6").status).toBe("excluded");
  });
});

describe("buildProposals: pool basis", () => {
  const POOL_PAGE = page("https://p/pool", "Relay Plus Pool 0.03x · Relay Pro Pool 0.05x\ngpt-a gpt-img\nThe relay does not charge cache writes. Images $0.015 per image.");
  const routes = [
    route("p1", "gpt-a", { inputCost: "0.4", outputCost: "2.5", cachedInputCost: "0.05", cacheWriteCost: "0.5" }, { officialInputPrice: "10", officialOutputPrice: "50", officialCachedPrice: "1", officialCacheWritePrice: "12.5" }),
    route("p2", "gpt-img", { inputCost: "0", outputCost: "0", imageCost: "0.02" }, { capabilities: ["images"], officialInputPrice: "5", officialOutputPrice: "30" }),
    route("p3", "gpt-unlisted", { inputCost: "0.1", outputCost: "0.5" }, { officialInputPrice: "2", officialOutputPrice: "10" }),
  ];
  const run = (poolPct: number, poolName = "Relay Pro Pool") =>
    buildProposals({
      basis: "pool",
      poolName,
      providerPreset: "codex-everywhere",
      maxAutoChangePct: 50,
      routes: routes as never,
      modelSources: {},
      pages: [POOL_PAGE],
      ai: ai([], { name: "Relay Pro Pool (0.05x)", percent: poolPct, charges_cache_writes: false, image_price: 0.015, models: ["gpt-a", "gpt-img"] }),
    });

  it("cost = official x the pool's %, cache writes 0 when the pool does not charge them", () => {
    const { proposals, pool } = run(5);
    expect(pool).toMatchObject({ percent: 5, verified: true, chargesCacheWrites: false });
    const p = proposals.find((x) => x.routeId === "p1")!;
    const u = Object.fromEntries(p.units.map((x) => [x.unit, x.next]));
    expect(u).toMatchObject({ input: "0.500000000000", output: null, cachedInput: null, cacheWrite: "0.000000000000" });
    expect(p.status).toBe("review"); // 0.4 -> 0.5 is fine but 0.5 -> 0 on cache write is a 100% change
  });
  it("an image model billed per image only gets its per-image price (token costs untouched)", () => {
    const p = run(5).proposals.find((x) => x.routeId === "p2")!;
    expect(p.units.map((u) => u.unit)).toEqual(["image"]);
    expect(p.units[0]).toMatchObject({ next: "0.015000000000", verified: true });
  });
  it("a model the page does not list for the pool goes to review", () => {
    const p = run(5).proposals.find((x) => x.routeId === "p3")!;
    expect(p.status).toBe("review");
    expect(p.reasons.join()).toMatch(/not listed/);
  });
  it("a percentage that is not on the page is not verified", () => {
    const { pool, proposals } = run(7);
    expect(pool!.verified).toBe(false);
    expect(proposals.every((p) => p.status !== "update")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------- database
const h = createHarness("psy");

describe.skipIf(!dbOk)("runPriceSync / applyPriceSyncRun (database)", () => {
  let providerId = "";
  let modelId = "";
  let routeId = "";
  let before: SettingValues["priceSyncTargets"];

  beforeAll(async () => {
    await h.start();
    const p = await h.makeProvider("vendor", { formats: ["openai_chat"], preset: "openai", keys: [{ s: "v1" }] });
    providerId = p.id;
    const mm = await h.makeModel("chat", {
      caps: ["chat"],
      providerId,
      upstream: "gpt-test-a",
      official: { officialInputPrice: "9", officialOutputPrice: "50" },
      model: { vendor: "openai", pricingMode: "PERCENT_OF_OFFICIAL", pricingValue: "50" },
      cost: { inputCost: "9", outputCost: "50" },
    });
    modelId = mm.id;
    routeId = (await db.modelRoute.findFirstOrThrow({ where: { modelId } })).id;
    before = await getSetting("priceSyncTargets");
  });
  afterAll(async () => {
    await db.priceSyncRun.deleteMany({ where: { providerId } }).catch(() => undefined);
    if (before) await setSetting("priceSyncTargets", before);
    else if (before === null) {
      await db.setting.deleteMany({ where: { key: "priceSyncTargets" } });
      invalidateSettingsCache();
    }
    const bot = await db.user.findUnique({ where: { email: PRICING_BOT_EMAIL } });
    if (bot) {
      await flushMeter().catch(() => undefined);
      await db.requestLog.deleteMany({ where: { userId: bot.id } });
      await db.user.delete({ where: { id: bot.id } });
    }
    await h.cleanup();
  });

  it("reads the page, asks the AI, stores proposals, and apply updates cost + official + customer price", async () => {
    await db.priceSync.create({ data: { providerId, sources: [{ url: "https://p/official" }], basis: "official" } });
    let asked = "";
    const runId = await runPriceSync(providerId, {
      trigger: "manual",
      fetchText: async (url) => page(url, "| gpt-test-a | $10.00 | $50.00 |"),
      ask: async (_sys, user) => {
        asked = user;
        return { text: JSON.stringify({ models: [{ id: "gpt-test-a", found: true, page_model: "gpt-test-a", input: 10, output: 50 }] }), requestId: null, model: "x" };
      },
    });
    expect(asked).toContain("gpt-test-a");
    expect(asked).toContain("===== PAGE https://p/official");
    const run = await db.priceSyncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("ok");
    const props = run.proposals as Array<{ routeId: string; status: string }>;
    expect(props).toEqual([expect.objectContaining({ routeId, status: "update" })]);

    expect(await applyPriceSyncRun(runId, [routeId], { actorId: null })).toEqual({ applied: 1 });
    const r = await db.modelRoute.findUniqueOrThrow({ where: { id: routeId } });
    const model = await db.model.findUniqueOrThrow({ where: { id: modelId } });
    expect(r.inputCost.toString()).toBe("10");
    expect(model.officialInputPrice!.toString()).toBe("10");
    expect(model.inputPrice.toString()).toBe("5"); // 50% of official, re-derived
    const applied = (await db.priceSyncRun.findUniqueOrThrow({ where: { id: runId } })).applied as { items: unknown[] };
    expect(applied.items).toHaveLength(1);
  });

  it("a page that cannot be read fails the run without touching prices", async () => {
    const runId = await runPriceSync(providerId, { trigger: "manual", fetchText: async (url) => ({ url, ok: false, text: "", chars: 0, error: "HTTP 404" }), ask: async () => { throw new Error("must not be called"); } });
    const run = await db.priceSyncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/HTTP 404/);
  });

  it("the AI call goes through our gateway as the internal customer: logged with our cost, price 0", async () => {
    const aiModel = await h.makeModel("ai", { caps: ["chat"], providerId });
    const g = await db.group.findUniqueOrThrow({ where: { id: h.groupId } });
    await setSetting("priceSyncTargets", [{ pool: g.slug, model: aiModel.slug }]);
    const answer = await askPricingAi("system", "say hi");
    expect(answer.text.length).toBeGreaterThan(0);
    expect(answer.requestId).toBeTruthy();
    await flushMeter();
    const log = await db.requestLog.findUniqueOrThrow({ where: { id: answer.requestId! }, include: { user: true } });
    expect(log.user?.email).toBe(PRICING_BOT_EMAIL);
    expect(log.price.toString()).toBe("0");
    expect(Number(log.cost.toString())).toBeGreaterThan(0);
    // the throwaway key is gone again: no standing internal key in the key lists
    expect(await db.apiKey.count({ where: { userId: log.userId!, name: "Pricing fetch AI run" } })).toBe(0);
  });
});
