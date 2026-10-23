import { openHeaders } from "@/lib/secret-headers";
import type { InboundFormat, JsonObject, Operation } from "../types";

/**
 * Provider adapters: URL + header construction for every upstream wire surface.
 * (Body shaping lives in the pipeline: model substitution, paramOverrides, translators.)
 *
 * URL conventions (docs/FOUNDATION.md):
 *   - OpenAI-compatible: provider.baseUrl INCLUDES the version segment (".../v1") and we append "/chat/completions" etc.
 *   - Google: baseUrl is the origin. Native: <origin>/v1beta/models/{m}:{action}; OpenAI-compat: <origin>/v1beta/openai/*.
 *   - Anthropic: settings.anthropicBaseUrl (origin) else baseUrl (a trailing "/v1" is stripped); we append "/v1/messages".
 *   - Gemini on non-Google providers: settings.geminiBaseUrl (origin or origin + "/v1beta"; "/v1beta" is stripped).
 *   - Azure: baseUrl is the resource origin; deployment = key.extra.deployments[model] ?? upstreamModel.
 *   - fal.ai: auth is "Authorization: Key <key>" (applied here, keyed on preset); the request itself is built by the
 *     fal driver (providers/fal.ts). Replicate uses plain Bearer auth and its own driver (providers/replicate.ts).
 *   - Videos (OpenAI Sora shape): ${root}/videos[/{id}[/content?variant=]] on OpenAI-compatible providers.
 */
export interface AdapterProvider {
  slug: string;
  preset: string;
  baseUrl: string;
  authStyle: "BEARER" | "X_API_KEY" | "X_GOOG_API_KEY" | "AZURE_API_KEY" | "QUERY_KEY";
  tags: readonly string[];
  extraHeaders: Record<string, string>;
  settings: JsonObject;
}

export interface UpstreamTarget {
  url: string;
  headers: Record<string, string>;
}

type Surface = "openai" | "anthropic" | "gemini";

export function surfaceOf(format: InboundFormat): Surface {
  if (format === "anthropic_messages" || format === "anthropic_files" || format === "anthropic_batches") return "anthropic";
  if (format === "gemini" || format === "gemini_files") return "gemini";
  return "openai";
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

const OPENAI_SUFFIX: Partial<Record<Operation, string>> = {
  chat: "/chat/completions",
  completions: "/completions",
  responses: "/responses",
  embeddings: "/embeddings",
  images_generations: "/images/generations",
  images_edits: "/images/edits",
  images_variations: "/images/variations",
  audio_speech: "/audio/speech",
  audio_transcriptions: "/audio/transcriptions",
  audio_translations: "/audio/translations",
  moderations: "/moderations",
};

const GEMINI_ACTION: Partial<Record<Operation, string>> = {
  gemini_generate: "generateContent",
  gemini_stream: "streamGenerateContent",
  gemini_count_tokens: "countTokens",
  gemini_embed: "embedContent",
  gemini_batch_embed: "batchEmbedContents",
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export interface UrlInput {
  provider: AdapterProvider;
  /** Wire format spoken to the upstream (after translation). */
  format: InboundFormat;
  op: Operation;
  upstreamModel: string;
  stream: boolean;
  keyExtra?: JsonObject;
  /** For Responses lookups: response id. */
  responseId?: string;
  /** For video lookups: the UPSTREAM video id, plus a raw query string (e.g. "variant=thumbnail"). */
  videoId?: string;
  query?: string;
  /** Files APIs: the UPSTREAM object id (file id, upload id, Gemini `files/xyz`). */
  objectId?: string;
  /** Secret, only used for QUERY_KEY auth. */
  secret?: string;
}

const encPath = (s: string): string => s.split("/").map(encodeURIComponent).join("/");

/** URL of a Files-API operation (raw passthrough): same path shape as the upstream's own API. */
function filesUrl(i: UrlInput): string {
  const { provider: p, format, op } = i;
  const s = p.settings;
  const id = i.objectId;
  if (format === "anthropic_files") {
    const root = trimSlash(str(s.anthropicBaseUrl) ?? p.baseUrl).replace(/\/v1$/, "");
    return `${root}/v1/files${id ? `/${encodeURIComponent(id)}` : ""}${op === "files_content" ? "/content" : ""}`;
  }
  if (format === "gemini_files") {
    const root = trimSlash(str(s.geminiBaseUrl) ?? p.baseUrl).replace(/\/v1(beta)?$/, "");
    if (op === "gfiles_upload") return `${root}/upload/v1beta/files`;
    return `${root}/v1beta/${id ? encPath(id) : "files"}`;
  }
  const root = trimSlash(str(s.openaiBaseUrl) ?? p.baseUrl);
  switch (op) {
    case "containers_file_get":
    case "containers_file_content": {
      const [cid, fid] = (id ?? "/").split("/");
      return `${root}/containers/${encodeURIComponent(cid)}/files/${encodeURIComponent(fid ?? "")}${op === "containers_file_content" ? "/content" : ""}`;
    }
    case "uploads_create":
      return `${root}/uploads`;
    case "uploads_part":
      return `${root}/uploads/${encodeURIComponent(id ?? "")}/parts`;
    case "uploads_complete":
      return `${root}/uploads/${encodeURIComponent(id ?? "")}/complete`;
    case "uploads_cancel":
      return `${root}/uploads/${encodeURIComponent(id ?? "")}/cancel`;
    default:
      return `${root}/files${id ? `/${encodeURIComponent(id)}` : ""}${op === "files_content" ? "/content" : ""}`;
  }
}

/** URL of a Batch-API operation: Anthropic `/v1/messages/batches[/{id}[/results|/cancel]]`, OpenAI `/batches[/{id}[/cancel]]`. */
function batchesUrl(i: UrlInput): string {
  const { provider: p, format, op } = i;
  const id = i.objectId ? `/${encodeURIComponent(i.objectId)}` : "";
  const tail = op === "batches_results" ? "/results" : op === "batches_cancel" ? "/cancel" : "";
  if (format === "anthropic_batches") {
    const root = trimSlash(str(p.settings.anthropicBaseUrl) ?? p.baseUrl).replace(/\/v1$/, "");
    return `${root}/v1/messages/batches${id}${tail}`;
  }
  return `${trimSlash(str(p.settings.openaiBaseUrl) ?? p.baseUrl)}/batches${id}${tail}`;
}

/** Operation as seen on the upstream wire (translated chat <-> messages share the "chat"/"messages" ops). */
export function upstreamOp(inboundOp: Operation, upstream: InboundFormat): Operation {
  if (inboundOp === "chat" && upstream === "anthropic_messages") return "messages";
  if (inboundOp === "messages" && upstream === "openai_chat") return "chat";
  if (inboundOp === "messages_count_tokens" && upstream === "openai_chat") return "chat";
  return inboundOp;
}

export function buildUpstreamUrl(i: UrlInput): string {
  const { provider: p, format, op } = i;
  const s = p.settings;
  let url: string;

  if (op.startsWith("files_") || op.startsWith("uploads_") || op.startsWith("gfiles_") || op.startsWith("containers_")) {
    url = filesUrl(i);
    if (i.query) url += (url.includes("?") ? "&" : "?") + i.query;
  } else if (op.startsWith("batches_")) {
    url = batchesUrl(i);
    if (i.query) url += (url.includes("?") ? "&" : "?") + i.query;
  } else if (format === "anthropic_messages") {
    const root = trimSlash(str(s.anthropicBaseUrl) ?? p.baseUrl).replace(/\/v1$/, "");
    url = `${root}/v1/messages${op === "messages_count_tokens" ? "/count_tokens" : ""}`;
  } else if (format === "gemini") {
    const root = trimSlash(str(s.geminiBaseUrl) ?? p.baseUrl).replace(/\/v1(beta)?$/, "");
    const action = GEMINI_ACTION[op];
    if (!action) throw new Error(`no gemini action for op ${op}`);
    const m = i.upstreamModel.replace(/^models\//, "");
    url = `${root}/v1beta/models/${encodeURIComponent(m)}:${action}`;
    if (op === "gemini_stream") url += "?alt=sse";
  } else if (p.preset === "azure" || p.authStyle === "AZURE_API_KEY") {
    const root = trimSlash(p.baseUrl);
    const version = str(s.azureApiVersion) ?? "2025-04-01-preview";
    if (op === "responses" || op.startsWith("responses_")) {
      const id = i.responseId ? `/${encodeURIComponent(i.responseId)}` : "";
      const tail = op === "responses_cancel" ? "/cancel" : op === "responses_input_items" ? "/input_items" : "";
      url = `${root}/openai/v1/responses${id}${tail}?api-version=${encodeURIComponent(str(s.azureResponsesApiVersion) ?? "preview")}`;
    } else {
      const deployments = (i.keyExtra?.deployments ?? {}) as Record<string, string>;
      const deployment = deployments[i.upstreamModel] ?? i.upstreamModel;
      const suffix = OPENAI_SUFFIX[op];
      if (!suffix) throw new Error(`no azure path for op ${op}`);
      url = `${root}/openai/deployments/${encodeURIComponent(deployment)}${suffix}?api-version=${encodeURIComponent(version)}`;
    }
  } else {
    // OpenAI-compatible surface
    let root: string;
    if (p.preset === "google") root = `${trimSlash(p.baseUrl).replace(/\/v1(beta)?$/, "")}/v1beta/openai`;
    else root = trimSlash(str(s.openaiBaseUrl) ?? p.baseUrl);
    if (op.startsWith("responses_")) {
      const id = encodeURIComponent(i.responseId ?? "");
      const tail = op === "responses_cancel" ? "/cancel" : op === "responses_input_items" ? "/input_items" : "";
      url = `${root}/responses/${id}${tail}`;
    } else if (op === "videos_create" || op === "videos_list") {
      url = `${root}/videos`;
    } else if (op.startsWith("videos_")) {
      const id = encodeURIComponent(i.videoId ?? "");
      url = `${root}/videos/${id}${op === "videos_content" ? "/content" : ""}`;
      if (op === "videos_content" && i.query) url += `?${i.query}`;
    } else {
      const suffix = OPENAI_SUFFIX[op];
      if (!suffix) throw new Error(`no openai path for op ${op}`);
      url = `${root}${suffix}`;
    }
  }

  if (p.authStyle === "QUERY_KEY" && i.secret) {
    url += (url.includes("?") ? "&" : "?") + `key=${encodeURIComponent(i.secret)}`;
  }
  return url;
}

export interface HeaderInput {
  provider: AdapterProvider;
  format: InboundFormat;
  secret: string;
  stream: boolean;
  keyExtra?: JsonObject;
  /** Headers of the inbound customer request (only whitelisted ones are forwarded). */
  inbound?: Headers;
  /** multipart: pass the original content-type (with boundary); otherwise JSON. */
  contentType?: string | null;
  hasBody?: boolean;
  /** Upstream operation (video content requests accept any media type and forward Range). */
  op?: Operation;
}

function authHeaders(provider: AdapterProvider, surface: Surface, secret: string): Record<string, string> {
  // fal.ai wants "Authorization: Key <id:secret>" regardless of the stored authStyle
  if (provider.preset === "fal") return { authorization: `Key ${secret}` };
  const bearer = { authorization: `Bearer ${secret}` };
  switch (provider.authStyle) {
    case "QUERY_KEY":
      return {};
    case "AZURE_API_KEY":
      return { "api-key": secret };
    case "X_API_KEY":
      return surface === "gemini" ? { "x-api-key": secret, "x-goog-api-key": secret } : { "x-api-key": secret };
    case "X_GOOG_API_KEY":
      return surface === "openai" ? { ...bearer, "x-goog-api-key": secret } : { "x-goog-api-key": secret };
    case "BEARER":
    default:
      // relays often accept only one style per surface: send the native one in addition to Bearer
      if (surface === "anthropic") return { ...bearer, "x-api-key": secret };
      if (surface === "gemini") return { ...bearer, "x-goog-api-key": secret };
      return bearer;
  }
}

export function buildUpstreamHeaders(i: HeaderInput): Record<string, string> {
  const { provider: p } = i;
  const surface = surfaceOf(i.format);
  const h: Record<string, string> = {
    accept: i.stream ? "text/event-stream" : "application/json",
    "user-agent": "ProviderProxy/1.0",
  };
  if (i.hasBody !== false) h["content-type"] = i.contentType || "application/json";
  if (i.op === "videos_content" || i.op === "files_content" || i.op === "containers_file_content" || i.op === "batches_results") {
    h.accept = "*/*";
    const range = i.inbound?.get("range");
    if (range) h.range = range;
  }
  // forwarded unchanged: providers that support idempotency handle it, we never dedupe (PLAN 9d)
  const idem = i.inbound?.get("idempotency-key");
  if (idem) h["idempotency-key"] = idem;
  if (i.op && (i.op.startsWith("gfiles_") || i.op.startsWith("uploads_") || i.op.startsWith("files_"))) {
    // Files APIs: the resumable-upload protocol headers are part of the wire contract
    i.inbound?.forEach((v, k) => {
      if (k.startsWith("x-goog-upload-")) h[k] = v;
    });
  }

  if (surface === "anthropic") {
    h["anthropic-version"] = i.inbound?.get("anthropic-version") || str(p.settings.anthropicVersion) || "2023-06-01";
    const beta = i.inbound?.get("anthropic-beta");
    if (beta) h["anthropic-beta"] = beta;
  }
  if (surface === "openai") {
    const beta = i.inbound?.get("openai-beta");
    if (beta) h["openai-beta"] = beta;
    const org = str(i.keyExtra?.organization) ?? str(i.keyExtra?.org);
    const project = str(i.keyExtra?.project);
    if (org) h["openai-organization"] = org;
    if (project) h["openai-project"] = project;
  }
  // test hook: let load tests steer the mock upstream (x-mock-delay-ms ...) - only for providers tagged "mock"
  if (i.inbound && p.tags.includes("mock")) {
    i.inbound.forEach((v, k) => {
      if (k.startsWith("x-mock-")) h[k] = v;
    });
  }

  Object.assign(h, p.extraHeaders);
  const extraKeyHeaders = i.keyExtra?.headers;
  if (extraKeyHeaders && typeof extraKeyHeaders === "object") Object.assign(h, openHeaders(extraKeyHeaders));
  // auth last: admin extraHeaders can never clobber the credential
  Object.assign(h, authHeaders(p, surface, i.secret));
  return h;
}

/** Typed accessors for Provider.settings. */
export function providerSettings(p: { settings: JsonObject }) {
  const s = p.settings;
  return {
    stripFields: Array.isArray(s.stripFields) ? (s.stripFields as unknown[]).filter((x): x is string => typeof x === "string") : [],
    forceStreamUsage: s.forceStreamUsage !== false,
    maxTokensParam: s.maxTokensParam === "max_completion_tokens" ? ("max_completion_tokens" as const) : s.maxTokensParam === "max_tokens" ? ("max_tokens" as const) : undefined,
    // remove OpenAI prompt-caching hints (`prompt_cache_breakpoint` on input parts, `prompt_cache_options`) for upstreams that reject or ignore them
    stripCacheHints: s.stripCacheHints === true,
    // the service tiers this provider really serves (e.g. ["auto","default"]); a request for another tier skips it. Unset = any.
    serviceTiers: Array.isArray(s.serviceTiers) ? (s.serviceTiers as unknown[]).filter((x): x is string => typeof x === "string") : null,
    // the upstream ignores max_output_tokens: the gateway enforces it on the streamed output and ends with response.incomplete
    enforceMaxOutputTokens: s.enforceMaxOutputTokens === true,
    // the upstream does not bill a stream it ends with its own error event (Codex Everywhere: its ~900 s cap, "Upstream
    // service temporarily unavailable"): such a stream is not billed to the customer either, even if output was delivered
    unbilledStreamErrors: s.unbilledStreamErrors === true,
  };
}
