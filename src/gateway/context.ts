import type { RequestStatus } from "@/generated/prisma/client";
import type { Decimal } from "@/lib/money";
import { ZERO } from "@/lib/money";
import type { AuthRecord, ConfigSnapshot, GroupRec, ModelRec } from "./cache";
import { GatewayError, errorResponse } from "./errors";
import { logger } from "@/lib/logger";
import { allowAnonymousLog } from "./limits";
import { poolListShare } from "./pool-prices";
import { recordOutcome, type Charge, type Outcome } from "./metering";
import { settleFunds, type FundsState } from "./reserve";
import type { ParsedForm } from "./multipart";
import type { TopLevelScan } from "./jsonscan";
import type { BatchCtx } from "./batches";
import type { FilesState } from "./files";
import type { BodySpool } from "./spool";
import type { Candidate } from "./select";
import type { SlotLease } from "./slots";
import type { AttemptRecord, ErrorFormat, Json, JsonObject, ParsedPath, Usage } from "./types";

/** Mutable per-request state threaded through the pipeline. */
export interface Ctx {
  requestId: string;
  req: Request;
  url: URL;
  startedAt: number;
  ip: string;
  userAgent: string | null;
  path: ParsedPath | null;
  errorFormat: ErrorFormat;
  snap: ConfigSnapshot | null;
  auth: AuthRecord | null;
  group: GroupRec | null;
  /** the key's own pool when an effort rule serves the request as another pool (`group`) */
  effortFromGroup: GroupRec | null;
  /** the customer's body before an effort rule lowered its effort (restored if the rule is undone) */
  effortOrigBody: JsonObject | null;
  model: ModelRec | null;
  multiplier: Decimal;
  stream: boolean;
  clientWantsUsage: boolean;
  body: JsonObject | null;
  /** The customer's JSON bytes (spool) + where each top-level member sits: forwarded byte-identical except the members we change. */
  jsonRaw: { spool: BodySpool; scan: TopLevelScan } | null;
  form: ParsedForm | null;
  /** Raw passthrough body (Files / uploads): the decoded request stream, forwarded untouched. */
  rawBody: ReadableStream<Uint8Array> | null;
  /** Files APIs: the object the call targets, its owner row, and how the body is carried. */
  files: FilesState | null;
  /** Batch APIs: the batch the call targets / the state of a batch being created. */
  batch: BatchCtx | null;
  /** Cleanups run when the request is over (temp files, ...). */
  disposers: Array<() => void | Promise<void>>;
  attempts: AttemptRecord[];
  queueMs: number;
  /** last attempted (or serving) route + upstream key */
  chosen: Candidate | null;
  customerLease: SlotLease | null;
  upstreamLease: SlotLease | null;
  /** The response body owns lease release (SSE / binary streams). */
  deferRelease: boolean;
  logged: boolean;
  logBodies: boolean;
  /** Admin-only remarks collected while serving the request (translation decisions, a stream that ended oddly ...): appended to RequestLog.internalError. */
  notes: string[];
  /** Pre-flight estimates */
  inputEstimate: number;
  /** Credit reservation + output clamp for this request (PLAN 9c); null before reservation / for lookups. */
  funds: FundsState | null;
  /** Upstream cost of earlier attempts the upstream billed although nothing reached us (billsDroppedStreams): added to our cost, never to the price. */
  droppedCost: Decimal;
}

export function newCtx(req: Request, requestId: string, ip: string): Ctx {
  return {
    requestId,
    req,
    url: new URL(req.url),
    startedAt: Date.now(),
    ip,
    userAgent: req.headers.get("user-agent"),
    path: null,
    errorFormat: "openai",
    snap: null,
    auth: null,
    group: null,
    effortFromGroup: null,
    effortOrigBody: null,
    model: null,
    multiplier: ZERO,
    stream: false,
    clientWantsUsage: false,
    body: null,
    jsonRaw: null,
    form: null,
    rawBody: null,
    files: null,
    batch: null,
    disposers: [],
    attempts: [],
    queueMs: 0,
    chosen: null,
    customerLease: null,
    upstreamLease: null,
    deferRelease: false,
    logged: false,
    logBodies: false,
    notes: [],
    inputEstimate: 0,
    funds: null,
    droppedCost: ZERO,
  };
}

export function releaseUpstream(ctx: Ctx): void {
  const l = ctx.upstreamLease;
  ctx.upstreamLease = null;
  l?.release();
}

export function releaseAll(ctx: Ctx): void {
  releaseUpstream(ctx);
  const c = ctx.customerLease;
  ctx.customerLease = null;
  c?.release();
  const ds = ctx.disposers;
  ctx.disposers = [];
  for (const d of ds) {
    try {
      void Promise.resolve(d()).catch(() => undefined);
    } catch {
      /* best effort */
    }
  }
}

export const EXPOSE_HEADERS = "x-request-id, x-pool, x-price-multiplier, retry-after, retry-after-ms, x-ratelimit-limit-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-requests, x-ratelimit-remaining-tokens, x-ratelimit-reset-requests, x-ratelimit-reset-tokens, anthropic-ratelimit-requests-limit, anthropic-ratelimit-requests-remaining, anthropic-ratelimit-requests-reset, anthropic-ratelimit-tokens-limit, anthropic-ratelimit-tokens-remaining, anthropic-ratelimit-tokens-reset";

export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": EXPOSE_HEADERS,
  };
}

/**
 * What the caller pays as a share of the official list price (0.5 = half of list). A cost-based pool's own multiplier
 * is a factor on OUR cost and is never sent: its share is read off the pool's input price against the official one.
 */
export function listShare(ctx: Ctx): Decimal {
  return ctx.snap ? poolListShare(ctx.snap, ctx.group, ctx.multiplier, ctx.model) : ctx.multiplier;
}

/**
 * Add x-request-id + CORS to a response we constructed, and on billable calls the pool that served (and bills) it
 * plus its price as a share of the official list price. The exact charge: GET /v1/requests/{x-request-id}.
 */
export function withCommon(ctx: Ctx, res: Response): Response {
  try {
    res.headers.set("x-request-id", ctx.requestId);
    if (ctx.model && ctx.group) {
      res.headers.set("x-pool", ctx.group.slug);
      res.headers.set("x-price-multiplier", listShare(ctx).toString());
    }
    for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v);
  } catch {
    /* immutable headers: ignore */
  }
  return res;
}

export function statusForError(err: GatewayError): RequestStatus {
  switch (err.kind) {
    case "client":
      return "CLIENT_ERROR";
    case "upstream":
      return "UPSTREAM_ERROR";
    case "cancelled":
      return "CANCELLED";
    default:
      return "GATEWAY_ERROR";
  }
}

export type OutcomePatch = Partial<Omit<Outcome, "requestId" | "startedAt">> & { status: RequestStatus; httpStatus: number };

/**
 * Write the single RequestLog for this request (idempotent). Anonymous failures (no known key) are rate limited
 * per IP so garbage traffic cannot flood the table.
 */
export function logOutcome(ctx: Ctx, p: OutcomePatch): Charge | null {
  if (ctx.logged) return null;
  ctx.logged = true;
  if (!ctx.auth && !allowAnonymousLog(ctx.ip)) return null;
  const path = ctx.path;
  if (p.status === "GATEWAY_ERROR" || p.status === "UPSTREAM_ERROR") {
    // server-side problems are worth a structured log line (Cloud Logging); client errors only live in RequestLog
    logger.warn("gateway request failed", {
      requestId: ctx.requestId,
      endpoint: path?.endpoint,
      status: p.status,
      httpStatus: p.httpStatus,
      errorCode: p.errorCode,
      model: ctx.model?.slug,
      providerKeyId: ctx.chosen?.key.id,
      attempts: ctx.attempts.length,
      detail: p.internalError ? p.internalError.slice(0, 500) : undefined,
    });
  }
  const note = [ctx.funds?.note, ...ctx.notes].filter(Boolean).join(" | ") || null;
  const patch: OutcomePatch = note ? { ...p, internalError: p.internalError ? `${p.internalError} | ${note}` : note } : p;
  const charge = recordOutcome({
    requestId: ctx.requestId,
    startedAt: ctx.startedAt,
    ip: ctx.ip === "unknown" ? null : ctx.ip,
    userAgent: ctx.userAgent,
    endpoint: path?.endpoint ?? ctx.url.pathname.slice(0, 200),
    inboundFormat: path?.format ?? "unknown",
    stream: ctx.stream,
    auth: ctx.auth,
    groupSlug: ctx.group?.slug ?? null,
    model: ctx.model,
    route: ctx.chosen?.route ?? null,
    providerKeyId: ctx.chosen?.key.id ?? null,
    providerKeyHasTpm: !!ctx.chosen?.key.tpmLimit,
    multiplier: ctx.multiplier,
    priceBasis: ctx.group?.priceBasis ?? null,
    referenceSavingsPct: ctx.group?.referenceSavingsPct ?? null,
    errorCode: null,
    errorMessage: null,
    internalError: null,
    usage: null as Usage | null,
    ttftMs: null,
    queueMs: ctx.queueMs,
    droppedCost: ctx.droppedCost,
    billFailedRequests: ctx.snap?.settings.billFailedRequests ?? false,
    attempts: ctx.attempts,
    logBodies: ctx.logBodies,
    requestBody: ctx.logBodies ? (ctx.body as Json) : undefined,
    ...patch,
  });
  settleFunds(ctx, charge.price);
  // routes with an auto-updated cost refresh it lazily during real calls (never on a timer)
  const route = ctx.chosen?.route;
  if (route?.autoCostSync && p.status === "SUCCESS" && ctx.snap) {
    const settings = ctx.snap.settings;
    void import("@/server/pricing/auto-sync").then((m) => m.noteRouteCall(route, settings)).catch(() => undefined);
  }
  return charge;
}

/** Release everything, log the failure and render the error in the inbound format. */
export function failWith(ctx: Ctx, err: GatewayError): Response {
  releaseAll(ctx);
  const status = statusForError(err);
  logOutcome(ctx, {
    status,
    httpStatus: err.status,
    errorCode: err.code,
    errorMessage: err.message,
    internalError: err.internal ?? (err.opts.upstreamStatus ? `upstream status ${err.opts.upstreamStatus}` : null),
  });
  return withCommon(ctx, errorResponse(ctx.errorFormat, err, ctx.requestId));
}

