import { randomUUID } from "node:crypto";
import { getRedis } from "./redis";

/**
 * Sliding-window rate limiter. Redis (sorted set + Lua, atomic, shared across instances) with an
 * automatic in-memory fallback when Redis is unset or errors.
 *
 *   const r = await rateLimit(`login:${ip}`, { limit: 10, windowSec: 600 });
 *   if (!r.ok) -> reject, tell client to retry in r.retryAfterSec
 */
export interface RateLimitOptions {
  /** Max events allowed inside the window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until a slot frees up (0 when ok). */
  retryAfterMs: number;
  /** Same, rounded up to whole seconds (use for `retry-after`). */
  retryAfterSec: number;
}

const LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = tonumber(oldest[2]) + window - now
if retry < 0 then retry = 0 end
return {0, 0, retry}
`;

type Store = Map<string, number[]>;
const g = globalThis as unknown as { __rlStore?: Store; __rlTimer?: NodeJS.Timeout };
const store: Store = (g.__rlStore ??= new Map());

if (!g.__rlTimer) {
  g.__rlTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of store) {
      // entries are pruned on access; drop keys whose newest event is older than 1h
      if (arr.length === 0 || now - arr[arr.length - 1] > 3_600_000) store.delete(k);
    }
  }, 60_000);
  g.__rlTimer.unref?.();
}

function memoryLimit(key: string, { limit, windowSec }: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const arr = (store.get(key) ?? []).filter((t) => t > now - windowMs);
  if (arr.length < limit) {
    arr.push(now);
    store.set(key, arr);
    return { ok: true, limit, remaining: limit - arr.length, retryAfterMs: 0, retryAfterSec: 0 };
  }
  store.set(key, arr);
  const retryAfterMs = Math.max(0, arr[0] + windowMs - now);
  return { ok: false, limit, remaining: 0, retryAfterMs, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
}

/** Consume one event for `key`. Never throws. */
export async function rateLimit(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
  const redis = getRedis();
  if (redis && redis.status === "ready") {
    try {
      const now = Date.now();
      const res = (await redis.eval(
        LUA,
        1,
        `rl:${key}`,
        String(now),
        String(opts.windowSec * 1000),
        String(opts.limit),
        `${now}:${randomUUID()}`,
      )) as [number, number, number];
      const retryAfterMs = Number(res[2]);
      return {
        ok: res[0] === 1,
        limit: opts.limit,
        remaining: Number(res[1]),
        retryAfterMs,
        retryAfterSec: Math.ceil(retryAfterMs / 1000),
      };
    } catch {
      // fall through to memory
    }
  }
  return memoryLimit(key, opts);
}

/** Check several limits at once; returns the first failing result (or the last ok one). */
export async function rateLimitAll(
  checks: Array<{ key: string } & RateLimitOptions>,
): Promise<RateLimitResult> {
  let last: RateLimitResult | undefined;
  for (const c of checks) {
    last = await rateLimit(c.key, c);
    if (!last.ok) return last;
  }
  return last ?? { ok: true, limit: 0, remaining: 0, retryAfterMs: 0, retryAfterSec: 0 };
}

/** Clear a key (e.g. reset login attempts after a successful login). */
export async function resetRateLimit(key: string): Promise<void> {
  store.delete(key);
  const redis = getRedis();
  if (redis && redis.status === "ready") {
    try {
      await redis.del(`rl:${key}`);
    } catch {
      /* ignore */
    }
  }
}
