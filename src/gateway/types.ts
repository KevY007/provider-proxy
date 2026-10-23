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
  | "videos_create"
  | "videos_list"
  | "videos_get"
  | "videos_content"
  | "videos_delete"
  | "messages"
  | "messages_count_tokens"
  | "gemini_generate"
  | "gemini_stream"
  | "gemini_count_tokens"
  | "gemini_embed"
  | "gemini_batch_embed"
  | "models_list"
  | "model_get"
  | "model_info"
  | "request_get"
  | "gemini_models_list"
  | "gemini_model_get"
  // Files APIs (PLAN 5c): OpenAI /v1/files + /v1/uploads, Anthropic /v1/files, Gemini /upload/v1beta/files + /v1beta/files
  | "files_create"
  | "files_list"
  | "files_get"
  | "files_delete"
  | "files_content"
  | "uploads_create"
  | "uploads_part"
  | "uploads_complete"
  | "uploads_cancel"
  | "gfiles_upload"
  | "gfiles_list"
  | "gfiles_get"
  | "gfiles_delete"
  // OpenAI code-interpreter container files (created by a Responses request): /v1/containers/{id}/files/{file}[/content]
  | "containers_file_get"
  | "containers_file_content"
  // Batch APIs: Anthropic /v1/messages/batches (+results, cancel, delete), OpenAI /v1/batches (+cancel)
  | "batches_create"
  | "batches_list"
  | "batches_get"
  | "batches_cancel"
  | "batches_results"
  | "batches_delete";

/** Operations served by the generic raw passthrough (no model, streamed body, stateful objects). */
export const RAW_OPS: ReadonlySet<Operation> = new Set<Operation>([
  "files_create",
  "files_list",
  "files_get",
  "files_delete",
  "files_content",
  "uploads_create",
  "uploads_part",
  "uploads_complete",
  "uploads_cancel",
  "gfiles_upload",
  "gfiles_list",
  "gfiles_get",
  "gfiles_delete",
  "containers_file_get",
  "containers_file_content",
  "batches_create",
  "batches_list",
  "batches_get",
  "batches_cancel",
  "batches_results",
  "batches_delete",
]);

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
  /** Video lookups: OUR public video id. */
  videoId?: string;
  /** Streaming implied by the path (Gemini streamGenerateContent). */
  pathStream: boolean;
  /** Body is multipart/form-data. */
  multipart: boolean;
  /** Generic raw passthrough op (Files APIs): no model, the body is streamed untouched. */
  raw?: boolean;
  /** Files / Batch APIs: the id the customer used (file id / upload id / Gemini `files/xyz` / batch id). */
  objectId?: string;
}

/** Normalised token / unit usage of one request. inputTokens is the TOTAL prompt size (cached + cache-write included). */
export interface Usage {
  inputTokens: number;
  outputTokens: number; // includes reasoning
  cachedTokens: number;
  cacheWriteTokens: number; // total (5m + 1h)
  cacheWrite1hTokens: number; // subset of cacheWriteTokens
  reasoningTokens: number;
  /** reasoningTokens was estimated from the thinking text (the upstream did not itemize them); billing is unaffected (thinking is inside outputTokens) */
  reasoningEstimated?: boolean;
  audioInputTokens: number; // subset of inputTokens
  audioOutputTokens: number; // subset of outputTokens
  imageCount: number;
  audioSeconds: number;
  characters: number;
  /** Generated video seconds (billed per second). */
  videoSeconds: number;
  /**
   * Server tools the upstream ran for this request, by price key (`web_search_request`, `code_execution_hour`,
   * `web_search_call`, `file_search_call`, ...). Units are what the matching `Model.toolPrices` / `ModelRoute.toolCosts`
   * entry is priced in (USD per search / per container hour / per call).
   */
  toolUsage?: Record<string, number>;
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
    videoSeconds: 0,
    toolUsage: {},
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
  /** The client's Idempotency-Key, forwarded upstream unchanged (no gateway-side dedupe, PLAN 9d). */
  idempotencyKey?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
export type JsonObject = Record<string, Json>;
