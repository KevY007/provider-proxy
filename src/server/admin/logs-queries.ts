import "server-only";
import { db } from "@/lib/db";
import { toolUsageCsv, toolUsageMap } from "@/lib/tool-usage";
import { dstr0 } from "./serialize";
import { LOG_PAGE_SIZE, buildLogWhere, encodeCursor, type LogCursor, type LogFilters } from "./logs-query";

const rowSelect = {
  id: true,
  createdAt: true,
  modelSlug: true,
  upstreamModel: true,
  endpoint: true,
  status: true,
  httpStatus: true,
  errorCode: true,
  stream: true,
  inputTokens: true,
  outputTokens: true,
  cachedTokens: true,
  price: true,
  waived: true,
  cost: true,
  profit: true,
  officialPrice: true,
  latencyMs: true,
  queueMs: true,
  toolUsage: true,
  batchId: true,
  user: { select: { id: true, email: true } },
  apiKey: { select: { id: true, prefix: true, name: true } },
  provider: { select: { id: true, name: true } },
  providerKey: { select: { id: true, label: true } },
} as const;

export interface LogRow {
  id: string;
  createdAt: string;
  userId: string | null;
  email: string | null;
  keyPrefix: string | null;
  modelSlug: string | null;
  upstreamModel: string | null;
  providerName: string | null;
  providerKeyLabel: string | null;
  endpoint: string;
  status: string;
  httpStatus: number;
  errorCode: string | null;
  stream: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  price: string;
  /** part of the price never taken from the balance (free-when-empty customer) */
  waived: string;
  cost: string;
  profit: string;
  /** What the same usage would cost at the model's official prices. */
  officialPrice: string;
  latencyMs: number;
  queueMs: number;
  /** Server tools used ("web_search_request=2; ..."), "" when none. */
  serverTools: string;
  batchId: string | null;
}

function toRow(r: Awaited<ReturnType<typeof fetchRows>>[number]): LogRow {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    userId: r.user?.id ?? null,
    email: r.user?.email ?? null,
    keyPrefix: r.apiKey?.prefix ?? null,
    modelSlug: r.modelSlug,
    upstreamModel: r.upstreamModel,
    providerName: r.provider?.name ?? null,
    providerKeyLabel: r.providerKey?.label ?? null,
    endpoint: r.endpoint,
    status: r.status,
    httpStatus: r.httpStatus,
    errorCode: r.errorCode,
    stream: r.stream,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cachedTokens: r.cachedTokens,
    price: dstr0(r.price),
    waived: dstr0(r.waived),
    cost: dstr0(r.cost),
    profit: dstr0(r.profit),
    officialPrice: dstr0(r.officialPrice),
    latencyMs: r.latencyMs,
    queueMs: r.queueMs,
    serverTools: toolUsageCsv(toolUsageMap(r.toolUsage)),
    batchId: r.batchId,
  };
}

function fetchRows(f: LogFilters, cursor: LogCursor | null, dir: "older" | "newer", take: number) {
  return db.requestLog.findMany({
    where: buildLogWhere(f, cursor, dir),
    orderBy: dir === "older" ? [{ createdAt: "desc" }, { id: "desc" }] : [{ createdAt: "asc" }, { id: "asc" }],
    take,
    select: rowSelect,
  });
}

/** Keyset-paginated page of logs. Never counts or loads more than pageSize+1 rows. */
export async function listLogs(f: LogFilters, cursor: LogCursor | null, dir: "older" | "newer", pageSize = LOG_PAGE_SIZE) {
  const fetched = await fetchRows(f, cursor, dir, pageSize + 1);
  const more = fetched.length > pageSize;
  let page = more ? fetched.slice(0, pageSize) : fetched;
  if (dir === "newer") page = page.reverse();
  const rows = page.map(toRow);
  const hasOlder = dir === "older" ? more : !!cursor;
  const hasNewer = dir === "older" ? !!cursor : more;
  const first = page[0];
  const last = page[page.length - 1];
  return {
    rows,
    hasOlder,
    hasNewer,
    /** cursor to request the next older page (rows after the last shown) */
    olderCursor: last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    /** cursor to request the next newer page (rows before the first shown) */
    newerCursor: first ? encodeCursor({ createdAt: first.createdAt, id: first.id }) : null,
  };
}

/** Rows for CSV export in chunks (older direction), up to `cap` rows. */
export async function* iterateLogs(f: LogFilters, cap = 50_000, chunk = 2000): AsyncGenerator<LogRow[]> {
  let cursor: LogCursor | null = null;
  let total = 0;
  while (total < cap) {
    const take = Math.min(chunk, cap - total);
    const rows = await fetchRows(f, cursor, "older", take);
    if (!rows.length) return;
    total += rows.length;
    yield rows.map(toRow);
    if (rows.length < take) return;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
  }
}

export async function getLogDetailData(id: string) {
  const r = await db.requestLog.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, email: true } },
      apiKey: { select: { id: true, prefix: true, name: true } },
      provider: { select: { id: true, name: true } },
      providerKey: { select: { id: true, label: true } },
    },
  });
  if (!r) return null;
  // resolve provider names for attempts
  const attempts = Array.isArray(r.attempts) ? (r.attempts as Array<Record<string, unknown>>) : [];
  const pIds = [...new Set(attempts.map((a) => a.providerId).filter((x): x is string => typeof x === "string"))];
  const kIds = [...new Set(attempts.map((a) => a.providerKeyId).filter((x): x is string => typeof x === "string"))];
  const rIds = [...new Set(attempts.map((a) => a.routeId).filter((x): x is string => typeof x === "string"))];
  const [ps, ks, rs] = await Promise.all([
    pIds.length ? db.provider.findMany({ where: { id: { in: pIds } }, select: { id: true, name: true } }) : [],
    kIds.length ? db.providerKey.findMany({ where: { id: { in: kIds } }, select: { id: true, label: true } }) : [],
    rIds.length ? db.modelRoute.findMany({ where: { id: { in: rIds } }, select: { id: true, upstreamModel: true } }) : [],
  ]);
  const rModel = Object.fromEntries(rs.map((x) => [x.id, x.upstreamModel]));
  const pName = Object.fromEntries(ps.map((p) => [p.id, p.name]));
  const kLabel = Object.fromEntries(ks.map((k) => [k.id, k.label]));
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    user: r.user,
    apiKey: r.apiKey,
    groupSlug: r.groupSlug,
    modelSlug: r.modelSlug,
    upstreamModel: r.upstreamModel,
    endpoint: r.endpoint,
    inboundFormat: r.inboundFormat,
    provider: r.provider,
    providerKey: r.providerKey,
    status: r.status as string,
    httpStatus: r.httpStatus,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    internalError: r.internalError,
    stream: r.stream,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cachedTokens: r.cachedTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    reasoningTokens: r.reasoningTokens,
    imageCount: r.imageCount,
    audioSeconds: r.audioSeconds,
    videoSeconds: r.videoSeconds,
    characters: r.characters,
    usageEstimated: r.usageEstimated,
    toolUsage: toolUsageMap(r.toolUsage),
    batchId: r.batchId,
    price: dstr0(r.price),
    waived: dstr0(r.waived),
    cost: dstr0(r.cost),
    profit: dstr0(r.profit),
    officialPrice: dstr0(r.officialPrice),
    latencyMs: r.latencyMs,
    ttftMs: r.ttftMs,
    queueMs: r.queueMs,
    ip: r.ip,
    userAgent: r.userAgent,
    attempts: attempts.map((a): Record<string, unknown> => ({
      ...a,
      providerName: typeof a.providerId === "string" ? (pName[a.providerId] ?? null) : null,
      providerKeyLabel: typeof a.providerKeyId === "string" ? (kLabel[a.providerKeyId] ?? null) : null,
      upstreamModel: typeof a.routeId === "string" ? (rModel[a.routeId] ?? null) : null,
    })),
    requestBody: r.requestBody,
    responseBody: r.responseBody,
  };
}

export type LogDetail = NonNullable<Awaited<ReturnType<typeof getLogDetailData>>>;

/** Option lists for the filter bar (small tables only). */
export async function getLogFilterOptions() {
  const [providers, models] = await Promise.all([
    db.provider.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.model.findMany({ orderBy: { slug: "asc" }, select: { slug: true }, take: 500 }),
  ]);
  return { providers, models: models.map((m) => m.slug) };
}
