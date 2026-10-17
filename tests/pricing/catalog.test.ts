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

  it("marks the post-2025 seed models as needing review", () => {
    for (const [v, m] of [["openai", "gpt-6-astra"], ["anthropic", "claude-fable-5-1"], ["google", "gemini-3.8-flash"], ["xai", "grok-4.7"]]) {
      expect(lookupKnownPrice(v, m)!.needsReview, m).toBe(true);
    }
    expect(lookupKnownPrice("openai", "gpt-4o-mini")!.needsReview).toBeFalsy();
  });
});
