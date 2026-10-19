/**
 * Pricing in the model catalogs: /v1/models (OpenAI + OpenRouter fields), /v1/model/info (LiteLLM), spec-pure Anthropic
 * and Gemini lists and the public /api/pricing document. Real database; skipped when unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbOk, createHarness } from "./harness";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { __resetPublicPricingForTests, getPublicPricing } from "@/gateway/public-pricing";
import { GET as pricingRoute, OPTIONS as pricingOptions } from "@/app/api/pricing/route";
import { db } from "@/lib/db";
import { setSettings } from "@/lib/settings";

const h = createHarness("cat");
let model = { slug: "", id: "" };
let img = { slug: "", id: "" };
let fx = { key: "", userId: "" };
let fxDisc = { key: "", userId: "" };

describe.skipIf(!dbOk)("catalog pricing endpoints", () => {
  beforeAll(async () => {
    await h.start();
    const p = await h.makeProvider("oa", { formats: ["openai_chat", "openai_images"], keys: [{ s: "k1" }] });
    model = await h.makeModel("chat", {
      caps: ["chat", "responses", "vision", "tools"],
      providerId: p.id,
      in: "3",
      out: "15",
      cached: "0.3",
      maxOutput: 8000,
      official: { officialInputPrice: "5", officialOutputPrice: "25", officialCachedPrice: "0.5" },
      model: { contextWindow: 200_000, description: "Demo chat model" },
      cost: { inputCost: "1", outputCost: "5" },
    });
    img = await h.makeModel("img", { caps: ["images"], providerId: p.id, in: "0", out: "0", image: "0.052", official: { officialImagePrice: "0.04" }, cost: { inputCost: "0", outputCost: "0", imageCost: "0.02" } });
    const u = await h.makeUser("u", { balance: "5" });
    fx = await h.makeKey("u", u.id);
    const d = await h.makeUser("d", { balance: "5", priceMultiplier: "0.5" });
    fxDisc = await h.makeKey("d", d.id);
    await invalidateGatewayConfig("all");
    __resetPublicPricingForTests();
  }, 60_000);

  afterAll(async () => {
    await h.cleanup();
  }, 30_000);

  it("GET /v1/models: OpenAI fields + OpenRouter pricing strings + x_pricing", async () => {
    const res = await h.call("/v1/models", fx.key);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    const m = body.data.find((x: { id: string }) => x.id === model.slug);
    expect(m).toMatchObject({
      object: "model",
      owned_by: "gwt",
      name: model.slug,
      description: "Demo chat model",
      context_length: 200_000,
      pricing: { prompt: "0.000003", completion: "0.000015", request: "0", image: "0", input_cache_read: "0.0000003", input_cache_write: "0", internal_reasoning: "0" },
      top_provider: { context_length: 200_000, max_completion_tokens: 8000 },
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    });
    expect(typeof m.created).toBe("number");
    expect(m.x_pricing).toMatchObject({ unit: "usd_per_1m", currency: "USD", yours: { input: 3, output: 15, cached_input: 0.3 }, official: { input: 5, output: 25, cached_input: 0.5 } });
    expect(m.x_pricing.savings_pct).toEqual({ input: 40, output: 40, cached_input: 40 });
    const i = body.data.find((x: { id: string }) => x.id === img.slug);
    expect(i.pricing.image).toBe("0.052");
    expect(i.x_pricing.yours).toEqual({ image: 0.052 });
    expect(i.x_pricing.savings_pct).toEqual({ image: -30 });
    expect(i.architecture.output_modalities).toEqual(["image"]);
  });

  it("prices are the caller's effective prices (group x customer multiplier)", async () => {
    const m = (await (await h.call("/v1/models", fxDisc.key)).json()).data.find((x: { id: string }) => x.id === model.slug);
    expect(m.pricing.prompt).toBe("0.0000015");
    expect(m.pricing.completion).toBe("0.0000075");
    expect(m.x_pricing.yours).toMatchObject({ input: 1.5, output: 7.5 });
    expect(m.x_pricing.official.input).toBe(5); // official stays the maker's price
    expect(m.x_pricing.savings_pct.input).toBe(70);
  });

  it("GET /v1/models/{id} carries the same fields", async () => {
    const res = await h.call(`/v1/models/${model.slug}`, fx.key);
    expect(res.status).toBe(200);
    const m = await res.json();
    expect(m).toMatchObject({ id: model.slug, name: model.slug, pricing: { prompt: "0.000003" }, x_pricing: { unit: "usd_per_1m" } });
    expect((await h.call("/v1/models/nope-" + h.sfx, fx.key)).status).toBe(404);
  });

  it("the Anthropic-shaped list is spec-pure", async () => {
    const res = await h.call("/v1/models", null, undefined, { headers: { "x-api-key": fx.key, "anthropic-version": "2023-06-01" } });
    const body = await res.json();
    const m = body.data.find((x: { id: string }) => x.id === model.slug);
    expect(Object.keys(m).sort()).toEqual(["created_at", "display_name", "id", "type"]);
    expect(Object.keys(body).sort()).toEqual(["data", "first_id", "has_more", "last_id"]);
  });

  it("the Gemini-shaped list keeps only native fields", async () => {
    const res = await h.call("/v1beta/models", fx.key);
    const body = await res.json();
    const m = body.models.find((x: { name: string }) => x.name === `models/${model.slug}`);
    expect(Object.keys(m).sort()).toEqual(["description", "displayName", "inputTokenLimit", "name", "outputTokenLimit", "supportedGenerationMethods", "version"]);
    expect(m.outputTokenLimit).toBe(8000);
  });

  it("GET /v1/model/info (LiteLLM) at the caller's price; authentication required", async () => {
    const res = await h.call("/v1/model/info", fxDisc.key);
    expect(res.status).toBe(200);
    const body = await res.json();
    const e = body.data.find((x: { model_name: string }) => x.model_name === model.slug);
    expect(e.model_info).toMatchObject({
      input_cost_per_token: 0.0000015,
      output_cost_per_token: 0.0000075,
      cache_read_input_token_cost: 0.00000015,
      cache_creation_input_token_cost: null,
      max_tokens: 8000,
      max_input_tokens: 200_000,
      max_output_tokens: 8000,
      mode: "chat",
      supports_function_calling: true,
      supports_vision: true,
      supports_reasoning: false,
    });
    const i = body.data.find((x: { model_name: string }) => x.model_name === img.slug);
    expect(i.model_info).toMatchObject({ mode: "image_generation", output_cost_per_image: 0.026 });

    const anon = await h.call("/v1/model/info", null);
    expect(anon.status).toBe(401);
    expect((await anon.json()).error.code).toBe("invalid_api_key");
    expect((await h.call("/v1/model/info", fx.key, {})).status).toBe(405);
  });

  it("public /api/pricing: official vs default-group price, savings, no costs / providers / upstream ids", async () => {
    const doc = await getPublicPricing();
    expect(doc).not.toBeNull();
    expect(doc!.currency).toBe("USD");
    const m = doc!.data.find((x) => x.id === model.slug) as { pricing: { yours: { input: number }; official: { input: number } }; capabilities: string[]; context_length: number };
    expect(m).toBeTruthy();
    const mult = doc!.group.multiplier;
    expect(m.pricing.yours.input).toBeCloseTo(3 * mult, 9);
    expect(m.pricing.official.input).toBe(5);
    expect(m.capabilities).toContain("chat");
    expect(m.context_length).toBe(200_000);
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/inputCost|outputCost|up-chat|up-img|providerId|"cost"/);
    expect(text).not.toContain(h.name("oa")); // provider name / slug
    expect(text).not.toContain(h.base);
  });

  it("?group=<slug> prices a public group; unknown / non-public groups are 404", async () => {
    const own = await db.group.findFirstOrThrow({ where: { slug: h.name("g") } });
    await db.group.update({ where: { id: own.id }, data: { priceMultiplier: "0.8" } });
    await invalidateGatewayConfig("all");
    __resetPublicPricingForTests();
    const res = await pricingRoute(new Request(`http://x.test/api/pricing?group=${own.slug}`));
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.group).toMatchObject({ slug: own.slug, multiplier: 0.8 });
    const m = doc.data.find((x: { id: string }) => x.id === model.slug);
    expect(m.pricing.yours.input).toBe(2.4);
    expect(m.pricing.savings_pct.input).toBe(52);
    expect(doc.groups.some((g: { slug: string }) => g.slug === own.slug)).toBe(true);

    expect((await pricingRoute(new Request("http://x.test/api/pricing?group=nope-" + h.sfx))).status).toBe(404);
    await db.group.update({ where: { id: own.id }, data: { isPublic: false } });
    await invalidateGatewayConfig("all");
    __resetPublicPricingForTests();
    expect((await pricingRoute(new Request(`http://x.test/api/pricing?group=${own.slug}`))).status).toBe(404);
  });

  it("is cacheable for 60s and open to every origin", async () => {
    const res = await pricingRoute(new Request("http://x.test/api/pricing"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toMatch(/public.*max-age=60/);
    const pre = pricingOptions();
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("private pricing or a private model list: 401 for visitors, never cached", async () => {
    try {
      for (const off of [{ publicPricing: false }, { publicModels: false }]) {
        await setSettings({ publicPricing: true, publicModels: true, ...off });
        const res = await pricingRoute(new Request("http://x.test/api/pricing"));
        expect(res.status).toBe(401);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("pricing_private");
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    } finally {
      await setSettings({ publicPricing: true, publicModels: true });
    }
    expect((await pricingRoute(new Request("http://x.test/api/pricing"))).status).toBe(200);
  });
});
