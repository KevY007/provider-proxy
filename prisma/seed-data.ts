/**
 * Static seed data: provider presets (no secrets, created DISABLED) and the model catalog.
 * Official prices, capabilities and context sizes are NOT duplicated here: they come from the built-in known-price
 * catalog (src/gateway/price-catalog.ts). Pricing policy is PROFITABLE by default: route cost = the upstream list
 * price (the supplier is the maker itself) and the public sell price follows the rule MARKUP_OVER_COST +30%
 * (= cost x SELL_FACTOR); `official*` fields keep the vendor list price for the savings display.
 */
export const SELL_FACTOR = "1.3";
/** The pricing rule new seed models get (MARKUP_OVER_COST, +30%). */
export const SEED_MARKUP_PERCENT = 30;
/** Former default (official x 0.5): seed re-prices rows still carrying it so a dev DB never sells below cost. */
export const LEGACY_SELL_FACTOR = "0.5";

export type Fmt =
  | "openai_chat"
  | "openai_completions"
  | "openai_responses"
  | "openai_embeddings"
  | "openai_images"
  | "openai_audio"
  | "openai_moderations"
  | "openai_videos"
  | "openai_files"
  | "anthropic_messages"
  | "anthropic_files"
  | "gemini"
  | "gemini_files";

export interface ProviderSeed {
  slug: string;
  name: string;
  preset: string;
  baseUrl: string;
  authStyle: "BEARER" | "X_API_KEY" | "X_GOOG_API_KEY";
  formats: Fmt[];
  tags: string[];
  settings: Record<string, unknown>;
  notes?: string;
  priority?: number;
}

export const PROVIDERS: ProviderSeed[] = [
  {
    slug: "openai",
    name: "OpenAI",
    preset: "openai",
    baseUrl: "https://api.openai.com/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_completions", "openai_responses", "openai_embeddings", "openai_images", "openai_audio", "openai_moderations", "openai_videos", "openai_files"],
    tags: ["official"],
    settings: {},
  },
  {
    slug: "anthropic",
    name: "Anthropic",
    preset: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authStyle: "X_API_KEY",
    formats: ["anthropic_messages", "anthropic_files"],
    tags: ["official"],
    settings: { anthropicVersion: "2023-06-01" },
  },
  {
    slug: "google",
    name: "Google",
    preset: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    authStyle: "X_GOOG_API_KEY",
    // openai_chat is served by Google's OpenAI-compatible endpoint (/v1beta/openai)
    formats: ["gemini", "openai_chat"],
    tags: ["official"],
    settings: {},
  },
  {
    slug: "xai",
    name: "xAI",
    preset: "xai",
    baseUrl: "https://api.x.ai/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_responses", "openai_images"],
    tags: ["official"],
    settings: {},
  },
  {
    slug: "groq",
    name: "Groq",
    preset: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_responses", "openai_audio"],
    tags: ["fast"],
    settings: {},
  },
  {
    slug: "deepseek",
    name: "DeepSeek",
    preset: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_completions"],
    tags: ["official"],
    settings: {},
  },
  {
    slug: "openrouter",
    name: "OpenRouter",
    preset: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_embeddings"],
    tags: ["aggregator"],
    settings: {},
  },
  {
    slug: "codex-everywhere",
    name: "Codex Everywhere",
    preset: "codex-everywhere",
    baseUrl: "https://codex-everywhere.com/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_responses", "openai_images", "anthropic_messages", "gemini", "openai_embeddings"],
    tags: ["reseller"],
    // anthropicBaseUrl: origin; the adapter appends /v1/messages. geminiBaseUrl: includes /v1beta.
    settings: { anthropicBaseUrl: "https://codex-everywhere.com", geminiBaseUrl: "https://codex-everywhere.com/v1beta" },
  },
  {
    slug: "fal",
    name: "fal.ai",
    preset: "fal",
    baseUrl: "https://fal.run",
    authStyle: "BEARER", // the fal adapter sends "Authorization: Key <key>"
    formats: ["openai_images", "openai_videos"],
    tags: ["images"],
    settings: { queueBaseUrl: "https://queue.fal.run", falMode: "auto" },
  },
  {
    slug: "replicate",
    name: "Replicate",
    preset: "replicate",
    baseUrl: "https://api.replicate.com/v1",
    authStyle: "BEARER",
    formats: ["openai_images"],
    tags: ["images"],
    settings: {},
  },
];

export interface ModelSeed {
  slug: string;
  displayName: string;
  vendor: string;
  /** provider slug that natively serves this model */
  provider: string;
  /** model id sent upstream (default: the slug); looked up in the known-price catalog together with the provider preset */
  upstream?: string;
  description: string;
  sortOrder: number;
}

const m = (slug: string, displayName: string, vendor: string, provider: string, description: string, sortOrder: number, upstream?: string): ModelSeed => ({
  slug,
  displayName,
  vendor,
  provider,
  description,
  sortOrder,
  ...(upstream ? { upstream } : {}),
});

export const MODELS: ModelSeed[] = [
  m("gpt-6-astra", "GPT-6 Astra", "openai", "openai", "OpenAI flagship reasoning model.", 10),
  m("gpt-6.1-sol", "GPT-6.1 Sol", "openai", "openai", "Balanced GPT-6.1 model for everyday workloads.", 20),
  m("gpt-6-sol", "GPT-6 Sol", "openai", "openai", "Balanced GPT-6 model.", 30),
  m("gpt-6-luna", "GPT-6 Luna", "openai", "openai", "Fast, low-cost GPT-6 model.", 40),
  m("gpt-5.6-sol", "GPT-5.6 Sol", "openai", "openai", "GPT-5.6 high-capability model.", 50),
  m("gpt-5.6-terra", "GPT-5.6 Terra", "openai", "openai", "GPT-5.6 mid-tier model.", 60),
  m("gpt-5.6-luna", "GPT-5.6 Luna", "openai", "openai", "GPT-5.6 small, fast model.", 70),
  m("gpt-image-2", "GPT Image 2", "openai", "openai", "Image generation and editing.", 80),
  m("sora-2", "Sora 2", "openai", "openai", "Text/image-to-video generation with synced audio (720p).", 85),
  m("text-embedding-3-small", "Text Embedding 3 Small", "openai", "openai", "Low-cost text embeddings.", 90),
  m("claude-fable-5-1", "Claude Fable 5.1", "anthropic", "anthropic", "Anthropic's most capable model.", 100),
  m("claude-opus-5-5", "Claude Opus 5.5", "anthropic", "anthropic", "Frontier reasoning and coding.", 110),
  m("claude-sonnet-5-5", "Claude Sonnet 5.5", "anthropic", "anthropic", "Best balance of speed and intelligence.", 120),
  m("claude-haiku-5-5", "Claude Haiku 5.5", "anthropic", "anthropic", "Fastest, most affordable Claude.", 130),
  m("gemini-3.1-pro", "Gemini 3.1 Pro", "google", "google", "Google's flagship multimodal model.", 140),
  m("gemini-3.8-flash", "Gemini 3.8 Flash", "google", "google", "Fast, cost-efficient multimodal model.", 150),
  m("grok-4.7", "Grok 4.7", "xai", "xai", "xAI's flagship model.", 160),
  m("deepseek-v4", "DeepSeek V4", "deepseek", "deepseek", "Open-weights frontier model.", 170),
];
