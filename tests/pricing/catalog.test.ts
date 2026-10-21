import { describe, expect, it } from "vitest";
import { KNOWN_PRICES, lookupKnownPrice } from "@/gateway/price-catalog";
import { MODELS, PROVIDERS } from "../../prisma/seed-data";

describe("known price catalog", () => {
  it("has unique (vendor, model) keys and sane numbers", () => {
    const seen = new Set<string>();
    for (const k of KNOWN_PRICES) {
      const id = `${k.vendor}|${k.model}`;
      expect(seen.has(id), `duplicate ${id}`).toBe(false);
      seen.add(id);
      for (const [unit, v] of Object.entries(k.official)) {
        if (v === null || v === undefined) continue;
        expect(Number.isFinite(v) && v >= 0, `${id} ${unit}`).toBe(true);
      }
      expect(Object.values(k.official).some((v) => v !== null && v !== undefined), `${id} has no price at all`).toBe(true);
      expect(k.capabilities?.length, `${id} capabilities`).toBeGreaterThan(0);
    }
  });

  it("covers every model the seed creates and every model setup:live creates", () => {
    const presetOf = (slug: string) => PROVIDERS.find((p) => p.slug === slug)!.preset;
    for (const m of MODELS) expect(lookupKnownPrice(presetOf(m.provider), m.upstream ?? m.slug), m.slug).not.toBeNull();
    const live: Array<[string, string]> = [
      ["openai", "gpt-5-mini"], ["openai", "gpt-5-nano"], ["openai", "gpt-4.1-nano"], ["openai", "gpt-4o-mini"], ["openai", "gpt-image-1-mini"], ["openai", "tts-1"], ["openai", "whisper-1"],
      ["openai", "text-embedding-3-small"], ["openai", "omni-moderation-latest"], ["anthropic", "claude-haiku-4-5-20251001"], ["fal", "fal-ai/flux/schnell"], ["fal", "fal-ai/flux/dev"],
      ["fal", "fal-ai/flux-pro/v1.1"], ["fal", "fal-ai/recraft/v3/text-to-image"], ["fal", "fal-ai/kling-video/v2.1/master/text-to-video"], ["replicate", "black-forest-labs/flux-schnell"],
      ["replicate", "black-forest-labs/flux-dev"], ["replicate", "black-forest-labs/flux-1.1-pro"],
    ];
    for (const [v, m] of live) expect(lookupKnownPrice(v, m), `${v}/${m}`).not.toBeNull();
  });

  it("knows the common current model families", () => {
    for (const [v, m] of [
      ["openai", "gpt-4o"], ["openai", "gpt-4.1"], ["openai", "gpt-5"], ["openai", "o3"], ["openai", "tts-1-hd"], ["openai", "text-embedding-3-large"],
      ["anthropic", "claude-sonnet-4-5"], ["anthropic", "claude-opus-4-1"], ["google", "gemini-2.5-pro"], ["google", "gemini-3-pro-preview"], ["xai", "grok-4"], ["deepseek", "deepseek-chat"],
      ["groq", "llama-3.3-70b-versatile"], ["groq", "openai/gpt-oss-120b"], ["groq", "whisper-large-v3-turbo"], ["replicate", "black-forest-labs/flux-dev"],
    ]) expect(lookupKnownPrice(v, m), `${v}/${m}`).not.toBeNull();
  });

  it("has the official prices of the well-known models right", () => {
    expect(lookupKnownPrice("openai", "gpt-4o")!.official).toMatchObject({ input: 2.5, output: 10, cachedInput: 1.25 });
    expect(lookupKnownPrice("openai", "gpt-4o-mini")!.official).toMatchObject({ input: 0.15, output: 0.6, cachedInput: 0.075 });
    expect(lookupKnownPrice("anthropic", "claude-sonnet-4-5")!.official).toMatchObject({ input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 });
    expect(lookupKnownPrice("anthropic", "claude-sonnet-4-5")!.cacheWrite1h).toBe(6);
    expect(lookupKnownPrice("openai", "whisper-1")!.official).toEqual({ perMinute: 0.006 });
    expect(lookupKnownPrice("openai", "tts-1")!.official).toEqual({ perMillionChars: 15 });
    expect(lookupKnownPrice("fal", "fal-ai/flux/schnell")!.official).toEqual({ image: 0.003 });
  });

  it("tolerates date suffixes, -latest, provider prefixes and the 'models/' prefix", () => {
    expect(lookupKnownPrice("openai", "gpt-4o-mini-2024-07-18")?.model).toBe("gpt-4o-mini");
    expect(lookupKnownPrice("openai", "gpt-4.1-2025-04-14")?.model).toBe("gpt-4.1");
    expect(lookupKnownPrice("openai", "o3-2025-04-16")?.model).toBe("o3");
    expect(lookupKnownPrice("anthropic", "claude-sonnet-4-5-20250929")?.model).toBe("claude-sonnet-4-5");
    expect(lookupKnownPrice("anthropic", "claude-3-5-haiku-latest")?.model).toBe("claude-3-5-haiku");
    expect(lookupKnownPrice("google", "models/gemini-2.5-flash")?.model).toBe("gemini-2.5-flash");
    expect(lookupKnownPrice("openrouter", "anthropic/claude-sonnet-4.5")?.model).toBe("claude-sonnet-4-5");
    expect(lookupKnownPrice("custom", "openai/gpt-4o")?.vendor).toBe("openai");
    expect(lookupKnownPrice("OpenAI", " GPT-5 ")?.model).toBe("gpt-5");
  });

  it("does not guess: unknown models are null", () => {
    expect(lookupKnownPrice("openai", "gpt-99-ultra")).toBeNull();
    expect(lookupKnownPrice("openai", "")).toBeNull();
    expect(lookupKnownPrice("fal", "fal-ai/some-new-model")).toBeNull();
  });

  it("marks the post-2025 seed models it could not verify as needing review", () => {
    for (const [v, m] of [["google", "gemini-3.8-flash"], ["xai", "grok-4.7"]]) {
      expect(lookupKnownPrice(v, m)!.needsReview, m).toBe(true);
    }
    expect(lookupKnownPrice("openai", "gpt-4o-mini")!.needsReview).toBeFalsy();
  });

  it("GPT-6 / GPT-5.6 entries match the OpenAI pricing page (standard tier, checked 2026-10-21)", () => {
    const rows: Array<[string, number, number, number, number]> = [
      // input, cached, output, 30m cache write
      ["gpt-6-astra", 10, 1, 50, 12.5],
      ["gpt-6.1-sol", 2, 0.1, 10, 2.5],
      ["gpt-6-sol", 2, 0.2, 10, 2.5],
      ["gpt-6-luna", 0.1, 0.01, 0.5, 0.125],
      ["gpt-5.6-sol", 5, 0.5, 30, 6.25], // list price (the temporary promotion is not used)
      ["gpt-5.6-terra", 2, 0.2, 12, 2.5],
      ["gpt-5.6-luna", 0.2, 0.02, 1.2, 0.25],
    ];
    for (const [m, input, cached, output, cw] of rows) {
      const k = lookupKnownPrice("openai", m)!;
      expect(k.official, m).toMatchObject({ input, cachedInput: cached, output, cacheWrite: cw });
      expect(k.needsReview, m).toBeFalsy();
      expect(k.contextWindow, m).toBe(1_000_000);
      expect(k.longContext, m).toEqual({ threshold: 272_000, multiplier: 2, outputMultiplier: 1.5 });
    }
    expect(lookupKnownPrice("openai", "gpt-image-2")!.official).toMatchObject({ input: 5, output: 30, cachedInput: 1.25 });
  });

  it("Claude 5.x entries match the Anthropic pricing page / models overview (checked 2026-10-17)", () => {
    const get = (m: string) => lookupKnownPrice("anthropic", m)!;
    // prices per 1M tokens: input, output, cache read, 5m write, 1h write
    const row = (m: string) => {
      const k = get(m);
      return [k.official.input, k.official.output, k.official.cachedInput, k.official.cacheWrite, k.cacheWrite1h];
    };
    expect(row("claude-opus-5-5")).toEqual([4, 20, 0.2, 5, 8]);
    expect(row("claude-sonnet-5-5")).toEqual([2, 10, 0.1, 2.5, 4]); // cache reads are 0.05x input on Opus 5.5 / Sonnet 5.5
    expect(row("claude-haiku-5-5")).toEqual([0.1, 0.5, 0.01, 0.125, 0.2]);
    expect(row("claude-fable-5-1")).toEqual([10, 50, 0.25, 12.5, 20]);
    for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]) {
      expect(get(m).contextWindow, m).toBe(1_000_000);
      expect(get(m).maxOutput, m).toBe(128_000);
      expect(get(m).needsReview, m).toBeFalsy();
    }
    // Haiku 5.5: prompts over 100K tokens pay $0.50 / $2.50 = 5x on every token price
    expect(get("claude-haiku-5-5").longContext).toEqual({ threshold: 100_000, multiplier: 5 });
    expect(get("claude-sonnet-5-5").longContext).toBeUndefined();
  });

  it("dated Claude ids resolve through the catalog aliases (what Claude Code sends)", () => {
    expect(lookupKnownPrice("anthropic", "claude-haiku-4-5-20251001")!.model).toBe("claude-haiku-4-5");
    expect(lookupKnownPrice("anthropic", "claude-sonnet-4-5-20250929")!.aliases).toContain("claude-sonnet-4-5-20250929");
  });

  it("server tools carry their official unit prices", () => {
    expect(lookupKnownPrice("anthropic", "claude-sonnet-5-5")!.tools).toEqual({ web_search_request: 0.01, code_execution_hour: 0.05 });
    expect(lookupKnownPrice("openai", "gpt-5-mini")!.tools).toEqual({ web_search_call: 0.01, file_search_call: 0.0025 });
    expect(lookupKnownPrice("openai", "text-embedding-3-small")!.tools).toBeUndefined();
  });
});
