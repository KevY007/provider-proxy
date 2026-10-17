import { describe, expect, it } from "vitest";
import { decimalString, liteLLMMode, modalities, openRouterPricing, perTokenString, plainNumber, priceMatrix } from "@/gateway/price-view";
import { liteLLMEntry, openaiModel } from "@/gateway/catalog";
import type { ModelRec } from "@/gateway/cache";
import { officialTable, sellTable } from "@/gateway/pricing";
import { Decimal } from "@/lib/money";

const d = (v: Decimal.Value) => new Decimal(v);

describe("decimal formatting", () => {
  it("never uses exponent notation and trims trailing zeros", () => {
    expect(decimalString(d("0.00000015"))).toBe("0.00000015");
    expect(decimalString(d("1e-9"))).toBe("0.000000001");
    expect(decimalString(d("2.50"))).toBe("2.5");
    expect(decimalString(d("100"))).toBe("100");
    expect(decimalString(d("1e21"))).toBe("1000000000000000000000");
    expect(decimalString(d(0))).toBe("0");
  });

  it("converts USD per 1M tokens to USD per token without float noise", () => {
    expect(perTokenString(d("0.15"))).toBe("0.00000015");
    expect(perTokenString(d("2.5"))).toBe("0.0000025");
    expect(perTokenString(d("0.195"))).toBe("0.000000195");
    expect(perTokenString(d("0.01"))).toBe("0.00000001");
    expect(perTokenString(d("15"))).toBe("0.000015");
    expect(perTokenString(d("0.0000001"))).toBe("0.0000000000001");
    expect(perTokenString(null)).toBe("0");
    expect(perTokenString(d(0))).toBe("0");
    for (const v of ["0.15", "3.9", "26", "0.075", "0.0375", "1.25", "0.00185"]) expect(perTokenString(d(v))).not.toMatch(/e/i);
  });

  it("plainNumber is the clean double of the decimal", () => {
    expect(plainNumber(d("0.195"))).toBe(0.195);
    expect(plainNumber(d("0.0000000195"))).toBe(1.95e-8);
    expect(plainNumber(null)).toBeNull();
  });
});

describe("OpenRouter-style pricing", () => {
  const sell = sellTable({ inputPrice: "3", outputPrice: "15", cachedInputPrice: "0.3", cacheWritePrice: "3.75", imagePrice: "0.04", requestPrice: "0.001" });

  it("is per token as decimal strings, scaled by the caller's multiplier; request / image stay per unit", () => {
    expect(openRouterPricing(sell, d(1))).toEqual({
      prompt: "0.000003",
      completion: "0.000015",
      request: "0.001",
      image: "0.04",
      input_cache_read: "0.0000003",
      input_cache_write: "0.00000375",
      internal_reasoning: "0",
    });
    const cheap = openRouterPricing(sell, d("0.8"));
    expect(cheap.prompt).toBe("0.0000024");
    expect(cheap.image).toBe("0.032");
  });

  it('is "0" for units a model does not have', () => {
    const p = openRouterPricing(sellTable({ inputPrice: "0.1", outputPrice: "0" }), d(1));
    expect(p).toMatchObject({ prompt: "0.0000001", completion: "0", request: "0", image: "0", input_cache_read: "0", input_cache_write: "0" });
  });
});

describe("price matrix (x_pricing)", () => {
  it("lists yours / official / savings per unit with the right unit of measure", () => {
    const sell = sellTable({ inputPrice: "2", outputPrice: "10", cachedInputPrice: "0.2" });
    const official = officialTable({ officialInputPrice: "4", officialOutputPrice: "8" });
    const m = priceMatrix(sell, official, d(1));
    expect(m.yours).toEqual({ input: 2, output: 10, cached_input: 0.2 });
    expect(m.official).toEqual({ input: 4, output: 8 });
    expect(m.savings_pct).toEqual({ input: 50, output: -25 }); // above official: negative, shown
    expect(m.unit).toMatchObject({ input: "usd_per_1m_tokens", cached_input: "usd_per_1m_tokens" });
  });

  it("shows a pure image / video / transcription model without token prices", () => {
    const img = priceMatrix(sellTable({ inputPrice: "0", outputPrice: "0", imagePrice: "0.052" }), officialTable({ officialImagePrice: "0.04" }), d(1));
    expect(Object.keys(img.yours)).toEqual(["image"]);
    expect(img.unit.image).toBe("usd_per_image");
    expect(img.savings_pct.image).toBe(-30);
    const vid = priceMatrix(sellTable({ inputPrice: "0", outputPrice: "0", perSecondPrice: "0.13" }), officialTable({ officialPerSecondPrice: "0.1" }), d(1));
    expect(vid.unit).toEqual({ per_second: "usd_per_second" });
    const stt = priceMatrix(sellTable({ inputPrice: "0", outputPrice: "0", perMinutePrice: "0.0078" }), officialTable({}), d(1));
    expect(stt.yours).toEqual({ per_minute: 0.0078 });
    expect(stt.official).toEqual({});
    expect(stt.savings_pct).toEqual({});
  });

  it("applies the multiplier to your price only", () => {
    const m = priceMatrix(sellTable({ inputPrice: "2", outputPrice: "10" }), officialTable({ officialInputPrice: "4", officialOutputPrice: "20" }), d("0.5"));
    expect(m.yours).toEqual({ input: 1, output: 5 });
    expect(m.official).toEqual({ input: 4, output: 20 });
    expect(m.savings_pct).toEqual({ input: 75, output: 75 });
  });
});

describe("modalities / LiteLLM mode", () => {
  it("derives modalities from capabilities", () => {
    expect(modalities(["chat", "vision", "tools"])).toEqual({ input_modalities: ["text", "image"], output_modalities: ["text"] });
    expect(modalities(["images"])).toEqual({ input_modalities: ["text"], output_modalities: ["image"] });
    expect(modalities(["audio_speech"])).toEqual({ input_modalities: ["text"], output_modalities: ["audio"] });
    expect(modalities(["audio_transcription"])).toEqual({ input_modalities: ["audio"], output_modalities: ["text"] });
    expect(modalities(["video"])).toEqual({ input_modalities: ["text"], output_modalities: ["video"] });
    expect(modalities(["embeddings"]).output_modalities).toEqual(["embeddings"]);
  });

  it("maps capabilities to LiteLLM modes", () => {
    expect(liteLLMMode(["chat", "responses"])).toBe("chat");
    expect(liteLLMMode(["completions"])).toBe("completion");
    expect(liteLLMMode(["embeddings"])).toBe("embedding");
    expect(liteLLMMode(["images"])).toBe("image_generation");
    expect(liteLLMMode(["audio_speech"])).toBe("audio_speech");
    expect(liteLLMMode(["audio_transcription"])).toBe("audio_transcription");
    expect(liteLLMMode(["video"])).toBe("video_generation");
    expect(liteLLMMode(["moderation"])).toBe("moderation");
  });
});

const rec = (over: Partial<ModelRec> = {}): ModelRec => ({
  id: "m1",
  slug: "demo-model",
  aliases: [],
  displayName: "Demo Model",
  vendor: "acme",
  description: "A demo.",
  capabilities: new Set(["chat", "responses", "vision", "tools", "reasoning"]),
  contextWindow: 200_000,
  maxOutput: 8_000,
  status: "ACTIVE",
  sortOrder: 1,
  maskUpstreamModel: true,
  sell: sellTable({ inputPrice: "3", outputPrice: "15", cachedInputPrice: "0.3", cacheWritePrice: "3.75" }),
  official: officialTable({ officialInputPrice: "5", officialOutputPrice: "25", officialCachedPrice: "0.5" }),
  retiresAt: null,
  longContext: { threshold: null, multiplier: null },
  createdAt: 1_700_000_000_000,
  ...over,
});

describe("catalog shapes", () => {
  it("OpenAI model object keeps id/object/created/owned_by and adds the OpenRouter fields + x_pricing", () => {
    const o = openaiModel(rec(), d(1));
    expect(o).toMatchObject({
      id: "demo-model",
      object: "model",
      created: 1_700_000_000,
      owned_by: "acme",
      name: "Demo Model",
      context_length: 200_000,
      pricing: { prompt: "0.000003", completion: "0.000015", request: "0", image: "0", input_cache_read: "0.0000003", input_cache_write: "0.00000375", internal_reasoning: "0" },
      top_provider: { context_length: 200_000, max_completion_tokens: 8_000 },
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      x_pricing: { unit: "usd_per_1m", currency: "USD", yours: { input: 3, output: 15, cached_input: 0.3, cache_write: 3.75 }, official: { input: 5, output: 25, cached_input: 0.5 } },
    });
    expect(o.x_pricing.savings_pct).toEqual({ input: 40, output: 40, cached_input: 40 });
    expect(JSON.stringify(o)).not.toMatch(/\d+e-\d+/i); // no exponent notation anywhere
  });

  it("prices are the caller's effective prices", () => {
    const o = openaiModel(rec(), d("0.5"));
    expect(o.pricing.prompt).toBe("0.0000015");
    expect(o.x_pricing.yours.input).toBe(1.5);
    expect(o.x_pricing.savings_pct.input).toBe(70);
  });

  it("exposes the retirement date", () => {
    expect(openaiModel(rec({ retiresAt: Date.parse("2026-09-24T00:00:00Z") }), d(1)).x_retires_at).toBe("2026-09-24T00:00:00.000Z");
    expect(openaiModel(rec(), d(1)).x_retires_at).toBeUndefined();
  });

  it("LiteLLM model_info is per token at the caller's price", () => {
    const e = liteLLMEntry(rec(), d("0.8"));
    expect(e.model_name).toBe("demo-model");
    expect(e.model_info).toMatchObject({
      input_cost_per_token: 0.0000024,
      output_cost_per_token: 0.000012,
      cache_read_input_token_cost: 0.00000024,
      cache_creation_input_token_cost: 0.000003,
      output_cost_per_image: null,
      output_cost_per_second: null,
      max_tokens: 8_000,
      max_input_tokens: 200_000,
      max_output_tokens: 8_000,
      mode: "chat",
      supports_function_calling: true,
      supports_vision: true,
      supports_reasoning: true,
    });
  });

  it("LiteLLM info for image / video / transcription models", () => {
    const img = liteLLMEntry(rec({ capabilities: new Set(["images"]), sell: sellTable({ inputPrice: 0, outputPrice: 0, imagePrice: "0.04" }), maxOutput: null, contextWindow: null }), d(1));
    expect(img.model_info).toMatchObject({ mode: "image_generation", output_cost_per_image: 0.04, input_cost_per_token: 0, supports_function_calling: false, max_tokens: null });
    const vid = liteLLMEntry(rec({ capabilities: new Set(["video"]), sell: sellTable({ inputPrice: 0, outputPrice: 0, perSecondPrice: "0.13" }) }), d(1));
    expect(vid.model_info).toMatchObject({ mode: "video_generation", output_cost_per_second: 0.13 });
    const stt = liteLLMEntry(rec({ capabilities: new Set(["audio_transcription"]), sell: sellTable({ inputPrice: 0, outputPrice: 0, perMinutePrice: "0.006" }) }), d(1));
    expect(stt.model_info).toMatchObject({ mode: "audio_transcription", input_cost_per_second: 0.0001 });
  });
});
