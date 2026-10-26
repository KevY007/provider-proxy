/** Pure parts of the admin request-log query: filter parsing, cursor encode/decode, Prisma where builder. */
import type { Prisma } from "@/generated/prisma/client";
import { parseRangeParams } from "@/lib/date-range";

export const LOG_PAGE_SIZE = 50;
export const LOG_STATUSES = ["SUCCESS", "CLIENT_ERROR", "UPSTREAM_ERROR", "GATEWAY_ERROR", "CANCELLED"] as const;
/** status=ERRORS in the URL: every failed request (client, upstream and gateway errors). */
const ANY_ERROR = "ERRORS";

export interface LogFilters {
  from: Date;
  to: Date;
  /** customer id or (part of an) email */
  user: string;
  /** api key id or "sk-..." prefix */
  key: string;
  model: string;
  provider: string;
  providerKey: string;
  status: (typeof LOG_STATUSES)[number] | typeof ANY_ERROR | "";
  errorCode: string;
  stream: "" | "yes" | "no";
  endpoint: string;
  minLatency: number | null;
}

export interface LogCursor {
  createdAt: Date;
  id: string;
}

type SP = Record<string, string | string[] | undefined> | URLSearchParams;
function one(sp: SP, k: string): string {
  const v = sp instanceof URLSearchParams ? sp.get(k) : sp[k];
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
}

export function parseLogFilters(sp: SP, now = new Date()): LogFilters {
  const range = parseRangeParams({ range: one(sp, "range") || undefined, from: one(sp, "from") || undefined, to: one(sp, "to") || undefined }, "24h", now);
  const status = one(sp, "status");
  const stream = one(sp, "stream");
  const minLat = Number.parseInt(one(sp, "minLatency"), 10);
  const clip = (k: string) => one(sp, k).slice(0, 200);
  return {
    from: range.from,
    to: range.to,
    user: clip("user"),
    key: clip("key"),
    model: clip("model"),
    provider: clip("provider"),
    providerKey: clip("providerKey"),
    status: status === ANY_ERROR || (LOG_STATUSES as readonly string[]).includes(status) ? (status as LogFilters["status"]) : "",
    errorCode: clip("errorCode"),
    stream: stream === "yes" || stream === "no" ? stream : "",
    endpoint: clip("endpoint"),
    minLatency: Number.isFinite(minLat) && minLat > 0 ? minLat : null,
  };
}

export function encodeCursor(c: LogCursor): string {
  return `${c.createdAt.toISOString()}_${c.id}`;
}

/** Returns null for anything malformed. */
export function decodeCursor(raw: string | null | undefined): LogCursor | null {
  if (!raw) return null;
  const i = raw.indexOf("_");
  if (i < 20) return null;
  const iso = raw.slice(0, i);
  const id = raw.slice(i + 1);
  if (!id || id.length > 100 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(iso)) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { createdAt: d, id };
}

/** Prisma where for the filters. `cursor`+`dir` add the keyset condition (older = before cursor, newer = after). */
export function buildLogWhere(f: LogFilters, cursor?: LogCursor | null, dir: "older" | "newer" = "older"): Prisma.RequestLogWhereInput {
  const and: Prisma.RequestLogWhereInput[] = [{ createdAt: { gte: f.from, lte: f.to } }];
  if (f.user) {
    and.push(f.user.includes("@") ? { user: { email: { contains: f.user, mode: "insensitive" } } } : { userId: f.user });
  }
  if (f.key) and.push(f.key.startsWith("sk-") ? { apiKey: { prefix: { startsWith: f.key } } } : { apiKeyId: f.key });
  if (f.model) and.push({ modelSlug: f.model });
  if (f.provider) and.push({ providerId: f.provider });
  if (f.providerKey) and.push({ providerKeyId: f.providerKey });
  if (f.status === ANY_ERROR) and.push({ status: { in: ["CLIENT_ERROR", "UPSTREAM_ERROR", "GATEWAY_ERROR"] } });
  else if (f.status) and.push({ status: f.status });
  if (f.errorCode) and.push({ errorCode: f.errorCode });
  if (f.stream) and.push({ stream: f.stream === "yes" });
  if (f.endpoint) and.push({ endpoint: f.endpoint });
  if (f.minLatency) and.push({ latencyMs: { gte: f.minLatency } });
  if (cursor) {
    and.push(
      dir === "older"
        ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
        : { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] },
    );
  }
  return { AND: and };
}

/** Query-string for linking to the same filtered view (used by the CSV export button). */
export function filtersToQuery(sp: SP): string {
  const keys = ["range", "from", "to", "user", "key", "model", "provider", "providerKey", "status", "errorCode", "stream", "endpoint", "minLatency"];
  const out = new URLSearchParams();
  for (const k of keys) {
    const v = one(sp, k);
    if (v) out.set(k, v);
  }
  return out.toString();
}
