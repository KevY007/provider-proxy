/**
 * Prices a provider publishes through its own API (admin "Fetch pricing" + add-model prefill): every common shape is
 * understood and normalised to USD per 1M tokens / per unit; a live probe against the mock reads models + prices.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk } from "./harness";
import { parseRemotePricing, pricingCandidates } from "@/gateway/remote-pricing";
import { listUpstreamModels, probeProvider, __resetUpstreamModelsCacheForTests } from "@/gateway/upstream-models";

describe("parseRemotePricing", () => {
  it("OpenRouter: USD per token strings", () => {
    const m = parseRemotePricing({ data: [{ id: "anthropic/claude-x", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003", image: "0", request: "0" }, top_provider: { max_completion_tokens: 64000 } }] }, "/api/v1/models");
    const p = m.get("anthropic/claude-x")!;
    expect(p.prices).toEqual({ input: 3, output: 15, cachedInput: 0.3 });
    expect(p.contextWindow).toBe(200000);
    expect(p.maxOutput).toBe(64000);
    expect(p.source).toBe("/api/v1/models");
  });

  it("ProviderProxy upstream: x_pricing (per 1M, with official) wins over the per-token pricing", () => {
    const m = parseRemotePricing({ data: [{ id: "claude-sonnet-5-5", pricing: { prompt: "0.000002", completion: "0.00001" }, x_pricing: { unit: "usd_per_1m", yours: { input: 1.8, output: 9, cached_input: 0.18 }, official: { input: 2, output: 10, cached_input: 0.2 } } }] }, "/v1/models");
    const p = m.get("claude-sonnet-5-5")!;
    expect(p.prices).toEqual({ input: 1.8, output: 9, cachedInput: 0.18 });
    expect(p.official).toEqual({ input: 2, output: 10, cachedInput: 0.2 });
  });

  it("ProviderProxy public pricing document (/api/pricing)", () => {
    const m = parseRemotePricing({ models: [{ id: "gpt-x", pricing: { unit: {}, yours: { input: 1, output: 4, image: null }, official: { input: 1.25, output: 5 } } }] }, "/api/pricing");
    expect(m.get("gpt-x")?.prices).toEqual({ input: 1, output: 4 });
  });

  it("LiteLLM /model/info list and LiteLLM price map", () => {
    const list = parseRemotePricing({ data: [{ model_name: "m1", model_info: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, output_cost_per_image: null, max_input_tokens: 32000 } }, { model_name: "img", model_info: { output_cost_per_image: 0.04 } }] }, "/model/info");
    expect(list.get("m1")?.prices).toEqual({ input: 1, output: 2 });
    expect(list.get("m1")?.contextWindow).toBe(32000);
    expect(list.get("img")?.prices).toEqual({ image: 0.04 });
    const map = parseRemotePricing({ "gpt-4o-mini": { input_cost_per_token: 1.5e-7, output_cost_per_token: 6e-7 }, sample_spec: { note: "no prices" } }, "/prices.json");
    expect(map.get("gpt-4o-mini")?.prices).toEqual({ input: 0.15, output: 0.6 });
    expect(map.has("sample_spec")).toBe(false);
  });

  it("Together (per 1M) and DeepInfra (metadata.pricing per token) shapes; entries without prices are skipped", () => {
    const t = parseRemotePricing([{ id: "meta-llama/x", pricing: { input: 0.88, output: 0.88 } }, { id: "free-thing" }], "/models");
    expect(t.get("meta-llama/x")?.prices).toEqual({ input: 0.88, output: 0.88 });
    expect(t.has("free-thing")).toBe(false);
    const d = parseRemotePricing({ data: [{ id: "deep/y", metadata: { pricing: { input_tokens: 0.00000023, output_tokens: 0.0000004 } } }] }, "/models");
    expect(d.get("deep/y")?.prices).toEqual({ input: 0.23, output: 0.4 });
  });

  it("candidate URLs: custom pricingUrl first, then the provider's own host", () => {
    const urls = pricingCandidates({ slug: "x", preset: "custom", baseUrl: "https://relay.example/v1", authStyle: "BEARER", tags: [], extraHeaders: {}, settings: { pricingUrl: "https://relay.example/prices.json" } });
    expect(urls[0]).toBe("https://relay.example/prices.json");
    expect(urls).toContain("https://relay.example/v1/models");
    expect(urls).toContain("https://relay.example/v1/model/info");
    expect(urls).toContain("https://relay.example/api/v1/models");
    expect(urls).toContain("https://relay.example/api/pricing");
  });
});

const h = createHarness("rpx");

describe.skipIf(!dbOk)("probe + listing against the mock upstream", () => {
  let providerId = "";
  beforeAll(async () => {
    await h.start();
    providerId = (await h.makeProvider("oa", { formats: ["openai_chat"], keys: [{ s: "k1" }] })).id;
    __resetUpstreamModelsCacheForTests();
  }, 60_000);
  afterAll(() => h.cleanup(), 60_000);

  const draft = () => ({ slug: "draft", preset: "custom", baseUrl: `${h.base}/v1`, authStyle: "BEARER" as const, tags: [], extraHeaders: {}, settings: {}, formats: ["openai_chat"] });

  it("Test connection: lists the models with the typed key; a bad key is reported, without the key", async () => {
    const ok = await probeProvider(draft(), h.secret("k1"), {}, { pricing: false });
    expect(ok.models.ok).toBe(true);
    expect(ok.models.count).toBeGreaterThan(0);
    const bad = await probeProvider(draft(), "bad-key-123", {}, { pricing: false });
    expect(bad.models.ok).toBe(false);
    expect(bad.models.error).toMatch(/rejected the key/);
    expect(JSON.stringify(bad)).not.toContain("bad-key-123");
    const none = await probeProvider(draft(), null, {}, { pricing: false });
    expect(none.models.error).toMatch(/Enter an API key/);
  });

  it("Fetch pricing: reads the provider's published price list (LiteLLM shape on the mock)", async () => {
    const r = await probeProvider(draft(), h.secret("k1"), {}, { models: false });
    expect(r.pricing.count).toBe(2);
    const gpt = r.pricing.rows.find((x) => x.id === "gpt-mock")!;
    expect(gpt.prices).toEqual({ input: 2.5, output: 10, cachedInput: 1.25 });
    expect(gpt.contextWindow).toBe(128000);
    expect(r.pricing.tried.some((t) => t.url.endsWith("/v1/model/info") && t.found === 2)).toBe(true);
  });

  it("the add-model listing carries the provider's prices for the wizard prefill", async () => {
    const items = await listUpstreamModels(providerId);
    const gpt = items.find((m) => m.id === "gpt-mock");
    expect(gpt?.remote?.prices.input).toBe(2.5);
    expect(items.find((m) => m.id === "claude-mock")?.remote ?? null).toBeNull();
  });
});
