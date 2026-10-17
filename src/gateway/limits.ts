import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Decimal, ZERO, toDecimal } from "@/lib/money";
import { getRedis, redisReady } from "@/lib/redis";
import { rateLimit } from "@/lib/ratelimit";
import { onGatewayInvalidate } from "./cache";

/**
 * Soft limits that sit next to the slot manager:
 *  - RPM (sliding window via lib/ratelimit - Redis with memory fallback)
 *  - TPM (two-bucket sliding estimate, Redis INCRBY with memory fallback)
 *  - upstream-key daily budget + customer monthly spend (DB-seeded, locally incremented, 60s refresh)
 *  - failed-auth throttle per IP (protects the DB from garbage-key floods)
 */

// ------------------------------------------------------------------ RPM
export async function checkRpm(scope: string, limit: number): Promise<{ ok: boolean; retryAfterSec: number }> {
  const r = await rateLimit(`gw:rpm:${scope}`, { limit, windowSec: 60 });
  return { ok: r.ok, retryAfterSec: Math.max(1, r.retryAfterSec) };
}

// ------------------------------------------------------------------ TPM
const mem = new Map<string, number>();
const BUCKET_MS = 60_000;
let memSweep: NodeJS.Timeout | null = null;

function sweepMem(): void {
  if (memSweep) return;
  memSweep = setInterval(() => {
    const cutoff = Math.floor(Date.now() / BUCKET_MS) - 2;
    for (const k of mem.keys()) {
      const b = Number(k.slice(k.lastIndexOf(":") + 1));
      if (b < cutoff) mem.delete(k);
    }
  }, 60_000);
  memSweep.unref?.();
}

const bucketKey = (scope: string, b: number) => `tpm:${scope}:${b}`;

/** Tokens used in the (prorated) last minute for `scope`. */
export async function tpmUsed(scope: string): Promise<number> {
  const now = Date.now();
  const b = Math.floor(now / BUCKET_MS);
  const frac = (now % BUCKET_MS) / BUCKET_MS;
  let cur = 0;
  let prev = 0;
  const r = getRedis();
  if (r && redisReady()) {
    try {
      const [c, p] = await r.mget(bucketKey(scope, b), bucketKey(scope, b - 1));
      cur = Number(c ?? 0);
      prev = Number(p ?? 0);
      return cur + prev * (1 - frac);
    } catch {
      /* memory fallback */
    }
  }
  cur = mem.get(bucketKey(scope, b)) ?? 0;
  prev = mem.get(bucketKey(scope, b - 1)) ?? 0;
  return cur + prev * (1 - frac);
}

export function tpmAdd(scope: string, tokens: number): void {
  if (tokens <= 0) return;
  const b = Math.floor(Date.now() / BUCKET_MS);
  const k = bucketKey(scope, b);
  const r = getRedis();
  if (r && redisReady()) {
    r.multi().incrby(k, tokens).expire(k, 150).exec().catch(() => undefined);
    return;
  }
  sweepMem();
  mem.set(k, (mem.get(k) ?? 0) + tokens);
}

export async function checkTpm(scope: string, limit: number): Promise<{ ok: boolean; retryAfterSec: number }> {
  const used = await tpmUsed(scope);
  if (used < limit) return { ok: true, retryAfterSec: 0 };
  const secsToNextBucket = Math.ceil((BUCKET_MS - (Date.now() % BUCKET_MS)) / 1000);
  return { ok: false, retryAfterSec: Math.max(1, secsToNextBucket) };
}

// ------------------------------------------------------------------ DB-seeded running sums
interface Running {
  value: Decimal;
  loadedAt: number;
  loading: Promise<void> | null;
}

class RunningSum {
  private map = new Map<string, Running>();
  constructor(
    private readonly name: string,
    private readonly load: (id: string) => Promise<Decimal>,
    private readonly ttlMs = 60_000,
  ) {}

  /** Current value; (re)loads from the DB when missing or older than ttl. Blocks only when there is no value yet. */
  async get(id: string): Promise<Decimal> {
    const now = Date.now();
    let e = this.map.get(id);
    if (!e) {
      e = { value: ZERO, loadedAt: 0, loading: null };
      this.map.set(id, e);
    }
    if (now - e.loadedAt > this.ttlMs && !e.loading) {
      const entry = e;
      entry.loading = this.load(id)
        .then((v) => {
          entry.value = v;
          entry.loadedAt = Date.now();
        })
        .catch((err) => {
          logger.warn(`${this.name} load failed`, { err });
          entry.loadedAt = Date.now() - this.ttlMs + 5_000; // retry soon
        })
        .finally(() => {
          entry.loading = null;
        });
    }
    if (e.loadedAt === 0 && e.loading) await e.loading;
    return e.value;
  }

  add(id: string, amount: Decimal): void {
    const e = this.map.get(id);
    if (e) e.value = e.value.plus(amount);
  }

  clear(id?: string): void {
    if (id) this.map.delete(id);
    else this.map.clear();
  }
}

const dayStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

const g = globalThis as unknown as { __ppRunning?: { daily: RunningSum; monthly: RunningSum; dailyDay: number } };
const running = (g.__ppRunning ??= {
  dailyDay: dayStart().getTime(),
  daily: new RunningSum("provider-key daily cost", async (id) => {
    const r = await db.requestLog.aggregate({ _sum: { cost: true }, where: { providerKeyId: id, createdAt: { gte: dayStart() } } });
    return toDecimal(r._sum.cost);
  }),
  monthly: new RunningSum("monthly spend", async (id) => {
    const r = await db.requestLog.aggregate({ _sum: { price: true }, where: { userId: id, createdAt: { gte: monthStart() } } });
    return toDecimal(r._sum.price);
  }),
});

/** Cost paid to an upstream key since 00:00 UTC (for ProviderKey.dailyBudget). */
export async function providerKeyDailyCost(providerKeyId: string): Promise<Decimal> {
  const today = dayStart().getTime();
  if (running.dailyDay !== today) {
    running.dailyDay = today;
    running.daily.clear();
  }
  return running.daily.get(providerKeyId);
}

export function addProviderKeyCost(providerKeyId: string, cost: Decimal): void {
  running.daily.add(providerKeyId, cost);
}

/** Customer spend since the first of the month, UTC (for User.monthlySpendLimit). */
export async function userMonthlySpend(userId: string): Promise<Decimal> {
  return running.monthly.get(userId);
}

export function addUserSpend(userId: string, price: Decimal): void {
  running.monthly.add(userId, price);
}

export function clearSpendCaches(userId?: string): void {
  running.monthly.clear(userId);
}

onGatewayInvalidate((scope, id) => {
  if (scope === "users" || scope === "all") clearSpendCaches(id);
});

// ------------------------------------------------------------------ failed-auth throttle
const failMap = new Map<string, { n: number; resetAt: number }>();
const FAIL_LIMIT = 300;
const FAIL_WINDOW_MS = 60_000;

/** Record a failed key lookup from `ip`; returns true when the IP has exceeded the failure budget. */
export function noteAuthFailure(ip: string): boolean {
  const now = Date.now();
  let e = failMap.get(ip);
  if (!e || e.resetAt < now) {
    e = { n: 0, resetAt: now + FAIL_WINDOW_MS };
    failMap.set(ip, e);
    if (failMap.size > 50_000) failMap.clear();
  }
  e.n++;
  return e.n > FAIL_LIMIT;
}

export function isAuthThrottled(ip: string): boolean {
  const e = failMap.get(ip);
  return !!e && e.resetAt >= Date.now() && e.n > FAIL_LIMIT;
}

// ------------------------------------------------------------------ log flood guard for unauthenticated requests
const anonLog = new Map<string, { n: number; resetAt: number }>();

/** At most `perMinute` anonymous (no known user) request logs per IP. */
export function allowAnonymousLog(ip: string, perMinute = 20): boolean {
  const now = Date.now();
  let e = anonLog.get(ip);
  if (!e || e.resetAt < now) {
    e = { n: 0, resetAt: now + 60_000 };
    anonLog.set(ip, e);
    if (anonLog.size > 50_000) anonLog.clear();
  }
  e.n++;
  return e.n <= perMinute;
}
