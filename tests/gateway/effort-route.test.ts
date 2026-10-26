/**
 * Effort routing: a pool's requests at a high reasoning effort are routed AND billed as another pool (or sent to one
 * provider). Unit tests for effort parsing / rule matching, then the real pipeline against the in-process mock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbOk, createHarness } from "./harness";
import { invalidateGatewayConfig, type ConfigSnapshot, type GroupRec, type ModelRec } from "@/gateway/cache";
import { parseEffortRoutes, requestEffort, routeByEffort, withRequestEffort } from "@/gateway/effort-route";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";

describe("requestEffort", () => {
  it("reads the effort of every format", () => {
    expect(requestEffort("openai_chat", { reasoning_effort: "XHigh" })).toBe("xhigh");
    expect(requestEffort("openai_chat", { reasoning: { effort: "max" } })).toBe("max");
    expect(requestEffort("openai_responses", { reasoning: { effort: "high" } })).toBe("high");
    expect(requestEffort("anthropic_messages", { output_config: { effort: "max" } })).toBe("max");
    expect(requestEffort("gemini", { generationConfig: { thinkingConfig: { thinkingLevel: "high" } } })).toBe("high");
    expect(requestEffort("openai_chat", { messages: [] })).toBeNull();
    expect(requestEffort("openai_embeddings", { reasoning_effort: "max" })).toBeNull();
  });
});

describe("routeByEffort", () => {
  const g = (o: Partial<GroupRec>): GroupRec => ({ id: "x", slug: "x", name: "x", priceMultiplier: new Decimal(1), providerTags: [], allowedModels: null, isDefault: false, isPublic: true, rpmLimit: null, maxConcurrency: null, priceBasis: "model", referenceSavingsPct: null, effortRoutes: [], ...o });
  const official = g({ id: "off", slug: "standard" });
  const studio = g({ id: "st", slug: "studio", priceMultiplier: new Decimal("0.3"), effortRoutes: parseEffortRoutes([{ models: ["gpt-6*"], minEffort: "xhigh", groupId: "off" }]) });
  const snap = { groupsById: new Map([["off", official], ["st", studio]]), providers: new Map([["p1", {}]]) } as unknown as ConfigSnapshot;
  const model = (slug: string) => ({ slug }) as ModelRec;

  it("ticked efforts match independently, 'default' = no effort set", () => {
    const picky = g({ slug: "studio", effortRoutes: parseEffortRoutes([{ models: [], efforts: ["medium", "xhigh"], groupId: "off" }]) });
    const route = (e?: string) => routeByEffort(snap, picky, model("m"), "openai_chat", e ? { reasoning_effort: e } : {})?.group.slug ?? null;
    expect([route("low"), route("medium"), route("high"), route("xhigh"), route("max"), route()]).toEqual([null, "standard", null, "standard", null, null]);
    const dflt = g({ slug: "studio", effortRoutes: parseEffortRoutes([{ models: [], efforts: ["default"], groupId: "off" }]) });
    const r = routeByEffort(snap, dflt, model("m"), "openai_chat", {});
    expect(r?.group.slug).toBe("standard");
    expect(r?.effort).toBe("default");
    expect(routeByEffort(snap, dflt, model("m"), "openai_chat", { reasoning_effort: "high" })).toBeNull();
  });

  it("legacy minEffort rules mean that effort and above", () => {
    expect(parseEffortRoutes([{ minEffort: "xhigh", groupId: "a" }])[0].efforts).toEqual(["xhigh", "max"]);
  });

  it("moves xhigh and above, keeps high, default and other models", () => {
    expect(routeByEffort(snap, studio, model("gpt-6-astra"), "openai_chat", { reasoning_effort: "xhigh" })?.group.slug).toBe("standard");
    expect(routeByEffort(snap, studio, model("gpt-6-astra"), "openai_responses", { reasoning: { effort: "max" } })?.group.slug).toBe("standard");
    expect(routeByEffort(snap, studio, model("gpt-6-astra"), "openai_chat", { reasoning_effort: "high" })).toBeNull();
    expect(routeByEffort(snap, studio, model("gpt-6-astra"), "openai_chat", {})).toBeNull();
    expect(routeByEffort(snap, studio, model("gpt-5.6-sol"), "openai_chat", { reasoning_effort: "max" })).toBeNull();
    expect(routeByEffort(snap, studio, model("gpt-6-astra"), "openai_chat", { reasoning_effort: "turbo" })).toBeNull();
  });

  it("skips rules whose pool is gone or does not offer the model; a provider rule pins the provider", () => {
    const gone = g({ effortRoutes: parseEffortRoutes([{ models: [], minEffort: "high", groupId: "nope" }]) });
    expect(routeByEffort(snap, gone, model("m"), "openai_chat", { reasoning_effort: "max" })).toBeNull();
    const closed = { ...snap, groupsById: new Map([["off", { ...official, allowedModels: new Set(["other"]) }]]) } as unknown as ConfigSnapshot;
    expect(routeByEffort(closed, studio, model("gpt-6-astra"), "openai_chat", { reasoning_effort: "max" })).toBeNull();
    const pin = g({ slug: "studio", effortRoutes: parseEffortRoutes([{ models: [], minEffort: "xhigh", providerId: "p1" }]) });
    const r = routeByEffort(snap, pin, model("m"), "openai_chat", { reasoning_effort: "xhigh" });
    expect(r?.group.slug).toBe("studio");
    expect(r?.group.routeProviderId).toBe("p1");
  });

  it("a cap lowers only efforts above it", () => {
    const capped = g({ slug: "studio", effortRoutes: parseEffortRoutes([{ models: [], minEffort: "xhigh", groupId: "off", capEffort: "xhigh" }]) });
    expect(routeByEffort(snap, capped, model("m"), "openai_chat", { reasoning_effort: "max" })?.sendEffort).toBe("xhigh");
    expect(routeByEffort(snap, capped, model("m"), "openai_chat", { reasoning_effort: "xhigh" })?.sendEffort).toBeNull();
    const cappedDefault = g({ slug: "studio", effortRoutes: parseEffortRoutes([{ models: [], efforts: ["default"], groupId: "off", capEffort: "low" }]) });
    expect(routeByEffort(snap, cappedDefault, model("m"), "openai_chat", {})?.sendEffort).toBeNull();
  });

  it("withRequestEffort rewrites a copy in every format", () => {
    const chat = { reasoning_effort: "max", messages: [] };
    expect(withRequestEffort("openai_chat", chat, "xhigh").reasoning_effort).toBe("xhigh");
    expect(chat.reasoning_effort).toBe("max");
    const resp = { reasoning: { effort: "max", summary: "auto" } };
    expect(withRequestEffort("openai_responses", resp, "xhigh").reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(resp.reasoning.effort).toBe("max");
    expect(withRequestEffort("anthropic_messages", { output_config: { effort: "max" } }, "high").output_config).toEqual({ effort: "high" });
    expect(withRequestEffort("gemini", { generationConfig: { thinkingConfig: { thinkingLevel: "max" }, temperature: 1 } }, "high").generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "high" }, temperature: 1 });
  });

  it("drops malformed stored rules", () => {
    expect(parseEffortRoutes([{ minEffort: "ultra", groupId: "a" }, { minEffort: "high" }, { efforts: [], groupId: "a" }, { efforts: ["turbo"], groupId: "a" }, null, { efforts: ["max", "low", "x"], groupId: "a", models: [1, " gpt "] }])).toEqual([
      { models: ["gpt"], efforts: ["low", "max"], groupId: "a", providerId: null, capEffort: null },
    ]);
    expect(parseEffortRoutes("x")).toEqual([]);
  });
});

const h = createHarness("eff");

describe.skipIf(!dbOk)("effort routing through the gateway", () => {
  const S: Record<string, string> = {};
  let key = "";
  let modelSlug = "";

  beforeAll(async () => {
    await h.start();
    const reseller = await h.makeProvider("ce", { formats: ["openai_chat", "openai_responses"], keys: [{ s: "ce1" }] });
    const officialP = await h.makeProvider("off", { formats: ["openai_chat", "openai_responses"], keys: [{ s: "of1" }] });
    await db.provider.update({ where: { id: reseller.id }, data: { tags: [`ce-${h.sfx}`] } });
    await db.provider.update({ where: { id: officialP.id }, data: { tags: [`off-${h.sfx}`] } });
    const standard = await db.group.create({ data: { name: h.name("std"), slug: h.name("std"), priceMultiplier: "1", providerTags: [`off-${h.sfx}`] } });
    const studio = await db.group.create({
      data: { name: h.name("studio"), slug: h.name("studio"), priceMultiplier: "0.3", providerTags: [`ce-${h.sfx}`], effortRoutes: [{ models: [], minEffort: "xhigh", groupId: standard.id }] },
    });
    h.ids.groups.push(standard.id, studio.id);
    Object.assign(S, { reseller: reseller.id, official: officialP.id, standard: standard.slug, standardId: standard.id, studio: studio.slug, studioId: studio.id });
    const m = await h.makeModel("astra", { caps: ["chat", "responses", "reasoning"], providerId: reseller.id, in: "3", out: "15" });
    await db.modelRoute.create({ data: { modelId: m.id, providerId: officialP.id, upstreamModel: "up-astra-official", inputCost: "3", outputCost: "15" } });
    modelSlug = m.slug;
    const u = await h.makeUser("u", { balance: "50", groupId: studio.id });
    key = (await h.makeKey("k", u.id)).key;
    await invalidateGatewayConfig("all");
  });
  afterAll(() => h.cleanup());

  const chat = (effort?: string) => h.call("/v1/chat/completions", key, { model: modelSlug, messages: [{ role: "user", content: "hi" }], ...(effort ? { reasoning_effort: effort } : {}) });
  const listPrice = (row: { inputTokens: number; outputTokens: number }) => new Decimal(row.inputTokens).mul(3).add(new Decimal(row.outputTokens).mul(15)).div(1e6);

  it("up to high: the reseller, billed at the studio multiplier", async () => {
    for (const effort of [undefined, "low", "high"]) {
      const res = await chat(effort);
      expect(res.status).toBe(200);
      const row = await h.logOf(res);
      expect(row.providerId).toBe(S.reseller);
      expect(row.groupSlug).toBe(S.studio);
      expect(new Decimal(row.price.toString()).toFixed(9)).toBe(listPrice(row).mul("0.3").toFixed(9));
    }
  });

  it("xhigh and max: the official provider, logged and billed as the standard pool", async () => {
    for (const effort of ["xhigh", "max"]) {
      const res = await chat(effort);
      expect(res.status).toBe(200);
      const row = await h.logOf(res);
      expect(row.providerId).toBe(S.official);
      expect(row.upstreamModel).toBe("up-astra-official");
      expect(row.groupSlug).toBe(S.standard);
      expect(new Decimal(row.price.toString()).toFixed(9)).toBe(listPrice(row).toFixed(9));
    }
    const res = await h.call("/v1/responses", key, { model: modelSlug, input: "hi", reasoning: { effort: "xhigh" } });
    expect(res.status).toBe(200);
    expect((await h.logOf(res)).providerId).toBe(S.official);
  });

  it("a conversation held by the reseller (previous_response_id) stays there", async () => {
    const first = await h.call("/v1/responses", key, { model: modelSlug, input: "hi", reasoning: { effort: "high" } });
    expect(first.status).toBe(200);
    const id = ((await first.json()) as { id: string }).id;
    expect((await h.logOf(first)).providerId).toBe(S.reseller);
    const next = await h.call("/v1/responses", key, { model: modelSlug, input: "more", previous_response_id: id, reasoning: { effort: "max" } });
    expect(next.status).toBe(200);
    const row = await h.logOf(next);
    expect(row.providerId).toBe(S.reseller);
    expect(row.groupSlug).toBe(S.studio);
  });

  it("independently ticked efforts: medium and max move, high / xhigh / not set stay", async () => {
    await db.group.update({ where: { id: S.studioId }, data: { effortRoutes: [{ models: [], efforts: ["medium", "max"], groupId: S.standardId }] } });
    await invalidateGatewayConfig("all");
    const served: Record<string, string | null> = {};
    for (const e of ["medium", "high", "xhigh", "max", ""]) {
      const res = await chat(e || undefined);
      expect(res.status).toBe(200);
      const row = await h.logOf(res);
      served[e || "unset"] = row.providerId === S.official ? "official" : row.providerId === S.reseller ? "reseller" : row.providerId;
    }
    expect(served).toEqual({ medium: "official", high: "reseller", xhigh: "reseller", max: "official", unset: "reseller" });
  });

  it("a capped rule sends max to the official provider as xhigh", async () => {
    await db.group.update({ where: { id: S.studioId }, data: { effortRoutes: [{ models: [], minEffort: "xhigh", groupId: S.standardId, capEffort: "xhigh" }] } });
    await invalidateGatewayConfig("all");
    const res = await chat("max");
    expect(res.status).toBe(200);
    const row = await h.logOf(res);
    expect(row.providerId).toBe(S.official);
    expect(row.groupSlug).toBe(S.standard);
    const last = (await (await fetch(`${h.base}/__mock/last?path=${encodeURIComponent("/v1/chat/completions")}`)).json()) as { body: Record<string, unknown> };
    expect(last.body.reasoning_effort).toBe("xhigh");
    expect(last.body.model).toBe("up-astra-official");
  });

  it("a provider-only rule sends the request there but keeps the pool's price", async () => {
    await db.group.update({ where: { id: S.studioId }, data: { effortRoutes: [{ models: [modelSlug], minEffort: "xhigh", providerId: S.official }] } });
    await invalidateGatewayConfig("all");
    const res = await chat("xhigh");
    expect(res.status).toBe(200);
    const row = await h.logOf(res);
    expect(row.providerId).toBe(S.official);
    expect(row.groupSlug).toBe(S.studio);
    expect(new Decimal(row.price.toString()).toFixed(9)).toBe(listPrice(row).mul("0.3").toFixed(9));
  });
});
