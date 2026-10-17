import type { Prisma, RequestStatus } from "@/generated/prisma/client";
import { Decimal, ZERO, toDbString } from "@/lib/money";
import { debitLocal } from "./balance";
import type { AuthRecord, ModelRec, RouteRec } from "./cache";
import { addProviderKeyCost, addUserSpend, tpmAdd } from "./limits";
import { enqueueMeter } from "./meter-writer";
import { priceRequest } from "./pricing";
import type { AttemptRecord, Json, Usage } from "./types";
import { truncate } from "./util";

/**
 * Turns one finished request into a RequestLog row + financial side effects (via the batched meter writer) and
 * applies the immediate local effects (cached balance debit, spend counters, TPM) so the next request on this
 * instance already sees them. Exactly one call per request (callers guard with ctx.logged).
 */
export interface Outcome {
  requestId: string;
  startedAt: number;
  ip: string | null;
  userAgent: string | null;
  endpoint: string;
  inboundFormat: string;
  stream: boolean;

  auth: AuthRecord | null;
  groupSlug: string | null;
  model: ModelRec | null;
  route: RouteRec | null;
  providerKeyId: string | null;
  /** key limits needed for TPM bookkeeping */
  providerKeyHasTpm: boolean;
  multiplier: Decimal;

  status: RequestStatus;
  httpStatus: number;
  errorCode: string | null;
  errorMessage: string | null;
  internalError: string | null;

  usage: Usage | null;
  ttftMs: number | null;
  queueMs: number;
  attempts: AttemptRecord[];
  logBodies: boolean;
  requestBody?: Json;
  responseBody?: Json;
}

export interface Charge {
  price: Decimal;
  cost: Decimal;
  profit: Decimal;
}

const MAX_BODY_LOG = 100_000;

function shrinkForLog(v: Json): Json {
  try {
    const s = JSON.stringify(v, (_k, x) => (typeof x === "string" && x.length > 2_000 ? `${x.slice(0, 200)}...[${x.length} chars]` : x));
    if (s.length > MAX_BODY_LOG) return { truncated: true, preview: s.slice(0, MAX_BODY_LOG) };
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function recordOutcome(o: Outcome): Charge {
  const now = new Date();
  const usage = o.usage;
  let charge: Charge = { price: ZERO, cost: ZERO, profit: ZERO };
  if (usage && o.model && (o.status === "SUCCESS" || o.status === "CANCELLED" || o.status === "UPSTREAM_ERROR")) {
    const b = priceRequest(usage, o.model.sell, o.route?.cost ?? null, o.multiplier, o.model.longContext, o.status === "SUCCESS");
    charge = { price: b.price, cost: b.cost, profit: b.profit };
  }

  const u = usage;
  const log: Prisma.RequestLogCreateManyInput = {
    id: o.requestId,
    userId: o.auth?.user.id ?? null,
    apiKeyId: o.auth?.key.id ?? null,
    groupSlug: o.groupSlug,
    modelSlug: o.model?.slug ?? null,
    endpoint: o.endpoint,
    inboundFormat: o.inboundFormat,
    providerId: o.route?.providerId ?? null,
    providerKeyId: o.providerKeyId,
    upstreamModel: o.route?.upstreamModel ?? null,
    status: o.status,
    httpStatus: o.httpStatus,
    errorCode: o.errorCode,
    errorMessage: o.errorMessage ? truncate(o.errorMessage, 1000) : null,
    internalError: o.internalError ? truncate(o.internalError, 8000) : null,
    stream: o.stream,
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cachedTokens: u?.cachedTokens ?? 0,
    cacheWriteTokens: u?.cacheWriteTokens ?? 0,
    reasoningTokens: u?.reasoningTokens ?? 0,
    imageCount: u?.imageCount ?? 0,
    audioSeconds: u?.audioSeconds ?? 0,
    characters: u?.characters ?? 0,
    videoSeconds: u?.videoSeconds ?? 0,
    usageEstimated: u?.estimated ?? false,
    price: toDbString(charge.price),
    cost: toDbString(charge.cost),
    profit: toDbString(charge.profit),
    latencyMs: Math.max(0, now.getTime() - o.startedAt),
    ttftMs: o.ttftMs,
    queueMs: Math.max(0, Math.round(o.queueMs)),
    attempts: o.attempts as unknown as Prisma.InputJsonValue,
    ip: o.ip,
    userAgent: o.userAgent ? o.userAgent.slice(0, 300) : null,
    createdAt: new Date(o.startedAt),
    ...(o.logBodies && o.requestBody !== undefined ? { requestBody: shrinkForLog(o.requestBody) as Prisma.InputJsonValue } : {}),
    ...(o.logBodies && o.responseBody !== undefined ? { responseBody: shrinkForLog(o.responseBody) as Prisma.InputJsonValue } : {}),
  };

  const countForKey = !!o.providerKeyId && (o.status === "SUCCESS" || o.status === "CANCELLED" || (o.status === "UPSTREAM_ERROR" && !!usage));
  enqueueMeter({
    log,
    userId: o.auth?.user.id ?? null,
    apiKeyId: o.auth?.key.id ?? null,
    providerKeyId: o.providerKeyId,
    price: charge.price,
    cost: charge.cost,
    countForKey,
    keyHealthy: o.status === "SUCCESS" && !!o.providerKeyId,
    createdAt: new Date(o.startedAt),
  });

  // ---- immediate local effects
  if (o.auth && !charge.price.isZero()) {
    debitLocal(o.auth.user.id, charge.price);
    o.auth.spentDelta = o.auth.spentDelta.plus(charge.price);
    addUserSpend(o.auth.user.id, charge.price);
  }
  if (o.providerKeyId && !charge.cost.isZero()) addProviderKeyCost(o.providerKeyId, charge.cost);
  if (usage && o.auth && o.auth.key.tpmLimit) tpmAdd(`key:${o.auth.key.id}`, usage.inputTokens + usage.outputTokens);
  if (usage && o.providerKeyId && o.providerKeyHasTpm) tpmAdd(`pkey:${o.providerKeyId}`, usage.inputTokens + usage.outputTokens);
  return charge;
}
