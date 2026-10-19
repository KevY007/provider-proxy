import { randomBytes } from "node:crypto";
import type { Prisma, VideoJob } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { toDbString, toDecimal } from "@/lib/money";
import { afterLedgerCommit, appendEntryTx } from "@/server/billing/ledger";
import { getConfig, getKeySecret, type ConfigSnapshot, type KeyRec, type ProviderRec } from "./cache";
import { logOutcome, withCommon, type Ctx } from "./context";
import { GatewayError } from "./errors";
import type { AttemptResult, Fail, Rec } from "./execute";
import { finalError, type Failure } from "./failure";
import { classifyStatus, recordKeyFailure, recordKeySuccess } from "./keyhealth";
import { getField } from "./multipart";
import { priceRequest } from "./pricing";
import { buildUpstreamHeaders, buildUpstreamUrl } from "./providers/adapters";
import { sameOrigin, str, trimSlash } from "./providers/image-common";
import type { Candidate, RoutePlan } from "./select";
import { clientErrorFromUpstream, extractErrorMessage, parseRetryAfter, pickRateLimitHeaders, type HeaderLike } from "./shape";
import { emptyUsage, type Json, type JsonObject } from "./types";
import { ClientAbortError, UpstreamTimeoutError, readErrorBody, readTextLimited, sendUpstream, type UpstreamHandle } from "./upstream";
import { describeNetworkError, isObject, safeJsonParse } from "./util";

/**
 * OpenAI-compatible video API (Sora shape): POST /v1/videos, GET /v1/videos[/{id}[/content]], DELETE /v1/videos/{id}.
 *
 * - Our public ids are `video_<48 hex>`; the upstream id and the upstream account (provider key) that created the job
 *   live in VideoJob so status / content / delete calls stay sticky to that account (survives restarts).
 * - Ownership: every lookup is scoped to the authenticated user; foreign or unknown ids answer 404.
 * - Billing: the whole job is charged at creation (requested seconds x per-second price, through the normal
 *   RequestLog metering). If a status poll later observes the job as `failed`, the charge is refunded exactly once
 *   (ledger REFUND, atomically with the VideoJob.refunded flag).
 * - Backends: OpenAI-shaped upstreams (`/videos` on the provider) and fal.ai (queue API: submit -> status_url ->
 *   response_url; the result video is a CDN URL kept in VideoJob.meta and streamed to the customer).
 */
export const DEFAULT_VIDEO_SECONDS = 4;
const MAX_VIDEO_SECONDS = 600;
const VARIANTS = new Set(["video", "thumbnail", "spritesheet"]);

export type VideoStatus = "queued" | "in_progress" | "completed" | "failed";
const TERMINAL = new Set<string>(["completed", "failed"]);

export function normalizeVideoStatus(v: unknown): VideoStatus {
  const s = String(v ?? "").toLowerCase();
  if (s === "completed" || s === "complete" || s === "succeeded" || s === "success") return "completed";
  if (s === "failed" || s === "error" || s === "cancelled" || s === "canceled" || s === "expired") return "failed";
  if (s === "in_progress" || s === "processing" || s === "running" || s === "rendering") return "in_progress";
  return "queued";
}

const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const newVideoId = () => `video_${randomBytes(24).toString("hex")}`;
const jsonHeaders = (ctx: Ctx): Headers => new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": ctx.requestId });
const metaOf = (job: Pick<VideoJob, "meta">): JsonObject => (isObject(job.meta) ? job.meta : {});

// ------------------------------------------------------------------ request parsing
/** Requested duration (seconds) of a create request; invalid values are a 400 before anything is sent upstream. */
export function requestedSeconds(ctx: Ctx): number {
  const raw: unknown = ctx.form ? getField(ctx.form, "seconds") : ctx.body?.seconds;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_VIDEO_SECONDS;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0 || n > MAX_VIDEO_SECONDS) {
    throw new GatewayError("invalid_request", "'seconds' must be a positive number of seconds.", { param: "seconds" });
  }
  return n;
}

export function requestedSize(ctx: Ctx): string | null {
  const raw: unknown = ctx.form ? getField(ctx.form, "size") : ctx.body?.size;
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 40) : null;
}

// ------------------------------------------------------------------ job helpers
/** Customer-facing video object from an upstream one (our id, masked model). */
function publicObject(snap: ConfigSnapshot, job: Pick<VideoJob, "id" | "modelId" | "modelSlug" | "upstreamModel">, up: Json, status: VideoStatus): Json {
  const mask = snap.modelsById.get(job.modelId)?.maskUpstreamModel ?? true;
  const base = isObject(up) ? { ...up } : {};
  return { ...base, id: job.id, object: "video", model: mask ? job.modelSlug : typeof base.model === "string" ? base.model : job.upstreamModel, status };
}

function synthesize(job: VideoJob): Json {
  return {
    id: job.id,
    object: "video",
    model: job.modelSlug,
    status: job.status,
    progress: job.progress,
    created_at: unix(job.createdAt),
    completed_at: job.completedAt ? unix(job.completedAt) : null,
    expires_at: null,
    error: null,
    remixed_from_video_id: null,
    seconds: String(job.seconds),
    size: job.size,
  };
}

const objectOf = (job: VideoJob): Json => (isObject(job.lastObject) ? { ...job.lastObject, id: job.id, status: job.status } : synthesize(job));

async function findJob(ctx: Ctx): Promise<VideoJob> {
  const id = ctx.path!.videoId!;
  const job = await db.videoJob.findFirst({ where: { id, userId: ctx.auth!.user.id, deleted: false } });
  if (!job) throw new GatewayError("not_found", `No video found with id '${id}'.`, { param: "video_id" });
  return job;
}

/** Point the request log at the model / account the job runs on. */
function attribute(ctx: Ctx, snap: ConfigSnapshot, job: VideoJob): { provider: ProviderRec | undefined; key: KeyRec | undefined; route: RoutePlan | null } {
  const model = snap.modelsById.get(job.modelId);
  if (model) ctx.model = model;
  const provider = snap.providers.get(job.providerId);
  const key = snap.keysByProvider.get(job.providerId)?.find((k) => k.id === job.providerKeyId);
  const routeRec = snap.routesByModel.get(job.modelId)?.find((r) => r.id === job.routeId);
  const plan: RoutePlan | null = routeRec ? { route: routeRec, plan: { mode: "native", upstream: "openai_videos" } } : null;
  if (plan && key) ctx.chosen = { ...plan, key };
  return { provider, key, route: plan };
}

// ------------------------------------------------------------------ refunds
/**
 * Refund a failed job's charge. Idempotent: the `refunded` flag is claimed and the ledger entry written in one
 * transaction, so concurrent polls refund at most once. Returns true when THIS call issued the refund.
 */
export async function refundVideoJob(job: Pick<VideoJob, "id" | "userId" | "apiKeyId" | "price" | "modelSlug" | "requestId">): Promise<boolean> {
  const price = toDecimal(job.price);
  const done = await db.$transaction(
    async (tx) => {
      const claimed = await tx.videoJob.updateMany({ where: { id: job.id, refunded: false }, data: { refunded: true, refundedAt: new Date() } });
      if (claimed.count !== 1) return false;
      if (price.lte(0)) return false;
      await appendEntryTx(tx, job.userId, price, "REFUND", `Refund: video generation failed (${job.id})`, {
        metadata: { videoId: job.id, requestId: job.requestId, model: job.modelSlug, reason: "video_failed" },
      });
      if (job.apiKeyId) {
        await tx.apiKey.updateMany({ where: { id: job.apiKeyId, spent: { gte: toDbString(price) } }, data: { spent: { decrement: toDbString(price) } } });
      }
      return true;
    },
    { timeout: 15_000 },
  );
  if (done) await afterLedgerCommit(job.userId);
  return done;
}

// ------------------------------------------------------------------ upstream status poll
function upstreamErrorToGateway(provider: ProviderRec, key: KeyRec, secret: string, model: string, status: number, headers: HeaderLike, body: string, snap: ConfigSnapshot): GatewayError {
  const message = extractErrorMessage(body) || `HTTP ${status}`;
  if (status === 404) return new GatewayError("not_found", "The video is no longer available.", { param: "video_id", internal: `upstream 404: ${message}` });
  const failover = status === 401 || status === 402 || status === 403 || status === 408 || status === 429 || status >= 500;
  if (failover) {
    const f: Failure = {
      fk: classifyStatus(status),
      status,
      message,
      retryAfterSec: parseRetryAfter(headers),
      rlHeaders: pickRateLimitHeaders(headers),
      internal: body.slice(0, 2000),
    };
    recordKeyFailure(key, f.fk, { status, message, retryAfterSec: f.retryAfterSec }, snap.settings);
    return finalError(f, snap.settings);
  }
  return clientErrorFromUpstream(status, body, "openai_videos", "openai_videos", {
    upstreamModel: model,
    publicModel: model,
    providerName: provider.name,
    providerSlug: provider.slug,
    baseUrl: provider.baseUrl,
    secret,
  });
}

interface UpstreamAccount {
  snap: ConfigSnapshot;
  provider: ProviderRec;
  key: KeyRec;
  secret: string;
}

function accountOf(snap: ConfigSnapshot, job: VideoJob): UpstreamAccount {
  const provider = snap.providers.get(job.providerId);
  const key = snap.keysByProvider.get(job.providerId)?.find((k) => k.id === job.providerKeyId);
  if (!provider || !key) throw new GatewayError("not_found", "The video is no longer available.", { param: "video_id", internal: "provider or provider key of the video job no longer exists" });
  const secret = getKeySecret(key);
  if (!secret) throw new GatewayError("no_available_provider", undefined, { retryAfterSec: 30, internal: "upstream key could not be decrypted" });
  return { snap, provider, key, secret };
}

/** One small authenticated GET against the upstream account; transport failures become GatewayErrors (key health recorded). */
async function upstreamGet(a: UpstreamAccount, url: string, o: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ status: number; headers: HeaderLike; text: string }> {
  const headers = buildUpstreamHeaders({ provider: a.provider, format: "openai_videos", secret: a.secret, stream: false, keyExtra: a.key.extra, hasBody: false, op: "videos_get" });
  const timeoutMs = Math.min(a.provider.timeoutMs, o.timeoutMs ?? 30_000);
  let h: UpstreamHandle;
  try {
    h = await sendUpstream({ url, method: "GET", headers, timeoutMs, clientSignal: o.signal });
  } catch (err) {
    if (err instanceof ClientAbortError) throw new GatewayError("client_closed");
    const timeout = err instanceof UpstreamTimeoutError;
    recordKeyFailure(a.key, timeout ? "timeout" : "network", { status: 0, message: describeNetworkError(err) }, a.snap.settings);
    throw new GatewayError(timeout ? "upstream_timeout" : "upstream_error", undefined, { internal: `video status poll failed: ${describeNetworkError(err)}` });
  }
  const text = h.res.status >= 200 && h.res.status < 300 ? await readTextLimited(h.res, 8 * 1024 * 1024).catch(() => "") : await readErrorBody(h.res);
  const out = { status: h.res.status, headers: h.res.headers, text };
  h.dispose();
  return out;
}

interface Fetched {
  up: JsonObject;
  /** merged into VideoJob.meta (e.g. the fal result URL once the job completed) */
  metaPatch?: JsonObject;
}

async function fetchOpenAIVideo(a: UpstreamAccount, job: VideoJob, o: { signal?: AbortSignal; timeoutMs?: number }): Promise<Fetched> {
  const url = buildUpstreamUrl({ provider: a.provider, format: "openai_videos", op: "videos_get", upstreamModel: job.upstreamModel, stream: false, keyExtra: a.key.extra, videoId: job.upstreamId, secret: a.secret });
  const r = await upstreamGet(a, url, o);
  if (r.status < 200 || r.status >= 300) throw upstreamErrorToGateway(a.provider, a.key, a.secret, job.upstreamModel, r.status, r.headers, r.text, a.snap);
  const up = safeJsonParse<Json>(r.text);
  if (!isObject(up)) throw new GatewayError("upstream_error", undefined, { internal: `video status poll: non-JSON response ${r.text.slice(0, 300)}` });
  return { up };
}

function falQueueBase(provider: ProviderRec): string {
  return trimSlash(str(provider.settings.queueBaseUrl) ?? "https://queue.fal.run");
}

/** First video URL in a fal result (`video.url`, `videos[0].url`, `output.url`...). */
function falVideoUrl(result: Json): string | null {
  const pick = (v: unknown): string | null => (typeof v === "string" ? v : isObject(v) && typeof v.url === "string" ? v.url : null);
  if (!isObject(result)) return null;
  return pick(result.video) ?? (Array.isArray(result.videos) ? pick(result.videos[0]) : null) ?? pick(result.output) ?? pick(result.url);
}

/** fal queue job: status_url -> (COMPLETED) response_url -> result video URL. */
async function fetchFalVideo(a: UpstreamAccount, job: VideoJob, o: { signal?: AbortSignal; timeoutMs?: number }): Promise<Fetched> {
  const meta = metaOf(job);
  const queueBase = falQueueBase(a.provider);
  const statusUrl = str(meta.statusUrl);
  const responseUrl = str(meta.responseUrl);
  // the stored URLs were returned by fal; refuse to send our key anywhere but the queue origin
  if (!statusUrl || !responseUrl || !sameOrigin(statusUrl, queueBase) || !sameOrigin(responseUrl, queueBase)) {
    throw new GatewayError("not_found", "The video is no longer available.", { param: "video_id", internal: "fal job without usable queue URLs" });
  }
  const st = await upstreamGet(a, statusUrl, o);
  if (st.status < 200 || st.status >= 300) throw upstreamErrorToGateway(a.provider, a.key, a.secret, job.upstreamModel, st.status, st.headers, st.text, a.snap);
  const sj = safeJsonParse<Json>(st.text);
  const state = isObject(sj) ? String(sj.status ?? "") : "";
  if (state === "IN_QUEUE") return { up: { status: "queued", progress: 0 } };
  if (state === "IN_PROGRESS") return { up: { status: "in_progress", progress: 50 } };
  if (state !== "COMPLETED") throw new GatewayError("upstream_error", undefined, { internal: `unexpected fal queue status '${state}': ${st.text.slice(0, 300)}` });

  const r = await upstreamGet(a, responseUrl, o);
  if (r.status === 401 || r.status === 402 || r.status === 403 || r.status === 429) throw upstreamErrorToGateway(a.provider, a.key, a.secret, job.upstreamModel, r.status, r.headers, r.text, a.snap);
  if (r.status < 200 || r.status >= 300) {
    // a COMPLETED fal job whose result cannot be fetched ended in an error (validation / runtime failure)
    return { up: { status: "failed", progress: 0, error: { code: "generation_failed", message: "The video could not be generated." } }, metaPatch: { failure: r.text.slice(0, 500) } };
  }
  const url = falVideoUrl(safeJsonParse<Json>(r.text));
  if (!url || !/^https?:\/\//i.test(url)) {
    return { up: { status: "failed", progress: 0, error: { code: "generation_failed", message: "The video could not be generated." } }, metaPatch: { failure: "no video url in the result" } };
  }
  return { up: { status: "completed", progress: 100, completed_at: unix(new Date()), expires_at: null, error: null }, metaPatch: { videoUrl: url } };
}

/**
 * GET the job from the upstream account that owns it, persist the new status and refund once if it failed.
 * Returns the refreshed row + the customer-facing video object. Throws GatewayError.
 */
export async function pollVideoJob(snap: ConfigSnapshot, job: VideoJob, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ job: VideoJob; object: Json }> {
  const account = accountOf(snap, job);
  const { up, metaPatch } = account.provider.preset === "fal" ? await fetchFalVideo(account, job, o) : await fetchOpenAIVideo(account, job, o);

  const next = normalizeVideoStatus(up.status);
  const object = publicObject(snap, job, isObject(job.lastObject) && account.provider.preset === "fal" ? { ...job.lastObject, ...up } : up, next);
  const progress = typeof up.progress === "number" && Number.isFinite(up.progress) ? Math.max(0, Math.min(100, Math.round(up.progress))) : next === "completed" ? 100 : job.progress;
  const updated = await db.videoJob.update({
    where: { id: job.id },
    data: {
      status: next,
      progress,
      lastObject: object as Prisma.InputJsonValue,
      ...(metaPatch ? { meta: { ...metaOf(job), ...metaPatch } as Prisma.InputJsonValue } : {}),
      ...(next === "completed" && !job.completedAt ? { completedAt: new Date() } : {}),
    },
  });
  if (next === "failed" && !job.refunded) {
    try {
      const refunded = await refundVideoJob(job);
      if (refunded) {
        logger.info("video job failed: charge refunded", { videoId: job.id, userId: job.userId, price: toDecimal(job.price).toString() });
        return { job: { ...updated, refunded: true }, object };
      }
    } catch (err) {
      logger.error("video refund failed", { videoId: job.id, err });
    }
  }
  return { job: updated, object };
}

/** Poll open jobs (cron safety net: failed jobs get refunded even when the client never polls again). */
export async function sweepVideoJobs(limit = 40): Promise<{ polled: number; refunded: number }> {
  const snap = await getConfig();
  const jobs = await db.videoJob.findMany({
    where: { status: { in: ["queued", "in_progress"] }, deleted: false, createdAt: { gt: new Date(Date.now() - 7 * 86_400_000), lt: new Date(Date.now() - 60_000) } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let refunded = 0;
  await Promise.all(
    jobs.map(async (j) => {
      try {
        const r = await pollVideoJob(snap, j, { timeoutMs: 15_000 });
        if (r.job.refunded && !j.refunded) refunded++;
      } catch (err) {
        logger.debug("video sweep poll failed", { videoId: j.id, err: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
  return { polled: jobs.length, refunded };
}

// ------------------------------------------------------------------ POST /v1/videos : upstream answered
/** OpenAI-shaped upstream: read + parse the job object, then record the job. */
export async function handleVideoCreateOk(a: { ctx: Ctx; cand: Candidate; h: UpstreamHandle; t0: number; rec: Rec; fail: Fail }): Promise<AttemptResult> {
  const { ctx, cand, h, t0, rec, fail } = a;
  const provider = cand.route.provider;
  const timer = setTimeout(() => h.abort(new UpstreamTimeoutError("idle")), provider.timeoutMs);
  let text: string;
  try {
    text = await readTextLimited(h.res, 8 * 1024 * 1024);
  } catch (err) {
    clearTimeout(timer);
    h.dispose();
    if (ctx.req.signal.aborted || err instanceof ClientAbortError) throw new GatewayError("client_closed");
    if (h.signal.reason instanceof UpstreamTimeoutError) return fail("timeout", 0, "timed out reading the upstream response");
    return fail("network", 0, `failed reading upstream response: ${describeNetworkError(err)}`);
  }
  clearTimeout(timer);
  h.dispose();

  const up = safeJsonParse<Json>(text);
  if (!isObject(up) || typeof up.id !== "string" || !up.id) return fail("server", 200, "unexpected upstream video response", { internal: text.slice(0, 1000) });
  return finishVideoCreate({ ctx, cand, up, meta: {}, t0, rec });
}

/**
 * The upstream accepted the job (`up` = OpenAI-style video object with the UPSTREAM id): compute the charge, persist the
 * VideoJob (before answering, so the very next poll finds it), log + meter the request and answer with our own object.
 */
export async function finishVideoCreate(a: { ctx: Ctx; cand: Candidate; up: JsonObject; meta: JsonObject; t0: number; rec: Rec }): Promise<AttemptResult> {
  const { ctx, cand, up, meta, t0, rec } = a;
  const snap = ctx.snap!;
  const model = ctx.model!;
  const upstreamId = String(up.id);
  const status = normalizeVideoStatus(up.status);
  const upSeconds = Number(up.seconds);
  const seconds = Number.isFinite(upSeconds) && upSeconds > 0 ? upSeconds : requestedSeconds(ctx);
  const size = typeof up.size === "string" ? up.size : requestedSize(ctx);

  // jobs the upstream already rejected at creation are never charged
  const usage = emptyUsage();
  if (status !== "failed") usage.videoSeconds = seconds;
  const b = priceRequest(usage, model.sell, cand.route.cost, ctx.multiplier, model.longContext, true);

  const id = newVideoId();
  const job = { id, modelId: model.id, modelSlug: model.slug, upstreamModel: cand.route.upstreamModel };
  const object = publicObject(snap, job, { created_at: unix(new Date()), completed_at: null, expires_at: null, error: null, remixed_from_video_id: null, ...up, seconds: String(seconds), size }, status);
  const progress = typeof up.progress === "number" && Number.isFinite(up.progress) ? Math.max(0, Math.min(100, Math.round(up.progress))) : 0;

  try {
    await db.videoJob.create({
      data: {
        id,
        userId: ctx.auth!.user.id,
        apiKeyId: ctx.auth!.key.id,
        modelId: model.id,
        modelSlug: model.slug,
        providerId: cand.route.providerId,
        providerKeyId: cand.key.id,
        routeId: cand.route.id,
        upstreamId,
        upstreamModel: cand.route.upstreamModel,
        status,
        progress,
        seconds,
        size,
        price: toDbString(b.price),
        cost: toDbString(b.cost),
        refunded: status === "failed",
        requestId: ctx.requestId,
        meta: meta as Prisma.InputJsonValue,
        lastObject: object as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logger.error("could not persist video job", { requestId: ctx.requestId, err });
    void cancelUpstreamVideo({ snap, provider: cand.route.provider, key: cand.key, secret: getKeySecret(cand.key) ?? "" }, upstreamId, cand.route.upstreamModel, meta).catch(() => undefined);
    rec(500, "could not persist the video job");
    return { kind: "client_error", error: new GatewayError("internal_error", undefined, { internal: `video job insert failed: ${describeNetworkError(err)}` }) };
  }

  rec(200);
  recordKeySuccess(cand.key);
  logOutcome(ctx, { status: "SUCCESS", httpStatus: 200, usage, ttftMs: Date.now() - t0, responseBody: ctx.logBodies ? object : undefined });
  return { kind: "response", response: withCommon(ctx, new Response(JSON.stringify(object), { status: 200, headers: jsonHeaders(ctx) })) };
}

/** Best-effort DELETE (OpenAI shape) / queue cancel (fal) of an upstream job. Never throws to the caller's flow. */
async function cancelUpstreamVideo(a: UpstreamAccount, upstreamId: string, upstreamModel: string, meta: JsonObject, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ status: number; headers: HeaderLike; text: string } | null> {
  if (!a.secret) return null;
  let url: string;
  let method: "DELETE" | "PUT";
  if (a.provider.preset === "fal") {
    const cancel = str(meta.cancelUrl);
    if (!cancel || !sameOrigin(cancel, falQueueBase(a.provider))) return null;
    url = cancel;
    method = "PUT";
  } else {
    url = buildUpstreamUrl({ provider: a.provider, format: "openai_videos", op: "videos_delete", upstreamModel, stream: false, keyExtra: a.key.extra, videoId: upstreamId, secret: a.secret });
    method = "DELETE";
  }
  const headers = buildUpstreamHeaders({ provider: a.provider, format: "openai_videos", secret: a.secret, stream: false, keyExtra: a.key.extra, hasBody: false, op: "videos_delete" });
  let h: UpstreamHandle;
  try {
    h = await sendUpstream({ url, method, headers, timeoutMs: Math.min(a.provider.timeoutMs, o.timeoutMs ?? 15_000), clientSignal: o.signal });
  } catch (err) {
    if (err instanceof ClientAbortError) throw new GatewayError("client_closed");
    throw new GatewayError(err instanceof UpstreamTimeoutError ? "upstream_timeout" : "upstream_error", undefined, { internal: `video delete failed: ${describeNetworkError(err)}` });
  }
  const status = h.res.status;
  const text = status >= 200 && status < 300 ? "" : await readErrorBody(h.res);
  const out = { status, headers: h.res.headers, text };
  h.dispose();
  return out;
}

// ------------------------------------------------------------------ lookups (served by the dispatcher in handle.ts)
export async function videoGet(ctx: Ctx): Promise<Response> {
  const job = await findJob(ctx);
  const snap = ctx.snap!;
  attribute(ctx, snap, job);
  let object: Json;
  if (TERMINAL.has(job.status) && isObject(job.lastObject)) {
    object = objectOf(job);
  } else {
    ({ object } = await pollVideoJob(snap, job, { signal: ctx.req.signal }));
  }
  logOutcome(ctx, { status: "SUCCESS", httpStatus: 200 });
  return withCommon(ctx, new Response(JSON.stringify(object), { status: 200, headers: jsonHeaders(ctx) }));
}

export async function videoList(ctx: Ctx): Promise<Response> {
  const snap = ctx.snap!;
  const q = ctx.url.searchParams;
  const limitRaw = Number(q.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(100, Math.trunc(limitRaw)) : 20;
  const order = q.get("order") === "asc" ? "asc" : "desc";
  const userId = ctx.auth!.user.id;
  const after = q.get("after");
  if (after) {
    const exists = await db.videoJob.findFirst({ where: { id: after, userId }, select: { id: true } });
    if (!exists) throw new GatewayError("invalid_request", "Invalid 'after' cursor.", { param: "after" });
  }
  const rows = await db.videoJob.findMany({
    where: { userId, deleted: false },
    orderBy: [{ createdAt: order }, { id: order }],
    take: limit + 1,
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);

  // bring still-open jobs up to date (bounded, best effort)
  const open = page.filter((j) => !TERMINAL.has(j.status)).slice(0, 8);
  const fresh = new Map<string, Json>();
  await Promise.all(
    open.map(async (j) => {
      try {
        const r = await pollVideoJob(snap, j, { signal: ctx.req.signal, timeoutMs: 8_000 });
        fresh.set(j.id, r.object);
      } catch (err) {
        if (err instanceof GatewayError && err.code === "client_closed") throw err;
      }
    }),
  );
  const data = page.map((j) => fresh.get(j.id) ?? objectOf(j));
  logOutcome(ctx, { status: "SUCCESS", httpStatus: 200 });
  const body = { object: "list", data, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null, has_more: rows.length > limit };
  return withCommon(ctx, new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders(ctx) }));
}

export async function videoDelete(ctx: Ctx): Promise<Response> {
  const job = await findJob(ctx);
  const snap = ctx.snap!;
  const { provider, key } = attribute(ctx, snap, job);
  if (provider && key) {
    const secret = getKeySecret(key);
    if (secret) {
      const account: UpstreamAccount = { snap, provider, key, secret };
      const r = await cancelUpstreamVideo(account, job.upstreamId, job.upstreamModel, metaOf(job), { signal: ctx.req.signal, timeoutMs: 30_000 });
      // 404 = already gone upstream: fine, we still drop our record. fal cancellation is best effort.
      if (r && provider.preset !== "fal" && (r.status < 200 || r.status >= 300) && r.status !== 404) {
        throw upstreamErrorToGateway(provider, key, secret, job.upstreamModel, r.status, r.headers, r.text, snap);
      }
    }
  }
  await db.videoJob.update({ where: { id: job.id }, data: { deleted: true } });
  logOutcome(ctx, { status: "SUCCESS", httpStatus: 200 });
  return withCommon(ctx, new Response(JSON.stringify({ id: job.id, object: "video.deleted", deleted: true }), { status: 200, headers: jsonHeaders(ctx) }));
}

/** Everything execute() needs to stream `GET /v1/videos/{id}/content` from the owning upstream account. */
export async function videoContentPlan(ctx: Ctx): Promise<{ routes: RoutePlan[]; pinKeyId: string; upstreamId: string; query: string; externalUrl?: string }> {
  let job = await findJob(ctx);
  const snap = ctx.snap!;
  if (job.status === "failed") throw new GatewayError("not_found", "This video has no content because its generation failed.", { param: "video_id" });
  const variant = ctx.url.searchParams.get("variant");
  if (variant !== null && !VARIANTS.has(variant)) throw new GatewayError("invalid_request", "'variant' must be one of: video, thumbnail, spritesheet.", { param: "variant" });
  const { provider, route } = attribute(ctx, snap, job);
  if (!route) throw new GatewayError("no_available_provider", undefined, { retryAfterSec: 30, internal: "the route that created this video is disabled or removed" });

  let externalUrl: string | undefined;
  if (provider?.preset === "fal") {
    // fal results are plain CDN files: only the finished video itself exists
    if (variant && variant !== "video") throw new GatewayError("not_found", `The '${variant}' variant is not available for this video.`, { param: "variant" });
    let url = str(metaOf(job).videoUrl);
    if (!url) {
      ({ job } = await pollVideoJob(snap, job, { signal: ctx.req.signal }));
      if (job.status === "failed") throw new GatewayError("not_found", "This video has no content because its generation failed.", { param: "video_id" });
      url = str(metaOf(job).videoUrl);
    }
    if (!url) throw new GatewayError("not_found", "The video is not ready yet.", { param: "video_id" });
    externalUrl = url;
  }
  return { routes: [route], pinKeyId: job.providerKeyId, upstreamId: job.upstreamId, query: variant ? `variant=${variant}` : "", externalUrl };
}
