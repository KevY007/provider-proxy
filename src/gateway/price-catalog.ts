// Built-in known official list prices. Prefills the admin "Add model" flow and is the single source of numbers for
// `prisma/seed*.ts` and `scripts/setup-live-providers.ts`.
//
// `vendor` = the platform that SELLS the model through its API (it matches the provider preset: "openai", "anthropic",
// "google", "xai", "groq", "deepseek", "fal", "replicate"), so `official` is "what that vendor charges" - for a direct
// supplier our cost equals the official price. `model` = the id you send upstream.
// Token prices are USD per 1M tokens; image/request = USD each; perMinute/perSecond = USD per minute/second;
// perMillionChars = USD per 1M characters. `needsReview` = best guess (post-2025 model, or price not verifiable).
import type { PriceTable } from "@/server/pricing/preview";

export type KnownPrice = {
  vendor: string; // "openai" | "anthropic" | "google" | "fal" | "replicate" | ...
  model: string; // upstream model id
  official: PriceTable;
  capabilities?: string[];
  contextWindow?: number;
  maxOutput?: number;
  source?: string; // where the number came from
  needsReview?: boolean; // true when the price is a best guess
  // ---- additions (all optional)
  displayName?: string;
  description?: string;
  /** Anthropic 1h cache write ($/1M). Only a route COST / sell value: there is no separate official column for it. */
  cacheWrite1h?: number;
  /** Long-context surcharge: above `threshold` input tokens, tokens are priced x `multiplier` (output x `outputMultiplier` when set). */
  longContext?: { threshold: number; multiplier: number; outputMultiplier?: number };
  /** Extra ids that resolve to this entry. */
  aliases?: string[];
  /** ISO date the vendor retires the model (shown as "retiring" in admin). */
  retiresAt?: string;
  /** Official unit prices of the SERVER TOOLS the vendor bills on top of tokens (USD per search / per container hour / per call). */
  tools?: Record<string, number>;
};

const CHAT = ["chat", "responses", "vision", "tools", "reasoning"];
const CHAT_NO_REASON = ["chat", "responses", "completions", "vision", "tools"];
const CHAT_COMPAT = ["chat", "tools"];

const SEED = "project seed (prisma/seed-data.ts): post-2025 model, confirm against the vendor price list";
const LIST = "vendor list price";
const ANTHROPIC_PRICING = "Anthropic pricing page (platform.claude.com/docs/en/about-claude/pricing), checked 2026-10-17";

/** Anthropic server tools: web search $10 / 1,000 searches; code execution $0.05 per container hour (free next to web search / fetch; 5 minute minimum). */
export const CLAUDE_TOOL_PRICES = { web_search_request: 0.01, code_execution_hour: 0.05 } as const;
/** OpenAI built-in tools (Responses API): web search $10 / 1,000 calls, file search $2.50 / 1,000 calls. */
export const OPENAI_TOOL_PRICES = { web_search_call: 0.01, file_search_call: 0.0025 } as const;

type Opts = Partial<Omit<KnownPrice, "vendor" | "model" | "official">>;
const k = (vendor: string, model: string, official: PriceTable, o: Opts = {}): KnownPrice => ({ vendor, model, official, source: LIST, ...o });

/** token-priced chat model: in / out / cached (+ Anthropic cache-write prices) */
const chat = (vendor: string, model: string, i: number, o: number, cached: number | null, opts: Opts = {}): KnownPrice => {
  const caps = opts.capabilities ?? CHAT;
  return k(vendor, model, { input: i, output: o, ...(cached !== null ? { cachedInput: cached } : {}) }, { capabilities: CHAT, ...(vendor === "openai" && caps.includes("responses") ? { tools: { ...OPENAI_TOOL_PRICES } } : {}), ...opts });
};

const OPENAI_PRICING = "OpenAI pricing page (developers.openai.com/api/docs/pricing, standard tier), checked 2026-10-21";
/** GPT-6 / GPT-5.6: 1M context, long context above 272K input (input 2x, output 1.5x), 30-minute cache write 1.25x input. */
const oai6 = (model: string, i: number, o: number, cached: number, displayName: string, description: string, x: { cacheWrite?: number } = {}): KnownPrice => ({
  ...chat("openai", model, i, o, cached, { displayName, description, contextWindow: 1_000_000, maxOutput: 128_000, longContext: { threshold: 272_000, multiplier: 2, outputMultiplier: 1.5 }, source: OPENAI_PRICING }),
  official: { input: i, output: o, cachedInput: cached, cacheWrite: x.cacheWrite ?? round(i * 1.25) },
});

/** Anthropic: cache read 0.1x, 5m write 1.25x, 1h write 2x of input (unless overridden) */
const claude = (model: string, i: number, o: number, opts: Opts & { cached?: number; cw?: number; cw1h?: number } = {}): KnownPrice => {
  const { cached, cw, cw1h, ...rest } = opts;
  return k("anthropic", model, { input: i, output: o, cachedInput: cached ?? round(i * 0.1), cacheWrite: cw ?? round(i * 1.25) }, { capabilities: CHAT, cacheWrite1h: cw1h ?? round(i * 2), tools: { ...CLAUDE_TOOL_PRICES }, ...rest });
};

function round(n: number): number {
  return Number(n.toPrecision(10));
}

export const KNOWN_PRICES: KnownPrice[] = [
  // ======================================================================================================== OpenAI
  // ---- GPT-6 / GPT-5.6: OpenAI pricing page (standard tier), checked 2026-10-21. 1M context; above 272K input tokens
  // input and cached input cost 2x and output 1.5x; 30-minute cache writes are 1.25x input.
  oai6("gpt-6.2-astra", 8, 40, 0.4, "GPT-6.2 Astra", "Flagship reasoning model."),
  oai6("gpt-6.2-sol", 2, 10, 0.1, "GPT-6.2 Sol", "Balanced GPT-6.2 model."),
  oai6("gpt-6.1-terra", 1, 5, 0.05, "GPT-6.1 Terra", "Mid-tier GPT-6.1 model."),
  oai6("gpt-6-astra", 10, 50, 1, "GPT-6 Astra", "OpenAI flagship reasoning model."),
  oai6("gpt-6.1-sol", 2, 10, 0.1, "GPT-6.1 Sol", "Balanced GPT-6.1 model for everyday workloads."),
  oai6("gpt-6-sol", 2, 10, 0.2, "GPT-6 Sol", "Balanced GPT-6 model."),
  oai6("gpt-6-luna", 0.1, 0.5, 0.01, "GPT-6 Luna", "Fast, low-cost GPT-6 model."),
  // regular list price: OpenAI's temporary promotion (4 / 0.4 / 20, "at least through November 21, 2026") is not used
  oai6("gpt-5.6-sol", 5, 30, 0.5, "GPT-5.6 Sol", "GPT-5.6 high-capability model."),
  oai6("gpt-5.6-terra", 2, 12, 0.2, "GPT-5.6 Terra", "GPT-5.6 mid-tier model."),
  oai6("gpt-5.6-luna", 0.2, 1.2, 0.02, "GPT-5.6 Luna", "GPT-5.6 small, fast model."),
  // GPT Image 2 / 2.5: token-billed (text input 5, cached text 1.25, image output 30; image inputs are 8 per 1M)
  k("openai", "gpt-image-2", { input: 5, output: 30, cachedInput: 1.25 }, { displayName: "GPT Image 2", description: "Image generation and editing (token-billed: text in, image out).", capabilities: ["images"], contextWindow: 32_000, source: OPENAI_PRICING }),
  k("openai", "gpt-image-2.5-flare", { input: 5, output: 30, cachedInput: 1.25 }, { displayName: "GPT Image 2.5 Flare", description: "GPT Image 2.5 image generation and editing (token-billed).", capabilities: ["images"], contextWindow: 32_000, source: OPENAI_PRICING }),
  k("openai", "gpt-image-2.5-sunburst", { input: 5, output: 30, cachedInput: 1.25 }, { displayName: "GPT Image 2.5 Sunburst", description: "GPT Image 2.5 image generation and editing (token-billed).", capabilities: ["images"], contextWindow: 32_000, source: OPENAI_PRICING }),
  k("openai", "sora-2", { perSecond: 0.1 }, { displayName: "Sora 2", description: "Text/image-to-video generation with synced audio (720p, 4-12 s).", capabilities: ["video"], retiresAt: "2026-09-24", source: LIST }),
  // ---- GPT-5 family
  chat("openai", "gpt-5.2", 1.75, 14, 0.175, { displayName: "GPT-5.2", contextWindow: 400_000, maxOutput: 128_000, needsReview: true }),
  chat("openai", "gpt-5.1", 1.25, 10, 0.125, { displayName: "GPT-5.1", contextWindow: 400_000, maxOutput: 128_000, needsReview: true }),
  chat("openai", "gpt-5", 1.25, 10, 0.125, { displayName: "GPT-5", description: "OpenAI's flagship GPT-5 reasoning model.", contextWindow: 400_000, maxOutput: 128_000 }),
  chat("openai", "gpt-5-mini", 0.25, 2, 0.025, { displayName: "GPT-5 mini", description: "Faster, cheaper GPT-5 for well-defined tasks.", contextWindow: 400_000, maxOutput: 128_000 }),
  chat("openai", "gpt-5-nano", 0.05, 0.4, 0.005, { displayName: "GPT-5 nano", description: "Fastest, cheapest GPT-5 for summarization and classification.", contextWindow: 400_000, maxOutput: 128_000 }),
  chat("openai", "gpt-5-pro", 15, 120, null, { displayName: "GPT-5 pro", contextWindow: 400_000, maxOutput: 272_000, capabilities: ["chat", "responses", "vision", "tools", "reasoning"], needsReview: true }),
  // ---- GPT-4.1 family
  chat("openai", "gpt-4.1", 2, 8, 0.5, { displayName: "GPT-4.1", capabilities: CHAT_NO_REASON, contextWindow: 1_047_576, maxOutput: 32_768 }),
  chat("openai", "gpt-4.1-mini", 0.4, 1.6, 0.1, { displayName: "GPT-4.1 mini", capabilities: CHAT_NO_REASON, contextWindow: 1_047_576, maxOutput: 32_768 }),
  chat("openai", "gpt-4.1-nano", 0.1, 0.4, 0.025, { displayName: "GPT-4.1 nano", description: "Smallest GPT-4.1: very low latency.", capabilities: CHAT_NO_REASON, contextWindow: 1_047_576, maxOutput: 32_768 }),
  // ---- GPT-4o family
  chat("openai", "gpt-4o", 2.5, 10, 1.25, { displayName: "GPT-4o", capabilities: CHAT_NO_REASON, contextWindow: 128_000, maxOutput: 16_384 }),
  chat("openai", "gpt-4o-mini", 0.15, 0.6, 0.075, { displayName: "GPT-4o mini", description: "Affordable small model for focused tasks.", capabilities: CHAT_NO_REASON, contextWindow: 128_000, maxOutput: 16_384 }),
  chat("openai", "chatgpt-4o-latest", 5, 15, null, { displayName: "ChatGPT-4o (latest)", capabilities: CHAT_NO_REASON, contextWindow: 128_000, maxOutput: 16_384, needsReview: true }),
  chat("openai", "gpt-4-turbo", 10, 30, null, { displayName: "GPT-4 Turbo", capabilities: CHAT_NO_REASON, contextWindow: 128_000, maxOutput: 4_096 }),
  chat("openai", "gpt-3.5-turbo", 0.5, 1.5, null, { displayName: "GPT-3.5 Turbo", capabilities: ["chat", "completions", "tools"], contextWindow: 16_385, maxOutput: 4_096 }),
  // ---- o-series
  chat("openai", "o3", 2, 8, 0.5, { displayName: "o3", contextWindow: 200_000, maxOutput: 100_000 }),
  chat("openai", "o3-pro", 20, 80, null, { displayName: "o3-pro", contextWindow: 200_000, maxOutput: 100_000, needsReview: true }),
  chat("openai", "o4-mini", 1.1, 4.4, 0.275, { displayName: "o4-mini", contextWindow: 200_000, maxOutput: 100_000 }),
  chat("openai", "o3-mini", 1.1, 4.4, 0.55, { displayName: "o3-mini", contextWindow: 200_000, maxOutput: 100_000 }),
  chat("openai", "o1", 15, 60, 7.5, { displayName: "o1", contextWindow: 200_000, maxOutput: 100_000 }),
  chat("openai", "codex-mini-latest", 1.5, 6, 0.375, { displayName: "Codex mini", contextWindow: 200_000, maxOutput: 100_000, needsReview: true }),
  // ---- images / audio / embeddings / moderation
  k("openai", "gpt-image-1", { input: 5, output: 40, cachedInput: 1.25 }, { displayName: "GPT Image 1", description: "Image generation and editing (token-billed: text in, image out).", capabilities: ["images"], contextWindow: 32_000, needsReview: true }),
  k("openai", "gpt-image-1-mini", { input: 2, output: 8, cachedInput: 0.2 }, { displayName: "GPT Image 1 mini", description: "Low-cost image generation and editing (token-billed).", capabilities: ["images"] }),
  k("openai", "dall-e-3", { image: 0.04 }, { displayName: "DALL-E 3", description: "Image generation (1024x1024 standard).", capabilities: ["images"], needsReview: true, retiresAt: "2026-05-12" }),
  k("openai", "tts-1", { perMillionChars: 15 }, { displayName: "TTS-1", description: "Text-to-speech.", capabilities: ["audio_speech"] }),
  k("openai", "tts-1-hd", { perMillionChars: 30 }, { displayName: "TTS-1 HD", description: "Higher-quality text-to-speech.", capabilities: ["audio_speech"] }),
  k("openai", "gpt-4o-mini-tts", { input: 0.6, audioOutput: 12 }, { displayName: "GPT-4o mini TTS", description: "Steerable text-to-speech (about $0.015 per minute).", capabilities: ["audio_speech"], needsReview: true }),
  k("openai", "whisper-1", { perMinute: 0.006 }, { displayName: "Whisper", description: "Speech-to-text and translation.", capabilities: ["audio_transcription"] }),
  k("openai", "gpt-4o-transcribe", { input: 2.5, audioInput: 6, output: 10 }, { displayName: "GPT-4o Transcribe", description: "Speech-to-text (about $0.006 per minute).", capabilities: ["audio_transcription"], needsReview: true }),
  k("openai", "gpt-4o-mini-transcribe", { input: 1.25, audioInput: 3, output: 5 }, { displayName: "GPT-4o mini Transcribe", description: "Speech-to-text (about $0.003 per minute).", capabilities: ["audio_transcription"], needsReview: true }),
  k("openai", "text-embedding-3-small", { input: 0.02, output: 0 }, { displayName: "Text Embedding 3 Small", description: "Low-cost text embeddings.", capabilities: ["embeddings"], contextWindow: 8_191 }),
  k("openai", "text-embedding-3-large", { input: 0.13, output: 0 }, { displayName: "Text Embedding 3 Large", description: "Highest-quality text embeddings.", capabilities: ["embeddings"], contextWindow: 8_191 }),
  k("openai", "text-embedding-ada-002", { input: 0.1, output: 0 }, { displayName: "Text Embedding Ada 002", capabilities: ["embeddings"], contextWindow: 8_191 }),
  k("openai", "omni-moderation-latest", { input: 0, output: 0 }, { displayName: "Omni Moderation", description: "Text and image moderation (free).", capabilities: ["moderation"] }),
  k("openai", "text-moderation-latest", { input: 0, output: 0 }, { displayName: "Text Moderation", capabilities: ["moderation"] }),

  // ======================================================================================================== Anthropic
  // ---- current models: verified against the Anthropic pricing page (cache hits are 0.05x input on Opus 5.5 / Sonnet 5.5 and
  //      0.025x on Fable 5.1; Haiku 5.5 costs 5x for prompts over 100K tokens) and the models overview (1M context, 128K output)
  claude("claude-fable-5-2", 8, 40, { displayName: "Claude Fable 5.2", contextWindow: 1_000_000, maxOutput: 128_000, cached: 0.2, cw: 10, cw1h: 16, source: "Anthropic pricing page" }),
  claude("claude-fable-5-1", 10, 50, { displayName: "Claude Fable 5.1", description: "Anthropic's most capable model.", contextWindow: 1_000_000, maxOutput: 128_000, cached: 0.25, cw: 12.5, cw1h: 20, source: ANTHROPIC_PRICING }),
  claude("claude-fable-5", 10, 50, { displayName: "Claude Fable 5", description: "Anthropic's most capable model (previous release).", contextWindow: 1_000_000, maxOutput: 128_000, cached: 1, cw: 12.5, cw1h: 20, source: ANTHROPIC_PRICING }),
  claude("claude-opus-5-5", 4, 20, { displayName: "Claude Opus 5.5", description: "Frontier reasoning and coding.", contextWindow: 1_000_000, maxOutput: 128_000, cached: 0.2, cw: 5, cw1h: 8, source: ANTHROPIC_PRICING }),
  claude("claude-opus-5", 5, 25, { displayName: "Claude Opus 5", contextWindow: 1_000_000, maxOutput: 128_000, source: ANTHROPIC_PRICING }),
  claude("claude-opus-4-8", 5, 25, { displayName: "Claude Opus 4.8", contextWindow: 1_000_000, maxOutput: 128_000, source: ANTHROPIC_PRICING }),
  claude("claude-opus-4-7", 5, 25, { displayName: "Claude Opus 4.7", contextWindow: 1_000_000, maxOutput: 128_000, source: ANTHROPIC_PRICING }),
  claude("claude-opus-4-6", 5, 25, { displayName: "Claude Opus 4.6", contextWindow: 1_000_000, maxOutput: 128_000, source: ANTHROPIC_PRICING }),
  claude("claude-sonnet-5-5", 2, 10, { displayName: "Claude Sonnet 5.5", description: "Best balance of speed and intelligence.", contextWindow: 1_000_000, maxOutput: 128_000, cached: 0.1, cw: 2.5, cw1h: 4, source: ANTHROPIC_PRICING }),
  claude("claude-sonnet-5", 2, 10, { displayName: "Claude Sonnet 5", contextWindow: 1_000_000, maxOutput: 128_000, cached: 0.2, cw: 2.5, cw1h: 4, source: ANTHROPIC_PRICING }),
  claude("claude-sonnet-4-6", 3, 15, { displayName: "Claude Sonnet 4.6", contextWindow: 1_000_000, maxOutput: 128_000, source: ANTHROPIC_PRICING }),
  claude("claude-haiku-5-5", 0.1, 0.5, {
    displayName: "Claude Haiku 5.5",
    description: "Fastest, most affordable Claude.",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    cached: 0.01,
    cw: 0.125,
    cw1h: 0.2,
    // prompts over 100,000 tokens (cache reads and writes included) pay 5x on every token price: $0.50 / $2.50 per MTok
    longContext: { threshold: 100_000, multiplier: 5 },
    source: ANTHROPIC_PRICING,
  }),
  // ---- Claude 4.x
  claude("claude-opus-4-5", 5, 25, { displayName: "Claude Opus 4.5", contextWindow: 200_000, maxOutput: 64_000, aliases: ["claude-opus-4-5-20251101"], source: ANTHROPIC_PRICING }),
  claude("claude-opus-4-1", 15, 75, { displayName: "Claude Opus 4.1", contextWindow: 200_000, maxOutput: 32_000, aliases: ["claude-opus-4-1-20250805"] }),
  claude("claude-opus-4", 15, 75, { displayName: "Claude Opus 4", contextWindow: 200_000, maxOutput: 32_000, aliases: ["claude-opus-4-20250514"] }),
  claude("claude-sonnet-4-5", 3, 15, { displayName: "Claude Sonnet 4.5", contextWindow: 200_000, maxOutput: 64_000, aliases: ["claude-sonnet-4-5-20250929"] }),
  claude("claude-sonnet-4", 3, 15, { displayName: "Claude Sonnet 4", contextWindow: 200_000, maxOutput: 64_000, aliases: ["claude-sonnet-4-20250514"] }),
  claude("claude-haiku-4-5", 1, 5, { displayName: "Claude Haiku 4.5", description: "Fast and affordable Claude 4.5 Haiku.", contextWindow: 200_000, maxOutput: 64_000, aliases: ["claude-haiku-4-5-20251001"] }),
  // ---- Claude 3.x
  claude("claude-3-7-sonnet", 3, 15, { displayName: "Claude Sonnet 3.7", contextWindow: 200_000, maxOutput: 64_000, aliases: ["claude-3-7-sonnet-20250219", "claude-3-7-sonnet-latest"] }),
  claude("claude-3-5-sonnet", 3, 15, { displayName: "Claude Sonnet 3.5", contextWindow: 200_000, maxOutput: 8_192, aliases: ["claude-3-5-sonnet-20241022", "claude-3-5-sonnet-latest"], needsReview: true }),
  claude("claude-3-5-haiku", 0.8, 4, { displayName: "Claude Haiku 3.5", contextWindow: 200_000, maxOutput: 8_192, capabilities: ["chat", "vision", "tools"], aliases: ["claude-3-5-haiku-20241022", "claude-3-5-haiku-latest"] }),
  claude("claude-3-haiku", 0.25, 1.25, { displayName: "Claude Haiku 3", contextWindow: 200_000, maxOutput: 4_096, capabilities: ["chat", "vision", "tools"], cached: 0.03, cw: 0.3, cw1h: 0.5, aliases: ["claude-3-haiku-20240307"] }),

  // ======================================================================================================== Google
  chat("google", "gemini-3.1-pro", 2, 12, 0.2, { displayName: "Gemini 3.1 Pro", description: "Google's flagship multimodal model.", contextWindow: 1_000_000, maxOutput: 65_000, longContext: { threshold: 200_000, multiplier: 2 }, source: SEED, needsReview: true }),
  chat("google", "gemini-3.8-flash", 0.75, 3.75, 0.075, { displayName: "Gemini 3.8 Flash", description: "Fast, cost-efficient multimodal model.", contextWindow: 1_000_000, maxOutput: 65_000, source: SEED, needsReview: true }),
  chat("google", "gemini-3-pro-preview", 2, 12, 0.2, { displayName: "Gemini 3 Pro (preview)", contextWindow: 1_000_000, maxOutput: 65_000, longContext: { threshold: 200_000, multiplier: 2 }, needsReview: true }),
  chat("google", "gemini-3-flash-preview", 0.5, 3, 0.05, { displayName: "Gemini 3 Flash (preview)", contextWindow: 1_000_000, maxOutput: 65_000, needsReview: true }),
  chat("google", "gemini-2.5-pro", 1.25, 10, 0.125, { displayName: "Gemini 2.5 Pro", contextWindow: 1_048_576, maxOutput: 65_536, longContext: { threshold: 200_000, multiplier: 2 }, needsReview: true }),
  chat("google", "gemini-2.5-flash", 0.3, 2.5, 0.075, { displayName: "Gemini 2.5 Flash", contextWindow: 1_048_576, maxOutput: 65_536, needsReview: true }),
  chat("google", "gemini-2.5-flash-lite", 0.1, 0.4, 0.025, { displayName: "Gemini 2.5 Flash-Lite", contextWindow: 1_048_576, maxOutput: 65_536, needsReview: true }),
  chat("google", "gemini-2.0-flash", 0.1, 0.4, 0.025, { displayName: "Gemini 2.0 Flash", capabilities: ["chat", "vision", "tools"], contextWindow: 1_048_576, maxOutput: 8_192 }),
  chat("google", "gemini-2.0-flash-lite", 0.075, 0.3, null, { displayName: "Gemini 2.0 Flash-Lite", capabilities: ["chat", "vision", "tools"], contextWindow: 1_048_576, maxOutput: 8_192 }),
  k("google", "gemini-embedding-001", { input: 0.15, output: 0 }, { displayName: "Gemini Embedding", capabilities: ["embeddings"], contextWindow: 2_048 }),
  k("google", "imagen-4.0-generate-001", { image: 0.04 }, { displayName: "Imagen 4", capabilities: ["images"], needsReview: true }),

  // ======================================================================================================== xAI
  chat("xai", "grok-4.7", 3, 15, 0.75, { displayName: "Grok 4.7", description: "xAI's flagship model.", contextWindow: 256_000, maxOutput: 64_000, source: SEED, needsReview: true }),
  chat("xai", "grok-4", 3, 15, 0.75, { displayName: "Grok 4", contextWindow: 256_000, maxOutput: 64_000, needsReview: true }),
  chat("xai", "grok-4-fast-reasoning", 0.2, 0.5, 0.05, { displayName: "Grok 4 Fast (reasoning)", contextWindow: 2_000_000, maxOutput: 30_000, needsReview: true }),
  chat("xai", "grok-4-fast-non-reasoning", 0.2, 0.5, 0.05, { displayName: "Grok 4 Fast", capabilities: CHAT_COMPAT.concat("responses", "vision"), contextWindow: 2_000_000, maxOutput: 30_000, needsReview: true }),
  chat("xai", "grok-code-fast-1", 0.2, 1.5, 0.02, { displayName: "Grok Code Fast 1", contextWindow: 256_000, maxOutput: 10_000, needsReview: true }),
  chat("xai", "grok-3", 3, 15, 0.75, { displayName: "Grok 3", capabilities: CHAT_COMPAT, contextWindow: 131_072, maxOutput: 16_000 }),
  chat("xai", "grok-3-mini", 0.3, 0.5, 0.075, { displayName: "Grok 3 mini", capabilities: CHAT_COMPAT.concat("reasoning"), contextWindow: 131_072, maxOutput: 16_000 }),
  k("xai", "grok-2-image", { image: 0.07 }, { displayName: "Grok 2 Image", capabilities: ["images"], needsReview: true }),

  // ======================================================================================================== DeepSeek
  chat("deepseek", "deepseek-v4", 0.3, 1.2, 0.03, { displayName: "DeepSeek V4", description: "Open-weights frontier model.", capabilities: ["chat", "completions", "tools", "reasoning"], contextWindow: 128_000, maxOutput: 32_000, source: SEED, needsReview: true }),
  chat("deepseek", "deepseek-chat", 0.28, 0.42, 0.028, { displayName: "DeepSeek Chat", capabilities: ["chat", "completions", "tools"], contextWindow: 128_000, maxOutput: 8_192, needsReview: true }),
  chat("deepseek", "deepseek-reasoner", 0.28, 0.42, 0.028, { displayName: "DeepSeek Reasoner", capabilities: ["chat", "tools", "reasoning"], contextWindow: 128_000, maxOutput: 64_000, needsReview: true }),

  // ======================================================================================================== Groq
  chat("groq", "llama-3.3-70b-versatile", 0.59, 0.79, null, { displayName: "Llama 3.3 70B", capabilities: CHAT_COMPAT, contextWindow: 131_072, maxOutput: 32_768 }),
  chat("groq", "llama-3.1-8b-instant", 0.05, 0.08, null, { displayName: "Llama 3.1 8B Instant", capabilities: CHAT_COMPAT, contextWindow: 131_072, maxOutput: 131_072 }),
  chat("groq", "openai/gpt-oss-120b", 0.15, 0.75, 0.075, { displayName: "GPT-OSS 120B", contextWindow: 131_072, maxOutput: 65_536 }),
  chat("groq", "openai/gpt-oss-20b", 0.075, 0.3, 0.0375, { displayName: "GPT-OSS 20B", contextWindow: 131_072, maxOutput: 65_536 }),
  chat("groq", "meta-llama/llama-4-scout-17b-16e-instruct", 0.11, 0.34, null, { displayName: "Llama 4 Scout", capabilities: CHAT_COMPAT.concat("vision"), contextWindow: 131_072, maxOutput: 8_192 }),
  chat("groq", "meta-llama/llama-4-maverick-17b-128e-instruct", 0.2, 0.6, null, { displayName: "Llama 4 Maverick", capabilities: CHAT_COMPAT.concat("vision"), contextWindow: 131_072, maxOutput: 8_192 }),
  chat("groq", "qwen/qwen3-32b", 0.29, 0.59, null, { displayName: "Qwen3 32B", capabilities: CHAT_COMPAT.concat("reasoning"), contextWindow: 131_072, maxOutput: 40_960 }),
  chat("groq", "moonshotai/kimi-k2-instruct-0905", 1, 3, 0.5, { displayName: "Kimi K2 (0905)", capabilities: CHAT_COMPAT, contextWindow: 262_144, maxOutput: 16_384, needsReview: true }),
  k("groq", "whisper-large-v3", { perMinute: 0.00185 }, { displayName: "Whisper Large v3", capabilities: ["audio_transcription"] }),
  k("groq", "whisper-large-v3-turbo", { perMinute: 0.000667 }, { displayName: "Whisper Large v3 Turbo", capabilities: ["audio_transcription"] }),

  // ======================================================================================================== fal.ai (per image, 1 megapixel) / video
  k("fal", "fal-ai/flux/schnell", { image: 0.003 }, { displayName: "FLUX.1 schnell", description: "Fastest FLUX image model (1-4 steps).", capabilities: ["images"] }),
  k("fal", "fal-ai/flux/dev", { image: 0.025 }, { displayName: "FLUX.1 dev", description: "High-quality 12B FLUX image model.", capabilities: ["images"] }),
  k("fal", "fal-ai/flux-pro/v1.1", { image: 0.04 }, { displayName: "FLUX1.1 [pro]", description: "FLUX1.1 pro: top prompt adherence and quality.", capabilities: ["images"] }),
  k("fal", "fal-ai/flux-pro/v1.1-ultra", { image: 0.06 }, { displayName: "FLUX1.1 [pro] ultra", description: "FLUX1.1 pro ultra: up to 4MP.", capabilities: ["images"], needsReview: true }),
  k("fal", "fal-ai/recraft/v3/text-to-image", { image: 0.04 }, { displayName: "Recraft V3", description: "Design-grade images with strong text rendering.", capabilities: ["images"] }),
  k("fal", "fal-ai/kling-video/v2.1/master/text-to-video", { perSecond: 0.28 }, { displayName: "Kling 2.1 Master", description: "Text-to-video (5 or 10 s).", capabilities: ["video"], needsReview: true, source: "fal.ai list price ($1.40 per 5 s); not verified live" }),
  k("fal", "fal-ai/kling-video/v2.1/standard/image-to-video", { perSecond: 0.05 }, { displayName: "Kling 2.1 Standard", description: "Image-to-video (5 or 10 s).", capabilities: ["video"], needsReview: true }),
  k("fal", "fal-ai/kling-video/v2.1/pro/image-to-video", { perSecond: 0.09 }, { displayName: "Kling 2.1 Pro", description: "Image-to-video, higher fidelity (5 or 10 s).", capabilities: ["video"], needsReview: true }),

  // ======================================================================================================== Replicate
  k("replicate", "black-forest-labs/flux-schnell", { image: 0.003 }, { displayName: "FLUX.1 schnell (Replicate)", description: "FLUX.1 schnell served by Replicate.", capabilities: ["images"] }),
  k("replicate", "black-forest-labs/flux-dev", { image: 0.025 }, { displayName: "FLUX.1 dev (Replicate)", description: "FLUX.1 dev served by Replicate.", capabilities: ["images"] }),
  k("replicate", "black-forest-labs/flux-1.1-pro", { image: 0.04 }, { displayName: "FLUX1.1 [pro] (Replicate)", description: "FLUX1.1 pro served by Replicate.", capabilities: ["images"] }),
  k("replicate", "black-forest-labs/flux-kontext-pro", { image: 0.04 }, { displayName: "FLUX Kontext [pro]", description: "Prompt-based image editing.", capabilities: ["images"], needsReview: true }),
  k("replicate", "ideogram-ai/ideogram-v3-turbo", { image: 0.03 }, { displayName: "Ideogram v3 turbo", capabilities: ["images"], needsReview: true }),
];

// ------------------------------------------------------------------------------------------------ lookup
const byKey = new Map<string, KnownPrice>();
const byModel = new Map<string, KnownPrice[]>();
const norm = (s: string) => s.trim().toLowerCase();

for (const e of KNOWN_PRICES) {
  for (const id of [e.model, ...(e.aliases ?? [])]) {
    byKey.set(`${e.vendor}|${norm(id)}`, e);
    const list = byModel.get(norm(id)) ?? [];
    if (!list.includes(e)) list.push(e);
    byModel.set(norm(id), list);
  }
}

/** Candidate spellings of an upstream id: raw, without "models/", without a "vendor/" prefix, without date / "-latest" suffix. */
function variants(id: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => s && out.add(norm(s));
  let base = norm(id).replace(/^models\//, "");
  add(base);
  const stripDate = (s: string) =>
    s
      .replace(/-\d{4}-\d{2}-\d{2}$/, "") // -2025-08-07
      .replace(/-\d{8}$/, "") // -20250805
      .replace(/-\d{4}$/, "") // -0905 (4-digit release tag)
      .replace(/-latest$/, "")
      .replace(/:(free|beta|extended|thinking|nitro|floor)$/, "") // OpenRouter suffixes
      .replace(/-preview(-\d{2}-\d{2,4})?$/, "-preview");
  add(stripDate(base));
  // OpenRouter / Together style "vendor/model"
  const slash = base.indexOf("/");
  if (slash > 0) {
    const tail = base.slice(slash + 1);
    add(tail);
    add(stripDate(tail));
    add(tail.replace(/\./g, "-")); // anthropic/claude-sonnet-4.5 -> claude-sonnet-4-5
    add(stripDate(tail).replace(/\./g, "-"));
  }
  add(base.replace(/\./g, "-"));
  base = stripDate(base);
  add(base.replace(/\./g, "-"));
  return [...out];
}

/** Find a known price by provider preset/vendor + upstream model id (tolerates date suffixes like -2025-08-07). */
export function lookupKnownPrice(presetOrVendor: string, upstreamModel: string): KnownPrice | null {
  if (!upstreamModel) return null;
  const vendor = norm(presetOrVendor || "");
  const vs = variants(upstreamModel);
  // 1) the same vendor sells it
  for (const v of vs) {
    const hit = byKey.get(`${vendor}|${v}`);
    if (hit) return hit;
  }
  // 2) any vendor (OpenRouter / custom / reseller presets): prefer the maker's own listing
  for (const v of vs) {
    const list = byModel.get(v);
    if (list?.length) return list.find((e) => e.vendor === "openai" || e.vendor === "anthropic" || e.vendor === "google") ?? list[0];
  }
  return null;
}
