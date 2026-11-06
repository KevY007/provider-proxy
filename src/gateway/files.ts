import { randomBytes } from "node:crypto";
import type { Prisma, UpstreamObject } from "@/generated/prisma/client";
import { decrypt, encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Decimal } from "@/lib/money";
import type { ConfigSnapshot, GroupRec, ModelRec, ProviderRec, RouteRec } from "./cache";
import { inboundBody, requestEncodings } from "./bodyin";
import { logOutcome, withCommon, type Ctx } from "./context";
import { GatewayError } from "./errors";
import { ensureMetered, handleBatchOk, maskedJsonl, type BatchMeta } from "./batches";
import { execute, handleBinary, type AttemptResult, type Fail, type Rec } from "./execute";
import type { GeneratedFile } from "./generated-files";
import { forwardUpstreamHeaders } from "./headers";
import { recordKeySuccess } from "./keyhealth";
import { buildUpstreamHeaders, buildUpstreamUrl } from "./providers/adapters";
import type { InboundFormat, Json, JsonObject, Operation } from "./types";
import { emptyUsage } from "./types";
import { costTable, effectiveMultiplier } from "./pricing";
import { orderRoutes, type Candidate, type RoutePlan } from "./select";
import { BodySpool, SpoolLimitError } from "./spool";
import type { Prepared } from "./shape";
import { readTextLimited, type UpstreamHandle } from "./upstream";
import { describeNetworkError, isObject, safeJsonParse } from "./util";

/**
 * Files APIs passthrough (PLAN 5c): OpenAI `/v1/files` (+content) and `/v1/uploads` (+parts / complete / cancel),
 * Anthropic `/v1/files`, Gemini resumable upload `/upload/v1beta/files` + `/v1beta/files`.
 *
 * These are STATEFUL: a file lives on exactly one upstream account (provider key). Every created object is recorded in
 * `UpstreamObject` (owner = the customer) so that
 *   - later calls on the object are pinned to that account,
 *   - requests that REFERENCE a file (`file_id` / `fileData.fileUri` in chat / responses / messages / generateContent
 *     bodies) are routed to that account too,
 *   - other customers get a native 404 for it (listings are served from our own records, never from the shared
 *     upstream account).
 * The request body is streamed to the upstream untouched (uploads of any size). Storage is free unless an admin creates
 * a hidden model with slug `files` and a requestPrice / route requestCost.
 */
export interface FilesState {
  /** The UPSTREAM id of the object the call targets (file id / upload id / Gemini `files/xyz`). */
  upstreamId?: string;
  /** Owned object the call is pinned to. */
  row?: UpstreamObject;
  /** Gemini resumable upload: the upstream session URL a data request is forwarded to. */
  sessionUrl?: string;
  /** Small JSON bodies are buffered (failover-safe); everything else is streamed once. */
  buffered?: Buffer | null;
  streamed: boolean;
  declaredLength?: number | null;
}

const OWNED_FILE_OPS = new Set<Operation>(["files_get", "files_delete", "files_content", "gfiles_get", "gfiles_delete"]);
const OWNED_CONTAINER_FILE_OPS = new Set<Operation>(["containers_file_get", "containers_file_content"]);
const OWNED_UPLOAD_OPS = new Set<Operation>(["uploads_part", "uploads_complete", "uploads_cancel"]);
const CREATE_OPS = new Set<Operation>(["files_create", "uploads_create", "gfiles_upload"]);
const MAX_SMALL_BODY = 64 * 1024 * 1024;
const MAX_LIST = 5000;

const fmtOf = (ctx: Ctx): InboundFormat => ctx.path!.format as InboundFormat;

// ------------------------------------------------------------------ errors
function notFound(ctx: Ctx, what: "file" | "upload", id: string): GatewayError {
  const fmt = fmtOf(ctx);
  const message = fmt === "anthropic_files" ? `File not found: ${id}` : fmt === "gemini_files" ? `File ${id} was not found.` : `No such ${what === "upload" ? "Upload" : "File"} object: ${id}`;
  return new GatewayError("not_found", message, { param: "id", internal: `${what} '${id}' is not owned by the caller (or unknown)` });
}

// ------------------------------------------------------------------ routes
/** A zero-priced stand-in route on provider `p` (calls that are not model requests: files, batch management). */
export function providerRoute(p: ProviderRec): RouteRec {
  return zeroRoute(p);
}

function zeroRoute(p: ProviderRec): RouteRec {
  return {
    id: `files:${p.id}`,
    modelId: "files",
    providerId: p.id,
    provider: p,
    upstreamModel: "files",
    label: null,
    priority: 0,
    weight: 1,
    groupSlugs: [],
    paramOverrides: {},
    maxOutputTokens: null,
    cost: costTable({ inputCost: 0, outputCost: 0 }),
    batchCostDiscountPct: new Decimal(50),
  };
}

/** Routes for a Files call: the hidden `files` model's routes when an admin priced it, otherwise every active provider speaking the format. */
function filesRoutes(snap: ConfigSnapshot, group: GroupRec | null, format: InboundFormat, model: ModelRec | null): RoutePlan[] {
  const out: RoutePlan[] = [];
  if (model) {
    for (const route of snap.routesByModel.get(model.id) ?? []) {
      const p = route.provider;
      if (p.status !== "ACTIVE" || !p.formats.has(format)) continue;
      if (group?.providerTags.length && !p.tags.some((t) => group.providerTags.includes(t))) continue;
      out.push({ route, plan: { mode: "native", upstream: format } });
    }
    return out;
  }
  for (const p of snap.providers.values()) {
    if (p.status !== "ACTIVE" || !p.formats.has(format)) continue;
    if (group?.providerTags.length && !p.tags.some((t) => group.providerTags.includes(t))) continue;
    out.push({ route: zeroRoute(p), plan: { mode: "native", upstream: format } });
  }
  return out;
}

// ------------------------------------------------------------------ entry
export async function handleRaw(ctx: Ctx): Promise<Response> {
  const path = ctx.path!;
  const snap = ctx.snap!;
  const user = ctx.auth!.user;
  ctx.multiplier = effectiveMultiplier(user.priceMultiplier, ctx.group?.priceMultiplier);
  if (path.op === "files_list" || path.op === "gfiles_list") return listFiles(ctx);

  const st: FilesState = { streamed: false };
  ctx.files = st;
  let row: UpstreamObject | null = null;
  if (OWNED_FILE_OPS.has(path.op)) row = await owned(ctx, "file", path.objectId!);
  else if (OWNED_CONTAINER_FILE_OPS.has(path.op)) row = await owned(ctx, "container_file", path.objectId!);
  else if (OWNED_UPLOAD_OPS.has(path.op)) row = await owned(ctx, "upload", path.objectId!);
  else if (path.op === "gfiles_upload") {
    const uploadId = ctx.url.searchParams.get("upload_id");
    if (uploadId) {
      row = await owned(ctx, "gemini_upload", uploadId);
      const stored = typeof metaOf(row).url === "string" ? (metaOf(row).url as string) : null;
      // (encrypted at rest: the upstream session URL may carry credentials; older rows hold it in plain text)
      const url = stored && stored.startsWith("enc:") ? safeDecrypt(stored.slice(4)) : stored;
      if (!url) throw notFound(ctx, "file", uploadId);
      st.sessionUrl = url;
    }
  }
  if (row && path.op === "files_delete" && typeof metaOf(row).batchOutputOf === "string") {
    // the results of a batch are billed from this file: it can only go once the batch is metered
    const batch = await db.upstreamObject.findFirst({ where: { kind: "batch", upstreamId: metaOf(row).batchOutputOf as string, providerId: row.providerId } });
    if (batch) await ensureMetered(batch);
  }
  if (row) {
    st.row = row;
    st.upstreamId = row.kind === "gemini_upload" ? undefined : row.upstreamId;
  }

  const filesModel = snap.modelsBySlug.get("files") ?? null;
  if (filesModel) ctx.model = filesModel;
  let routes = orderRoutes(filesRoutes(snap, ctx.group, path.format as InboundFormat, filesModel));
  if (row) routes = routes.filter((r) => r.route.providerId === row!.providerId);
  if (!routes.length) {
    throw new GatewayError("unsupported_endpoint", "File uploads are not available on this API.", { internal: `no active provider speaks ${path.format}` });
  }

  await readRawBody(ctx, st);
  const prefer = !row && CREATE_OPS.has(path.op) ? await affinityKey(user.id, path.format as InboundFormat) : null;
  return execute(ctx, routes, { pinKeyId: row?.providerKeyId ?? null, preferKeyId: prefer, maxAttempts: st.streamed ? 1 : undefined });
}

async function owned(ctx: Ctx, kind: "file" | "upload" | "gemini_upload" | "container_file", id: string): Promise<UpstreamObject> {
  const row = await db.upstreamObject.findFirst({ where: { kind, upstreamId: id, userId: ctx.auth!.user.id } });
  if (!row) throw notFound(ctx, kind === "upload" ? "upload" : "file", id);
  return row;
}

/** The upstream account that already holds this customer's files of this format (new uploads prefer it, so their files stay together). */
async function affinityKey(userId: string, format: InboundFormat): Promise<string | null> {
  const rows = await db.upstreamObject.findMany({ where: { userId, kind: { in: ["file", "upload"] } }, orderBy: { createdAt: "desc" }, take: 20 });
  for (const r of rows) if (metaOf(r).fmt === format) return r.providerKeyId;
  return null;
}

function safeDecrypt(v: string): string | null {
  try {
    return decrypt(v);
  } catch {
    return null;
  }
}

const metaOf = (r: { meta: unknown }): JsonObject => (isObject(r.meta) ? (r.meta as JsonObject) : {});

// ------------------------------------------------------------------ request body
function limitBytes(ctx: Ctx): number | undefined {
  const mb = ctx.snap!.settings.maxRequestBodyMb;
  return mb > 0 ? mb * 1024 * 1024 : undefined;
}

/** A stream that errors with SpoolLimitError once more than `limit` bytes passed. */
function limited(stream: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      const r = await reader.read();
      if (r.done) return c.close();
      total += r.value.byteLength;
      if (total > limit) return c.error(new SpoolLimitError(limit));
      c.enqueue(r.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

async function readRawBody(ctx: Ctx, st: FilesState): Promise<void> {
  const m = ctx.req.method.toUpperCase();
  if (m === "GET" || m === "DELETE" || m === "HEAD") return;
  const stream = inboundBody(ctx.req);
  if (!stream) return;
  const ct = ctx.req.headers.get("content-type") ?? "";
  const limit = limitBytes(ctx);
  if (/json/i.test(ct)) {
    try {
      const spool = await BodySpool.fromStream(stream, { maxBytes: Math.min(limit ?? MAX_SMALL_BODY, MAX_SMALL_BODY), memLimit: MAX_SMALL_BODY });
      st.buffered = await spool.toBuffer();
      await spool.dispose();
    } catch (e) {
      if (e instanceof SpoolLimitError) throw new GatewayError("payload_too_large", `Request body exceeds the ${Math.round(e.limit / 1048576)}MB limit.`);
      if (ctx.req.signal.aborted) throw new GatewayError("client_closed");
      throw new GatewayError("invalid_request", "Could not read the request body.");
    }
    return;
  }
  // everything else (multipart file uploads, binary chunks) is streamed straight to the upstream, once
  const lenHeader = ctx.req.headers.get("content-length");
  const declared = lenHeader === null || lenHeader.trim() === "" ? NaN : Number(lenHeader); // (Number(null) is 0: a chunked upload has NO declared length)
  if (limit && !requestEncodings(ctx.req.headers) && Number.isFinite(declared) && declared > limit) {
    throw new GatewayError("payload_too_large", `Request body exceeds the ${Math.round(limit / 1048576)}MB limit.`);
  }
  ctx.rawBody = limit ? limited(stream, limit) : stream;
  st.streamed = true;
  st.declaredLength = requestEncodings(ctx.req.headers) || !Number.isFinite(declared) ? null : declared;
}

/** Query string forwarded upstream: the customer's own parameters, never their API key. */
function forwardQuery(ctx: Ctx, drop: string[] = []): string {
  const q = new URLSearchParams(ctx.url.searchParams);
  q.delete("key");
  for (const k of drop) q.delete(k);
  return q.toString();
}

/** Build the upstream request of a Files call. */
export function prepareRawUpstream(ctx: Ctx, cand: Candidate, secret: string): Prepared {
  const path = ctx.path!;
  const st = ctx.files!;
  const provider = cand.route.provider;
  const format = cand.plan.upstream;
  const op = path.op;
  const ct = ctx.req.headers.get("content-type");
  const hasBody = !!st.buffered || !!ctx.rawBody;

  let url: string;
  if (st.sessionUrl) {
    // Gemini resumable upload, data phase: the session URL the upstream handed out (same origin as the provider only)
    const target = new URL(st.sessionUrl);
    const root = new URL(buildUpstreamUrl({ provider, format, op, upstreamModel: "files", stream: false, keyExtra: cand.key.extra, secret }));
    if (target.origin !== root.origin) throw new GatewayError("not_found", "The upload session is no longer valid.", { internal: "gemini upload session URL points to a foreign origin" });
    url = target.toString();
  } else {
    const q = forwardQuery(ctx);
    url = buildUpstreamUrl({ provider, format, op, upstreamModel: "files", stream: false, keyExtra: cand.key.extra, objectId: st.upstreamId, query: q || undefined, secret });
  }
  const headers = buildUpstreamHeaders({ provider, format, secret, stream: false, keyExtra: cand.key.extra, inbound: ctx.req.headers, clientUserAgent: ctx.auth?.key.userAgent ?? null, contentType: hasBody ? ct : null, hasBody, op });
  let body: Prepared["body"] = null;
  if (st.buffered) body = st.buffered;
  else if (ctx.rawBody) {
    body = ctx.rawBody;
    if (st.declaredLength !== null && st.declaredLength !== undefined && Number.isFinite(st.declaredLength)) headers["content-length"] = String(st.declaredLength);
  }
  return { url, method: ctx.req.method.toUpperCase(), headers, body, upstreamFormat: format, upstreamOp: op };
}

// ------------------------------------------------------------------ successful upstream answer
function publicOrigin(ctx: Ctx): string {
  const h = ctx.req.headers;
  const proto = (h.get("x-forwarded-proto") ?? ctx.url.protocol.replace(":", "")).split(",")[0].trim();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? ctx.url.host).split(",")[0].trim();
  return `${proto}://${host}`;
}

async function register(ctx: Ctx, cand: Candidate, kind: "file" | "upload" | "gemini_upload", upstreamId: string, meta: Json): Promise<void> {
  const providerId = cand.route.providerId;
  const value = meta as Prisma.InputJsonValue;
  try {
    await db.upstreamObject.upsert({
      where: { kind_upstreamId_providerId: { kind, upstreamId, providerId } },
      create: { kind, upstreamId, providerId, providerKeyId: cand.key.id, userId: ctx.auth!.user.id, apiKeyId: ctx.auth!.key.id, meta: value },
      update: { meta: value },
    });
  } catch (err) {
    logger.error("could not record upstream object", { requestId: ctx.requestId, kind, upstreamId, err });
  }
}

async function unregister(ctx: Ctx, cand: Candidate, kind: string, upstreamId: string): Promise<void> {
  await db.upstreamObject.deleteMany({ where: { kind, upstreamId, providerId: cand.route.providerId, userId: ctx.auth!.user.id } }).catch(() => undefined);
}

/**
 * Files the upstream created while serving a model request (code execution outputs, code-interpreter container files):
 * record them as owned by the calling customer and pinned to the upstream account that served the request, so
 * `GET /v1/files/{id}` + `/content` (or `/v1/containers/...`) work through the gateway and nobody else can read them.
 * Never takes over a row that already exists (a foreign id stays foreign). Never throws.
 */
export async function registerGeneratedFiles(ctx: Ctx, cand: Candidate, found: GeneratedFile[]): Promise<void> {
  if (!found.length || !ctx.auth) return;
  try {
    await db.upstreamObject.createMany({
      data: found.map((f) => ({
        kind: f.kind,
        upstreamId: f.id,
        providerId: cand.route.providerId,
        providerKeyId: cand.key.id,
        userId: ctx.auth!.user.id,
        apiKeyId: ctx.auth!.key.id,
        meta: { fmt: f.fmt, generated: true, ...(f.filename ? { filename: f.filename } : {}), requestId: ctx.requestId } as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
  } catch (err) {
    logger.error("could not record generated files", { requestId: ctx.requestId, count: found.length, err });
  }
}

export async function handleFilesOk(ctx: Ctx, cand: Candidate, h: UpstreamHandle, t0: number, rec: Rec, fail: Fail): Promise<AttemptResult> {
  const path = ctx.path!;
  const op = path.op;
  const fmt = cand.plan.upstream;
  const settings = ctx.snap!.settings;
  if (op.startsWith("batches_")) return handleBatchOk(ctx, cand, h, t0, rec, fail);
  if (op === "files_content" && ctx.files?.row && typeof metaOf(ctx.files.row).batchOutputOf === "string") {
    // output / error file of an OpenAI batch: the upstream model is masked on every line
    const batch = await db.upstreamObject.findFirst({ where: { kind: "batch", upstreamId: metaOf(ctx.files.row).batchOutputOf as string, providerId: ctx.files.row.providerId } });
    if (batch) return maskedJsonl(ctx, cand, h, t0, rec, batch.meta as unknown as BatchMeta, batch);
  }
  if (op === "files_content" || op === "containers_file_content") return handleBinary(ctx, cand, h, t0, rec, true);

  const timer = setTimeout(() => h.abort(), cand.route.provider.timeoutMs);
  let text: string;
  try {
    text = await readTextLimited(h.res, 256 * 1024 * 1024);
  } catch (err) {
    clearTimeout(timer);
    h.dispose();
    if (ctx.req.signal.aborted) throw new GatewayError("client_closed");
    return fail("network", 0, `failed reading upstream response: ${describeNetworkError(err)}`);
  }
  clearTimeout(timer);
  h.dispose();

  const json = safeJsonParse<Json>(text);
  const headers = new Headers({ "content-type": h.res.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "no-store" });
  forwardUpstreamHeaders(h.res.headers, headers, { rateLimits: settings.passUpstreamRateLimits, upload: true });

  // ---- keep our records in step with what the upstream just did
  if (op === "gfiles_upload") {
    const url = h.res.headers.get("x-goog-upload-url");
    if (url) {
      const id = `gup_${randomBytes(18).toString("base64url")}`;
      await register(ctx, cand, "gemini_upload", id, { fmt, url: `enc:${encrypt(url)}` });
      headers.set("x-goog-upload-url", `${publicOrigin(ctx)}/upload/v1beta/files?upload_id=${id}&upload_protocol=resumable`);
    }
    const file = isObject(json) && isObject(json.file) ? json.file : null;
    if (file && typeof file.name === "string") await register(ctx, cand, "file", file.name, { fmt, object: file });
  } else if (isObject(json)) {
    const id = typeof json.id === "string" ? json.id : null;
    switch (op) {
      case "files_create":
      case "files_get":
        if (id) await register(ctx, cand, "file", id, { fmt, object: json });
        break;
      case "uploads_create":
        if (id) await register(ctx, cand, "upload", id, { fmt, object: json });
        break;
      case "uploads_complete":
        if (isObject(json.file) && typeof json.file.id === "string") await register(ctx, cand, "file", json.file.id, { fmt, object: json.file });
        break;
      case "gfiles_get": {
        const file = isObject(json.file) ? json.file : json;
        if (typeof file.name === "string") await register(ctx, cand, "file", file.name, { fmt, object: file });
        break;
      }
      default:
    }
  }
  if ((op === "files_delete" || op === "gfiles_delete") && ctx.files?.row) await unregister(ctx, cand, "file", ctx.files.row.upstreamId);

  rec(h.res.status);
  recordKeySuccess(cand.key);
  logOutcome(ctx, { status: "SUCCESS", httpStatus: h.res.status, usage: emptyUsage(), ttftMs: Date.now() - t0 });
  return { kind: "response", response: withCommon(ctx, new Response(h.res.status === 204 || h.res.status === 304 ? null : text, { status: h.res.status, headers })) };
}

/** Minimal listing entry of a generated file (replaced by the upstream's own object once someone fetched its metadata). */
function generatedFileObject(r: UpstreamObject, fmt: InboundFormat): JsonObject {
  const filename = typeof metaOf(r).filename === "string" ? (metaOf(r).filename as string) : r.upstreamId;
  if (fmt === "anthropic_files") return { id: r.upstreamId, type: "file", filename, mime_type: "application/octet-stream", size_bytes: 0, created_at: r.createdAt.toISOString(), downloadable: true };
  if (fmt === "gemini_files") return { name: r.upstreamId, displayName: filename, createTime: r.createdAt.toISOString() };
  return { id: r.upstreamId, object: "file", bytes: 0, created_at: Math.floor(r.createdAt.getTime() / 1000), filename, purpose: "assistants_output", status: "processed", status_details: null };
}

// ------------------------------------------------------------------ listings (served from our records)
function pageSize(raw: string | null, dflt: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.trunc(n)) : dflt;
}

async function listFiles(ctx: Ctx): Promise<Response> {
  const fmt = fmtOf(ctx);
  const q = ctx.url.searchParams;
  const rows = await db.upstreamObject.findMany({ where: { userId: ctx.auth!.user.id, kind: "file" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_LIST });
  let items = rows.flatMap((r) => {
    const m = metaOf(r);
    if (m.fmt !== fmt) return [];
    if (isObject(m.object)) return [{ row: r, obj: m.object as JsonObject }];
    // a file the upstream created for the customer (code execution output): listed from what we know until its metadata was fetched
    return m.generated === true ? [{ row: r, obj: generatedFileObject(r, fmt) }] : [];
  });
  let body: Json;
  if (fmt === "gemini_files") {
    const size = pageSize(q.get("pageSize"), 10, 100);
    const start = Math.max(0, Number(q.get("pageToken")) || 0);
    const page = items.slice(start, start + size);
    body = { files: page.map((i) => i.obj), ...(start + size < items.length ? { nextPageToken: String(start + size) } : {}) };
  } else if (fmt === "anthropic_files") {
    const size = pageSize(q.get("limit"), 20, 1000);
    const after = q.get("after_id");
    const before = q.get("before_id");
    if (after) {
      const i = items.findIndex((x) => x.row.upstreamId === after);
      items = i >= 0 ? items.slice(i + 1) : [];
    }
    if (before) {
      const i = items.findIndex((x) => x.row.upstreamId === before);
      items = i >= 0 ? items.slice(Math.max(0, i - size), i) : [];
    }
    const page = items.slice(0, size);
    body = { data: page.map((i) => i.obj), first_id: page[0]?.row.upstreamId ?? null, last_id: page[page.length - 1]?.row.upstreamId ?? null, has_more: items.length > size };
  } else {
    const purpose = q.get("purpose");
    if (purpose) items = items.filter((i) => i.obj.purpose === purpose);
    if (q.get("order") === "asc") items = [...items].reverse();
    const after = q.get("after");
    if (after) {
      const i = items.findIndex((x) => x.row.upstreamId === after);
      items = i >= 0 ? items.slice(i + 1) : [];
    }
    const size = pageSize(q.get("limit"), 10000, 10000);
    const page = items.slice(0, size);
    body = { object: "list", data: page.map((i) => i.obj), first_id: page[0]?.row.upstreamId ?? null, last_id: page[page.length - 1]?.row.upstreamId ?? null, has_more: items.length > size };
  }
  logOutcome(ctx, { status: "SUCCESS", httpStatus: 200, usage: emptyUsage() });
  return withCommon(ctx, new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }));
}

// ------------------------------------------------------------------ references inside model requests
const MAX_WALK = 400_000;

/** `file_id` values (OpenAI / Anthropic) and Gemini `fileUri`s found in a request body. */
export function collectFileRefs(body: JsonObject): Set<string> {
  const ids = new Set<string>();
  let budget = MAX_WALK;
  const visit = (v: unknown, key: string | null, depth: number): void => {
    if (budget-- <= 0 || depth > 24) return;
    if (typeof v === "string") {
      if (key === "file_id" && v.length < 256) ids.add(v);
      else if ((key === "fileUri" || key === "file_uri") && v.length < 2048) {
        const m = /\/files\/([A-Za-z0-9_-]+)/.exec(v);
        if (m) ids.add(`files/${m[1]}`);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
      return;
    }
    if (isObject(v)) for (const [k, x] of Object.entries(v)) visit(x, k, depth + 1);
  };
  visit(body, null, 0);
  return ids;
}

/**
 * Files referenced by a chat / responses / messages / generateContent body: they must belong to the caller (anyone
 * else's id answers 404, like an unknown one) and pin the request to the upstream account that stores them.
 */
export async function fileRefPins(ctx: Ctx): Promise<{ providerId: string; providerKeyId: string } | null> {
  if (!ctx.body) return null;
  const ids = collectFileRefs(ctx.body);
  if (!ids.size) return null;
  const rows = await db.upstreamObject.findMany({ where: { kind: "file", upstreamId: { in: [...ids] } } });
  if (!rows.length) return null;
  const userId = ctx.auth!.user.id;
  const mine = new Map<string, UpstreamObject>();
  for (const r of rows) {
    if (r.userId === userId) mine.set(r.upstreamId, r);
  }
  for (const r of rows) {
    if (r.userId !== userId && !mine.has(r.upstreamId)) {
      const fmt: InboundFormat = ctx.errorFormat === "anthropic" ? "anthropic_files" : ctx.errorFormat === "gemini" ? "gemini_files" : "openai_files";
      const message = fmt === "anthropic_files" ? `File not found: ${r.upstreamId}` : fmt === "gemini_files" ? `File ${r.upstreamId} was not found.` : `No such File object: ${r.upstreamId}`;
      throw new GatewayError("not_found", message, { param: "file_id", internal: `file '${r.upstreamId}' belongs to another customer` });
    }
  }
  const keys = new Set([...mine.values()].map((r) => `${r.providerId}|${r.providerKeyId}`));
  if (keys.size > 1) {
    throw new GatewayError("invalid_request", "The referenced files are stored on different upstream accounts and cannot be used in one request. Upload them again together.", {
      param: "file_id",
      internal: `file references span ${keys.size} upstream accounts`,
    });
  }
  const first = [...mine.values()][0];
  return first ? { providerId: first.providerId, providerKeyId: first.providerKeyId } : null;
}
