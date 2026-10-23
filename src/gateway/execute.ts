import { logger } from "@/lib/logger";
import type { SettingValues } from "@/lib/settings";
import type { ConfigSnapshot } from "./cache";
import { getKeySecret } from "./cache";
import { logOutcome, releaseAll, releaseUpstream, withCommon, type Ctx } from "./context";
import { GatewayError, streamErrorEvent } from "./errors";
import { handleFilesOk, prepareRawUpstream, registerGeneratedFiles } from "./files";
import { generatedFilesOfAnthropicMessage, generatedFilesOfResponsesOutput } from "./generated-files";
import { finalError, type Failure } from "./failure";
import { forwardUpstreamHeaders } from "./headers";
import { classifyStatus, modelCooldownLeftSec, providerNoCooldown, recordKeyFailure, recordKeySuccess, type FailureKind } from "./keyhealth";
import { checkRpm, checkTpm, providerKeyDailyCost } from "./limits";
import { fileBytes } from "./multipart";
import type { StreamProcessor } from "./processor";
import { streamExceedsHold } from "./reserve";
import { rememberResponse } from "./responses-sticky";
import { buildCandidates, type Candidate, type RoutePlan } from "./select";
import {
  extractErrorMessage,
  extractUsage,
  inbandErrorDocument,
  maskResponse,
  mirrorErrorFromUpstream,
  parseRetryAfter,
  pickRateLimitHeaders,
  prepareUpstream,
  scrubText,
  type HeaderLike,
  type Prepared,
  type ScrubContext,
  clientErrorFromUpstream,
} from "./shape";
import { DriverClientError, DriverFailure, UpstreamHttpError, type Driver } from "./providers/driver-types";
import { makeDriverEnv } from "./providers/driver-env";
import { getDriver } from "./providers/drivers";
import { acquireSlots, trackQueued, waitForRelease, type SlotLease, type SlotPool } from "./slots";
import { StreamSession, type FinishInfo } from "./stream";
import { holdCommitAfterMs, isPreambleEvent } from "./stream-start";
import { canCollect, SseCollector } from "./stream-collect";
import { providerSettings, upstreamOp } from "./providers/adapters";
import { SseParser } from "./sse";
import { GeminiJsonArrayStream } from "./stream-gemini-array";
import { AnthropicStreamPassthrough, GeminiStreamPassthrough, OpenAIStreamPassthrough, ResponsesStreamPassthrough } from "./stream-processors";
import { countRequestTokens, countTokens } from "./tokenizer";
import { AnthropicToChatStream, ChatToAnthropicStream, THINKING_BURN_NOTE, chatResponseToMessages, chatUsageFromNormalized, messagesResponseToChat } from "./translate";
import { emptyUsage, type Json, type JsonObject, type Operation, type Usage } from "./types";
import { ClientAbortError, UpstreamTimeoutError, readErrorBody, readTextLimited, sendUpstream, wantsHttp2, type UpstreamHandle } from "./upstream";
import { assertPublicUrl, BlockedUrlError, hostOf } from "./ssrf";
import { finishVideoCreate, handleVideoCreateOk } from "./video";
import { describeNetworkError, isObject, safeJsonParse, sleep } from "./util";

export { finalError, type Failure } from "./failure";

const MAX_JSON_RESPONSE = 512 * 1024 * 1024;
const STREAM_OPS = new Set<Operation>(["chat", "completions", "responses", "messages", "gemini_stream"]);
const TOKEN_OPS = new Set<Operation>(["chat", "completions", "responses", "messages", "gemini_generate", "gemini_stream", "embeddings", "gemini_embed", "gemini_batch_embed"]);

export type AttemptResult =
  | { kind: "response"; response: Response }
  | { kind: "failure"; failure: Failure }
  | { kind: "client_error"; error: GatewayError };

export interface ExecOptions {
  /** Restrict to a single upstream key (Responses-API / Files stickiness). */
  pinKeyId?: string | null;
  /** Try this upstream key first when it is usable (affinity, not a pin). */
  preferKeyId?: string | null;
  maxAttempts?: number;
  responseId?: string;
  /** Video lookups: the UPSTREAM video id + raw query string (e.g. "variant=thumbnail"). */
  upstreamVideoId?: string;
  upstreamQuery?: string;
  /** Video content hosted outside the provider API (fal CDN): fetched as-is, without credentials. */
  externalUrl?: string;
}

const isFailoverStatus = (s: number) => s === 401 || s === 402 || s === 403 || s === 408 || s === 429 || s >= 500 || (s >= 300 && s < 400);
/** Upstream answers we hand to the client as they are (after our own pool failover): the upstream's own overload / rate-limit / server errors. */
const isMirrorStatus = (s: number) => s === 408 || s === 429 || (s >= 500 && s < 600);

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
 * A client that disconnects while queued leaves the queue at once (nothing is sent upstream).
 */
export async function execute(ctx: Ctx, routes: RoutePlan[], opts: ExecOptions = {}): Promise<Response> {
  const snap = ctx.snap!;
  const settings = snap.settings;
  const maxAttempts = opts.maxAttempts ?? settings.maxAttempts;
  const failures = new Map<string, number>();
  // (route, key) pairs that answered a "forbidden" 403: retrying them cannot help, other routes / keys still may
  const forbidden = new Set<string>();
  const signal = ctx.req.signal;
  let attemptsMade = 0;
  let lastFailure: Failure | null = null;
  let queueStart: number | null = null;
  let queued = false;
  let queueRecorded = false;

  try {
    for (;;) {
      if (signal.aborted) throw new GatewayError("client_closed");
      const built = buildCandidates(snap, routes, { failures, pinKeyId: opts.pinKeyId, preferKeyId: opts.preferKeyId });
      const cands = forbidden.size ? built.filter((c) => !forbidden.has(`${c.route.id}:${c.key.id}`)) : built;
      if (!cands.length) throw lastFailure ? finalError(lastFailure, settings) : (modelRateLimitedError(snap, routes) ?? noProviderError(snap, routes));

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

      // retrying a key that already failed in this request (a single-key provider, or the last one left): a short,
      // growing pause so a relay's transient "service unavailable" has a moment to clear
      const triedThisKey = failures.get(pick.cand.key.id) ?? 0;
      if (triedThisKey > 0) await sleep(Math.min(3000, 500 * triedThisKey) + Math.floor(Math.random() * 250), signal);

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
      if (f.fk === "forbidden") forbidden.add(`${pick.cand.route.id}:${pick.cand.key.id}`);
      if (f.fk === "auth" && !getKeySecret(pick.cand.key)) {
        recordKeyFailure(pick.cand.key, "auth", { status: f.status, message: f.message }, settings);
      } else {
        recordKeyFailure(pick.cand.key, f.fk, { status: f.status, message: f.message, retryAfterSec: f.retryAfterSec, startedAt: f.startedAt, noCooldown: providerNoCooldown(pick.cand.route.provider), model: pick.cand.route.upstreamModel }, settings);
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

/** Every usable key is rate-limited for this model (a relay's per-model limit): a 429 the client can retry. */
function modelRateLimitedError(snap: ConfigSnapshot, routes: RoutePlan[]): GatewayError | null {
  const pairs: Array<[string, string]> = [];
  for (const rp of routes) for (const k of snap.keysByProvider.get(rp.route.providerId) ?? []) pairs.push([k.id, rp.route.upstreamModel]);
  const left = modelCooldownLeftSec(pairs);
  if (left === null) return null;
  return new GatewayError("rate_limited", `Rate limit reached for this model upstream. Please retry in ${left}s.`, { retryAfterSec: left, internal: "every key is cooling down for this model after an upstream 429" });
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

// ------------------------------------------------------------------ one attempt
async function attempt(ctx: Ctx, cand: Candidate, settings: SettingValues, opts: ExecOptions): Promise<AttemptResult> {
  const t0 = Date.now();
  const { route, key } = cand;
  const provider = route.provider;
  const idempotencyKey = ctx.req.headers.get("idempotency-key")?.slice(0, 200) ?? undefined;
  const rec = (status: number, error?: string) =>
    ctx.attempts.push({ providerId: provider.id, providerKeyId: key.id, routeId: route.id, status, error: error?.slice(0, 300), latencyMs: Date.now() - t0, ...(idempotencyKey ? { idempotencyKey } : {}) });
  const fail = (fk: FailureKind, status: number, message: string, extra: Partial<Failure> = {}): AttemptResult => {
    rec(status, message);
    return { kind: "failure", failure: { fk, status, message, internal: message, startedAt: t0, ...extra } };
  };

  const secret = getKeySecret(key);
  if (!secret) return fail("auth", 0, "upstream key could not be decrypted");

  // providers whose API is not one OpenAI-shaped HTTP exchange (fal.ai, Replicate) run through a driver
  const driver = ctx.path!.raw ? null : getDriver(provider.preset, ctx.path!.op);
  if (driver) return runDriver(driver, ctx, cand, secret, t0, rec, fail);

  let prepared: Prepared;
  try {
    if (ctx.path!.raw) prepared = prepareRawUpstream(ctx, cand, secret);
    else {
      prepared = prepareUpstream({
        path: ctx.path!,
        cand,
        model: ctx.model!,
        body: ctx.body,
        jsonRaw: ctx.jsonRaw,
        form: ctx.form,
        stream: ctx.stream,
        inboundHeaders: ctx.req.headers,
        secret,
        responseId: opts.responseId ?? ctx.path!.responseId,
        videoId: opts.upstreamVideoId,
        query: opts.upstreamQuery,
        outputCap: ctx.funds?.injectOutput ?? null,
        fillOutput: ctx.funds?.fillOutput ?? null,
        forceStream: collectUpstream(ctx, cand),
      });
    }
    for (const n of prepared.notes ?? []) if (!ctx.notes.includes(n)) ctx.notes.push(n);
    if (opts.externalUrl) {
      try {
        await assertPublicUrl(opts.externalUrl, [hostOf(provider.baseUrl), hostOf(typeof provider.settings.queueBaseUrl === "string" ? provider.settings.queueBaseUrl : null)]);
      } catch {
        return fail("server", 0, "the video URL the upstream returned points to a private address (refused)");
      }
      const range = ctx.req.headers.get("range");
      prepared = { ...prepared, url: opts.externalUrl, headers: { accept: "*/*", "user-agent": "ProviderProxy/1.0", ...(range ? { range } : {}) } };
    }
  } catch (e) {
    if (e instanceof GatewayError) {
      rec(e.status, e.message);
      return { kind: "client_error", error: e };
    }
    throw e;
  }

  const http2 = wantsHttp2(provider);
  // a one-shot stream body (large upload) cannot be re-sent on the same connection attempt
  const replayable = prepared.body === null || typeof prepared.body === "string" || prepared.body instanceof Uint8Array;
  let h: UpstreamHandle;
  for (let tries = 0; ; tries++) {
    try {
      h = await sendUpstream({ url: prepared.url, method: prepared.method, headers: prepared.headers, body: prepared.body, timeoutMs: provider.timeoutMs, clientSignal: ctx.req.signal, http2 });
      break;
    } catch (err) {
      if (err instanceof ClientAbortError || ctx.req.signal.aborted) throw new GatewayError("client_closed");
      if (err instanceof UpstreamTimeoutError) return fail("timeout", 0, `no response within ${provider.timeoutMs}ms`);
      // connection could not even be established (nothing was sent): safe to retry once on the same key
      if (tries === 0 && replayable && isConnectError(err)) {
        await sleep(25 + Math.random() * 75, ctx.req.signal);
        continue;
      }
      return fail("network", 0, describeNetworkError(err));
    }
  }

  // media downloads may be answered with a redirect to a CDN: follow it once (credentials only to the same origin)
  if (ctx.path!.op === "videos_content" && [301, 302, 303, 307, 308].includes(h.res.status)) {
    const location = h.res.headers.get("location");
    h.dispose();
    if (location) {
      try {
        const target = new URL(location, prepared.url);
        const sameOrigin = target.origin === new URL(prepared.url).origin;
        if (!sameOrigin) await assertPublicUrl(target.toString(), [hostOf(provider.baseUrl)]);
        const range = ctx.req.headers.get("range");
        const headers: Record<string, string> = sameOrigin ? prepared.headers : { accept: "*/*", "user-agent": "ProviderProxy/1.0", ...(range ? { range } : {}) };
        h = await sendUpstream({ url: target.toString(), method: "GET", headers, timeoutMs: provider.timeoutMs, clientSignal: ctx.req.signal, http2 });
      } catch (err) {
        if (err instanceof ClientAbortError) throw new GatewayError("client_closed");
        if (err instanceof UpstreamTimeoutError) return fail("timeout", 0, `no response within ${provider.timeoutMs}ms`);
        if (err instanceof BlockedUrlError) return fail("server", 0, "the upstream redirected to a private address (refused)");
        return fail("network", 0, describeNetworkError(err));
      }
    }
  }

  const res = h.res;
  if (res.status >= 200 && res.status < 300) return handleOk(ctx, cand, prepared, h, t0, settings, rec, fail, secret);

  const errBody = await readErrorBody(res);
  h.dispose();
  return httpErrorResult(ctx, cand, secret, res.status, res.headers, errBody, t0, rec, prepared.upstreamFormat);
}

/** Classify a non-2xx upstream answer: failover-worthy failure, or a client error passed through (scrubbed). */
function httpErrorResult(
  ctx: Ctx,
  cand: Candidate,
  secret: string,
  status: number,
  headers: HeaderLike,
  errBody: string,
  t0: number,
  rec: Rec,
  upstreamFormat: Prepared["upstreamFormat"],
): AttemptResult {
  const message = extractErrorMessage(errBody) || `HTTP ${status}`;
  rec(status, message);
  const inbound = ctx.path!.format === "catalog" ? "openai_chat" : ctx.path!.format;
  if (isFailoverStatus(status)) {
    return {
      kind: "failure",
      failure: {
        fk: classifyStatus(status, message),
        status,
        message,
        retryAfterSec: parseRetryAfter(headers),
        rlHeaders: pickRateLimitHeaders(headers),
        internal: errBody.slice(0, 2000),
        startedAt: t0,
        // what the client receives if this turns out to be the last attempt: the upstream's own answer
        mirror: isMirrorStatus(status) ? mirrorErrorFromUpstream(status, errBody, headers, inbound, upstreamFormat, scrubCtx(ctx, cand, secret), { rateLimits: ctx.snap!.settings.passUpstreamRateLimits }) : undefined,
      },
    };
  }
  return { kind: "client_error", error: clientErrorFromUpstream(status, errBody, inbound, upstreamFormat, scrubCtx(ctx, cand, secret)) };
}

/** Run a provider driver (fal.ai / Replicate): one logical upstream call that may submit, poll and download. */
async function runDriver(driver: Driver, ctx: Ctx, cand: Candidate, secret: string, t0: number, rec: Rec, fail: Fail): Promise<AttemptResult> {
  const env = makeDriverEnv(ctx, cand, secret, t0);
  try {
    const out = await driver.run(env);
    if (ctx.path!.op === "videos_create") return await finishVideoCreate({ ctx, cand, up: out.body as JsonObject, meta: out.meta ?? {}, t0, rec });
    rec(out.status);
    recordKeySuccess(cand.key);
    logOutcome(ctx, { status: "SUCCESS", httpStatus: out.status, usage: out.usage, ttftMs: Date.now() - t0, responseBody: ctx.logBodies ? out.body : undefined });
    return { kind: "response", response: withCommon(ctx, new Response(JSON.stringify(out.body), { status: out.status, headers: jsonHeaders(ctx) })) };
  } catch (e) {
    if (e instanceof ClientAbortError) throw new GatewayError("client_closed");
    if (e instanceof DriverFailure) return fail(e.fk, e.status, e.message, e.internal ? { internal: e.internal } : {});
    if (e instanceof DriverClientError) {
      rec(e.status, e.message);
      return { kind: "client_error", error: new GatewayError(e.code, e.message, { status: e.status, param: e.param ?? null, kind: e.opts.kind ?? "client", internal: e.opts.internal }) };
    }
    // 422 (validation) is reported as a plain 400, like OpenAI's image API
    if (e instanceof UpstreamHttpError) return httpErrorResult(ctx, cand, secret, e.status === 422 ? 400 : e.status, e.headers, e.body, t0, rec, "openai_images");
    throw e;
  }
}

/** Errors raised before any byte of the request reached the upstream (retry-safe). */
function isConnectError(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "UND_ERR_CONNECT_TIMEOUT";
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

export type Rec = (status: number, error?: string) => number;
export type Fail = (fk: FailureKind, status: number, message: string, extra?: Partial<Failure>) => AttemptResult;

// ------------------------------------------------------------------ successful upstream response
/**
 * Provider option `streamUpstream`: a non-streaming chat / responses / messages request goes upstream as a stream and the
 * reply is assembled back into JSON (stream-collect.ts). Keeps long generations alive through relays with a read timeout
 * on silent requests, and makes every failure before the end retryable (the client has received nothing yet).
 */
function collectUpstream(ctx: Ctx, cand: Candidate): boolean {
  if (ctx.stream || ctx.path!.raw || cand.route.provider.settings.streamUpstream !== true) return false;
  const op = ctx.path!.op;
  if (op !== "chat" && op !== "responses" && op !== "messages") return false;
  return canCollect(cand.plan.upstream, upstreamOp(op, cand.plan.upstream));
}

/** Read an upstream SSE reply to the end and assemble it into the provider's JSON document (see collectUpstream). */
async function handleCollected(ctx: Ctx, cand: Candidate, prepared: Prepared, h: UpstreamHandle, t0: number, settings: SettingValues, rec: Rec, fail: Fail): Promise<AttemptResult> {
  const body = h.res.body as ReadableStream<Uint8Array> | null;
  if (!body) {
    h.dispose();
    return fail("server", 200, "empty upstream stream");
  }
  const collector = new SseCollector(prepared.upstreamFormat);
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const idleMs = idleMsFor(cand, settings);
  let idle: NodeJS.Timeout | null = idleMs > 0 ? setTimeout(() => h.abort(new UpstreamTimeoutError("idle")), idleMs) : null;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      idle?.refresh();
      const events = done ? [...parser.push(decoder.decode()), ...parser.end()] : parser.push(decoder.decode(value, { stream: true }));
      for (const ev of events) collector.push(ev);
      if (done) break;
    }
  } catch (err) {
    if (ctx.req.signal.aborted || err instanceof ClientAbortError || h.signal.reason instanceof ClientAbortError) throw new GatewayError("client_closed");
    if (h.signal.reason instanceof UpstreamTimeoutError) return fail("timeout", 0, "assembled stream: upstream went silent");
    return fail("network", 0, `assembled stream broke: ${describeNetworkError(err)}`);
  } finally {
    if (idle) clearTimeout(idle);
    idle = null;
    h.dispose();
  }
  const r = collector.result();
  if (!r.ok && !isFailoverStatus(r.status)) {
    rec(r.status, r.message);
    const inbound = ctx.path!.format === "catalog" ? "openai_chat" : ctx.path!.format;
    return { kind: "client_error", error: clientErrorFromUpstream(r.status, inbandErrorDocument(prepared.upstreamFormat, r), inbound, prepared.upstreamFormat, scrubCtx(ctx, cand, getKeySecret(cand.key) ?? "")) };
  }
  if (!r.ok) return fail(classifyStatus(r.status, r.message), r.status, r.message, { internal: `assembled stream: ${r.message}` });
  return handleJson(ctx, cand, prepared, h, t0, rec, fail, JSON.stringify(r.json));
}

async function handleOk(ctx: Ctx, cand: Candidate, prepared: Prepared, h: UpstreamHandle, t0: number, settings: SettingValues, rec: Rec, fail: Fail, secret: string): Promise<AttemptResult> {
  const path = ctx.path!;
  const ct = h.res.headers.get("content-type") ?? "";
  const isSse = ct.includes("text/event-stream");
  if (prepared.collect && isSse) return handleCollected(ctx, cand, prepared, h, t0, settings, rec, fail);

  if (path.raw) return handleFilesOk(ctx, cand, h, t0, rec, fail);
  if (path.op === "videos_create") return handleVideoCreateOk({ ctx, cand, h, t0, rec, fail });
  if (path.op === "videos_content") return handleBinary(ctx, cand, h, t0, rec, true);

  if (ctx.stream && STREAM_OPS.has(path.op)) {
    if (!isSse) {
      const body = await readErrorBody(h.res);
      h.dispose();
      return fail("server", 200, `expected an event stream, got ${ct || "no content-type"}`, { internal: body.slice(0, 1000) });
    }
    return handleStream(ctx, cand, prepared, h, t0, settings, rec, fail, secret);
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

/**
 * Fill what the upstream did not report: prompt / completion tokens (tokenizer estimate, `estimated`), reasoning tokens of
 * a model that thought without itemizing them (estimated from the thinking text: informational only, thinking is
 * already inside the output tokens), and the server-tool policy.
 */
async function completeUsage(ctx: Ctx, usage: Usage | null, outputText: string, op: Operation, thinkingText = ""): Promise<Usage> {
  if (!TOKEN_OPS.has(op)) return usage ?? emptyUsage();
  const needInput = !usage || usage.inputTokens === 0;
  const needOutput = op !== "embeddings" && op !== "gemini_embed" && op !== "gemini_batch_embed" && (!usage || usage.outputTokens === 0) && outputText.length > 0;
  const needReasoning = !!usage && usage.reasoningTokens === 0 && thinkingText.length > 0;
  if (!needInput && !needOutput && !needReasoning) return applyToolPolicy(ctx, usage!);
  const u: Usage = usage ? { ...usage } : emptyUsage();
  if (needInput || needOutput) u.estimated = true;
  if (needInput) u.inputTokens = await countRequestTokens(ctx.body ?? {});
  if (needOutput) u.outputTokens = await countTokens(outputText);
  if (needReasoning) {
    u.reasoningTokens = Math.min(await countTokens(thinkingText), u.outputTokens || Number.MAX_SAFE_INTEGER);
    u.reasoningEstimated = true;
  }
  return applyToolPolicy(ctx, u);
}

/** web_search_2026* / web_fetch_2026* in the request: Anthropic runs code execution for free next to them (dynamic filtering). */
function declaresFreeCodeExecution(body: JsonObject | null): boolean {
  const tools = body && Array.isArray(body.tools) ? body.tools : [];
  return tools.some((t: Json) => isObject(t) && typeof t.type === "string" && /^web_(search|fetch)_20(2[6-9]|[3-9]\d)/.test(t.type));
}

/** Server-tool billing rules that depend on the request (not just the usage the upstream reported). */
function applyToolPolicy(ctx: Ctx, usage: Usage): Usage {
  if (!usage.toolUsage?.code_execution_hour || !declaresFreeCodeExecution(ctx.body)) return usage;
  const toolUsage = { ...usage.toolUsage };
  delete toolUsage.code_execution_hour;
  return { ...usage, toolUsage };
}

async function handleJson(ctx: Ctx, cand: Candidate, prepared: Prepared, h: UpstreamHandle, t0: number, rec: Rec, fail: Fail, assembled?: string): Promise<AttemptResult> {
  const path = ctx.path!;
  const provider = cand.route.provider;
  const settings = ctx.snap!.settings;
  let text: string;
  if (assembled !== undefined) text = assembled;
  else {
    const timer = setTimeout(() => h.abort(new UpstreamTimeoutError("idle")), provider.timeoutMs);
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
  }

  const parsed = safeJsonParse<Json>(text);
  const publicName = publicModelName(ctx, cand);
  const mask = ctx.model?.maskUpstreamModel ?? true;
  const fwd = (base: Headers): Headers => {
    forwardUpstreamHeaders(h.res.headers, base, { rateLimits: settings.passUpstreamRateLimits });
    return base;
  };

  // non-JSON success bodies are legitimate only for audio transcription formats (text / srt / vtt)
  if (parsed === undefined) {
    if ((path.op === "audio_transcriptions" || path.op === "audio_translations") && h.res.status === 200) {
      const u = emptyUsage();
      u.audioSeconds = ctx.form ? Math.max(1, Math.round(fileBytes(ctx.form) / 16_000)) : 0;
      u.estimated = true;
      rec(200);
      recordKeySuccess(cand.key);
      logOutcome(ctx, { status: "SUCCESS", httpStatus: 200, usage: u, ttftMs: Date.now() - t0 });
      const hdr = fwd(new Headers({ "content-type": h.res.headers.get("content-type") ?? "text/plain; charset=utf-8", "x-request-id": ctx.requestId }));
      return { kind: "response", response: withCommon(ctx, new Response(text, { status: 200, headers: hdr })) };
    }
    return fail("server", 200, "upstream returned a non-JSON response", { internal: text.slice(0, 1000) });
  }

  // some relays answer 200 with an error document: treat it as an upstream failure (failover) instead of passing it on
  if (isObject(parsed) && isObject(parsed.error) && ["chat", "completions", "messages", "responses", "embeddings"].includes(path.op) && parsed.choices === undefined && parsed.content === undefined && parsed.output === undefined && parsed.data === undefined) {
    const code = Number(parsed.error.code);
    const status = code >= 400 && code < 600 ? code : parsed.error.type === "overloaded_error" ? 529 : parsed.error.type === "rate_limit_error" ? 429 : 502;
    return fail(classifyStatus(status, extractErrorMessage(text)), status, extractErrorMessage(text) || "upstream error in a 200 response", { internal: text.slice(0, 1000), mirror: isMirrorStatus(status) ? mirrorErrorFromUpstream(status, text, h.res.headers, ctx.path!.format === "catalog" ? "openai_chat" : ctx.path!.format, prepared.upstreamFormat, scrubCtx(ctx, cand, getKeySecret(cand.key) ?? ""), { rateLimits: settings.passUpstreamRateLimits }) : undefined });
  }

  let out: Json = parsed;
  let usage: Usage | null;
  let burned = false;
  if (cand.plan.mode === "chat_to_messages") {
    if (!isObject(parsed)) return fail("server", 200, "unexpected upstream response shape");
    const t = messagesResponseToChat(parsed, publicName);
    out = t.body;
    usage = t.usage;
    burned = t.burned;
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
  const finalUsage = await completeUsage(ctx, usage, outText, path.op, usage && usage.reasoningTokens === 0 ? collectThinkingText(parsed) : "");
  if (ctx.form && (path.op === "audio_transcriptions" || path.op === "audio_translations") && finalUsage.audioSeconds === 0 && finalUsage.inputTokens === 0) {
    finalUsage.audioSeconds = Math.max(1, Math.round(fileBytes(ctx.form) / 16_000));
    finalUsage.estimated = true;
  }

  // translated Claude answer: the reasoning tokens (itemized or estimated from the thinking text) belong in the chat usage too
  if (cand.plan.mode === "chat_to_messages" && isObject(out) && finalUsage.reasoningTokens > 0) out.usage = chatUsageFromNormalized(finalUsage);
  if (burned) ctx.notes.push(THINKING_BURN_NOTE);

  // files the upstream created for this request (code execution outputs ...): owned by the caller, pinned to the account that served it
  if (cand.plan.mode === "native" && isObject(parsed)) {
    const generated = path.op === "messages" ? generatedFilesOfAnthropicMessage(parsed) : path.op === "responses" ? generatedFilesOfResponsesOutput(parsed.output) : [];
    if (generated.length) await registerGeneratedFiles(ctx, cand, generated);
  }

  // Responses: remember which account owns the response id (GET/DELETE/previous_response_id stickiness)
  if ((path.op === "responses") && isObject(parsed) && typeof parsed.id === "string" && ctx.auth && ctx.model) {
    void rememberResponse(parsed.id, { userId: ctx.auth.user.id, providerId: cand.route.providerId, providerKeyId: cand.key.id, routeId: cand.route.id, modelId: ctx.model.id });
  }

  rec(200);
  recordKeySuccess(cand.key);
  logOutcome(ctx, { status: "SUCCESS", httpStatus: 200, usage: finalUsage, ttftMs: Date.now() - t0, responseBody: ctx.logBodies ? out : undefined });
  const outHeaders = fwd(jsonHeaders(ctx));
  if (burned) outHeaders.set("x-reasoning-budget-exhausted", "true");
  return { kind: "response", response: withCommon(ctx, new Response(JSON.stringify(out), { status: 200, headers: outHeaders })) };
}

/** Thinking text of an Anthropic Messages response (the `thinking` content blocks). */
function collectThinkingText(json: Json): string {
  if (!isObject(json) || !Array.isArray(json.content)) return "";
  return json.content.map((b: Json) => (isObject(b) && b.type === "thinking" && typeof b.thinking === "string" ? b.thinking : "")).filter(Boolean).join("\n");
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

/** Idle cutoff for streams: off unless the admin set one (provider.settings.idleTimeoutSec, else the global setting). */
function idleMsFor(cand: Candidate, settings: SettingValues): number {
  const own = cand.route.provider.settings.idleTimeoutSec;
  const sec = typeof own === "number" && own >= 0 ? own : settings.upstreamIdleTimeoutSec;
  return sec > 0 ? Math.round(sec * 1000) : 0;
}

// ------------------------------------------------------------------ binary passthrough (audio, media, file content)
export async function handleBinary(ctx: Ctx, cand: Candidate, h: UpstreamHandle, t0: number, rec: Rec, passthrough = false): Promise<AttemptResult> {
  const path = ctx.path!;
  const settings = ctx.snap!.settings;
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
    return { kind: "response", response: withCommon(ctx, new Response(null, { status: passthrough ? h.res.status : 200, headers: { "content-type": ct, "x-request-id": ctx.requestId } })) };
  }
  const session = new StreamSession({
    body,
    processor: null,
    abort: h.abort,
    signal: h.signal,
    idleTimeoutMs: idleMsFor(cand, settings),
    startedAt: t0,
    expectedBytes: knownLength(h),
    onFinish: (info) => {
      h.dispose();
      releaseAll(ctx);
      const u = emptyUsage();
      if (path.op === "audio_speech" && ctx.body && typeof ctx.body.input === "string") u.characters = ctx.body.input.length;
      finishLog(ctx, cand, info, u, "binary");
    },
  });
  const hdr = new Headers({ "content-type": ct, "cache-control": "no-store", "x-request-id": ctx.requestId });
  forwardUpstreamHeaders(h.res.headers, hdr, { rateLimits: settings.passUpstreamRateLimits, media: passthrough });
  if (passthrough) {
    // media downloads (video / file content): keep length semantics so players and downloaders can seek and resume
    const encoded = !!h.res.headers.get("content-encoding");
    const len = h.res.headers.get("content-length");
    if (len && !encoded) hdr.set("content-length", len);
  }
  return { kind: "response", response: withCommon(ctx, new Response(session.toReadable(), { status: passthrough ? h.res.status : 200, headers: hdr })) };
}

/** Announced body length of an upstream response that is passed on as it is (undefined when unknown or content-encoded). */
function knownLength(h: UpstreamHandle): number | undefined {
  if (h.res.headers.get("content-encoding")) return undefined;
  const len = Number(h.res.headers.get("content-length"));
  return Number.isFinite(len) && len >= 0 && h.res.headers.get("content-length") !== null ? len : undefined;
}

/** RequestLog for a finished non-SSE body stream (binary downloads). */
export function finishLog(ctx: Ctx, cand: Candidate, info: FinishInfo, usage: Usage, what: string): void {
  const base = { usage, ttftMs: info.firstOutputMs };
  switch (info.reason) {
    case "completed":
      logOutcome(ctx, { ...base, status: "SUCCESS", httpStatus: 200 });
      break;
    case "cancelled":
      logOutcome(ctx, { ...base, status: "CANCELLED", httpStatus: 499, errorCode: "client_closed", errorMessage: "Client closed the request." });
      break;
    case "gateway_error":
      logger.error("GATEWAY_ERROR", { requestId: ctx.requestId, what, err: describeNetworkError(info.error) });
      logOutcome(ctx, { ...base, status: "GATEWAY_ERROR", httpStatus: 500, errorCode: "internal_error", errorMessage: "Internal server error.", internalError: `${what} stream processing failed: ${describeNetworkError(info.error)}` });
      break;
    case "timeout":
      recordKeyFailure(cand.key, "timeout", { status: 0, message: `${what} stream idle timeout`, noCooldown: providerNoCooldown(cand.route.provider) }, ctx.snap!.settings);
      logOutcome(ctx, { ...base, status: "UPSTREAM_ERROR", httpStatus: 504, errorCode: "upstream_timeout", errorMessage: "The upstream provider timed out.", internalError: `${what} stream idle timeout; client connection dropped` });
      break;
    default:
      recordKeyFailure(cand.key, "server", { status: 0, message: `${what} stream ${info.reason}`, noCooldown: providerNoCooldown(cand.route.provider) }, ctx.snap!.settings);
      logOutcome(ctx, { ...base, status: "UPSTREAM_ERROR", httpStatus: 502, errorCode: "upstream_error", errorMessage: "The upstream provider returned an error.", internalError: `${what} stream ${info.reason}; client connection dropped: ${describeNetworkError(info.error)}` });
  }
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
    case "openai_responses": {
      const max = ctx.body && typeof ctx.body.max_output_tokens === "number" ? ctx.body.max_output_tokens : null;
      return new ResponsesStreamPassthrough(mask, { maxOutputTokens: max, enforceMaxOutputTokens: providerSettings(cand.route.provider).enforceMaxOutputTokens });
    }
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

async function handleStream(ctx: Ctx, cand: Candidate, prepared: Prepared, h: UpstreamHandle, t0: number, settings: SettingValues, rec: Rec, fail: Fail, secret: string): Promise<AttemptResult> {
  const body = h.res.body as ReadableStream<Uint8Array> | null;
  if (!body) {
    h.dispose();
    return fail("server", 200, "empty upstream stream");
  }
  const processor = makeProcessor(ctx, cand);
  const sc = scrubCtx(ctx, cand, secret);
  processor.setScrub?.((t) => scrubText(t, sc));
  // files the upstream creates while streaming (code execution outputs) become downloadable the moment the client sees their id
  processor.onGeneratedFiles = (files) => void registerGeneratedFiles(ctx, cand, files);
  const sse = !geminiJsonArray(ctx);
  const heartbeatMs = sse ? Math.max(0, settings.streamHeartbeatSec) * 1000 : 0;
  const session = new StreamSession({
    body,
    processor,
    abort: h.abort,
    signal: h.signal,
    idleTimeoutMs: idleMsFor(cand, settings),
    heartbeatMs,
    startedAt: t0,
    isPreamble: (ev) => isPreambleEvent(prepared.upstreamFormat, ev),
    guard: ctx.funds?.outputTokens
      ? {
          exceeded: () => streamExceedsHold(ctx, processor),
          events: () => {
            const f = ctx.funds!;
            f.cut = true;
            const ev = budgetCutEvent(ctx);
            return processor.abortEvents ? processor.abortEvents(ev) : [ev];
          },
        }
      : undefined,
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
    // Before anything is sent to the client a failure fails over (next key, or a fresh attempt on the same one). The
    // response is held until real output arrives - opening bookkeeping events do not count - for up to
    // streamStartHoldSec (counted from the request's arrival, across retries); after that it is committed anyway
    // (200 + SSE headers) and heartbeats keep the client alive.
    await session.prime({ commitAfterMs: heartbeatMs > 0 ? holdCommitAfterMs(heartbeatMs, settings.streamStartHoldSec, ctx.startedAt) : undefined });
  } catch (err) {
    // classify BEFORE aborting: h.abort() itself sets the abort reason
    const reason = h.signal.reason;
    const clientGone = ctx.req.signal.aborted || reason instanceof ClientAbortError;
    session.discard();
    h.abort();
    h.dispose();
    if (clientGone) throw new GatewayError("client_closed");
    if (reason instanceof UpstreamTimeoutError) return fail("timeout", 0, "timed out waiting for the first stream event");
    return fail("network", 0, `stream failed before first event: ${describeNetworkError(err)}`);
  }
  const inband = processor.error();
  if (inband && session.firstEventError) {
    // an error before any output: fail over; if every key answers like that the client gets the upstream's error as an HTTP error
    session.discard();
    h.abort();
    h.dispose();
    const inboundFmt = ctx.path!.format === "catalog" ? "openai_chat" : ctx.path!.format;
    if (!isFailoverStatus(inband.status)) {
      // the request itself is wrong (invalid / unsupported parameter): every retry would fail the same way
      rec(inband.status, inband.message);
      return { kind: "client_error", error: clientErrorFromUpstream(inband.status, inbandErrorDocument(prepared.upstreamFormat, inband), inboundFmt, prepared.upstreamFormat, sc) };
    }
    const mirrorable = isMirrorStatus(inband.status);
    return fail(classifyStatus(inband.status, inband.message), inband.status, inband.message, {
      internal: `in-band stream error: ${inband.type ?? ""} ${inband.message}`,
      mirror: mirrorable
        ? mirrorErrorFromUpstream(inband.status, inbandErrorDocument(prepared.upstreamFormat, inband), {}, ctx.path!.format === "catalog" ? "openai_chat" : ctx.path!.format, prepared.upstreamFormat, sc, { rateLimits: settings.passUpstreamRateLimits })
        : undefined,
    });
  }
  if (session.isEmpty()) {
    session.discard();
    h.dispose();
    return fail("server", 200, "upstream closed the stream before producing any output");
  }

  rec(200);
  recordKeySuccess(cand.key); // the upstream answered: clear transient failure state now, not at the end of a long stream
  ctx.deferRelease = true;
  const headers = new Headers({
    "content-type": sse ? "text/event-stream; charset=utf-8" : "application/json; charset=UTF-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    "x-request-id": ctx.requestId,
  });
  if (sse) headers.set("connection", "keep-alive");
  forwardUpstreamHeaders(h.res.headers, headers, { rateLimits: settings.passUpstreamRateLimits });
  return { kind: "response", response: withCommon(ctx, new Response(session.toReadable(), { status: 200, headers })) };
}

/** The ONE event we author ourselves mid-stream: the credit hold is used up (PLAN 9c). */
function budgetCutEvent(ctx: Ctx): string {
  const ge = new GatewayError("insufficient_balance", "Your available balance was used up while the response was streaming. Add credit to continue.");
  return streamErrorEvent(ctx.errorFormat, ge, ctx.requestId);
}

async function finalizeStream(ctx: Ctx, cand: Candidate, processor: StreamProcessor, info: FinishInfo, settings: SettingValues): Promise<void> {
  const path = ctx.path!;
  const reported = processor.usage();
  let usage = await completeUsage(ctx, reported, processor.outputText(), path.op, processor.reasoningText?.() ?? "");
  // a stream that did not reach its end has no final usage (Anthropic reports output_tokens: 1 in message_start and
  // the real count only in message_delta): bill at least what the client received
  if (info.reason !== "completed" && TOKEN_OPS.has(path.op)) {
    const seen = await countTokens(processor.outputText());
    if (seen > usage.outputTokens) usage = { ...usage, outputTokens: seen, estimated: true };
  }

  const streamNote = processor.note?.();
  if (streamNote) ctx.notes.push(streamNote);
  const generated = processor.generatedFiles?.() ?? [];
  if (generated.length) await registerGeneratedFiles(ctx, cand, generated); // (idempotent final pass)

  const rid = processor.responseId?.();
  if (rid && ctx.auth && ctx.model) {
    void rememberResponse(rid, { userId: ctx.auth.user.id, providerId: cand.route.providerId, providerKeyId: cand.key.id, routeId: cand.route.id, modelId: ctx.model.id });
  }

  const err = processor.error();
  if (info.reason === "completed") {
    recordKeySuccess(cand.key);
    logOutcome(ctx, { status: "SUCCESS", httpStatus: 200, usage, ttftMs: info.firstOutputMs });
  } else if (info.reason === "budget") {
    recordKeySuccess(cand.key);
    logOutcome(ctx, {
      status: "CLIENT_ERROR",
      httpStatus: 402,
      errorCode: "insufficient_balance",
      errorMessage: "The response was cut off because the available balance was used up.",
      internalError: `funds: stream cut at the credit hold (${ctx.funds?.outputTokens ?? "?"} reserved output tokens); the output produced was metered`,
      usage,
      ttftMs: info.firstOutputMs,
      billable: true,
    });
  } else if (info.reason === "cancelled") {
    logOutcome(ctx, { status: "CANCELLED", httpStatus: 499, errorCode: "client_closed", errorMessage: "Client closed the request.", usage, ttftMs: info.firstOutputMs });
  } else if (info.reason === "gateway_error") {
    logger.error("GATEWAY_ERROR", { requestId: ctx.requestId, endpoint: path.endpoint, err: describeNetworkError(info.error) });
    logOutcome(ctx, {
      status: "GATEWAY_ERROR",
      httpStatus: 500,
      errorCode: "internal_error",
      errorMessage: "Internal server error.",
      internalError: `stream processing failed after the response was committed (upstream aborted, client connection dropped): ${describeNetworkError(info.error)}`,
      usage,
      ttftMs: info.firstOutputMs,
    });
  } else if (info.inband && err) {
    // the upstream sent an error EVENT (forwarded verbatim) and ended the stream: the client saw exactly that
    recordKeyFailure(cand.key, classifyStatus(err.status, err.message), { status: err.status, message: err.message, noCooldown: providerNoCooldown(cand.route.provider) }, settings);
    logOutcome(ctx, {
      status: "UPSTREAM_ERROR",
      httpStatus: err.status >= 400 ? err.status : 502,
      errorCode: err.status === 429 ? "rate_limited" : err.status === 529 ? "upstream_overloaded" : "upstream_error",
      errorMessage: "The upstream provider returned an error.",
      internalError: `in-stream error event forwarded verbatim: ${err.type ?? ""} ${err.message}`,
      usage,
      ttftMs: info.firstOutputMs,
    });
  } else {
    // upstream reset / dropped / ended early / stalled: the client connection was destroyed the same way
    const timeout = info.reason === "timeout";
    recordKeyFailure(cand.key, timeout ? "timeout" : "server", { status: 0, message: `stream ${info.reason}`, noCooldown: providerNoCooldown(cand.route.provider) }, settings);
    logOutcome(ctx, {
      status: "UPSTREAM_ERROR",
      httpStatus: timeout ? 504 : 502,
      errorCode: timeout ? "upstream_timeout" : "upstream_error",
      errorMessage: timeout ? "The upstream provider timed out." : "The upstream provider returned an error.",
      internalError: `stream ${info.reason}: upstream ${timeout ? "stalled" : "connection broke"} after the response started; client connection dropped${info.error ? ` (${describeNetworkError(info.error)})` : ""}`,
      usage,
      ttftMs: info.firstOutputMs,
    });
  }
}
