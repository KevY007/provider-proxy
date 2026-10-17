/** Pure display labels (safe in client code). */
/** Vendor display names for badges. */
export const VENDOR_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  groq: "Groq",
  mistral: "Mistral",
  meta: "Meta",
};

export function vendorLabel(v: string): string {
  return VENDOR_LABELS[v] ?? v.charAt(0).toUpperCase() + v.slice(1);
}

/** Human labels for model capabilities. */
export const CAPABILITY_LABELS: Record<string, string> = {
  chat: "Chat",
  responses: "Responses",
  completions: "Completions",
  embeddings: "Embeddings",
  images: "Images",
  audio_speech: "Speech",
  audio_transcription: "Transcription",
  moderation: "Moderation",
  vision: "Vision",
  tools: "Tools",
  reasoning: "Reasoning",
};
