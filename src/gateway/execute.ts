import { logger } from "@/lib/logger";
import type { SettingValues } from "@/lib/settings";
import type { ConfigSnapshot } from "./cache";
import { getKeySecret } from "./cache";
import { logOutcome, releaseAll, releaseUpstream, withCommon, type Ctx } from "./context";
import { GatewayError, streamErrorEvent, type GatewayErrorCode } from "./errors";
import { classifyStatus, recordKeyFailure, recordKeySuccess, type FailureKind } from "./keyhealth";
import { checkRpm, checkTpm, providerKeyDailyCost } from "./limits";
import { fileBytes } from "./multipart";
import type { StreamProcessor } from "./processor";
import { rememberResponse } from "./responses-sticky";
import { buildCandidates, type Candidate, type RoutePlan } from "./select";
import {
  clientErrorFromUpstream,
  extractErrorMessage,
  extractUsage,
  maskResponse,
  parseRetryAfter,
  pickRateLimitHeaders,
  prepareUpstream,
  type Prepared,
  type ScrubContext,
} from "./shape";
import { acquireSlots, trackQueued, waitForRelease, type SlotLease, type SlotPool } from "./slots";
import { InBandError, StreamSession, type FinishInfo } from "./stream";
import { GeminiJsonArrayStream } from "./stream-gemini-array";
import { AnthropicStreamPassthrough, GeminiStreamPassthrough, OpenAIStreamPassthrough, ResponsesStreamPassthrough } from "./stream-processors";
import { countRequestTokens, countTokens } from "./tokenizer";
import { AnthropicToChatStream, ChatToAnthropicStream, chatResponseToMessages, messagesResponseToChat } from "./translate";
import { emptyUsage, type Json, type Operation, type Usage } from "./types";
import { ClientAbortError, UpstreamTimeoutError, readErrorBody, readTextLimited, sendUpstream, type UpstreamHandle } from "./upstream";
import { isObject, safeJsonParse, sleep } from "./util";

const MAX_JSON_RESPONSE = 64 * 1024 * 1024;
const STREAM_OPS = new Set<Operation>(["chat", "completions", "responses", "messages", "gemini_stream"]);
const TOKEN_OPS = new Set<Operation>(["chat", "completions", "responses", "messages", "gemini_generate", "gemini_stream", "embeddings", "gemini_embed", "gemini_batch_embed"]);

export interface Failure {
  fk: FailureKind;
  status: number;
  message: string;
  startedAt?: number;
  retryAfterSec?: number;
  rlHeaders?: Record<string, string>;
  internal: string;
}

export type AttemptResult =
  | { kind: "response"; response: Response }
  | { kind: "failure"; failure: Failure }
  | { kind: "client_error"; error: GatewayError };

export interface ExecOptions {
  /** Restrict to a single upstream key (Responses-API stickiness). */
  pinKeyId?: string | null;
  maxAttempts?: number;
  responseId?: string;
}

const isFailoverStatus = (s: number) => s === 401 || s === 402 || s === 403 || s === 408 || s === 429 || s >= 500 || (s >= 300 && s < 400);

// ------------------------------------------------------------------ slot selection
export function upstreamPools(c: Candidate, settings: Pick<SettingValues, "defaultKeyConcurrency">): SlotPool[] {
  const pools: SlotPool[] = [{ kind: "pkey", id: c.key.id, max: c.key.maxConcurrency ?? settings.defaultKeyConcurrency }];
  const pm = c.route.provider.maxConcurrency;
  if (pm && pm > 0) pools.push({ kind: "provider", id: c.route.provider.id, max: pm });
  return pools;
}

/** First candidate (in order) that has a free slot and passes its rpm/tpm/daily-budget limits. */
async function pickSlot(cands: Candidate[], settings: SettingValues): Promise<{ cand: Candidate; lease: SlotLease } | null> {
  for (const c of cands) {
    const r = await acquireSlots(upstreamPools(c, settings));
    if (!r.ok) continue;
    const k = c.key;
    if (k.rpmLimit && !(await checkRpm(`pkey:${k.id}`, k.rpmLimit)).ok) {
      r.lease.release();
      continue;
    }
    if (k.tpmLimit && !(await checkTpm(`pkey:${k.id}`, k.tpmLimit)).ok) {
      r.lease.release();
      continue;
    }
    if (k.dailyBudget && (await providerKeyDailyCost(k.id)).gte(k.dailyBudget)) {
      r.lease.release();
      continue;
    }
    return { cand: c, lease: r.lease };
  }
  return null;
}

// ------------------------------------------------------------------ main loop
/**
 * Execute the request against `routes` with failover (PLAN 5 steps 7-11, 9b):
 * walk (route, key) candidates in order, take the first free slot, queue when everything is busy, retry on
 * 429/5xx/network/auth failures before any byte reached the client, give up after settings.maxAttempts.
 */
export async function execute(ctx: Ctx, routes: RoutePlan[], opts: ExecOptions = {}): Promise<Response> {
  const snap = ctx.snap!;
  const settings = snap.settings;
  const maxAttempts = opts.maxAttempts ?? settings.maxAttempts;
  const failures = new Map<string, number>();
  const signal = ctx.req.signal;
  let attemptsMade = 0;
  let lastFailure: Failure | null = null;
  let queueStart: number | null = null;
  let queued = false;
  let queueRecorded = false;

  try {
    for (;;) {
      if (signal.aborted) throw new GatewayError("client_closed");
      const cands = buildCandidates(snap, routes, { failures, pinKeyId: opts.pinKeyId });
      if (!cands.length) throw lastFailure ? finalError(lastFailure, settings) : noProviderError(snap, routes);

      const pick = await pickSlot(cands, settings);
      if (!pick) {
        if (queueStart === null) {
          queueStart = Date.now();
          queued = true;
          trackQueued(1);
        }
        const remaining = settings.queueTimeoutMs - (Date.now() - queueStart);
        if (remaining <= 0) {
          throw new GatewayError("no_capacity", undefined, { retryAfterSec: 2, internal: `queue timeout after ${settings.queueTimeoutMs}ms; ${cands.length} candidate key(s) busy` });
        }
        await waitForRelease(Math.min(remaining, 150), signal);
        continue;
      }
      if (!queueRecorded) {
        queueRecorded = true;
        ctx.queueMs = queueStart === null ? 0 : Date.now() - queueStart;
      }
      if (queued) {
        queued = false;
        trackQueued(-1);
      }

      ctx.chosen = pick.cand;
      ctx.upstreamLease = pick.lease;
      const r = await attempt(ctx, pick.cand, settings, opts);
      if (r.kind === "response") return r.response;

      releaseUpstream(ctx);
      if (r.kind === "client_error") throw r.error;

      const f = r.failure;
      lastFailure = f;
      attemptsMade++;
      failures.set(pick.cand.key.id, (failures.get(pick.cand.key.id) ?? 0) + 1);
      if (f.fk === "auth" && !getKeySecret(pick.cand.key)) {
        recordKeyFailure(pick.cand.key, "auth", { status: f.status, message: f.message }, settings);
      } else {
        recordKeyFailure(pick.cand.key, f.fk, { status: f.status, message: f.message, retryAfterSec: f.retryAfterSec, startedAt: f.startedAt }, settings);
      }
      if (attemptsMade >= maxAttempts) throw finalError(f, settings);
    }
  } finally {
    if (queued) {
      trackQueued(-1);
      if (queueStart !== null && !queueRecorded) ctx.queueMs = Date.now() - queueStart;
    }
  }
}

function noProviderError(snap: ConfigSnapshot, routes: RoutePlan[]): GatewayError {
  const now = Date.now();
  let soonest = Infinity;
  for (const rp of routes) {
    for (const k of snap.keysByProvider.get(rp.route.providerId) ?? []) {
      if (k.cooldownUntil && k.cooldownUntil > now) soonest = Math.min(soonest, k.cooldownUntil - now);
    }
  }
  const retry = Number.isFinite(soonest) ? Math.min(60, Math.max(1, Math.ceil(soonest / 1000))) : 30;
  return new GatewayError("no_available_provider", undefined, { retryAfterSec: retry, internal: "no usable upstream key (all disabled, invalid, cooling down or missing)" });
}

/** Customer-facing error once attempts are exhausted (never reveals upstream identity). */
export function finalError(f: Failure, settings: Pick<SettingValues, "passUpstreamRateLimits">): GatewayError {
  let code: GatewayErrorCode;
  let opts: ConstructorParameters<typeof GatewayError>[2] = { internal: `${f.status || "network"} ${f.fk}: ${f.internal}`.slice(0, 4000), upstreamStatus: f.status || undefined };
  switch (f.fk) {
    case "rate_limit":
      code = "rate_limited";
      opts = {
        ...opts,
        kind: "upstream",
        retryAfterSec: f.retryAfterSec ?? 2,
        headers: settings.passUpstreamRateLimits ? (f.rlHeaders ?? {}) : {},
      };
      return new GatewayError(code, "Rate limit exceeded. Please retry later.", opts);
    case "timeout":
      return new GatewayError("upstream_timeout", undefined, opts);
    case "auth":
    case "payment":
      return new GatewayError("no_available_provider", undefined, { ...opts, retryAfterSec: 30 });
    default:
      if (f.status === 529) return new GatewayError("upstream_overloaded", undefined, { ...opts, retryAfterSec: f.retryAfterSec ?? 5, anthropicType: "overloaded_error" });
      return new GatewayError("upstream_error", undefined, opts);
  }
}

// ------------------------------------------------------------------ one attempt
async function attempt(ctx: Ctx, cand: Candidate, settings: SettingValues, opts: ExecOptions): Promise<AttemptResult> {
  const t0 = Date.now();
  const { route, key } = cand;
  const provider = route.provider;
  const rec = (status: number, error?: string) =>
    ctx.attempts.push({ providerId: provider.id, providerKeyId: key.id, routeId: route.id, status, error: error?.slice(0, 300), latencyMs: Date.now() - t0 });
  const fail = (fk: FailureKind, status: number, message: string, extra: Partial<Failure> = {}): AttemptResult => {
    rec(status, message);
    return { kind: "failure", failure: { fk, status, message, internal: message, startedAt: t0, ...extra } };
  };

  const secret = getKeySecret(key);
  if (!secret) return fail("auth", 0, "upstream key could not be decrypted");

  let prepared: Prepared;
  try {
    prepared = prepareUpstream({ path: ctx.path!, cand, model: ctx.model!, body: ctx.body, form: ctx.form, stream: ctx.stream, inboundHeaders: ctx.req.headers, secret, responseId: opts.responseId ?? ctx.path!.responseId });
  } catch (e) {
    if (e instanceof GatewayError) {
      rec(e.status, e.message);
      return { kind: "client_error", error: e };
    }
    throw e;
  }

  let h: UpstreamHandle;
  for (let tries = 0; ; tries++) {
    try {
      h = await sendUpstream({ url: prepared.url, method: prepared.method, headers: prepared.headers, body: prepared.body, timeoutMs: provider.timeoutMs, clientSignal: ctx.req.signal });
      break;
    } catch (err) {
      if (err instanceof ClientAbortError) throw new GatewayError("client_closed");
      if (err instanceof UpstreamTimeoutError) return fail("timeout", 0, `no response within ${provider.timeoutMs}ms`);
      // connection could not even be established (nothing was sent): safe to retry once on the same key
      if (tries === 0 && isConnectError(err)) {
        await sleep(25 + Math.random() * 75, ctx.req.signal);
        continue;
      }
      return fail("network", 0, describeNetworkError(err));
    }
  }

  const res = h.res;
  if (res.status >= 200 && res.status < 300) return handleOk(ctx, cand, prepared, h, t0, settings, rec, fail);

  const errBody = await readErrorBody(res);
  h.dispose();
  const message = extractErrorMessage(errBody) || `HTTP ${res.status}`;
  rec(res.status, message);
  if (isFailoverStatus(res.status)) {
    return {
      kind: "failure",
      failure: {
        fk: classifyStatus(res.status),
        status: res.status,
        message,
        retryAfterSec: parseRetryAfter(res.headers),
        rlHeaders: pickRateLimitHeaders(res.headers),
        internal: errBody.slice(0, 2000),
        startedAt: t0,
      },
    };
  }
  return { kind: "client_error", error: clientErrorFromUpstream(res.status, errBody, ctx.path!.format === "catalog" ? "openai_chat" : ctx.path!.format, prepared.upstreamFormat, scrubCtx(ctx, cand, secret)) };
}

/** Errors raised before any byte of the request reached the upstream (retry-safe). */
function isConnectError(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "UND_ERR_CONNECT_TIMEOUT";
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return `${err.message}${cause?.code ? ` (${cause.code})` : ""}`.slice(0, 300);
  }
  return String(err).slice(0, 300);
}

function scrubCtx(ctx: Ctx, cand: Candidate, secret: string): ScrubContext {
  return {
    upstreamModel: cand.route.upstreamModel,
    publicModel: ctx.model?.slug ?? cand.route.upstreamModel,
    providerName: cand.route.provider.name,
    providerSlug: cand.route.provider.slug,
    baseUrl: cand.route.provider.baseUrl,
    secret,
  };
}

type Rec = (status: number, error?: string) => number;
type Fail = (fk: FailureKind, status: number, message: string, extra?: Partial<Failure>) => AttemptResult;

// ------------------------------------------------------------------ successful upstream response
async function handleOk(ctx: Ctx, cand: Candidate, prepared: Prepared, h: UpstreamHandle, t0: number, settings: SettingValues, rec: Rec, fail: Fail): Promise<AttemptResult> {
  const path = ctx.path!;
  const ct = h.res.headers.get("content-type") ?? "";
  const isSse = ct.includes("text/event-stream");

  if (ctx.stream && STREAM_OPS.has(path.op)) {
    if (!isSse) {
      const body = await readErrorBody(h.res);
      h.dispose();
      return fail("server", 200, `expected an event stream, got ${ct || "no content-type"}`, { internal: body.slice(0, 1000) });
    }
    return handleStream(ctx, cand, prepared, h, t0, settings, rec, fail);
  }
  if (path.op === "audio_speech" || /^(audio|video|image)\//i.test(ct) || ct.includes("application/octet-stream")) {
    return handleBinary(ctx, cand, h, t0, rec);
  }
  return handleJson(ctx, cand, prepared, h, t0, rec, fail);
}

function publicModelName(ctx: Ctx, cand: Candidate): string {
  return ctx.model?.maskUpstreamModel ? ctx.model.slug : cand.route.upstreamModel;
}

const jsonHeaders = (ctx: Ctx, extra: Record<string, string> = {}): Headers => {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
  h.set("x-request-id", ctx.requestId);
  return h;
};

async function completeUsage(ctx: Ctx, usage: Usage | null, outputText: string, op: Operation): Promise<Usage> {
  if (!TOKEN_OPS.has(op)) return usage ?? emptyUsage();
  const needInput = !usage || usage.inputTokens === 0;
  const needOutput = op !== "embeddings" && op !== "gemini_embed" && op !== "gemini_batch_embed" && (!usage || usage.outputTokens === 0) && outputText.length > 0;
  if (!needInput && !needOutput) return usage!;
  const u: Usage = usage ? { ...usage } : emptyUsage();
  u.estimated = true;
  if (needInput) u.inputTokens = await countRequestTokens(ctx.body ?? {});
  if (needOutput) u.outputTokens = await countTokens(outputText);
  return u;
}

async function handleJson(ctx: Ctx, cand: Candidate, prepared: Prepared, h: UpstreamHandle, t0: number, rec: Rec, fail: Fail): Promise<AttemptResult> {
  const path = ctx.path!;
  const provider = cand.route.provider;
  const timer = setTimeout(() => h.abort(new UpstreamTimeoutError("idle")), provider.timeoutMs);
  let text: string;
  try {
    text = await readTextLimited(h.res, MAX_JSON_RESPONSE);
  } catch (err) {
    clearTimeout(timer);
    h.dispose();
    if (ctx.req.signal.aborted || err instanceof ClientAbortError || h.signal.reason instanceof ClientAbortError) throw new GatewayError("client_closed");
    if (h.signal.reason instanceof UpstreamTimeoutError) return fail("timeout", 0, "timed out reading the upstream response");
    return fail("network", 0, `failed reading upstream response: ${describeNetworkError(err)}`);
  }
  clearTimeout(timer);
  h.dispose();

  const parsed = safeJsonParse<Json>(text);
  const publicName = publicModelName(ctx, cand);
  const mask = ctx.model?.maskUpstreamModel ?? true;

  // non-JSON success bodies are legitimate only for audio transcription formats (text / srt / vtt)
  if (parsed === undefined) {
    if ((path.op === "audio_transcriptions" || path.op === "audio_translations") && h.res.status === 200) {
      const u = emptyUsage();
      u.audioSeconds = ctx.form ? Math.max(1, Math.round(fileBytes(ctx.form) / 16_000)) : 0;
      u.estimated = true;
      rec(200);
      recordKeySuccess(cand.key);
      logOutcome(ctx, { status: "SUCCESS", httpStatus: 200, usage: u, ttftMs: Date.now() - t0 });
      const hdr = new Headers({ "content-type": h.res.headers.get("content-type") ?? "text/plain; charset=utf-8", "x-request-id": ctx.requestId });
      return { kind: "response", response: withCommon(ctx, new Response(text, { status: 200, headers: hdr })) };
    }
    return fail("server", 200, "upstream returned a non-JSON response", { internal: text.slice(0, 1000) });
  }

  // some relays answer 200 with an error document: treat it as an upstream failure (failover) instead of passing it on
  if (isObject(parsed) && isObject(parsed.error) && ["chat", "completions", "messages", "responses", "embeddings"].includes(path.op) && parsed.choices === undefined && parsed.content === undefined && parsed.output === undefined && parsed.data === undefined) {
    const code = Number(parsed.error.code);
    const status = code >= 400 && code < 600 ? code : parsed.error.type === "overloaded_error" ? 529 : parsed.error.type === "rate_limit_error" ? 429 : 502;
    return fail(classifyStatus(status), status, extractErrorMessage(text) || "upstream error in a 200 response", { internal: text.slice(0, 1000) });
  }

  let out: Json = parsed;
  let usage: Usage | null;
  if (cand.plan.mode === "chat_to_messages") {
    if (!isObject(parsed)) return fail("server", 200, "unexpected upstream response shape");
    const t = messagesResponseToChat(parsed, publicName);
    out = t.body;
    usage = t.usage;
  } else if (cand.plan.mode === "messages_to_chat") {
    if (!isObject(parsed)) return fail("server", 200, "unexpected upstream response shape");
    const t = chatResponseToMessages(parsed, publicName);
    out = t.body;
    usage = t.usage;
  } else {
    usage = extractUsage(prepared.upstreamFormat, prepared.upstreamOp, parsed);
    if (mask && ctx.model) maskResponse(out, ctx.model.slug);
  }

  const outText = TOKEN_OPS.has(path.op) && (!usage || usage.outputTokens === 0) ? collectOutputText(parsed) : "";
  const finalUsage = await completeUsage(ctx, usage, outText, path.op);
  if (ctx.form && (path.op === "audio_transcriptions" || path.op === "audio_translations") && finalUsage.audioSeconds === 0 && finalUsage.inputTokens === 0) {
    finalUsage.audioSeconds = Math.max(1, Math.round(fileBytes(ctx.form) / 16_000));
    finalUsage.estimated = true;
  }

  // Responses: remember which account owns the response id (GET/DELETE/previous_response_id stickiness)
  if ((path.op === "responses") && isObject(parsed) && typeof parsed.id === "string" && ctx.auth && ctx.model) {
    void rememberResponse(parsed.id, { userId: ctx.auth.user.id, providerId: cand.route.providerId, providerKeyId: cand.key.id, routeId: cand.route.id, modelId: ctx.model.id });
  }

  rec(200);
  recordKeySuccess(cand.key);
  logOutcome(ctx, { status: "SUCCESS", httpStatus: 200, usage: finalUsage, ttftMs: Date.now() - t0, responseBody: ctx.logBodies ? out : undefined });
  return { kind: "response", response: withCommon(ctx, new Response(JSON.stringify(out), { status: 200, headers: jsonHeaders(ctx) })) };
}

function collectOutputText(json: Json): string {
  const parts: string[] = [];
  const visit = (v: Json, depth: number) => {
    if (depth > 12 || parts.length > 2000) return;
    if (typeof v === "string") return;
    if (Array.isArray(v)) return void v.forEach((x) => visit(x, depth + 1));
    if (!isObject(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string" && (k === "text" || k === "content" || k === "arguments" || k === "thinking" || k === "partial_json")) parts.push(x);
      else visit(x, depth + 1);
    }
  };
  if (isObject(json)) {
    visit(json.choices ?? json.content ?? json.output ?? json.candidates ?? json, 0);
  }
  return parts.join("\n");
}

// ------------------------------------------------------------------ binary passthrough (audio)
async function handleBinary(ctx: Ctx, cand: Candidate, h: UpstreamHandle, t0: number, rec: Rec): Promise<AttemptResult> {
  const path = ctx.path!;
  rec(200);
  recordKeySuccess(cand.key);
  ctx.deferRelease = true;
  const body = h.res.body as ReadableStream<Uint8Array> | null;
  const ct = h.res.headers.get("content-type") ?? "application/octet-stream";
  if (!body) {
    h.dispose();
    ctx.deferRelease = false;
    const u = emptyUsage();
    logOutcome(ctx, { status: "SUCCESS", httpStatus: 200, usage: u });
    return { kind: "response", response: withCommon(ctx, new Response(null, { status: 200, headers: { "content-type": ct, "x-request-id": ctx.requestId } })) };
  }
  const session = new StreamSession({
    body,
    processor: null,
    abort: h.abort,
    signal: h.signal,
    idleTimeoutMs: cand.route.provider.timeoutMs,
    startedAt: t0,
    onFinish: (info) => {
      h.dispose();
      releaseAll(ctx);
      const u = emptyUsage();
      if (path.op === "audio_speech" && ctx.body && typeof ctx.body.input === "string") u.characters = ctx.body.input.length;
      finishLog(ctx, cand, info, u, "binary");
    },
  });
  const hdr = new Headers({ "content-type": ct, "cache-control": "no-store", "x-request-id": ctx.requestId });
  return { kind: "response", response: withCommon(ctx, new Response(session.toReadable(), { status: 200, headers: hdr })) };
}

function finishLog(ctx: Ctx, cand: Candidate, info: FinishInfo, usage: Usage, what: string): void {
  const base = { usage, ttftMs: info.firstOutputMs };
  switch (info.reason) {
    case "completed":
      logOutcome(ctx, { ...base, status: "SUCCESS", httpStatus: 200 });
      break;
    case "cancelled":
      logOutcome(ctx, { ...base, status: "CANCELLED", httpStatus: 499, errorCode: "client_closed", errorMessage: "Client closed the request." });
      break;
    case "timeout":
      recordKeyFailure(cand.key, "timeout", { status: 0, message: `${what} stream idle timeout` }, ctxSettings(ctx));
      logOutcome(ctx, { ...base, status: "UPSTREAM_ERROR", httpStatus: 504, errorCode: "upstream_timeout", errorMessage: "The upstream provider timed out.", internalError: `${what} stream idle timeout` });
      break;
    default:
      recordKeyFailure(cand.key, "server", { status: 0, message: `${what} stream ${info.reason}` }, ctxSettings(ctx));
      logOutcome(ctx, { ...base, status: "UPSTREAM_ERROR", httpStatus: 502, errorCode: "upstream_error", errorMessage: "The upstream provider returned an error.", internalError: `${what} stream ${info.reason}: ${describeNetworkError(info.error)}` });
  }
}

function ctxSettings(ctx: Ctx): SettingValues {
  return ctx.snap!.settings;
}

// ------------------------------------------------------------------ SSE streaming
/** Gemini streaming without ?alt=sse expects a JSON array body instead of SSE. */
function geminiJsonArray(ctx: Ctx): boolean {
  return ctx.path?.op === "gemini_stream" && ctx.url.searchParams.get("alt") !== "sse";
}

function makeProcessor(ctx: Ctx, cand: Candidate): StreamProcessor {
  const publicName = publicModelName(ctx, cand);
  const mask = ctx.model?.maskUpstreamModel ? ctx.model.slug : null;
  switch (cand.plan.mode) {
    case "chat_to_messages":
      return new AnthropicToChatStream(publicName, ctx.clientWantsUsage);
    case "messages_to_chat":
      return new ChatToAnthropicStream(publicName);
    default:
  }
  switch (cand.plan.upstream) {
    case "openai_responses":
      return new ResponsesStreamPassthrough(mask);
    case "anthropic_messages":
      return new AnthropicStreamPassthrough(mask);
    case "gemini": {
      const g = new GeminiStreamPassthrough(mask);
      return geminiJsonArray(ctx) ? new GeminiJsonArrayStream(g) : g;
    }
    default:
      return new OpenAIStreamPassthrough(mask, ctx.clientWantsUsage);
  }
}

async function handleStream(ctx: Ctx, cand: Candidate, prepared: Prepared, h: UpstreamHandle, t0: number, settings: SettingValues, rec: Rec, fail: Fail): Promise<AttemptResult> {
  void prepared;
  const body = h.res.body as ReadableStream<Uint8Array> | null;
  if (!body) {
    h.dispose();
    return fail("server", 200, "empty upstream stream");
  }
  const processor = makeProcessor(ctx, cand);
  const session = new StreamSession({
    body,
    processor,
    abort: h.abort,
    signal: h.signal,
    idleTimeoutMs: cand.route.provider.timeoutMs,
    startedAt: t0,
    errorEvent: (err) => {
      let ge: GatewayError;
      if (err instanceof UpstreamTimeoutError) ge = new GatewayError("upstream_timeout");
      else if (err instanceof InBandError && err.info.status === 429) ge = new GatewayError("rate_limited", "Rate limit exceeded. Please retry later.");
      else if (err instanceof InBandError && err.info.status === 529) ge = new GatewayError("upstream_overloaded");
      else ge = new GatewayError("upstream_error");
      return streamErrorEvent(ctx.errorFormat, ge, ctx.requestId);
    },
    onFinish: (info) => {
      h.dispose();
      releaseAll(ctx); // free slots first, bookkeeping after
      void finalizeStream(ctx, cand, processor, info, settings).catch((err) => {
        logger.error("stream finalize failed", { requestId: ctx.requestId, err });
        logOutcome(ctx, { status: "GATEWAY_ERROR", httpStatus: 500, errorCode: "internal_error", errorMessage: "Internal server error.", internalError: String(err) });
      });
    },
  });

  try {
    await session.prime();
  } catch (err) {
    session.discard();
    h.abort();
    h.dispose();
    if (ctx.req.signal.aborted || h.signal.reason instanceof ClientAbortError) throw new GatewayError("client_closed");
    if (h.signal.reason instanceof UpstreamTimeoutError) return fail("timeout", 0, "timed out waiting for the first stream event");
    return fail("network", 0, `stream failed before first event: ${describeNetworkError(err)}`);
  }
  const inband = processor.error();
  if (inband) {
    session.discard();
    h.abort();
    h.dispose();
    return fail(classifyStatus(inband.status), inband.status, inband.message, { internal: `in-band stream error: ${inband.type ?? ""} ${inband.message}` });
  }
  if (session.isEmpty()) {
    session.discard();
    h.dispose();
    return fail("server", 200, "upstream closed the stream without sending data");
  }

  rec(200);
  recordKeySuccess(cand.key); // the upstream answered: clear transient failure state now, not at the end of a long stream
  ctx.deferRelease = true;
  const headers = new Headers({
    "content-type": geminiJsonArray(ctx) ? "application/json; charset=UTF-8" : "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    "x-request-id": ctx.requestId,
  });
  return { kind: "response", response: withCommon(ctx, new Response(session.toReadable(), { status: 200, headers })) };
}

async function finalizeStream(ctx: Ctx, cand: Candidate, processor: StreamProcessor, info: FinishInfo, settings: SettingValues): Promise<void> {
  const path = ctx.path!;
  const reported = processor.usage();
  const usage = await completeUsage(ctx, reported, processor.outputText(), path.op);

  const rid = processor.responseId?.();
  if (rid && ctx.auth && ctx.model) {
    void rememberResponse(rid, { userId: ctx.auth.user.id, providerId: cand.route.providerId, providerKeyId: cand.key.id, routeId: cand.route.id, modelId: ctx.model.id });
  }

  const err = processor.error();
  if (info.reason === "completed") {
    recordKeySuccess(cand.key);
    logOutcome(ctx, { status: "SUCCESS", httpStatus: 200, usage, ttftMs: info.firstOutputMs });
  } else if (info.reason === "cancelled") {
    logOutcome(ctx, { status: "CANCELLED", httpStatus: 499, errorCode: "client_closed", errorMessage: "Client closed the request.", usage, ttftMs: info.firstOutputMs });
  } else {
    const timeout = info.reason === "timeout";
    recordKeyFailure(cand.key, timeout ? "timeout" : "server", { status: err?.status ?? 0, message: err?.message ?? `stream ${info.reason}` }, settings);
    logOutcome(ctx, {
      status: "UPSTREAM_ERROR",
      httpStatus: timeout ? 504 : 502,
      errorCode: timeout ? "upstream_timeout" : "upstream_error",
      errorMessage: timeout ? "The upstream provider timed out." : "The upstream provider returned an error.",
      internalError: `stream ${info.reason}${err ? `: ${err.type ?? ""} ${err.message}` : ""}${info.error ? ` (${describeNetworkError(info.error)})` : ""}`,
      usage,
      ttftMs: info.firstOutputMs,
    });
  }
}

