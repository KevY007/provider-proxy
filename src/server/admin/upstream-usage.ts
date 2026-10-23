import "server-only";
// Upstream usage check: what a provider says each of our upstream keys spent (its own usage API), next to the cost we
// recorded for that key, day by day. A difference shows requests the upstream billed that we did not (or the other way
// round): e.g. a generation the upstream finished and billed after the client had gone.
//
// Supported: the relay (`GET /v1/usage` with the key: daily totals in Asia/Shanghai days, balance) and any
// provider with `settings.usageUrl` answering the same shape. Read-only, on demand; never on a timer.
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { assertPublicUrl } from "@/gateway/ssrf";

export interface UsageDay {
  date: string;
  upstreamRequests: number | null;
  upstreamCost: number | null;
  ourRequests: number;
  ourCost: number;
}

export interface KeyUsage {
  keyId: string;
  label: string;
  ok: boolean;
  error?: string;
  balance: number | null;
  upstreamTotal: number | null;
  ourTotal: number;
  days: UsageDay[];
}

export interface UpstreamUsageReport {
  supported: boolean;
  timezone: string;
  checkedAt: string;
  keys: KeyUsage[];
}

const TIMEOUT_MS = 10_000;

/** Where a provider publishes per-key usage, or null when it does not. */
export function usageEndpoint(p: { preset: string; baseUrl: string; settings: unknown }): { url: string; timezone: string } | null {
  const s = (p.settings && typeof p.settings === "object" ? p.settings : {}) as Record<string, unknown>;
  const tz = typeof s.usageTimezone === "string" && s.usageTimezone ? s.usageTimezone : "Asia/Shanghai";
  if (typeof s.usageUrl === "string" && /^https?:\/\//.test(s.usageUrl)) return { url: s.usageUrl, timezone: tz };
  if (p.preset !== "codex-everywhere") return null;
  try {
    return { url: `${new URL(p.baseUrl).origin}/v1/usage`, timezone: tz };
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Parse a the relay-style usage document. */
export function parseUsageDoc(doc: unknown): { balance: number | null; total: number | null; days: Array<{ date: string; requests: number | null; cost: number | null }> } {
  const d = (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  const daily = Array.isArray(d.daily_usage) ? d.daily_usage : [];
  const usage = (d.usage && typeof d.usage === "object" ? d.usage : {}) as Record<string, unknown>;
  const total = (usage.total && typeof usage.total === "object" ? usage.total : {}) as Record<string, unknown>;
  return {
    balance: num(d.balance ?? d.remaining),
    total: num(total.actual_cost),
    days: daily
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as Record<string, unknown>).date === "string")
      .map((x) => ({ date: String(x.date), requests: num(x.requests), cost: num(x.actual_cost ?? x.cost) })),
  };
}

export async function checkUpstreamUsage(providerId: string): Promise<UpstreamUsageReport> {
  const provider = await db.provider.findUnique({ where: { id: providerId }, include: { keys: { orderBy: [{ priority: "desc" }, { createdAt: "asc" }] } } });
  if (!provider) throw new Error("Provider not found");
  const ep = usageEndpoint(provider);
  const checkedAt = new Date().toISOString();
  if (!ep) return { supported: false, timezone: "UTC", checkedAt, keys: [] };
  await assertPublicUrl(ep.url, [new URL(provider.baseUrl).hostname]);

  // our recorded cost per key and per day, in the provider's day boundaries
  const keyIds = provider.keys.map((k) => k.id);
  const ours = keyIds.length
    ? await db.$queryRaw<Array<{ id: string; d: string; n: bigint; cost: number }>>(Prisma.sql`
        SELECT r."providerKeyId" AS id,
               to_char((r."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${ep.timezone}, 'YYYY-MM-DD') AS d,
               count(*) FILTER (WHERE r.cost > 0) AS n,
               coalesce(sum(r.cost), 0)::float8 AS cost
        FROM "RequestLog" r
        WHERE r."providerKeyId" IN (${Prisma.join(keyIds)})
        GROUP BY 1, 2`)
    : [];

  const keys = await Promise.all(
    provider.keys.map(async (k): Promise<KeyUsage> => {
      const mine = ours.filter((o) => o.id === k.id);
      const ourTotal = mine.reduce((a, o) => a + o.cost, 0);
      const base = { keyId: k.id, label: k.label, ourTotal };
      let doc: unknown;
      try {
        const res = await fetch(ep.url, { headers: { authorization: `Bearer ${decrypt(k.secretEncrypted)}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return { ...base, ok: false, error: `HTTP ${res.status}`, balance: null, upstreamTotal: null, days: dayRows([], mine) };
        doc = await res.json();
      } catch (err) {
        return { ...base, ok: false, error: err instanceof Error ? err.message : String(err), balance: null, upstreamTotal: null, days: dayRows([], mine) };
      }
      const u = parseUsageDoc(doc);
      return { ...base, ok: true, balance: u.balance, upstreamTotal: u.total, days: dayRows(u.days, mine) };
    }),
  );
  return { supported: true, timezone: ep.timezone, checkedAt, keys };
}

function dayRows(up: Array<{ date: string; requests: number | null; cost: number | null }>, mine: Array<{ d: string; n: bigint; cost: number }>): UsageDay[] {
  const dates = [...new Set([...up.map((x) => x.date), ...mine.map((x) => x.d)])].sort().reverse();
  return dates.map((date) => {
    const a = up.find((x) => x.date === date);
    const b = mine.find((x) => x.d === date);
    return { date, upstreamRequests: a?.requests ?? null, upstreamCost: a?.cost ?? null, ourRequests: b ? Number(b.n) : 0, ourCost: b?.cost ?? 0 };
  });
}
