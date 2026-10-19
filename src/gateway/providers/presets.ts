/**
 * Provider presets - used by the Admin "Add provider" form and mirrored by prisma/seed-data.ts.
 *
 * Conventions (see docs/FOUNDATION.md):
 *  - `baseUrl` for OpenAI-compatible providers INCLUDES the version segment (e.g. https://api.openai.com/v1).
 *  - Anthropic-native: `baseUrl` is the origin; adapters append `/v1/messages`.
 *    A provider that serves Anthropic AND OpenAI formats from different roots sets `settings.anthropicBaseUrl` (origin).
 *  - Gemini-native: `settings.geminiBaseUrl` (origin or origin + `/v1beta`) or, for Google itself, `baseUrl` (origin).
 *    Google's OpenAI-compatible surface lives at `<origin>/v1beta/openai/*`.
 *  - Azure: `baseUrl` is the resource origin; deployment name = upstream model (or key.extra.deployments[model]).
 */
export const ENDPOINT_FORMATS = [
  "openai_chat",
  "openai_completions",
  "openai_responses",
  "openai_embeddings",
  "openai_images",
  "openai_audio",
  "openai_moderations",
  "openai_videos",
  "openai_files",
  "openai_batches",
  "anthropic_messages",
  "anthropic_files",
  "anthropic_batches",
  "gemini",
  "gemini_files",
] as const;
export type EndpointFormat = (typeof ENDPOINT_FORMATS)[number];

export type ProviderPreset = {
  id: string; // "openai" | "anthropic" | "google" | ... | "custom"
  name: string;
  baseUrl: string;
  authStyle: "BEARER" | "X_API_KEY" | "X_GOOG_API_KEY" | "AZURE_API_KEY" | "QUERY_KEY";
  formats: EndpointFormat[];
  settings?: Record<string, unknown>;
  docsUrl?: string;
  sampleModels?: string[];
  description?: string;
  /** Suggested tags for the provider (admin can change). */
  tags?: string[];
  /** Suggested request timeout (ms). */
  timeoutMs?: number;
  /** Hint for the base URL field (e.g. Azure resource placeholder). */
  baseUrlHint?: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_completions", "openai_responses", "openai_embeddings", "openai_images", "openai_audio", "openai_moderations", "openai_videos", "openai_files", "openai_batches"],
    settings: {},
    docsUrl: "https://platform.openai.com/docs/api-reference",
    sampleModels: ["gpt-5", "gpt-5-mini", "gpt-4.1", "o4-mini", "text-embedding-3-small", "gpt-image-1", "sora-2", "whisper-1", "tts-1"],
    description: "Official OpenAI API (chat, responses, embeddings, images, audio, moderations, Sora video).",
    tags: ["official"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    authStyle: "X_API_KEY",
    formats: ["anthropic_messages", "anthropic_files", "anthropic_batches"],
    settings: { anthropicVersion: "2023-06-01" },
    docsUrl: "https://docs.anthropic.com/en/api/messages",
    sampleModels: ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"],
    description: "Official Anthropic Messages API. OpenAI-format requests are translated automatically.",
    tags: ["official"],
  },
  {
    id: "google",
    name: "Google (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com",
    authStyle: "X_GOOG_API_KEY",
    // openai_chat + openai_embeddings are served by Google's OpenAI-compatible endpoint (/v1beta/openai)
    formats: ["gemini", "openai_chat", "openai_embeddings", "gemini_files"],
    settings: {},
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    sampleModels: ["gemini-2.5-pro", "gemini-2.5-flash", "text-embedding-004"],
    description: "Google AI Studio / Gemini API. Native Gemini plus the OpenAI-compatible endpoint.",
    tags: ["official"],
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    baseUrl: "https://YOUR-RESOURCE.openai.azure.com",
    baseUrlHint: "https://<resource>.openai.azure.com",
    authStyle: "AZURE_API_KEY",
    formats: ["openai_chat", "openai_completions", "openai_embeddings", "openai_images", "openai_audio"],
    settings: { azureApiVersion: "2025-04-01-preview" },
    docsUrl: "https://learn.microsoft.com/azure/ai-services/openai/reference",
    sampleModels: ["gpt-4o (deployment name)", "text-embedding-3-small (deployment name)"],
    description: "Azure OpenAI deployments. The upstream model is the deployment name (override per key via extra.deployments).",
    tags: ["official", "azure"],
  },
  {
    id: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_responses", "openai_images"],
    settings: {},
    docsUrl: "https://docs.x.ai/docs",
    sampleModels: ["grok-4", "grok-3-mini"],
    description: "xAI Grok models (OpenAI-compatible).",
    tags: ["official"],
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_responses", "openai_audio"],
    settings: {},
    docsUrl: "https://console.groq.com/docs/api-reference",
    sampleModels: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "whisper-large-v3"],
    description: "Groq LPU inference (OpenAI-compatible).",
    tags: ["fast"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_completions"],
    settings: {},
    docsUrl: "https://api-docs.deepseek.com",
    sampleModels: ["deepseek-chat", "deepseek-reasoner"],
    description: "DeepSeek API (OpenAI-compatible).",
    tags: ["official"],
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_embeddings"],
    settings: {},
    docsUrl: "https://docs.mistral.ai/api",
    sampleModels: ["mistral-large-latest", "mistral-small-latest", "codestral-latest", "mistral-embed"],
    description: "Mistral La Plateforme (OpenAI-compatible chat + embeddings).",
    tags: ["official"],
  },
  {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_completions", "openai_embeddings", "openai_images"],
    settings: {},
    docsUrl: "https://docs.together.ai/reference",
    sampleModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-V3", "black-forest-labs/FLUX.1-schnell"],
    description: "Together AI open-model hosting (OpenAI-compatible).",
    tags: ["open-models"],
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_completions", "openai_embeddings"],
    settings: {},
    docsUrl: "https://docs.fireworks.ai/api-reference",
    sampleModels: ["accounts/fireworks/models/llama-v3p3-70b-instruct", "accounts/fireworks/models/deepseek-v3"],
    description: "Fireworks AI open-model hosting (OpenAI-compatible).",
    tags: ["open-models"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_embeddings"],
    settings: {},
    docsUrl: "https://openrouter.ai/docs",
    sampleModels: ["openai/gpt-5", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"],
    description: "OpenRouter aggregator (OpenAI-compatible).",
    tags: ["aggregator"],
  },
  {
    id: "codex-everywhere",
    name: "Codex Everywhere",
    baseUrl: "https://codex-everywhere.com/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_responses", "openai_images", "anthropic_messages", "gemini", "openai_embeddings"],
    // anthropicBaseUrl: origin (adapter appends /v1/messages); geminiBaseUrl: includes /v1beta.
    settings: { anthropicBaseUrl: "https://codex-everywhere.com", geminiBaseUrl: "https://codex-everywhere.com/v1beta" },
    docsUrl: "https://codex-everywhere.com",
    sampleModels: ["gpt-5", "claude-sonnet-4-5", "gemini-2.5-pro"],
    description: "Codex Everywhere relay: OpenAI, Anthropic and Gemini formats on one key.",
    tags: ["reseller"],
  },
  {
    id: "fal",
    name: "fal.ai",
    baseUrl: "https://fal.run",
    // Auth is "Authorization: Key <key>" - applied by the fal adapter (keyed on preset), not by authStyle.
    authStyle: "BEARER",
    formats: ["openai_images", "openai_videos"],
    // queueBaseUrl: used for long jobs / when falMode is "queue" ("sync" default, "auto" falls back to the queue).
    settings: { queueBaseUrl: "https://queue.fal.run", falMode: "auto" },
    docsUrl: "https://fal.ai/docs",
    sampleModels: ["fal-ai/flux/schnell", "fal-ai/flux/dev", "fal-ai/flux-pro/v1.1", "fal-ai/kling-video/v2.1/master/text-to-video"],
    description: "fal.ai image models behind POST /v1/images/generations and video models behind the OpenAI-style /v1/videos API (queue based).",
    tags: ["images"],
    timeoutMs: 180000,
  },
  {
    id: "replicate",
    name: "Replicate",
    baseUrl: "https://api.replicate.com/v1",
    authStyle: "BEARER",
    formats: ["openai_images"],
    settings: {},
    docsUrl: "https://replicate.com/docs/reference/http",
    sampleModels: ["black-forest-labs/flux-schnell", "black-forest-labs/flux-dev", "owner/name:version"],
    description: "Replicate image models behind POST /v1/images/generations. Use owner/name or a version-pinned owner/name:version.",
    tags: ["images"],
    timeoutMs: 180000,
  },
  {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    baseUrl: "https://example.com/v1",
    authStyle: "BEARER",
    formats: ["openai_chat"],
    settings: {},
    sampleModels: [],
    description: "Any OpenAI-compatible endpoint. Set the base URL (including /v1), auth style and supported formats.",
    tags: ["custom"],
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
