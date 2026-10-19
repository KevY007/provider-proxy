import { createHash } from "node:crypto";
import type { Prisma, UpstreamObject } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Decimal, ZERO } from "@/lib/money";
import { getConfig, getKeySecret, resolveModel, type ConfigSnapshot, type KeyRec, type ModelRec, type ProviderRec, type RouteRec } from "./cache";
import { inboundBody } from "./bodyin";
import { logOutcome, releaseAll, withCommon, type Ctx } from "./context";
import { GatewayError } from "./errors";
import { execute, finishLog, type AttemptResult, type Fail, type Rec } from "./execute";
import { providerRoute } from "./files";
import { forwardUpstreamHeaders } from "./headers";
import { releaseHold, restoreHold, type HoldRef } from "./holds";
import { recordKeySuccess } from "./keyhealth";
import { flushMeter } from "./meter-writer";
import { recordOutcome } from "./metering";
import { buildUpstreamHeaders, buildUpstreamUrl } from "./providers/adapters";
import { computeAmount, DEFAULT_BATCH_DISCOUNT_PCT, effectiveMultiplier } from "./pricing";
import { BATCH_HOLD_TTL_MS, explicitMaxOutput, reserveBatchHold, UNKNOWN_MAX_OUTPUT } from "./reserve";
import { eligibleRoutes, orderRoutes, type Candidate, type RoutePlan } from "./select";
import { BodySpool, SpoolLimitError } from "./spool";
import { StreamSession } from "./stream";
import { collectText, roughTokens } from "./tokenizer";
import { emptyUsage, type InboundFormat, type Json, type JsonObject, type Operation, type Usage } from "./types";
import { readBytesLimited, readErrorBody, readTextLimited, sendUpstream, wantsHttp2, type UpstreamHandle } from "./upstream";
import { usageFromAnthropic, usageFromOpenAI, usageFromResponsesObject } from "./usage";
import { describeNetworkError, isObject, safeJsonParse } from "./util";

/**
 * Batch APIs (PLAN 5c): Anthropic Message Batches (`/v1/messages/batches`) and OpenAI Batch (`/v1/batches`).
 *
 *  - Create: every request of the batch is checked like a normal call (model exists, key / group may use it, the
 *    model has a route on a provider that speaks the batch format); one failing request rejects the WHOLE batch with
 *    a native 400 naming its `custom_id`. Public model names are rewritten to the route's upstream model (OpenAI: the
 *    input file is rewritten and uploaded again on the same upstream account). All models must be served by the
 *    same provider; the batch lives on ONE upstream account.
 *  - Funds: one long-lived credit hold covers the worst case of the whole batch at the batch price (`reserveBatchHold`).
 *  - The batch is recorded as `UpstreamObject` kind "batch" (owner, pinned account, models + multiplier at creation):
 *    later calls are owner-checked (foreign ids answer a native 404) and pinned; listings are served from our records.
 *  - Results are passed through as they stream (status / headers / no compression / client abort = upstream abort) with
 *    the upstream model masked line by line.
 *  - Metering (`meterBatch`): every result is metered exactly once at the batch price under a deterministic RequestLog id
 *    (the meter writer skips duplicates), triggered by a results download, the cron sweep (`sweepBatches`) and delete.
 *    The hold is released when the batch is metered.
 */

export interface BatchModel {
  slug: string;
  modelId: string;
  routeId: string;
  upstreamModel: string;
  mask: boolean;
}

export interface BatchMeta {
  fmt: InboundFormat;
  object?: JsonObject;
  models: BatchModel[];
  /** custom_id -> index into `models` (only when the batch uses more than one model) */
  customIdModels?: Record<string, number>;
  multiplier: string;
  groupSlug: string | null;
  holdId: string | null;
  holdAmount: string;
  holdBackend?: string;
  /** OpenAI: the customer's input file, and the rewritten copy we uploaded in its place (deleted after metering) */
  inputFileId?: string;
  rewrittenFileId?: string;
  endpoint?: string;
}

/** Per-request state of a batch call (set by handleBatch, read by handleBatchOk). */
export interface BatchCtx {
  row?: UpstreamObject;
  meta?: BatchMeta;
  hold?: HoldRef | null;
}

const MAX_BATCH_BODY = 512 * 1024 * 1024;
const MAX_INPUT_FILE = 256 * 1024 * 1024;
const MAX_LIST = 5000;
const CLAIM_STALE_MS = 10 * 60_000;

const ANTHROPIC_ENDED = new Set(["ended"]);
const OPENAI_ENDED = new Set(["completed", "failed", "expired", "cancelled"]);

/** OpenAI batch endpoints we can meter: capability + wire format + operation of each line. */
const OPENAI_BATCH_ENDPOINTS: Record<string, { capability: string; format: InboundFormat; op: Operation }> = {
  "/v1/chat/completions": { capability: "chat", format: "openai_chat", op: "chat" },
  "/v1/responses": { capability: "responses", format: "openai_responses", op: "responses" },
  "/v1/embeddings": { capability: "embeddings", format: "openai_embeddings", op: "embeddings" },
  "/v1/completions": { capability: "completions", format: "openai_completions", op: "completions" },
  "/v1/moderations": { capability: "moderation", format: "openai_moderations", op: "moderations" },
};

const fmtOf = (ctx: Ctx): InboundFormat => ctx.path!.format as InboundFormat;
const metaOf = (r: { meta: unknown }): BatchMeta => (isObject(r.meta) ? (r.meta as unknown as BatchMeta) : ({ fmt: "anthropic_batches", models: [], multiplier: "1", groupSlug: null, holdId: null, holdAmount: "0" } as BatchMeta));
const isEnded = (fmt: InboundFormat, status: string | null | undefined): boolean => !!status && (fmt === "anthropic_batches" ? ANTHROPIC_ENDED : OPENAI_ENDED).has(status);
const statusOf = (fmt: InboundFormat, obj: Json): string | null => (isObject(obj) ? (fmt === "anthropic_batches" ? (typeof obj.processing_status === "string" ? obj.processing_status : null) : typeof obj.status === "string" ? obj.status : null) : null);

function notFound(ctx: Ctx, id: string): GatewayError {
  const message = fmtOf(ctx) === "anthropic_batches" ? `Message batch not found: ${id}` : `No batch found with id '${id}'.`;
  return new GatewayError("not_found", message, { param: "batch_id", internal: `batch '${id}' is not owned by the caller (or unknown)` });
}

function invalid(message: string, internal?: string): GatewayError {
  return new GatewayError("invalid_request", message, { internal });
}

// ------------------------------------------------------------------ entry
export async function handleBatch(ctx: Ctx): Promise<Response> {
  const path = ctx.path!;
  ctx.multiplier = effectiveMultiplier(ctx.auth!.user.priceMultiplier, ctx.group?.priceMultiplier);
  ctx.batch = {};
  switch (path.op) {
    case "batches_list":
      return listBatches(ctx);
    case "batches_create":
      return fmtOf(ctx) === "anthropic_batches" ? createAnthropic(ctx) : createOpenAI(ctx);
    default:
      return onExisting(ctx);
  }
}

async function ownedBatch(ctx: Ctx, id: string): Promise<UpstreamObject> {
  const row = await db.upstreamObject.findFirst({ where: { kind: "batch", upstreamId: id, userId: ctx.auth!.user.id } });
  if (!row || metaOf(row).fmt !== fmtOf(ctx)) throw notFound(ctx, id);
  return row;
}

/** The route a batch's management calls are logged under (its first model's route, else a zero-priced stand-in). */
function routeFor(snap: ConfigSnapshot, row: UpstreamObject, meta: BatchMeta): RouteRec | null {
  const first = meta.models[0];
  const route = first ? (snap.routesByModel.get(first.modelId) ?? []).find((r) => r.id === first.routeId) : undefined;
  if (route && route.providerId === row.providerId) return route;
  const p = snap.providers.get(row.providerId);
  return p ? providerRoute(p) : null;
}

/** get / cancel / results / delete: owner-checked, pinned to the account that holds the batch. */
async function onExisting(ctx: Ctx): Promise<Response> {
  const path = ctx.path!;
  const snap = ctx.snap!;
  const row = await ownedBatch(ctx, path.objectId!);
  const meta = metaOf(row);
  ctx.batch = { row, meta };
  ctx.files = { streamed: false, upstreamId: row.upstreamId, row };
  if (path.op === "batches_delete") await meterBatch(row.id).catch((err) => logger.error("batch metering before delete failed", { batchId: row.upstreamId, err }));
  const route = routeFor(snap, row, meta);
  if (!route || route.provider.status !== "ACTIVE") throw new GatewayError("no_available_provider", undefined, { retryAfterSec: 30, internal: "the provider holding this batch is not active" });
  const first = meta.models[0];
  if (first) ctx.model = snap.modelsById.get(first.modelId) ?? null;
  const routes: RoutePlan[] = [{ route, plan: { mode: "native", upstream: fmtOf(ctx) } }];
  return execute(ctx, routes, { pinKeyId: row.providerKeyId, maxAttempts: path.op === "batches_get" || path.op === "batches_results" ? undefined : 1 });
}

// ------------------------------------------------------------------ request body
async function readJson(ctx: Ctx): Promise<JsonObject> {
  const stream = inboundBody(ctx.req);
  if (!stream) throw invalid("Request body is empty; expected a JSON object.");
  const mb = ctx.snap!.settings.maxRequestBodyMb;
  const limit = mb > 0 ? Math.min(mb * 1024 * 1024, MAX_BATCH_BODY) : MAX_BATCH_BODY;
  let text: string;
  try {
    const spool = await BodySpool.fromStream(stream, { maxBytes: limit });
    try {
      text = (await spool.toBuffer()).toString("utf8");
    } finally {
      await spool.dispose();
    }
  } catch (e) {
    if (e instanceof SpoolLimitError) throw new GatewayError("payload_too_large", `Request body exceeds the ${Math.round(e.limit / 1048576)}MB limit.`);
    if (ctx.req.signal.aborted) throw new GatewayError("client_closed");
    throw invalid("Could not read the request body.");
  }
  const parsed = safeJsonParse<Json>(text);
  if (!isObject(parsed)) throw invalid("Request body must be a valid JSON object.");
  return parsed;
}

// ------------------------------------------------------------------ per-request checks
/** Resolve + authorize the model of one batch request (errors name the request, so the customer can find it). */
function checkModel(ctx: Ctx, name: unknown, capability: string, customId: string): ModelRec {
  const where = `requests[custom_id=${JSON.stringify(customId)}]`;
  if (typeof name !== "string" || !name) throw invalid(`${where}: 'model' is required.`);
  const model = resolveModel(ctx.snap!, name);
  if (!model) throw new GatewayError("model_not_found", `${where}: the model '${name}' does not exist or you do not have access to it.`, { param: "model" });
  const { key } = ctx.auth!;
  if ((key.allowedModels && !key.allowedModels.has(model.slug)) || (ctx.group?.allowedModels && !ctx.group.allowedModels.has(model.slug))) {
    throw new GatewayError("model_not_allowed", `${where}: your API key does not have access to the model '${name}'.`, { param: "model" });
  }
  if (!model.capabilities.has(capability)) throw new GatewayError("unsupported_endpoint", `${where}: the model '${model.slug}' does not support this endpoint.`, { param: "model" });
  return model;
}

/** Worst-case output tokens of one request (its own limit, else the model maximum). */
function worstOutput(model: ModelRec, op: Operation, body: JsonObject): number {
  if (op === "embeddings" || op === "moderations") return 0;
  const explicit = explicitMaxOutput(op, body);
  const cap = model.maxOutput && model.maxOutput > 0 ? model.maxOutput : null;
  if (explicit !== null) return cap ? Math.min(explicit, cap) : explicit;
  return cap ?? UNKNOWN_MAX_OUTPUT;
}

/** Hold contribution of one request: char-based input estimate (fast for 100k-request batches) + worst-case output, at the batch price. */
function worstPrice(ctx: Ctx, model: ModelRec, op: Operation, body: JsonObject): Decimal {
  const { text, images, messages } = collectText(body);
  const u = emptyUsage();
  u.inputTokens = Math.ceil(roughTokens(text) * 1.15) + images * 1000 + messages * 4;
  u.outputTokens = worstOutput(model, op, body);
  return computeAmount(u, model.sell, { multiplier: ctx.multiplier, longContext: model.longContext, tokenDiscountPct: model.batchDiscountPct ?? DEFAULT_BATCH_DISCOUNT_PCT });
}

interface Line {
  customId: string;
  model: ModelRec;
}

/** One provider that has a batch route for every model of the batch; its route per model. */
function pickProvider(ctx: Ctx, models: ModelRec[], format: InboundFormat, onlyProvider?: string): { providerId: string; routes: Map<string, RouteRec> } {
  const snap = ctx.snap!;
  const perModel = new Map<string, RoutePlan[]>();
  for (const m of models) {
    let rs = orderRoutes(eligibleRoutes(snap, m, ctx.group, format)).filter((r) => r.plan.mode === "native");
    if (onlyProvider) rs = rs.filter((r) => r.route.providerId === onlyProvider);
    if (!rs.length) {
      const why = onlyProvider ? "with the account that stores the input file" : "through the Batch API";
      throw new GatewayError("unsupported_endpoint", `The model '${m.slug}' is not available ${why}.`, { param: "model", internal: `no ${format} route for ${m.slug}${onlyProvider ? ` on provider ${onlyProvider}` : ""}` });
    }
    perModel.set(m.id, rs);
  }
  const first = perModel.get(models[0].id)!;
  for (const cand of first) {
    const pid = cand.route.providerId;
    const routes = new Map<string, RouteRec>();
    for (const m of models) {
      const r = perModel.get(m.id)!.find((x) => x.route.providerId === pid);
      if (r) routes.set(m.id, r.route);
    }
    if (routes.size === models.length) return { providerId: pid, routes };
  }
  throw invalid("The models of this batch cannot be served together. Split the batch by model.", "no single provider has a batch route for every model of the batch");
}

function batchModels(models: ModelRec[], routes: Map<string, RouteRec>): BatchModel[] {
  return models.map((m) => {
    const r = routes.get(m.id)!;
    return { slug: m.slug, modelId: m.id, routeId: r.id, upstreamModel: r.upstreamModel, mask: m.maskUpstreamModel };
  });
}

function baseMeta(ctx: Ctx, fmt: InboundFormat, models: BatchModel[], lines: Line[], hold: HoldRef | null, amount: Decimal): BatchMeta {
  const index = new Map(models.map((m, i) => [m.modelId, i]));
  return {
    fmt,
    models,
    ...(models.length > 1 ? { customIdModels: Object.fromEntries(lines.map((l) => [l.customId, index.get(l.model.id)!])) } : {}),
    multiplier: ctx.multiplier.toString(),
    groupSlug: ctx.group?.slug ?? null,
    holdId: hold?.id ?? null,
    holdAmount: amount.toString(),
    ...(hold ? { holdBackend: hold.backend } : {}),
  };
}

/** Run the create call; the hold is released when it does not result in a batch. */
async function forwardCreate(ctx: Ctx, routes: RoutePlan[], pinKeyId: string | null): Promise<Response> {
  try {
    const res = await execute(ctx, routes, { pinKeyId, maxAttempts: pinKeyId ? 1 : undefined });
    if (res.status >= 300 && ctx.batch?.hold) releaseHold(ctx.batch.hold);
    return res;
  } catch (e) {
    if (ctx.batch?.hold) releaseHold(ctx.batch.hold);
    throw e;
  }
}

// ------------------------------------------------------------------ Anthropic create
async function createAnthropic(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx);
  const requests = body.requests;
  if (!Array.isArray(requests) || requests.length === 0) throw invalid("requests: Field required");
  const lines: Line[] = [];
  const seen = new Set<string>();
  const models = new Map<string, ModelRec>();
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    if (!isObject(r) || typeof r.custom_id !== "string" || !isObject(r.params)) throw invalid(`requests.${i}: each request needs a 'custom_id' and 'params'.`);
    if (seen.has(r.custom_id)) throw invalid(`requests.${i}: duplicate custom_id ${JSON.stringify(r.custom_id)}.`);
    seen.add(r.custom_id);
    const model = checkModel(ctx, r.params.model, "chat", r.custom_id);
    models.set(model.id, model);
    lines.push({ customId: r.custom_id, model });
  }
  const list = [...models.values()];
  const { routes } = pickProvider(ctx, list, "anthropic_batches");
  let amount = ZERO;
  for (let i = 0; i < requests.length; i++) {
    const params = requests[i].params as JsonObject;
    const m = lines[i].model;
    amount = amount.plus(worstPrice(ctx, m, "messages", params));
    params.model = routes.get(m.id)!.upstreamModel;
  }
  const hold = await reserveBatchHold(ctx, amount);
  const bm = batchModels(list, routes);
  ctx.batch = { hold, meta: baseMeta(ctx, "anthropic_batches", bm, lines, hold, amount) };
  ctx.model = list[0];
  ctx.files = { streamed: false, buffered: Buffer.from(JSON.stringify(body)) };
  const route = routes.get(list[0].id)!;
  return forwardCreate(ctx, [{ route, plan: { mode: "native", upstream: "anthropic_batches" } }], null);
}

// ------------------------------------------------------------------ direct upstream calls (outside the request loop)
interface Account {
  provider: ProviderRec;
  key: KeyRec;
  secret: string;
}

function accountOf(snap: ConfigSnapshot, providerId: string, keyId: string): Account | null {
  const provider = snap.providers.get(providerId);
  const key = (snap.keysByProvider.get(providerId) ?? []).find((k) => k.id === keyId);
  const secret = key ? getKeySecret(key) : null;
  return provider && key && secret ? { provider, key, secret } : null;
}

async function direct(acc: Account, format: InboundFormat, op: Operation, o: { objectId?: string; method?: string; body?: Uint8Array | string | null; contentType?: string | null; signal?: AbortSignal; inbound?: Headers } = {}): Promise<UpstreamHandle> {
  const { provider, key, secret } = acc;
  const url = buildUpstreamUrl({ provider, format, op, upstreamModel: "batch", stream: false, keyExtra: key.extra, objectId: o.objectId, secret });
  const hasBody = o.body !== undefined && o.body !== null;
  const headers = buildUpstreamHeaders({ provider, format, secret, stream: false, keyExtra: key.extra, contentType: o.contentType ?? null, hasBody, op, inbound: o.inbound });
  return sendUpstream({ url, method: o.method ?? "GET", headers, body: o.body ?? null, timeoutMs: provider.timeoutMs, clientSignal: o.signal, http2: wantsHttp2(provider) });
}

// ------------------------------------------------------------------ OpenAI create
async function createOpenAI(ctx: Ctx): Promise<Response> {
  const snap = ctx.snap!;
  const body = await readJson(ctx);
  const inputId = body.input_file_id;
  const endpoint = body.endpoint;
  if (typeof inputId !== "string" || !inputId) throw new GatewayError("invalid_request", "Missing required parameter: 'input_file_id'.", { param: "input_file_id" });
  if (typeof endpoint !== "string") throw new GatewayError("invalid_request", "Missing required parameter: 'endpoint'.", { param: "endpoint" });
  const ep = OPENAI_BATCH_ENDPOINTS[endpoint];
  if (!ep) throw new GatewayError("invalid_request", `Unsupported batch endpoint '${endpoint}'. Supported: ${Object.keys(OPENAI_BATCH_ENDPOINTS).join(", ")}.`, { param: "endpoint" });
  const file = await db.upstreamObject.findFirst({ where: { kind: "file", upstreamId: inputId, userId: ctx.auth!.user.id } });
  if (!file) throw new GatewayError("not_found", `No such File object: ${inputId}`, { param: "input_file_id", internal: "batch input file is not owned by the caller (or unknown)" });
  const acc = accountOf(snap, file.providerId, file.providerKeyId);
  if (!acc || acc.provider.status !== "ACTIVE" || !acc.provider.formats.has("openai_batches")) {
    throw new GatewayError("unsupported_endpoint", "Batches are not available for this input file.", { internal: "the account holding the input file cannot run batches (provider inactive / no openai_batches format / key unusable)" });
  }

  // ---- read the input file from the account that stores it, validate + rewrite each line
  let raw: Buffer;
  try {
    const h = await direct(acc, "openai_files", "files_content", { objectId: inputId, signal: ctx.req.signal });
    if (h.res.status >= 300) {
      const t = await readErrorBody(h.res);
      h.dispose();
      throw new GatewayError(h.res.status === 404 ? "not_found" : "upstream_error", h.res.status === 404 ? `No such File object: ${inputId}` : undefined, { param: "input_file_id", internal: `input file download ${h.res.status}: ${t.slice(0, 500)}` });
    }
    raw = await readBytesLimited(h.res, MAX_INPUT_FILE);
    h.dispose();
  } catch (e) {
    if (e instanceof GatewayError) throw e;
    if (ctx.req.signal.aborted) throw new GatewayError("client_closed");
    throw new GatewayError("upstream_error", undefined, { internal: `input file download failed: ${describeNetworkError(e)}` });
  }
  const parsed: Array<{ customId: string; obj: JsonObject }> = [];
  const lines: Line[] = [];
  const models = new Map<string, ModelRec>();
  const seen = new Set<string>();
  let n = 0;
  for (const text of raw.toString("utf8").split("\n")) {
    n++;
    if (!text.trim()) continue;
    const obj = safeJsonParse<Json>(text);
    if (!isObject(obj) || typeof obj.custom_id !== "string" || !isObject(obj.body)) throw invalid(`Line ${n} of the input file is not a valid batch request (custom_id, method, url, body).`);
    if (seen.has(obj.custom_id)) throw invalid(`Line ${n}: duplicate custom_id ${JSON.stringify(obj.custom_id)}.`);
    seen.add(obj.custom_id);
    if (typeof obj.url === "string" && obj.url !== endpoint) throw invalid(`Line ${n}: url '${obj.url}' does not match the batch endpoint '${endpoint}'.`);
    const model = checkModel(ctx, obj.body.model, ep.capability, obj.custom_id);
    models.set(model.id, model);
    lines.push({ customId: obj.custom_id, model });
    parsed.push({ customId: obj.custom_id, obj });
  }
  if (!parsed.length) throw invalid("The input file contains no requests.");
  const list = [...models.values()];
  const { providerId, routes } = pickProvider(ctx, list, "openai_batches", file.providerId);
  let amount = ZERO;
  let changed = false;
  for (let i = 0; i < parsed.length; i++) {
    const b = parsed[i].obj.body as JsonObject;
    const m = lines[i].model;
    amount = amount.plus(worstPrice(ctx, m, ep.op, b));
    const up = routes.get(m.id)!.upstreamModel;
    if (b.model !== up) {
      b.model = up;
      changed = true;
    }
  }

  const hold = await reserveBatchHold(ctx, amount);
  const meta = baseMeta(ctx, "openai_batches", batchModels(list, routes), lines, hold, amount);
  meta.inputFileId = inputId;
  meta.endpoint = endpoint;
  ctx.batch = { hold, meta };
  ctx.model = list[0];
  let upstreamInput = inputId;
  if (changed) {
    try {
      const jsonl = parsed.map((p) => JSON.stringify(p.obj)).join("\n") + "\n";
      const fd = new FormData();
      fd.append("purpose", "batch");
      fd.append("file", new Blob([jsonl], { type: "application/jsonl" }), "batch_input.jsonl");
      const req = new Request("http://local/", { method: "POST", body: fd });
      const bytes = new Uint8Array(await req.arrayBuffer());
      const h = await direct(acc, "openai_files", "files_create", { method: "POST", body: bytes, contentType: req.headers.get("content-type"), signal: ctx.req.signal });
      const t = await readTextLimited(h.res, 1024 * 1024);
      h.dispose();
      const created = safeJsonParse<Json>(t);
      if (h.res.status >= 300 || !isObject(created) || typeof created.id !== "string") throw new GatewayError("upstream_error", undefined, { internal: `rewritten input upload failed ${h.res.status}: ${t.slice(0, 500)}` });
      upstreamInput = created.id;
      meta.rewrittenFileId = created.id;
    } catch (e) {
      if (hold) releaseHold(hold);
      if (e instanceof GatewayError) throw e;
      if (ctx.req.signal.aborted) throw new GatewayError("client_closed");
      throw new GatewayError("upstream_error", undefined, { internal: `rewritten input upload failed: ${describeNetworkError(e)}` });
    }
  }
  ctx.files = { streamed: false, buffered: Buffer.from(JSON.stringify({ ...body, input_file_id: upstreamInput })) };
  const route = routes.get(list[0].id)!;
  if (route.providerId !== providerId) throw new Error("unreachable: batch route on another provider");
  return forwardCreate(ctx, [{ route, plan: { mode: "native", upstream: "openai_batches" } }], file.providerKeyId);
}

// ------------------------------------------------------------------ public object
function publicOrigin(ctx: Ctx): string {
  const h = ctx.req.headers;
  const proto = (h.get("x-forwarded-proto") ?? ctx.url.protocol.replace(":", "")).split(",")[0].trim();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? ctx.url.host).split(",")[0].trim();
  return `${proto}://${host}`;
}

/** The batch object as the customer sees it: our results URL, their own input file id, masked model names. */
export function publicBatch(obj: JsonObject, meta: BatchMeta, origin: string | null): JsonObject {
  const out: JsonObject = { ...obj };
  if (meta.fmt === "anthropic_batches") {
    if (typeof out.results_url === "string" && out.results_url && origin && typeof out.id === "string") out.results_url = `${origin}/v1/messages/batches/${encodeURIComponent(out.id)}/results`;
  } else {
    if (meta.inputFileId && meta.rewrittenFileId && out.input_file_id === meta.rewrittenFileId) out.input_file_id = meta.inputFileId;
    if (typeof out.model === "string") out.model = maskModel(meta, out.model);
  }
  return out;
}

function maskModel(meta: BatchMeta, upstream: string): string {
  const m = meta.models.find((x) => x.upstreamModel === upstream);
  return m && m.mask ? m.slug : upstream;
}

async function register(ctx: Ctx, cand: Candidate, obj: JsonObject): Promise<UpstreamObject | null> {
  const id = typeof obj.id === "string" ? obj.id : null;
  if (!id) return null;
  const meta: BatchMeta = { ...ctx.batch!.meta!, object: obj };
  try {
    return await db.upstreamObject.upsert({
      where: { kind_upstreamId_providerId: { kind: "batch", upstreamId: id, providerId: cand.route.providerId } },
      create: { kind: "batch", upstreamId: id, providerId: cand.route.providerId, providerKeyId: cand.key.id, userId: ctx.auth!.user.id, apiKeyId: ctx.auth!.key.id, status: statusOf(meta.fmt, obj), meta: meta as unknown as Prisma.InputJsonValue },
      update: {},
    });
  } catch (err) {
    logger.error("could not record batch", { requestId: ctx.requestId, batchId: id, err });
    return null;
  }
}

/** Keep our record in step with an upstream batch object we just saw; OpenAI output / error files become the owner's files. */
async function refreshRecord(row: UpstreamObject, obj: JsonObject): Promise<UpstreamObject> {
  const meta = metaOf(row);
  const status = statusOf(meta.fmt, obj);
  const next = await db.upstreamObject.update({ where: { id: row.id }, data: { status, meta: { ...meta, object: obj } as unknown as Prisma.InputJsonValue } }).catch(() => row);
  if (meta.fmt === "openai_batches") {
    const files = [obj.output_file_id, obj.error_file_id].filter((x): x is string => typeof x === "string" && !!x);
    if (files.length) {
      await db.upstreamObject
        .createMany({
          data: files.map((f) => ({ kind: "file", upstreamId: f, providerId: row.providerId, providerKeyId: row.providerKeyId, userId: row.userId, apiKeyId: row.apiKeyId, meta: { fmt: "openai_files", generated: true, batchOutputOf: row.upstreamId, filename: `${row.upstreamId}_${f === obj.error_file_id ? "error" : "output"}.jsonl` } })),
          skipDuplicates: true,
        })
        .catch((err) => logger.error("could not record batch output files", { batchId: row.upstreamId, err }));
    }
  }
  return next;
}

// ------------------------------------------------------------------ successful upstream answer
export async function handleBatchOk(ctx: Ctx, cand: Candidate, h: UpstreamHandle, t0: number, rec: Rec, fail: Fail): Promise<AttemptResult> {
  const op = ctx.path!.op;
  const settings = ctx.snap!.settings;
  const b = ctx.batch!;
  if (op === "batches_results") return maskedJsonl(ctx, cand, h, t0, rec, b.meta!, b.row!);

  let text: string;
  try {
    text = await readTextLimited(h.res, 64 * 1024 * 1024);
  } catch (err) {
    h.dispose();
    if (ctx.req.signal.aborted) throw new GatewayError("client_closed");
    return fail("network", 0, `failed reading upstream response: ${describeNetworkError(err)}`);
  }
  h.dispose();
  const json = safeJsonParse<Json>(text);
  const headers = new Headers({ "content-type": h.res.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "no-store" });
  forwardUpstreamHeaders(h.res.headers, headers, { rateLimits: settings.passUpstreamRateLimits });
  let out = text;
  if (isObject(json)) {
    let meta = b.meta!;
    if (op === "batches_create") {
      const row = await register(ctx, cand, json);
      if (!row && b.hold) releaseHold(b.hold);
    } else if (b.row && op !== "batches_delete") {
      const row = await refreshRecord(b.row, json);
      meta = metaOf(row);
      if (isEnded(meta.fmt, row.status) && !row.meteredAt) void meterBatch(row.id).catch((err) => logger.error("batch metering failed", { batchId: row.upstreamId, err }));
    }
    if (op === "batches_delete" && b.row) {
      // results are metered before the delete was forwarded; the record goes once that is done
      await db.upstreamObject.deleteMany({ where: { id: b.row.id, meteredAt: { not: null } } }).catch(() => undefined);
    }
    out = JSON.stringify(op === "batches_delete" ? json : publicBatch(json, meta, publicOrigin(ctx)));
  }
  rec(h.res.status);
  recordKeySuccess(cand.key);
  logOutcome(ctx, { status: "SUCCESS", httpStatus: h.res.status, usage: emptyUsage(), ttftMs: Date.now() - t0 });
  return { kind: "response", response: withCommon(ctx, new Response(h.res.status === 204 ? null : out, { status: h.res.status, headers })) };
}

/**
 * A JSONL download passed through as it streams (results of an Anthropic batch, the output / error file of an OpenAI
 * batch) with the upstream model masked on every line. Client abort aborts the upstream; a completed download triggers
 * the metering of the batch.
 */
export function maskedJsonl(ctx: Ctx, cand: Candidate, h: UpstreamHandle, t0: number, rec: Rec, meta: BatchMeta, row: UpstreamObject): AttemptResult {
  const settings = ctx.snap!.settings;
  rec(h.res.status);
  recordKeySuccess(cand.key);
  ctx.deferRelease = true;
  const src = h.res.body as ReadableStream<Uint8Array> | null;
  const hdr = new Headers({ "content-type": h.res.headers.get("content-type") ?? "application/binary", "cache-control": "no-store" });
  forwardUpstreamHeaders(h.res.headers, hdr, { rateLimits: settings.passUpstreamRateLimits, media: true });
  hdr.delete("content-length"); // lines are rewritten
  if (!src) {
    h.dispose();
    ctx.deferRelease = false;
    logOutcome(ctx, { status: "SUCCESS", httpStatus: h.res.status, usage: emptyUsage() });
    return { kind: "response", response: withCommon(ctx, new Response(null, { status: h.res.status, headers: hdr })) };
  }
  const session = new StreamSession({
    body: src.pipeThrough(lineMapper((line) => maskLine(line, meta))),
    processor: null,
    abort: h.abort,
    signal: h.signal,
    startedAt: t0,
    onFinish: (info) => {
      h.dispose();
      releaseAll(ctx);
      finishLog(ctx, cand, info, emptyUsage(), "batch results");
      if (info.reason === "completed" && isEnded(meta.fmt, row.status ?? statusOf(meta.fmt, meta.object))) void meterBatch(row.id).catch((err) => logger.error("batch metering failed", { batchId: row.upstreamId, err }));
    },
  });
  return { kind: "response", response: withCommon(ctx, new Response(session.toReadable(), { status: h.res.status, headers: hdr })) };
}

/** Upstream model -> public slug inside one result line (Anthropic `result.message.model`, OpenAI `response.body.model`). */
export function maskLine(line: string, meta: BatchMeta): string {
  if (!line.trim() || !meta.models.some((m) => m.mask && m.upstreamModel !== m.slug)) return line;
  const obj = safeJsonParse<Json>(line);
  if (!isObject(obj)) return line;
  const target = isObject(obj.result) && isObject(obj.result.message) ? obj.result.message : isObject(obj.response) && isObject(obj.response.body) ? obj.response.body : null;
  if (!target || typeof target.model !== "string") return line;
  const masked = maskModel(meta, target.model);
  if (masked === target.model) return line;
  target.model = masked;
  return JSON.stringify(obj);
}

/** A byte stream transformed line by line (newlines kept as they were). */
function lineMapper(fn: (line: string) => string): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  return new TransformStream({
    transform(chunk, c) {
      buf += dec.decode(chunk, { stream: true });
      const i = buf.lastIndexOf("\n");
      if (i < 0) return;
      const done = buf.slice(0, i + 1);
      buf = buf.slice(i + 1);
      c.enqueue(enc.encode(done.split("\n").map((l, k, all) => (k === all.length - 1 ? l : fn(l.replace(/\r$/, "")) + (l.endsWith("\r") ? "\r" : ""))).join("\n")));
    },
    flush(c) {
      buf += dec.decode();
      if (buf) c.enqueue(enc.encode(fn(buf)));
    },
  });
}

// ------------------------------------------------------------------ listings (served from our records)
function pageSize(raw: string | null, dflt: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.trunc(n)) : dflt;
}

async function listBatches(ctx: Ctx): Promise<Response> {
  const fmt = fmtOf(ctx);
  const q = ctx.url.searchParams;
  const rows = (await db.upstreamObject.findMany({ where: { userId: ctx.auth!.user.id, kind: "batch" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_LIST })).filter((r) => metaOf(r).fmt === fmt && isObject(metaOf(r).object));
  let items = rows;
  const origin = publicOrigin(ctx);
  let body: Json;
  const page = async (sel: UpstreamObject[]) => (await refreshOpen(ctx.snap!, sel)).map((r) => publicBatch(metaOf(r).object!, metaOf(r), origin));
  if (fmt === "anthropic_batches") {
    const size = pageSize(q.get("limit"), 20, 1000);
    const after = q.get("after_id");
    const before = q.get("before_id");
    if (after) {
      const i = items.findIndex((x) => x.upstreamId === after);
      items = i >= 0 ? items.slice(i + 1) : [];
    }
    if (before) {
      const i = items.findIndex((x) => x.upstreamId === before);
      items = i >= 0 ? items.slice(Math.max(0, i - size), i) : [];
    }
    const sel = items.slice(0, size);
    body = { data: await page(sel), has_more: items.length > size, first_id: sel[0]?.upstreamId ?? null, last_id: sel[sel.length - 1]?.upstreamId ?? null };
  } else {
    const after = q.get("after");
    if (after) {
      const i = items.findIndex((x) => x.upstreamId === after);
      items = i >= 0 ? items.slice(i + 1) : [];
    }
    const size = pageSize(q.get("limit"), 20, 100);
    const sel = items.slice(0, size);
    body = { object: "list", data: await page(sel), first_id: sel[0]?.upstreamId ?? null, last_id: sel[sel.length - 1]?.upstreamId ?? null, has_more: items.length > size };
  }
  logOutcome(ctx, { status: "SUCCESS", httpStatus: 200, usage: emptyUsage() });
  return withCommon(ctx, new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }));
}

/** Best effort: re-read the batches of a listing page that have not ended yet (short timeout; stale records are served on failure). */
async function refreshOpen(snap: ConfigSnapshot, rows: UpstreamObject[]): Promise<UpstreamObject[]> {
  return Promise.all(
    rows.map(async (r) => {
      if (isEnded(metaOf(r).fmt, r.status)) return r;
      const obj = await fetchObject(snap, r, 5_000).catch(() => null);
      return obj ? refreshRecord(r, obj) : r;
    }),
  );
}

async function fetchObject(snap: ConfigSnapshot, row: UpstreamObject, timeoutMs?: number): Promise<JsonObject | null> {
  const acc = accountOf(snap, row.providerId, row.providerKeyId);
  if (!acc) return null;
  const meta = metaOf(row);
  const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const h = await direct(acc, meta.fmt, "batches_get", { objectId: row.upstreamId, signal });
  const text = await readTextLimited(h.res, 16 * 1024 * 1024);
  h.dispose();
  const obj = safeJsonParse<Json>(text);
  return h.res.status === 200 && isObject(obj) ? obj : null;
}

// ------------------------------------------------------------------ metering
/** Deterministic RequestLog id of one batch result (re-metering the same result is a no-op). */
export function batchLogId(batchId: string, customId: string): string {
  return `b${createHash("sha256").update(`${batchId}:${customId}`).digest("hex").slice(0, 24)}`;
}

async function* jsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield safeJsonParse<Json>(line);
    }
  }
  buf += dec.decode();
  if (buf.trim()) yield safeJsonParse<Json>(buf.trim());
}

interface ResultOutcome {
  customId: string;
  upstreamModel: string | null;
  usage: Usage | null;
  status: "SUCCESS" | "CLIENT_ERROR" | "UPSTREAM_ERROR" | "CANCELLED";
  httpStatus: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export function anthropicResult(line: Json): ResultOutcome | null {
  if (!isObject(line) || typeof line.custom_id !== "string" || !isObject(line.result)) return null;
  const r = line.result;
  const base = { customId: line.custom_id, upstreamModel: null as string | null, usage: null as Usage | null, errorCode: null as string | null, errorMessage: null as string | null };
  switch (r.type) {
    case "succeeded": {
      const msg = isObject(r.message) ? r.message : {};
      return { ...base, upstreamModel: typeof msg.model === "string" ? msg.model : null, usage: usageFromAnthropic(msg.usage), status: "SUCCESS", httpStatus: 200 };
    }
    case "errored": {
      const err = isObject(r.error) && isObject(r.error.error) ? r.error.error : isObject(r.error) ? r.error : {};
      const type = typeof err.type === "string" ? err.type : "api_error";
      const client = type === "invalid_request_error" || type === "not_found_error" || type === "permission_error";
      return { ...base, status: client ? "CLIENT_ERROR" : "UPSTREAM_ERROR", httpStatus: client ? 400 : 500, errorCode: type, errorMessage: typeof err.message === "string" ? err.message : null };
    }
    case "canceled":
      return { ...base, status: "CANCELLED", httpStatus: 499, errorCode: "batch_canceled", errorMessage: "The batch was canceled before this request ran." };
    case "expired":
      return { ...base, status: "CANCELLED", httpStatus: 408, errorCode: "batch_expired", errorMessage: "The batch expired before this request ran." };
    default:
      return null;
  }
}

export function openaiResult(line: Json, endpoint: string | undefined): ResultOutcome | null {
  if (!isObject(line) || typeof line.custom_id !== "string") return null;
  const base = { customId: line.custom_id, upstreamModel: null as string | null, usage: null as Usage | null, errorCode: null as string | null, errorMessage: null as string | null };
  const resp = isObject(line.response) ? line.response : null;
  const code = resp ? Number(resp.status_code) : 0;
  const rb = resp && isObject(resp.body) ? resp.body : null;
  if (resp && code >= 200 && code < 300 && rb) {
    const usage = endpoint === "/v1/responses" ? usageFromResponsesObject(rb) : usageFromOpenAI(rb.usage);
    return { ...base, upstreamModel: typeof rb.model === "string" ? rb.model : null, usage, status: "SUCCESS", httpStatus: code };
  }
  const err = rb && isObject(rb.error) ? rb.error : isObject(line.error) ? line.error : {};
  const status = code || 500;
  const errCode = typeof err.code === "string" ? err.code : null;
  if (errCode === "batch_expired" || errCode === "batch_cancelled") return { ...base, status: "CANCELLED", httpStatus: errCode === "batch_expired" ? 408 : 499, errorCode: errCode, errorMessage: typeof err.message === "string" ? err.message : null };
  return { ...base, status: status >= 500 ? "UPSTREAM_ERROR" : "CLIENT_ERROR", httpStatus: status, errorCode: errCode ?? (typeof err.type === "string" ? err.type : "batch_error"), errorMessage: typeof err.message === "string" ? err.message : null };
}

function modelOfResult(meta: BatchMeta, r: ResultOutcome): BatchModel | null {
  if (meta.models.length === 1) return meta.models[0];
  const idx = meta.customIdModels?.[r.customId];
  if (idx !== undefined && meta.models[idx]) return meta.models[idx];
  return meta.models.find((m) => m.upstreamModel === r.upstreamModel) ?? meta.models[0] ?? null;
}

/**
 * Meter every result of an ended batch exactly once (deterministic RequestLog ids + skipDuplicates in the meter writer),
 * then release its hold. Safe to call concurrently (claim with a 10 minute lease) and repeatedly. Never throws for an
 * already metered / unknown batch; returns the number of results recorded in this run.
 */
export async function meterBatch(rowId: string): Promise<number> {
  const now = new Date();
  const claimed = await db.upstreamObject.updateMany({
    where: { id: rowId, kind: "batch", meteredAt: null, OR: [{ meterClaimedAt: null }, { meterClaimedAt: { lt: new Date(now.getTime() - CLAIM_STALE_MS) } }] },
    data: { meterClaimedAt: now },
  });
  if (!claimed.count) return 0;
  const row = await db.upstreamObject.findUnique({ where: { id: rowId } });
  if (!row) return 0;
  const meta = metaOf(row);
  try {
    const snap = await getConfig();
    const acc = accountOf(snap, row.providerId, row.providerKeyId);
    if (!acc) throw new Error("the upstream account holding the batch is gone");
    const n = await meterResults(snap, acc, row, meta);
    await flushMeter();
    await db.upstreamObject.update({ where: { id: row.id }, data: { meteredAt: new Date(), meterClaimedAt: null } });
    if (meta.holdId) releaseHold({ id: meta.holdId, userId: row.userId, keyId: row.apiKeyId, backend: meta.holdBackend === "memory" ? "memory" : "redis", createdAt: row.createdAt.getTime() });
    if (meta.rewrittenFileId) void direct(acc, "openai_files", "files_delete", { objectId: meta.rewrittenFileId, method: "DELETE" }).then((h) => h.dispose(), () => undefined);
    logger.info("batch metered", { batchId: row.upstreamId, results: n });
    return n;
  } catch (err) {
    await db.upstreamObject.update({ where: { id: row.id }, data: { meterClaimedAt: null } }).catch(() => undefined);
    throw err;
  }
}

async function meterResults(snap: ConfigSnapshot, acc: Account, row: UpstreamObject, meta: BatchMeta): Promise<number> {
  const sources: Array<{ format: InboundFormat; op: Operation; objectId: string; parse: (l: Json) => ResultOutcome | null }> = [];
  if (meta.fmt === "anthropic_batches") sources.push({ format: "anthropic_batches", op: "batches_results", objectId: row.upstreamId, parse: anthropicResult });
  else {
    const obj = meta.object ?? {};
    for (const f of [obj.output_file_id, obj.error_file_id]) if (typeof f === "string" && f) sources.push({ format: "openai_files", op: "files_content", objectId: f, parse: (l) => openaiResult(l, meta.endpoint) });
  }
  const endpoint = meta.fmt === "anthropic_batches" ? "/v1/messages/batches" : "/v1/batches";
  const multiplier = new Decimal(meta.multiplier || "1");
  let n = 0;
  for (const s of sources) {
    const h = await direct(acc, s.format, s.op, { objectId: s.objectId });
    if (h.res.status !== 200 || !h.res.body) {
      const t = await readErrorBody(h.res);
      h.dispose();
      throw new Error(`batch results download ${h.res.status}: ${t.slice(0, 300)}`);
    }
    try {
      for await (const line of jsonLines(h.res.body as ReadableStream<Uint8Array>)) {
        const r = s.parse(line);
        if (!r) continue;
        const bm = modelOfResult(meta, r);
        const model = bm ? (snap.modelsById.get(bm.modelId) ?? snap.modelsBySlug.get(bm.slug) ?? null) : null;
        const route = bm && model ? ((snap.routesByModel.get(model.id) ?? []).find((x) => x.id === bm.routeId) ?? null) : null;
        recordOutcome({
          requestId: batchLogId(row.upstreamId, r.customId),
          startedAt: row.createdAt.getTime(),
          ip: null,
          userAgent: null,
          endpoint,
          inboundFormat: meta.fmt,
          stream: false,
          auth: null,
          owner: { userId: row.userId, apiKeyId: row.apiKeyId },
          groupSlug: meta.groupSlug,
          model,
          route: route ?? (bm ? ({ ...providerRoute(acc.provider), id: bm.routeId, upstreamModel: bm.upstreamModel } as RouteRec) : null),
          providerKeyId: row.providerKeyId,
          providerKeyHasTpm: false,
          multiplier,
          status: r.status,
          httpStatus: r.httpStatus,
          errorCode: r.errorCode,
          errorMessage: r.errorMessage,
          internalError: `batch ${row.upstreamId} custom_id ${r.customId}${model ? "" : " | model no longer exists: not priced"}`,
          usage: r.status === "SUCCESS" ? r.usage : null,
          ttftMs: null,
          queueMs: 0,
          attempts: [],
          logBodies: false,
          batchId: row.upstreamId,
          billable: r.status === "SUCCESS",
        });
        n++;
      }
    } finally {
      h.dispose();
    }
  }
  return n;
}

/**
 * Cron: poll the batches that are not metered yet, record their state, meter the ended ones and keep the holds of the
 * running ones in place. Returns counts for the cron log.
 */
export async function sweepBatches(limit = 200): Promise<{ polled: number; metered: number; failed: number }> {
  const rows = await db.upstreamObject.findMany({ where: { kind: "batch", meteredAt: null }, orderBy: { createdAt: "asc" }, take: limit });
  if (!rows.length) return { polled: 0, metered: 0, failed: 0 };
  const snap = await getConfig();
  let polled = 0;
  let metered = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      let row = r;
      const meta = metaOf(row);
      if (!isEnded(meta.fmt, row.status)) {
        const obj = await fetchObject(snap, row, 30_000);
        polled++;
        if (obj) row = await refreshRecord(row, obj);
      }
      if (isEnded(meta.fmt, row.status)) {
        await meterBatch(row.id);
        metered++;
      } else if (meta.holdId) {
        await restoreHold({ id: meta.holdId, userId: row.userId, keyId: row.apiKeyId, backend: meta.holdBackend === "memory" ? "memory" : "redis", createdAt: row.createdAt.getTime() }, new Decimal(meta.holdAmount || "0"), BATCH_HOLD_TTL_MS);
      }
    } catch (err) {
      failed++;
      logger.warn("batch sweep failed for one batch", { batchId: r.upstreamId, err });
    }
  }
  return { polled, metered, failed };
}
