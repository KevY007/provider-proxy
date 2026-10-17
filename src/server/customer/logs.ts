import "server-only";
import { db } from "@/lib/db";
import type { Prisma, RequestStatus } from "@/generated/prisma/client";

/** Customer-safe RequestLog access. NEVER select provider/providerKey/upstreamModel/internalError/attempts-detail/bodies. */

export interface LogFilters {
  keyId?: string;
  model?: string;
  status?: "success" | "error" | RequestStatus;
  errorCode?: string;
  from: Date;
  to: Date;
}

export interface LogRow {
  id: string;
  createdAt: string;
  apiKeyId: string | null;
  keyName: string | null;
  keyPrefix: string | null;
  modelSlug: string | null;
  endpoint: string;
  stream: boolean;
  status: string;
  httpStatus: number;
  errorCode: string | null;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  imageCount: number;
  videoSeconds: number;
  price: string;
  /** What this usage would cost at official prices ("0" when not recorded). */
  officialPrice: string;
  latencyMs: number;
  ttftMs: number | null;
  usageEstimated: boolean;
  /** Number of upstream attempts only; details stay internal. */
  attempts: number;
}

const SAFE_SELECT = {
  id: true,
  createdAt: true,
  apiKeyId: true,
  apiKey: { select: { name: true, prefix: true } },
  modelSlug: true,
  endpoint: true,
  stream: true,
  status: true,
  httpStatus: true,
  errorCode: true,
  errorMessage: true,
  inputTokens: true,
  outputTokens: true,
  cachedTokens: true,
  reasoningTokens: true,
  imageCount: true,
  videoSeconds: true,
  price: true,
  officialPrice: true,
  latencyMs: true,
  ttftMs: true,
  usageEstimated: true,
  attempts: true,
} satisfies Prisma.RequestLogSelect;

type SafeRow = Prisma.RequestLogGetPayload<{ select: typeof SAFE_SELECT }>;

function toRow(r: SafeRow): LogRow {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    apiKeyId: r.apiKeyId,
    keyName: r.apiKey?.name ?? null,
    keyPrefix: r.apiKey?.prefix ?? null,
    modelSlug: r.modelSlug,
    endpoint: r.endpoint,
    stream: r.stream,
    status: r.status,
    httpStatus: r.httpStatus,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cachedTokens: r.cachedTokens,
    reasoningTokens: r.reasoningTokens,
    imageCount: r.imageCount,
    videoSeconds: r.videoSeconds,
    price: r.price.toString(),
    officialPrice: r.officialPrice.toString(),
    latencyMs: r.latencyMs,
    ttftMs: r.ttftMs,
    usageEstimated: r.usageEstimated,
    attempts: Array.isArray(r.attempts) ? r.attempts.length : 0,
  };
}

export function buildLogWhere(userId: string, f: LogFilters): Prisma.RequestLogWhereInput {
  const where: Prisma.RequestLogWhereInput = { userId, createdAt: { gte: f.from, lte: f.to } };
  if (f.keyId) where.apiKeyId = f.keyId;
  if (f.model) where.modelSlug = f.model;
  if (f.errorCode) where.errorCode = f.errorCode;
  if (f.status === "success") where.status = "SUCCESS";
  else if (f.status === "error") where.status = { in: ["CLIENT_ERROR", "UPSTREAM_ERROR", "GATEWAY_ERROR"] };
  else if (f.status) where.status = f.status;
  return where;
}

export const LOG_PAGE_SIZE = 50;

/** Cursor pagination (newest first). `cursor` is the id of the last row of the previous page. */
export async function listLogs(userId: string, f: LogFilters, cursor?: string | null): Promise<{ rows: LogRow[]; nextCursor: string | null }> {
  const rows = await db.requestLog.findMany({
    where: buildLogWhere(userId, f),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LOG_PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: SAFE_SELECT,
  });
  const hasMore = rows.length > LOG_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, LOG_PAGE_SIZE) : rows;
  return { rows: page.map(toRow), nextCursor: hasMore ? page[page.length - 1].id : null };
}

/** For CSV export: up to `max` rows, same safe columns. */
export async function exportLogs(userId: string, f: LogFilters, max = 50_000): Promise<LogRow[]> {
  const rows = await db.requestLog.findMany({
    where: buildLogWhere(userId, f),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: max,
    select: SAFE_SELECT,
  });
  return rows.map(toRow);
}

/** Filter option lists for the logs page. */
export async function getLogFilterOptions(userId: string) {
  const [keys, models, codes] = await Promise.all([
    db.apiKey.findMany({ where: { userId, isPlayground: false }, select: { id: true, name: true, prefix: true }, orderBy: { createdAt: "desc" } }),
    db.requestLog.groupBy({ by: ["modelSlug"], where: { userId, modelSlug: { not: null } }, _count: { _all: true }, orderBy: { _count: { modelSlug: "desc" } }, take: 100 }),
    db.requestLog.groupBy({ by: ["errorCode"], where: { userId, errorCode: { not: null } }, _count: { _all: true }, orderBy: { _count: { errorCode: "desc" } }, take: 50 }),
  ]);
  return {
    keys,
    models: models.map((m) => m.modelSlug as string),
    errorCodes: codes.map((c) => c.errorCode as string),
  };
}
