// STUB created by lead — Gateway agent replaces the contents, keeping these exports & types.
export const ENDPOINT_FORMATS = [
  "openai_chat",
  "openai_completions",
  "openai_responses",
  "openai_embeddings",
  "openai_images",
  "openai_audio",
  "openai_moderations",
  "anthropic_messages",
  "gemini",
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
};

export const PROVIDER_PRESETS: ProviderPreset[] = [];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
