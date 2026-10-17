import { getClientIp } from "@/lib/http";
import { logger } from "@/lib/logger";
import { authenticate } from "./auth";
import { resolveModel } from "./cache";
import { getConfig } from "./cache";
import { catalogResponse } from "./catalog";
import { corsHeaders, failWith, logOutcome, newCtx, releaseAll, withCommon, type Ctx } from "./context";
import { execute } from "./execute";
import { GatewayError, toGatewayError } from "./errors";
import { checkRpm, checkTpm } from "./limits";
import { getField, parseMultipart } from "./multipart";
import { guessErrorFormat, parsePath } from "./path";
import { effectiveMultiplier } from "./pricing";
import { closeFunds, reserveFunds } from "./reserve";
import { validateRequest } from "./validate";
import { lookupResponse } from "./responses-sticky";
import { eligibleRoutes, orderRoutes, type RoutePlan } from "./select";
import { acquireSlots, type SlotPool } from "./slots";
import { countRequestTokens } from "./tokenizer";
import { emptyUsage, type Json, type Operation } from "./types";
import { isObject, newId, safeJsonParse } from "./util";
import { videoContentPlan, videoDelete, videoGet, videoList } from "./video";

export { guessErrorFormat, parsePath } from "./path";

const MAX_JSON_BODY = 20 * 1024 * 1024;
const MAX_MULTIPART_BODY = 50 * 1024 * 1024;
const STREAMABLE = new Set<Operation>(["chat", "completions", "responses", "messages", "gemini_stream"]);

/**
 * Gateway entry point: `handle(Request) => Response` (framework agnostic). Never throws.
 * Pipeline = PLAN 5 steps 1-14 + 9b: request id -> path -> auth -> customer slots -> body/model -> limits ->
 * balance -> route/key selection with upstream slots + failover -> response/stream -> metering.
 */
export async function handle(req: Request): Promise<Response> {
  const ctx = newCtx(req, newId(), getClientIp(req.headers));
  try {
    if (req.method === "OPTIONS") return preflight(ctx);
    const res = await run(ctx);
    if (!ctx.deferRelease) {
      releaseAll(ctx);
      closeFunds(ctx); // safety net: normally the hold was settled when the request was logged
    }
    return res;
  } catch (e) {
    if (!(e instanceof GatewayError)) logger.error("gateway internal error", { requestId: ctx.requestId, err: e });
    try {
      return failWith(ctx, toGatewayError(e));
    } catch (e2) {
      logger.error("gateway failWith crashed", { requestId: ctx.requestId, err: e2 });
      releaseAll(ctx);
      closeFunds(ctx);
      return new Response(JSON.stringify({ error: { message: "Internal server error.", type: "server_error", code: "internal_error", param: null } }), {
        status: 500,
        headers: { "content-type": "application/json", "x-request-id": ctx.requestId },
      });
    }
  }
}

function preflight(ctx: Ctx): Response {
  const h = ctx.req.headers;
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(),
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": h.get("access-control-request-headers") ?? "authorization, content-type, x-api-key, x-goog-api-key, anthropic-version, anthropic-beta, openai-beta",
      "access-control-max-age": "86400",
      "x-request-id": ctx.requestId,
    },
  });
}

async function run(ctx: Ctx): Promise<Response> {
  ctx.errorFormat = guessErrorFormat(ctx.url.pathname);
  ctx.path = parsePath(ctx.url.pathname, ctx.req.method);
  ctx.errorFormat = ctx.path.errorFormat;
  if (ctx.req.signal.aborted) throw new GatewayError("client_closed");

  const snap = (ctx.snap = await getConfig());
  ctx.logBodies = snap.settings.logBodies;
  await authenticate(ctx);
  await acquireCustomerSlots(ctx);

  const path = ctx.path;
  if (path.format === "catalog") {
    const { body } = catalogResponse(ctx);
    logOutcome(ctx, { status: "SUCCESS", httpStatus: 200, usage: emptyUsage() });
    return withCommon(ctx, new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }));
  }

  if (path.op.startsWith("responses_")) return dispatchResponsesLookup(ctx);
  if (path.op.startsWith("videos_") && path.op !== "videos_create") return dispatchVideoLookup(ctx);

  await readBody(ctx);
  resolveRequestModel(ctx);
  validateRequest(ctx);
  await checkLimits(ctx);
  await reserveFunds(ctx);
  return dispatch(ctx);
}

// ------------------------------------------------------------------ customer concurrency
async function acquireCustomerSlots(ctx: Ctx): Promise<void> {
  const { key, user } = ctx.auth!;
  const group = ctx.group;
  const pools: SlotPool[] = [];
  if (key.maxConcurrency) pools.push({ kind: "key", id: key.id, max: key.maxConcurrency });
  if (user.maxConcurrency) pools.push({ kind: "user", id: user.id, max: user.maxConcurrency });
  if (group?.maxConcurrency) pools.push({ kind: "group", id: group.id, max: group.maxConcurrency });
  if (!pools.length) pools.push({ kind: "user", id: user.id, max: ctx.snap!.settings.defaultCustomerConcurrency });
  const r = await acquireSlots(pools);
  if (!r.ok) {
    throw new GatewayError("rate_limited", "Too many concurrent requests. Please retry shortly.", {
      retryAfterSec: 1,
      internal: `customer concurrency limit reached (${pools[r.fullIndex]?.kind ?? "?"} pool, max ${pools[r.fullIndex]?.max ?? "?"})`,
    });
  }
  ctx.customerLease = r.lease;
}

// ------------------------------------------------------------------ body
async function readLimited(req: Request, limit: number): Promise<Buffer> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new GatewayError("payload_too_large", `Request body exceeds the ${Math.round(limit / 1048576)}MB limit.`);
  const body = req.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let r: ReadableStreamReadResult<Uint8Array>;
    try {
      r = await reader.read();
    } catch {
      throw new GatewayError("client_closed");
    }
    if (r.done) break;
    total += r.value.byteLength;
    if (total > limit) {
      reader.cancel().catch(() => undefined);
      throw new GatewayError("payload_too_large", `Request body exceeds the ${Math.round(limit / 1048576)}MB limit.`);
    }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks);
}

async function readBody(ctx: Ctx): Promise<void> {
  const path = ctx.path!;
  const req = ctx.req;
  const contentType = req.headers.get("content-type") ?? "";
  // POST /v1/videos takes JSON or multipart (input_reference file)
  const multipart = path.multipart || (path.op === "videos_create" && /multipart\/form-data/i.test(contentType));
  if (multipart) {
    const ct = contentType;
    if (!/multipart\/form-data/i.test(ct)) throw new GatewayError("invalid_request", "Content-Type must be multipart/form-data.");
    const buf = await readLimited(req, MAX_MULTIPART_BODY);
    try {
      ctx.form = await parseMultipart(buf, ct);
    } catch {
      throw new GatewayError("invalid_request", "Could not parse the multipart form body.");
    }
    return;
  }
  const buf = await readLimited(req, MAX_JSON_BODY);
  if (!buf.length) {
    if (path.op === "messages_count_tokens" || path.model) {
      ctx.body = {};
      return;
    }
    throw new GatewayError("invalid_request", "Request body is empty; expected a JSON object.");
  }
  const parsed = safeJsonParse<Json>(buf.toString("utf8"));
  if (!isObject(parsed)) throw new GatewayError("invalid_request", "Request body must be a valid JSON object.");
  ctx.body = parsed;

  if (parsed.stream === true && path.op !== "gemini_stream") {
    if (!STREAMABLE.has(path.op)) throw new GatewayError("invalid_request", "'stream' is not supported for this endpoint.", { param: "stream" });
    ctx.stream = true;
  }
  if (path.op === "gemini_stream") ctx.stream = true;
  if (isObject(parsed.stream_options) && parsed.stream_options.include_usage === true) ctx.clientWantsUsage = true;
}

// ------------------------------------------------------------------ model
function resolveRequestModel(ctx: Ctx): void {
  const snap = ctx.snap!;
  const path = ctx.path!;
  const { key } = ctx.auth!;
  const name = path.model ?? (ctx.body && typeof ctx.body.model === "string" ? ctx.body.model : ctx.form ? getField(ctx.form, "model") : undefined);
  if (!name) throw new GatewayError("invalid_request", "'model' is required.", { param: "model" });
  const model = resolveModel(snap, name);
  if (!model) throw new GatewayError("model_not_found", `The model '${name}' does not exist or you do not have access to it.`, { param: "model" });
  ctx.model = model;
  if (key.allowedModels && !key.allowedModels.has(model.slug)) throw new GatewayError("model_not_allowed");
  if (ctx.group?.allowedModels && !ctx.group.allowedModels.has(model.slug)) throw new GatewayError("model_not_allowed");
  if (path.capability && !model.capabilities.has(path.capability)) {
    throw new GatewayError("unsupported_endpoint", `The model '${model.slug}' does not support this endpoint.`, { param: "model" });
  }
  if (path.op === "videos_create" && !model.sell.perSecond?.gt(0)) {
    // fail closed: a video model without a per-second price would be generated for free
    throw new GatewayError("no_available_provider", undefined, { retryAfterSec: 60, internal: `model '${model.slug}' has no perSecondPrice configured` });
  }
  const { user } = ctx.auth!;
  ctx.multiplier = effectiveMultiplier(user.priceMultiplier, ctx.group?.priceMultiplier);
}

// ------------------------------------------------------------------ rate limits
async function checkLimits(ctx: Ctx): Promise<void> {
  const { key, user } = ctx.auth!;
  const group = ctx.group;
  if (key.rpmLimit) {
    const r = await checkRpm(`key:${key.id}`, key.rpmLimit);
    if (!r.ok) throw rateLimited("requests per minute", r.retryAfterSec, key.rpmLimit);
  }
  if (group?.rpmLimit) {
    const r = await checkRpm(`group:${group.id}:user:${user.id}`, group.rpmLimit);
    if (!r.ok) throw rateLimited("requests per minute", r.retryAfterSec, group.rpmLimit);
  }
  if (key.tpmLimit) {
    const r = await checkTpm(`key:${key.id}`, key.tpmLimit);
    if (!r.ok) throw rateLimited("tokens per minute", r.retryAfterSec, key.tpmLimit);
  }
}

function rateLimited(what: string, retryAfterSec: number, limit: number): GatewayError {
  return new GatewayError("rate_limited", `Rate limit reached for ${what}. Please retry in ${retryAfterSec}s.`, {
    retryAfterSec,
    headers: { "x-ratelimit-limit-requests": String(limit), "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": `${retryAfterSec}s` },
    internal: `rate limit (${what}) limit=${limit}`,
  });
}

// ------------------------------------------------------------------ dispatch
async function dispatch(ctx: Ctx): Promise<Response> {
  const snap = ctx.snap!;
  const path = ctx.path!;
  const model = ctx.model!;
  let pinKeyId: string | null = null;
  let routes: RoutePlan[] = orderRoutes(eligibleRoutes(snap, model, ctx.group, path.wireFormat!));

  if (path.op === "responses" && ctx.body && typeof ctx.body.previous_response_id === "string") {
    const sticky = await lookupResponse(ctx.body.previous_response_id);
    if (sticky && sticky.userId === ctx.auth!.user.id) {
      pinKeyId = sticky.providerKeyId;
      routes = routes.filter((r) => r.route.providerId === sticky.providerId);
    }
  }

  if (!routes.length) {
    const hasAny = (snap.routesByModel.get(model.id) ?? []).some((r) => r.provider.status === "ACTIVE");
    if (hasAny) {
      throw new GatewayError("unsupported_endpoint", `The model '${model.slug}' is not available through this API format.`, { param: "model", internal: "no eligible route (format / group / provider tags)" });
    }
    throw new GatewayError("no_available_provider", undefined, { retryAfterSec: 30, internal: "model has no enabled route on an active provider" });
  }

  if (path.op === "messages_count_tokens") {
    const native = routes.filter((r) => r.plan.mode === "native");
    if (!native.length) return localCountTokens(ctx);
    routes = native;
  }
  return execute(ctx, routes, { pinKeyId });
}

/** Anthropic count_tokens when no native Anthropic upstream exists: estimate locally (not billed). */
async function localCountTokens(ctx: Ctx): Promise<Response> {
  const body = ctx.body ?? {};
  const n = await countRequestTokens({ system: body.system, messages: body.messages, tools: body.tools });
  logOutcome(ctx, { status: "SUCCESS", httpStatus: 200, usage: emptyUsage() });
  return withCommon(ctx, new Response(JSON.stringify({ input_tokens: n }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }));
}

/** GET/DELETE /v1/videos[/{id}[/content]]: ownership-checked, sticky to the upstream account that created the job. */
async function dispatchVideoLookup(ctx: Ctx): Promise<Response> {
  ctx.multiplier = effectiveMultiplier(ctx.auth!.user.priceMultiplier, ctx.group?.priceMultiplier);
  switch (ctx.path!.op) {
    case "videos_list":
      return videoList(ctx);
    case "videos_get":
      return videoGet(ctx);
    case "videos_delete":
      return videoDelete(ctx);
    default: {
      const plan = await videoContentPlan(ctx);
      return execute(ctx, plan.routes, { pinKeyId: plan.pinKeyId, maxAttempts: 1, upstreamVideoId: plan.upstreamId, upstreamQuery: plan.query, externalUrl: plan.externalUrl });
    }
  }
}

async function dispatchResponsesLookup(ctx: Ctx): Promise<Response> {
  const snap = ctx.snap!;
  const path = ctx.path!;
  const sticky = await lookupResponse(path.responseId!);
  if (!sticky || sticky.userId !== ctx.auth!.user.id) {
    throw new GatewayError("not_found", `No response found with id '${path.responseId}'.`, { param: "response_id" });
  }
  const model = snap.modelsById.get(sticky.modelId);
  const route = snap.routesByModel.get(sticky.modelId)?.find((r) => r.id === sticky.routeId);
  if (!model || !route) throw new GatewayError("not_found", `No response found with id '${path.responseId}'.`, { param: "response_id" });
  ctx.model = model;
  ctx.multiplier = effectiveMultiplier(ctx.auth!.user.priceMultiplier, ctx.group?.priceMultiplier);
  const routes: RoutePlan[] = [{ route, plan: { mode: "native", upstream: "openai_responses" } }];
  return execute(ctx, routes, { pinKeyId: sticky.providerKeyId, maxAttempts: 1, responseId: path.responseId });
}
