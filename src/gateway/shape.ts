import type { Candidate } from "./select";
import { GatewayError, type GatewayErrorCode } from "./errors";
import { encodeMultipart, type ParsedForm } from "./multipart";
import { buildUpstreamHeaders, buildUpstreamUrl, providerSettings, upstreamOp } from "./providers/adapters";
import { chatRequestToMessages, messagesRequestToChat } from "./translate";
import type { InboundFormat, Json, JsonObject, Operation, ParsedPath, Usage } from "./types";
import { emptyUsage } from "./types";
import { usageFromAnthropic, usageFromGemini, usageFromOpenAI, usageFromResponses } from "./usage";
import { deepMerge, isObject, safeJsonParse } from "./util";
import type { ModelRec } from "./cache";

/**
 * Per-attempt request shaping and response post-processing: model substitution, stream-usage injection, field
 * stripping, route paramOverrides + output clamp, translators, usage extraction, model-name masking, and
 * scrubbing of upstream identity from error bodies.
 */
export interface PrepareInput {
  path: ParsedPath;
  cand: Candidate;
  model: ModelRec;
  body: JsonObject | null;
  form: ParsedForm | null;
  stream: boolean;
  inboundHeaders: Headers;
  secret: string;
  responseId?: string;
  /** Video lookups: UPSTREAM video id + raw query (e.g. "variant=thumbnail"). */
  videoId?: string;
  query?: string;
}

export interface Prepared {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Buffer | null;
  upstreamFormat: InboundFormat;
  upstreamOp: Operation;
}

/** Clamp / set the output-token cap for the upstream format. */
function applyOutputClamp(obj: JsonObject, format: InboundFormat, op: Operation, limit: number, tokensParam: "max_tokens" | "max_completion_tokens"): void {
  if (op === "messages_count_tokens" || op === "gemini_count_tokens") return;
  if (format === "anthropic_messages") {
    obj.max_tokens = typeof obj.max_tokens === "number" ? Math.min(obj.max_tokens, limit) : limit;
  } else if (format === "gemini") {
    if (op === "gemini_generate" || op === "gemini_stream") {
      const gc = isObject(obj.generationConfig) ? obj.generationConfig : (obj.generationConfig = {});
      gc.maxOutputTokens = typeof gc.maxOutputTokens === "number" ? Math.min(gc.maxOutputTokens, limit) : limit;
    }
  } else if (format === "openai_responses") {
    obj.max_output_tokens = typeof obj.max_output_tokens === "number" ? Math.min(obj.max_output_tokens, limit) : limit;
  } else if (op === "chat" || op === "completions") {
    let set = false;
    for (const k of ["max_tokens", "max_completion_tokens"] as const) {
      if (typeof obj[k] === "number") {
        obj[k] = Math.min(obj[k], limit);
        set = true;
      }
    }
    if (!set) obj[op === "completions" ? "max_tokens" : tokensParam] = limit;
  }
}

export function maxTokensParamFor(provider: { preset: string; settings: JsonObject }): "max_tokens" | "max_completion_tokens" {
  const configured = providerSettings(provider).maxTokensParam;
  if (configured) return configured;
  return provider.preset === "openai" || provider.preset === "azure" ? "max_completion_tokens" : "max_tokens";
}

export function prepareUpstream(i: PrepareInput): Prepared {
  const { path, cand, model } = i;
  const { route, key, plan } = cand;
  const provider = route.provider;
  const upFormat = plan.upstream;
  const op = upstreamOp(path.op, upFormat);
  const ps = providerSettings(provider);
  const tokensParam = maxTokensParamFor(provider);
  let body: string | Buffer | null = null;
  let contentType: string | null = null;

  if (i.form) {
    const enc = encodeMultipart(i.form, { model: route.upstreamModel });
    body = enc.body;
    contentType = enc.contentType;
  } else if (i.body) {
    let obj: JsonObject;
    switch (plan.mode) {
      case "chat_to_messages":
        obj = chatRequestToMessages(i.body, { upstreamModel: route.upstreamModel, defaultMaxTokens: route.maxOutputTokens ?? model.maxOutput ?? 4096 });
        break;
      case "messages_to_chat":
        obj = messagesRequestToChat(i.body, { upstreamModel: route.upstreamModel, maxTokensParam: tokensParam });
        if (op === "chat" && path.op === "messages_count_tokens") obj.stream = false;
        break;
      default: {
        const hasOverrides = Object.keys(route.paramOverrides).length > 0;
        obj = hasOverrides ? structuredClone(i.body) : { ...i.body };
        if (upFormat === "gemini") {
          const full = `models/${route.upstreamModel}`;
          if (op === "gemini_embed") obj.model = full;
          if (op === "gemini_batch_embed" && Array.isArray(obj.requests)) {
            obj.requests = obj.requests.map((r: Json) => (isObject(r) ? { ...r, model: full } : r));
          }
        } else {
          obj.model = route.upstreamModel;
        }
      }
    }
    // the Sora-style video API takes `seconds` as a string enum ("4" | "8" | "12")
    if (op === "videos_create" && obj.seconds !== undefined && typeof obj.seconds !== "string") obj.seconds = String(obj.seconds);
    if (i.stream && (op === "chat" || op === "completions") && ps.forceStreamUsage) {
      obj.stream_options = { ...(isObject(obj.stream_options) ? obj.stream_options : {}), include_usage: true };
    }
    for (const f of ps.stripFields) delete obj[f];
    if (Object.keys(route.paramOverrides).length) deepMerge(obj, route.paramOverrides);
    if (route.maxOutputTokens && route.maxOutputTokens > 0) applyOutputClamp(obj, upFormat, op, route.maxOutputTokens, tokensParam);
    body = JSON.stringify(obj);
  }

  const method =
    path.op === "responses_get" || path.op === "responses_input_items" || path.op === "videos_get" || path.op === "videos_content"
      ? "GET"
      : path.op === "responses_delete" || path.op === "videos_delete"
        ? "DELETE"
        : "POST";
  const hasBody = body !== null;
  return {
    url: buildUpstreamUrl({ provider, format: upFormat, op, upstreamModel: route.upstreamModel, stream: i.stream, keyExtra: key.extra, responseId: i.responseId, videoId: i.videoId, query: i.query, secret: i.secret }),
    method,
    headers: buildUpstreamHeaders({ provider, format: upFormat, secret: i.secret, stream: i.stream, keyExtra: key.extra, inbound: i.inboundHeaders, contentType, hasBody, op }),
    body,
    upstreamFormat: upFormat,
    upstreamOp: op,
  };
}

// ---------------------------------------------------------------- usage extraction
/** Usage of a non-streaming upstream JSON response. Returns null when the response carries no usage signal. */
export function extractUsage(upFormat: InboundFormat, op: Operation, json: Json): Usage | null {
  if (!isObject(json)) return null;
  switch (op) {
    case "chat":
    case "completions":
    case "embeddings":
      return isObject(json.usage) ? usageFromOpenAI(json.usage) : null;
    case "responses":
      return isObject(json.usage) ? usageFromResponses(json.usage) : null;
    case "images_generations":
    case "images_edits":
    case "images_variations": {
      const u = isObject(json.usage) ? usageFromOpenAI(json.usage) : emptyUsage();
      u.imageCount = Array.isArray(json.data) ? json.data.length : 1;
      return u;
    }
    case "audio_transcriptions":
    case "audio_translations": {
      const u = emptyUsage();
      const usage = isObject(json.usage) ? json.usage : null;
      if (usage?.type === "tokens") Object.assign(u, usageFromOpenAI(usage));
      const secs = Number(json.duration ?? usage?.seconds);
      if (Number.isFinite(secs) && secs > 0) u.audioSeconds = secs;
      return u.audioSeconds > 0 || u.inputTokens > 0 || u.outputTokens > 0 ? u : null;
    }
    case "moderations":
      return emptyUsage();
    case "messages":
      return isObject(json.usage) ? usageFromAnthropic(json.usage) : null;
    case "messages_count_tokens":
    case "gemini_count_tokens":
      return emptyUsage();
    case "gemini_generate":
    case "gemini_stream":
      return isObject(json.usageMetadata) ? usageFromGemini(json.usageMetadata) : null;
    default:
      void upFormat;
      return null;
  }
}

// ---------------------------------------------------------------- masking
/** Rewrite upstream model names in a response body to the public slug. */
export function maskResponse(json: Json, publicModel: string): void {
  if (!isObject(json)) return;
  if (typeof json.model === "string") json.model = publicModel;
  if (typeof json.modelVersion === "string") json.modelVersion = publicModel;
  if (isObject(json.response) && typeof json.response.model === "string") json.response.model = publicModel;
}

// ---------------------------------------------------------------- error handling
export interface ScrubContext {
  upstreamModel: string;
  publicModel: string;
  providerName: string;
  providerSlug: string;
  baseUrl: string;
  secret?: string | null;
}

/** Remove upstream identity (model, provider name, host, URLs, key) from text shown to customers. */
export function scrubText(text: string, c: ScrubContext): string {
  let t = text;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (c.secret && c.secret.length >= 6) t = t.split(c.secret).join("[redacted]");
  if (c.upstreamModel && c.upstreamModel !== c.publicModel) t = t.replace(new RegExp(esc(c.upstreamModel), "gi"), c.publicModel);
  try {
    const host = new URL(c.baseUrl).host;
    if (host) t = t.replace(new RegExp(esc(host), "gi"), "upstream");
  } catch {
    /* ignore */
  }
  t = t.replace(/https?:\/\/[^\s"'<>)]+/gi, "[url]");
  for (const name of new Set([c.providerName, c.providerSlug])) {
    if (name && name.length >= 3) t = t.replace(new RegExp(`\\b${esc(name)}\\b`, "gi"), "the upstream provider");
  }
  t = t.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
  return t;
}

function scrubJson(v: Json, c: ScrubContext): Json {
  if (typeof v === "string") return scrubText(v, c);
  if (Array.isArray(v)) return v.map((x) => scrubJson(x, c));
  if (isObject(v)) {
    const out: JsonObject = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrubJson(x, c);
    return out;
  }
  return v;
}

/** Best-effort human message out of an upstream error body (OpenAI / Anthropic / Gemini / plain text). */
export function extractErrorMessage(body: string): string {
  const j = safeJsonParse<Json>(body);
  if (isObject(j)) {
    if (isObject(j.error) && typeof j.error.message === "string") return j.error.message;
    if (typeof j.error === "string") return j.error;
    if (typeof j.message === "string") return j.message;
    if (typeof j.detail === "string") return j.detail;
    if (Array.isArray(j.detail)) {
      const msgs = j.detail.map((d: Json) => (isObject(d) && typeof d.msg === "string" ? d.msg : typeof d === "string" ? d : "")).filter(Boolean);
      if (msgs.length) return msgs.join("; ");
    }
    if (Array.isArray(j) && isObject(j[0]) && isObject(j[0].error)) return String(j[0].error.message ?? "");
  }
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Build the customer-facing error for a NON-retryable upstream 4xx (400/404/413/422...). When inbound and
 * upstream speak the same wire format the (scrubbed) body is passed through unchanged; otherwise it is re-wrapped
 * in the inbound shape.
 */
export function clientErrorFromUpstream(
  status: number,
  bodyText: string,
  inboundFormat: InboundFormat,
  upstreamFormat: InboundFormat,
  scrub: ScrubContext,
): GatewayError {
  const parsed = safeJsonParse<Json>(bodyText);
  const sameShape = (inboundFormat === upstreamFormat || (inboundFormat.startsWith("openai_") && upstreamFormat.startsWith("openai_"))) && isObject(parsed) && (isObject(parsed.error) || parsed.type === "error");
  const msg = scrubText(extractErrorMessage(bodyText) || "The upstream provider rejected the request.", scrub);
  const code: GatewayErrorCode = status === 413 ? "payload_too_large" : "invalid_request";
  return new GatewayError(code, msg, {
    status,
    internal: `upstream ${status}: ${bodyText.slice(0, 2000)}`,
    kind: "client",
    ...(sameShape ? { passthroughBody: JSON.stringify(scrubJson(parsed, scrub)) } : {}),
    upstreamStatus: status,
  });
}

const RL_HEADERS = /^(retry-after|retry-after-ms|x-ratelimit-.+|anthropic-ratelimit-.+|ratelimit-.+)$/i;

/** Minimal header reader shared by DOM and undici Headers. */
export interface HeaderLike {
  get(name: string): string | null;
  forEach(cb: (value: string, key: string) => void): void;
}

/** x-ratelimit-* / retry-after headers worth forwarding on a 429. */
export function pickRateLimitHeaders(h: HeaderLike): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (RL_HEADERS.test(k)) out[k.toLowerCase()] = v;
  });
  return out;
}

/** retry-after (seconds) from upstream headers, if present and sane. */
export function parseRetryAfter(h: HeaderLike): number | undefined {
  const ms = Number(h.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 1000);
  const v = h.get("retry-after");
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const d = Date.parse(v);
  if (Number.isFinite(d)) return Math.max(1, Math.ceil((d - Date.now()) / 1000));
  return undefined;
}
