/**
 * Static seed data: provider presets (no secrets, created DISABLED) and the model catalog with
 * official prices. Sell prices default to official x SELL_FACTOR (a sane placeholder the admin
 * will tune); route cost = official price. Prices are USD per 1M tokens unless stated.
 */
export const SELL_FACTOR = "0.5";

export type Fmt =
  | "openai_chat"
  | "openai_completions"
  | "openai_responses"
  | "openai_embeddings"
  | "openai_images"
  | "openai_audio"
  | "openai_moderations"
  | "anthropic_messages"
  | "gemini";

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
    formats: ["openai_chat", "openai_completions", "openai_responses", "openai_embeddings", "openai_images", "openai_audio", "openai_moderations"],
    tags: ["official"],
    settings: {},
  },
  {
    slug: "anthropic",
    name: "Anthropic",
    preset: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authStyle: "X_API_KEY",
    formats: ["anthropic_messages"],
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
    name: "the relay",
    preset: "codex-everywhere",
    baseUrl: "https://codex-everywhere.com/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_responses", "openai_images", "anthropic_messages", "gemini", "openai_embeddings"],
    tags: ["reseller"],
    // anthropicBaseUrl: origin; the adapter appends /v1/messages. geminiBaseUrl: includes /v1beta.
    settings: { anthropicBaseUrl: "https://codex-everywhere.com", geminiBaseUrl: "https://codex-everywhere.com/v1beta" },
  },
];

export interface ModelSeed {
  slug: string;
  displayName: string;
  vendor: string;
  /** provider slug that natively serves this model */
  provider: string;
  description: string;
  capabilities: string[];
  contextWindow: number;
  maxOutput: number;
  /** official USD per 1M tokens */
  input?: string;
  output?: string;
  cached?: string;
  /** Anthropic-style cache write multipliers over input price */
  cacheWriteMult?: string;
  cacheWrite1hMult?: string;
  /** official USD per generated image */
  image?: string;
  longContext?: { threshold: number; multiplier: string };
  sortOrder: number;
}

const CHAT_CAPS = ["chat", "responses", "vision", "tools", "reasoning"];

export const MODELS: ModelSeed[] = [
  { slug: "gpt-6-astra", displayName: "GPT-6 Astra", vendor: "openai", provider: "openai", description: "OpenAI flagship reasoning model.", capabilities: CHAT_CAPS, contextWindow: 1_000_000, maxOutput: 128_000, input: "10", output: "50", cached: "1", sortOrder: 10 },
  { slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", vendor: "openai", provider: "openai", description: "Balanced GPT-6.1 model for everyday workloads.", capabilities: CHAT_CAPS, contextWindow: 1_000_000, maxOutput: 128_000, input: "2", output: "10", cached: "0.10", sortOrder: 20 },
  { slug: "gpt-6-sol", displayName: "GPT-6 Sol", vendor: "openai", provider: "openai", description: "Balanced GPT-6 model.", capabilities: CHAT_CAPS, contextWindow: 400_000, maxOutput: 128_000, input: "2", output: "10", cached: "0.20", sortOrder: 30 },
  { slug: "gpt-6-luna", displayName: "GPT-6 Luna", vendor: "openai", provider: "openai", description: "Fast, low-cost GPT-6 model.", capabilities: CHAT_CAPS, contextWindow: 400_000, maxOutput: 64_000, input: "0.10", output: "0.50", cached: "0.01", sortOrder: 40 },
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", vendor: "openai", provider: "openai", description: "GPT-5.6 high-capability model.", capabilities: CHAT_CAPS, contextWindow: 400_000, maxOutput: 128_000, input: "5", output: "30", cached: "0.50", sortOrder: 50 },
  { slug: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", vendor: "openai", provider: "openai", description: "GPT-5.6 mid-tier model.", capabilities: CHAT_CAPS, contextWindow: 400_000, maxOutput: 128_000, input: "2", output: "12", cached: "0.20", sortOrder: 60 },
  { slug: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", vendor: "openai", provider: "openai", description: "GPT-5.6 small, fast model.", capabilities: CHAT_CAPS, contextWindow: 400_000, maxOutput: 64_000, input: "0.20", output: "1.20", cached: "0.02", sortOrder: 70 },
  { slug: "gpt-image-2", displayName: "GPT Image 2", vendor: "openai", provider: "openai", description: "Image generation and editing.", capabilities: ["images"], contextWindow: 32_000, maxOutput: 0, image: "0.04", sortOrder: 80 },
  { slug: "text-embedding-3-small", displayName: "Text Embedding 3 Small", vendor: "openai", provider: "openai", description: "Low-cost text embeddings.", capabilities: ["embeddings"], contextWindow: 8_191, maxOutput: 0, input: "0.02", output: "0", sortOrder: 90 },
  { slug: "claude-fable-5-1", displayName: "Claude Fable 5.1", vendor: "anthropic", provider: "anthropic", description: "Anthropic's most capable model.", capabilities: CHAT_CAPS, contextWindow: 1_000_000, maxOutput: 128_000, input: "10", output: "50", cached: "0.25", cacheWriteMult: "1.25", cacheWrite1hMult: "2", sortOrder: 100 },
  { slug: "claude-opus-5-5", displayName: "Claude Opus 5.5", vendor: "anthropic", provider: "anthropic", description: "Frontier reasoning and coding.", capabilities: CHAT_CAPS, contextWindow: 500_000, maxOutput: 64_000, input: "4", output: "20", cached: "0.20", cacheWriteMult: "1.25", cacheWrite1hMult: "2", sortOrder: 110 },
  { slug: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", vendor: "anthropic", provider: "anthropic", description: "Best balance of speed and intelligence.", capabilities: CHAT_CAPS, contextWindow: 500_000, maxOutput: 64_000, input: "2", output: "10", cached: "0.10", cacheWriteMult: "1.25", cacheWrite1hMult: "2", sortOrder: 120 },
  { slug: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", vendor: "anthropic", provider: "anthropic", description: "Fastest, most affordable Claude.", capabilities: CHAT_CAPS, contextWindow: 200_000, maxOutput: 32_000, input: "0.10", output: "0.50", cached: "0.01", cacheWriteMult: "1.25", cacheWrite1hMult: "2", sortOrder: 130 },
  { slug: "gemini-3.1-pro", displayName: "Gemini 3.1 Pro", vendor: "google", provider: "google", description: "Google's flagship multimodal model.", capabilities: CHAT_CAPS, contextWindow: 1_000_000, maxOutput: 65_000, input: "2", output: "12", cached: "0.20", longContext: { threshold: 200_000, multiplier: "2" }, sortOrder: 140 },
  { slug: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", vendor: "google", provider: "google", description: "Fast, cost-efficient multimodal model.", capabilities: CHAT_CAPS, contextWindow: 1_000_000, maxOutput: 65_000, input: "0.75", output: "3.75", cached: "0.075", sortOrder: 150 },
  { slug: "grok-4.7", displayName: "Grok 4.7", vendor: "xai", provider: "xai", description: "xAI's flagship model.", capabilities: CHAT_CAPS, contextWindow: 256_000, maxOutput: 64_000, input: "3", output: "15", cached: "0.75", sortOrder: 160 },
  { slug: "deepseek-v4", displayName: "DeepSeek V4", vendor: "deepseek", provider: "deepseek", description: "Open-weights frontier model.", capabilities: ["chat", "completions", "tools", "reasoning"], contextWindow: 128_000, maxOutput: 32_000, input: "0.30", output: "1.20", cached: "0.03", sortOrder: 170 },
];
