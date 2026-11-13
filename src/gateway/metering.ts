import type { Prisma, RequestStatus } from "@/generated/prisma/client";
import { Decimal, ZERO, toDbString } from "@/lib/money";
import type { AuthRecord, ModelRec, RouteRec } from "./cache";
import { addProviderKeyCost, addUserSpend, tpmAdd } from "./limits";
import { enqueueMeter } from "./meter-writer";
import { priceRequest, referenceAmount, type PriceBasis } from "./pricing";
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
  /** the pool prices from the serving route's upstream cost instead of the model price */
  priceBasis?: PriceBasis | null;
  /** the pool's shown saving: the logged "official" figure becomes price / (1 - pct/100) */
  referenceSavingsPct?: number | null;

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
  /** Charge the usage even though the status is not a normally billable one (e.g. a stream cut off by the funds guard). */
  billable?: boolean;
  /** The upstream does not bill this request (e.g. OpenAI after a client cancel): the customer price stands, our cost is 0. */
  upstreamUnbilled?: boolean;
  /**
   * Setting `billFailedRequests`. Off (default): a request that ends as UPSTREAM_ERROR (the upstream dropped the stream or
   * ended it with its own error) costs the customer nothing - its tokens and our cost stay on the row. On: the customer
   * pays the input and the output delivered before the failure.
   */
  billFailedRequests?: boolean;
  /** Upstream cost of dropped earlier attempts the upstream billed (our cost only; the customer never pays for them). */
  droppedCost?: Decimal;
  /** Batch API result: the upstream batch id. Token prices are discounted by Model.batchDiscountPct / ModelRoute.batchCostDiscountPct. */
  batchId?: string | null;
  /** Who the row belongs to when there is no request (cron sweep of ended batches). */
  owner?: { userId: string; apiKeyId: string | null };
}

export interface Charge {
  price: Decimal;
  cost: Decimal;
  profit: Decimal;
  /** what the same usage would have cost at official prices */
  official: Decimal;
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
  let charge: Charge = { price: ZERO, cost: ZERO, profit: ZERO, official: ZERO };
  let notCharged = false;
  if (usage && o.model && (o.billable || o.status === "SUCCESS" || o.status === "CANCELLED" || o.status === "UPSTREAM_ERROR")) {
    const batch = o.batchId ? { sellPct: o.model.batchDiscountPct ?? null, costPct: o.route?.batchCostDiscountPct ?? null } : null;
    const b = priceRequest(usage, o.model.sell, o.route?.cost ?? null, o.multiplier, o.model.longContext, o.status === "SUCCESS" || !!o.billable, o.model.official, batch, o.priceBasis);
    charge = { price: b.price, cost: b.cost, profit: b.profit, official: referenceAmount(b.price, b.official, o.referenceSavingsPct) };
    if (o.upstreamUnbilled) charge = { ...charge, cost: ZERO, profit: b.price };
    // an upstream failure is not the customer's bill: no result, no charge (what the upstream bills us for it is our loss)
    if (o.status === "UPSTREAM_ERROR" && !o.billable && !o.billFailedRequests && !charge.price.isZero()) {
      charge = { price: ZERO, cost: charge.cost, profit: ZERO.minus(charge.cost), official: ZERO };
      notCharged = true;
    }
  }
  if (o.droppedCost && o.droppedCost.gt(0)) charge = { ...charge, cost: charge.cost.plus(o.droppedCost), profit: charge.profit.minus(o.droppedCost) };

  const u = usage;
  const userId = o.auth?.user.id ?? o.owner?.userId ?? null;
  const apiKeyId = o.auth?.key.id ?? o.owner?.apiKeyId ?? null;
  const log: Prisma.RequestLogCreateManyInput = {
    id: o.requestId,
    userId,
    apiKeyId,
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
    internalError: (() => {
      const note = u?.reasoningEstimated ? "reasoning tokens estimated from the streamed thinking text (the upstream did not itemize them)" : null;
      const free = notCharged ? "not charged to the customer: the request failed upstream (usage and our cost are recorded)" : null;
      const all = [o.internalError, note, free].filter(Boolean).join(" | ");
      return all ? truncate(all, 8000) : null;
    })(),
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
    toolUsage: (u?.toolUsage ?? {}) as Prisma.InputJsonValue,
    batchId: o.batchId ?? null,
    usageEstimated: u?.estimated ?? false,
    price: toDbString(charge.price),
    cost: toDbString(charge.cost),
    profit: toDbString(charge.profit),
    officialPrice: toDbString(charge.official),
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

  const countForKey = !!o.providerKeyId && (o.billable === true || o.status === "SUCCESS" || o.status === "CANCELLED" || (o.status === "UPSTREAM_ERROR" && !!usage));
  enqueueMeter({
    log,
    userId,
    apiKeyId,
    providerKeyId: o.providerKeyId,
    price: charge.price,
    cost: charge.cost,
    countForKey,
    keyHealthy: o.status === "SUCCESS" && !!o.providerKeyId,
    createdAt: new Date(o.startedAt),
  });

  // ---- immediate local effects
  if (o.auth && !charge.price.isZero()) {
    // the cached balance is not touched: the debit is made visible by the funds hold being settled (logOutcome)
    o.auth.spentDelta = o.auth.spentDelta.plus(charge.price);
    addUserSpend(o.auth.user.id, charge.price);
  }
  if (o.providerKeyId && !charge.cost.isZero()) addProviderKeyCost(o.providerKeyId, charge.cost);
  if (usage && o.auth && o.auth.key.tpmLimit) tpmAdd(`key:${o.auth.key.id}`, usage.inputTokens + usage.outputTokens);
  if (usage && o.providerKeyId && o.providerKeyHasTpm) tpmAdd(`pkey:${o.providerKeyId}`, usage.inputTokens + usage.outputTokens);
  return charge;
}
