import { ENDPOINT_FORMATS, PROVIDER_PRESETS, type EndpointFormat, type ProviderPreset } from "@/gateway/providers/presets";

/**
 * Preset list for the admin "Add provider" dialog. Uses the Gateway's PROVIDER_PRESETS and falls back to a
 * built-in minimal list for ids the gateway doesn't define (keeps the UI usable while that module is a stub).
 */
const OPENAI_FORMATS: EndpointFormat[] = ["openai_chat", "openai_responses", "openai_embeddings"];

const FALLBACK: ProviderPreset[] = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", authStyle: "BEARER", formats: ["openai_chat", "openai_completions", "openai_responses", "openai_embeddings", "openai_images", "openai_audio", "openai_moderations"] },
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", authStyle: "X_API_KEY", formats: ["anthropic_messages"], settings: { anthropicVersion: "2023-06-01" } },
  { id: "google", name: "Google (Gemini)", baseUrl: "https://generativelanguage.googleapis.com", authStyle: "X_GOOG_API_KEY", formats: ["gemini", "openai_chat"] },
  { id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1", authStyle: "BEARER", formats: ["openai_chat", "openai_responses", "openai_images"] },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", authStyle: "BEARER", formats: ["openai_chat", "openai_responses", "openai_audio"] },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", authStyle: "BEARER", formats: ["openai_chat"] },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", authStyle: "BEARER", formats: ["openai_chat"] },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", authStyle: "BEARER", formats: ["openai_chat", "openai_embeddings"] },
  { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", authStyle: "BEARER", formats: ["openai_chat", "openai_embeddings", "openai_images"] },
  { id: "fireworks", name: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", authStyle: "BEARER", formats: ["openai_chat", "openai_embeddings"] },
  { id: "azure", name: "Azure OpenAI", baseUrl: "https://YOUR-RESOURCE.openai.azure.com", authStyle: "AZURE_API_KEY", formats: ["openai_chat", "openai_embeddings"], settings: { azureApiVersion: "2024-10-21" } },
  {
    id: "codex-everywhere",
    name: "the relay",
    baseUrl: "https://codex-everywhere.com/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_responses", "openai_images", "anthropic_messages", "gemini", "openai_embeddings"],
    settings: { anthropicBaseUrl: "https://codex-everywhere.com", geminiBaseUrl: "https://codex-everywhere.com/v1beta" },
  },
  { id: "custom", name: "Custom (OpenAI-compatible)", baseUrl: "", authStyle: "BEARER", formats: OPENAI_FORMATS },
];

export function listPresets(): ProviderPreset[] {
  const map = new Map<string, ProviderPreset>();
  for (const p of FALLBACK) map.set(p.id, p);
  for (const p of PROVIDER_PRESETS) map.set(p.id, p);
  if (!map.has("custom")) map.set("custom", FALLBACK[FALLBACK.length - 1]);
  // keep "custom" last
  const custom = map.get("custom")!;
  map.delete("custom");
  return [...map.values(), custom];
}

export const ALL_FORMATS: readonly string[] = ENDPOINT_FORMATS;

export const AUTH_STYLES = ["BEARER", "X_API_KEY", "X_GOOG_API_KEY", "AZURE_API_KEY", "QUERY_KEY"] as const;
