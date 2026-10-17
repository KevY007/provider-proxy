import type { Candidate } from "./select";
import { GatewayError, anthropicTypeFor, errorFormatFor, geminiStatusFor, type GatewayErrorCode } from "./errors";
import { pickForwardHeaders, type HeaderSource } from "./headers";
import { spliceTopLevel, type TopLevelScan } from "./jsonscan";
import { multipartSegments, type ParsedForm } from "./multipart";
import { BodySpool, type Segment } from "./spool";
import type { UpstreamBody } from "./upstream";
import { buildUpstreamHeaders, buildUpstreamUrl, providerSettings, upstreamOp } from "./providers/adapters";
import { chatRequestToMessages, messagesRequestToChat } from "./translate";
import type { ErrorFormat, InboundFormat, Json, JsonObject, Operation, ParsedPath, Usage } from "./types";
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
  /** The customer's JSON bytes: forwarded byte-identical except the top-level members that change. */
  jsonRaw?: { spool: BodySpool; scan: TopLevelScan } | null;
  form: ParsedForm | null;
  stream: boolean;
  inboundHeaders: Headers;
  secret: string;
  responseId?: string;
  /** Video lookups: UPSTREAM video id + raw query (e.g. "variant=thumbnail"). */
  videoId?: string;
  query?: string;
  /** Funds guard (PLAN 9c): hard output cap to write into the request (the client set none and little is affordable). */
  outputCap?: number | null;
  /** Funds guard: output tokens reserved; used when the upstream REQUIRES a cap (Anthropic) and the client sent none. */
  fillOutput?: number | null;
}

export interface Prepared {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Buffers / strings can be re-sent on failover; a stream body (large spooled uploads) is created fresh per attempt. */
  body: UpstreamBody;
  upstreamFormat: InboundFormat;
  upstreamOp: Operation;
}

/** Spliced body -> a Buffer when small and in memory, else a fresh stream with an explicit content-length. */
function spliceBody(spool: BodySpool, segments: Segment[]): { body: UpstreamBody; length: number } {
  const length = BodySpool.lengthOf(segments);
  const buf = spool.inlineBuffer(segments);
  return { body: buf ?? spool.stream(segments), length };
}

/** Top-level members whose value differs between the customer's body and the body we want to send (null = not expressible as a splice). */
function topLevelChanges(orig: JsonObject, next: JsonObject): Record<string, unknown> | null {
  const changes: Record<string, unknown> = {};
  for (const k of Object.keys(orig)) if (!(k in next)) return null; // deletion
  for (const [k, v] of Object.entries(next)) if (!(k in orig) || orig[k] !== v) changes[k] = v;
  return changes;
}

/** Clamp / set the output-token cap for the upstream format. */
function applyOutputClamp(obj: JsonObject, format: InboundFormat, op: Operation, limit: number, tokensParam: "max_tokens" | "max_completion_tokens"): void {
  if (op === "messages_count_tokens" || op === "gemini_count_tokens") return;
  if (format === "anthropic_messages") {
    obj.max_tokens = typeof obj.max_tokens === "number" ? Math.min(obj.max_tokens, limit) : limit;
  } else if (format === "gemini") {
    if (op === "gemini_generate" || op === "gemini_stream") {
      const snake = !isObject(obj.generationConfig) && isObject(obj.generation_config);
      // copy before changing: `obj` shares nested objects with the customer's body (and the splice logic compares them)
      const gc: JsonObject = { ...(snake ? (obj.generation_config as JsonObject) : isObject(obj.generationConfig) ? obj.generationConfig : {}) };
      if (snake) obj.generation_config = gc;
      else obj.generationConfig = gc;
      const field = snake ? "max_output_tokens" : "maxOutputTokens";
      const cur = gc[field];
      gc[field] = typeof cur === "number" ? Math.min(cur, limit) : limit;
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
  let body: UpstreamBody = null;
  let bodyLength: number | null = null;
  let contentType: string | null = null;

  if (i.form) {
    // the customer's multipart bytes, forwarded as they are (same boundary / order); only `model` is replaced
    const segs = multipartSegments(i.form, { model: route.upstreamModel });
    ({ body, length: bodyLength } = spliceBody(i.form.spool, segs));
    contentType = i.form.contentType;
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
    if (i.outputCap && i.outputCap > 0) applyOutputClamp(obj, upFormat, op, i.outputCap, tokensParam);
    // Anthropic requires max_tokens: when the client sent none, use what the funds guard reserved
    if (upFormat === "anthropic_messages" && op === "messages" && typeof obj.max_tokens !== "number") {
      const known = route.maxOutputTokens ?? model.maxOutput;
      obj.max_tokens = known ? Math.min(i.fillOutput ?? known, known) : Math.min(i.fillOutput ?? 4096, 4096);
    }
    // Native passthrough: keep the customer's bytes and only splice the members that changed (model, injected caps ...).
    // Anything else (translation, overrides, deletions, big replacements) re-serialises.
    let spliced: Segment[] | null = null;
    if (i.jsonRaw && plan.mode === "native" && Object.keys(route.paramOverrides).length === 0 && i.body) {
      const changes = topLevelChanges(i.body, obj);
      if (changes) spliced = spliceTopLevel(i.jsonRaw.scan, i.jsonRaw.spool.size, changes);
    }
    if (spliced && i.jsonRaw) ({ body, length: bodyLength } = spliceBody(i.jsonRaw.spool, spliced));
    else body = JSON.stringify(obj);
  }

  const method =
    path.op === "responses_get" || path.op === "responses_input_items" || path.op === "videos_get" || path.op === "videos_content"
      ? "GET"
      : path.op === "responses_delete" || path.op === "videos_delete"
        ? "DELETE"
        : "POST";
  const hasBody = body !== null;
  const headers = buildUpstreamHeaders({ provider, format: upFormat, secret: i.secret, stream: i.stream, keyExtra: key.extra, inbound: i.inboundHeaders, contentType, hasBody, op });
  if (body !== null && typeof body === "object" && !(body instanceof Uint8Array) && bodyLength !== null) headers["content-length"] = String(bodyLength);
  return {
    url: buildUpstreamUrl({ provider, format: upFormat, op, upstreamModel: route.upstreamModel, stream: i.stream, keyExtra: key.extra, responseId: i.responseId, videoId: i.videoId, query: i.query, secret: i.secret }),
    method,
    headers,
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

/** Best-effort human message out of an upstream error JSON document (OpenAI / Anthropic / Gemini / FastAPI shapes). */
function messageFromJson(j: Json, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  if (Array.isArray(j)) {
    for (const item of j) {
      const m = messageFromJson(item, depth + 1);
      if (m) return m;
    }
    return undefined;
  }
  if (!isObject(j)) return undefined;
  if (isObject(j.error) && typeof j.error.message === "string") return j.error.message;
  if (typeof j.error === "string") return j.error;
  if (typeof j.message === "string") return j.message;
  if (typeof j.detail === "string") return j.detail;
  if (Array.isArray(j.detail)) {
    const msgs = j.detail.map((d: Json) => (isObject(d) && typeof d.msg === "string" ? d.msg : typeof d === "string" ? d : "")).filter(Boolean);
    if (msgs.length) return msgs.join("; ");
  }
  return undefined;
}

/** Best-effort human message out of an upstream error body (JSON in any vendor shape, HTML or plain text). Never the raw body. */
export function extractErrorMessage(body: string): string {
  const j = safeJsonParse<Json>(body);
  if (j !== undefined && typeof j === "object" && j !== null) {
    // JSON without a recognisable message: the caller substitutes a generic one, the raw document is never echoed
    return messageFromJson(j) ?? "";
  }
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Identifier-like strings (error type / code / param) that are safe to pass on. */
const safeId = (v: unknown): string | null => (typeof v === "string" && /^[\w.\-[\]]{1,100}$/.test(v) ? v : null);

const genericClientMessage = (status: number): string =>
  status === 404 ? "The requested resource was not found." : status === 413 ? "The request is too large." : status === 429 ? "Rate limit exceeded." : "The request was rejected as invalid.";

/** Default OpenAI-style error `type` when the upstream document did not carry a usable one. */
const openaiTypeFor = (status: number): string => (status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error");

/** Rebuild an upstream error JSON in the inbound format from whitelisted, scrubbed fields only. */
function sanitizedErrorBody(parsed: JsonObject, format: ErrorFormat, status: number, message: string): string {
  const e = isObject(parsed.error) ? parsed.error : parsed;
  if (format === "anthropic") return JSON.stringify({ type: "error", error: { type: safeId(e.type) ?? (status >= 400 && status < 500 && status !== 429 ? "invalid_request_error" : anthropicTypeFor(status)), message } });
  if (format === "gemini") return JSON.stringify({ error: { code: status, message, status: safeId(e.status) ?? geminiStatusFor(status) } });
  return JSON.stringify({ error: { message, type: safeId(e.type) ?? openaiTypeFor(status), code: safeId(e.code), param: safeId(e.param) } });
}

/**
 * Build the customer-facing error for a NON-retryable upstream 4xx (400/404/413/422...). The upstream body is NEVER
 * returned as-is: when inbound and upstream speak the same wire format and the body is a JSON error document, it is
 * rebuilt from its whitelisted fields (message scrubbed, type / code / param kept so SDK error handling keeps working);
 * anything else (plain text, HTML, odd JSON, cross-format) becomes a native error whose message is the scrubbed text.
 */
export function clientErrorFromUpstream(
  status: number,
  bodyText: string,
  inboundFormat: InboundFormat,
  upstreamFormat: InboundFormat,
  scrub: ScrubContext,
): GatewayError {
  const parsed = safeJsonParse<Json>(bodyText);
  const doc = Array.isArray(parsed) && isObject(parsed[0]) ? parsed[0] : parsed;
  const sameShape = (inboundFormat === upstreamFormat || (inboundFormat.startsWith("openai_") && upstreamFormat.startsWith("openai_"))) && isObject(doc) && (isObject(doc.error) || doc.type === "error");
  const raw = extractErrorMessage(bodyText).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const msg = scrubText(raw || genericClientMessage(status), scrub).slice(0, 1000);
  const code: GatewayErrorCode = status === 413 ? "payload_too_large" : "invalid_request";
  return new GatewayError(code, msg, {
    status,
    internal: `upstream ${status}: ${bodyText.slice(0, 2000)}`,
    kind: "client",
    ...(sameShape ? { passthroughBody: sanitizedErrorBody(doc as JsonObject, errorFormatFor(inboundFormat), status, msg) } : {}),
    upstreamStatus: status,
  });
}

/**
 * The error the CLIENT gets when every pre-commit attempt failed with an upstream HTTP error (PLAN 9d.1a): the LAST
 * upstream's real status, its retry-after / rate-limit headers, its request id (as `x-upstream-request-id`) and its
 * native error document (type / code / message kept, only our identity scrubbed). The gateway `code` is only used
 * for our own RequestLog; the body the client reads is the upstream's.
 */
export function mirrorErrorFromUpstream(
  status: number,
  bodyText: string,
  headers: HeaderSource | Record<string, string>,
  inboundFormat: InboundFormat,
  upstreamFormat: InboundFormat,
  scrub: ScrubContext,
  opts: { rateLimits: boolean },
): GatewayError {
  const parsed = safeJsonParse<Json>(bodyText);
  const doc = Array.isArray(parsed) && isObject(parsed[0]) ? parsed[0] : parsed;
  const sameShape = (inboundFormat === upstreamFormat || (inboundFormat.startsWith("openai_") && upstreamFormat.startsWith("openai_"))) && isObject(doc) && (isObject(doc.error) || doc.type === "error");
  const raw = extractErrorMessage(bodyText).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const msg = scrubText(raw || genericUpstreamMessage(status), scrub).slice(0, 1000);
  const code: GatewayErrorCode = status === 429 ? "rate_limited" : status === 529 ? "upstream_overloaded" : status === 504 || status === 408 ? "upstream_timeout" : "upstream_error";
  const fwd =
    typeof (headers as HeaderSource).forEach === "function"
      ? pickForwardHeaders(headers as HeaderSource, { rateLimits: opts.rateLimits })
      : (headers as Record<string, string>);
  return new GatewayError(code, msg, {
    status,
    kind: "upstream",
    headers: fwd,
    internal: `upstream ${status}: ${bodyText.slice(0, 2000)}`,
    upstreamStatus: status,
    ...(sameShape ? { passthroughBody: sanitizedErrorBody(doc as JsonObject, errorFormatFor(inboundFormat), status, msg) } : {}),
    ...(status === 529 ? { anthropicType: "overloaded_error" } : {}),
    ...(status === 429 ? { anthropicType: "rate_limit_error" } : {}),
  });
}

const genericUpstreamMessage = (status: number): string =>
  status === 429 ? "Rate limit exceeded. Please retry later." : status === 529 ? "The upstream provider is overloaded. Please retry shortly." : status === 504 || status === 408 ? "The upstream provider timed out." : "The upstream provider returned an error.";

/** The upstream error document equivalent of an in-stream error event (used when a stream fails before the response was committed). */
export function inbandErrorDocument(upstreamFormat: InboundFormat, e: { status: number; message: string; type?: string }): string {
  if (upstreamFormat === "anthropic_messages") return JSON.stringify({ type: "error", error: { type: e.type || anthropicTypeFor(e.status), message: e.message } });
  if (upstreamFormat === "gemini") return JSON.stringify({ error: { code: e.status, message: e.message, status: e.type || geminiStatusFor(e.status) } });
  return JSON.stringify({ error: { message: e.message, type: e.type || openaiTypeFor(e.status), code: null, param: null } });
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
