import type { EndpointFormat } from "./providers/presets";

/** Inbound wire format the customer speaks (also the provider "format" ids stored on Provider.formats). */
export type InboundFormat = EndpointFormat;
/** Shape used to render errors back to the customer. */
export type ErrorFormat = "openai" | "anthropic" | "gemini";

export type Operation =
  | "chat"
  | "completions"
  | "responses"
  | "responses_get"
  | "responses_delete"
  | "responses_cancel"
  | "responses_input_items"
  | "embeddings"
  | "images_generations"
  | "images_edits"
  | "images_variations"
  | "audio_speech"
  | "audio_transcriptions"
  | "audio_translations"
  | "moderations"
  | "messages"
  | "messages_count_tokens"
  | "gemini_generate"
  | "gemini_stream"
  | "gemini_count_tokens"
  | "gemini_embed"
  | "gemini_batch_embed"
  | "models_list"
  | "model_get"
  | "gemini_models_list"
  | "gemini_model_get";

export interface ParsedPath {
  /** Label stored in RequestLog.endpoint, e.g. "/v1/chat/completions", "/v1beta/models:generateContent". */
  endpoint: string;
  /** Format id for RequestLog.inboundFormat ("catalog" for model listings). */
  format: InboundFormat | "catalog";
  /** Format whose upstream surface serves this op (catalog ops have none). */
  wireFormat: InboundFormat | null;
  op: Operation;
  errorFormat: ErrorFormat;
  method: string;
  /** Required model capability, null for catalog / lookups. */
  capability: string | null;
  /** Gemini: model from the URL. Catalog: requested id. */
  model?: string;
  /** Responses lookups. */
  responseId?: string;
  /** Streaming implied by the path (Gemini streamGenerateContent). */
  pathStream: boolean;
  /** Body is multipart/form-data. */
  multipart: boolean;
}

/** Normalised token / unit usage of one request. inputTokens is the TOTAL prompt size (cached + cache-write included). */
export interface Usage {
  inputTokens: number;
  outputTokens: number; // includes reasoning
  cachedTokens: number;
  cacheWriteTokens: number; // total (5m + 1h)
  cacheWrite1hTokens: number; // subset of cacheWriteTokens
  reasoningTokens: number;
  audioInputTokens: number; // subset of inputTokens
  audioOutputTokens: number; // subset of outputTokens
  imageCount: number;
  audioSeconds: number;
  characters: number;
  estimated: boolean;
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    imageCount: 0,
    audioSeconds: 0,
    characters: 0,
    estimated: false,
  };
}

export interface AttemptRecord {
  providerId: string;
  providerKeyId: string;
  routeId: string;
  status: number; // upstream http status, 0 = network error / timeout
  error?: string;
  latencyMs: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
export type JsonObject = Record<string, Json>;
