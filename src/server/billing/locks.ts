import { randomUUID } from "node:crypto";
import { getRedis } from "@/lib/redis";

/**
 * Tiny distributed lock / dedupe helpers. Redis (SET NX PX) when available, in-memory fallback
 * (single instance) otherwise. Never throws.
 */
const mem = new Map<string, { token: string; expiresAt: number }>();

function memPrune(now: number) {
  if (mem.size < 500) return;
  for (const [k, v] of mem) if (v.expiresAt <= now) mem.delete(k);
}

const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Try to take `key` for `ttlMs`. Returns a release function, or null if someone else holds it. */
export async function acquireLock(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
  const token = randomUUID();
  const r = getRedis();
  if (r && r.status === "ready") {
    try {
      const ok = await r.set(`lock:${key}`, token, "PX", ttlMs, "NX");
      if (ok !== "OK") return null;
      return async () => {
        try {
          await r.eval(RELEASE_LUA, 1, `lock:${key}`, token);
        } catch {
          /* lock expires on its own */
        }
      };
    } catch {
      /* fall through to memory */
    }
  }
  const now = Date.now();
  memPrune(now);
  const cur = mem.get(key);
  if (cur && cur.expiresAt > now) return null;
  mem.set(key, { token, expiresAt: now + ttlMs });
  return async () => {
    if (mem.get(key)?.token === token) mem.delete(key);
  };
}

/** Run `fn` while holding the lock; returns `{ ran:false }` if the lock was busy. */
export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const release = await acquireLock(key, ttlMs);
  if (!release) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } finally {
    await release();
  }
}

/** Returns true the first time `key` is seen inside `ttlMs` (a "send once" gate), false afterwards. */
export async function once(key: string, ttlMs: number): Promise<boolean> {
  const r = getRedis();
  if (r && r.status === "ready") {
    try {
      const ok = await r.set(`once:${key}`, "1", "PX", ttlMs, "NX");
      return ok === "OK";
    } catch {
      /* fall through */
    }
  }
  const now = Date.now();
  memPrune(now);
  const cur = mem.get(`once:${key}`);
  if (cur && cur.expiresAt > now) return false;
  mem.set(`once:${key}`, { token: "1", expiresAt: now + ttlMs });
  return true;
}

/** Test helper. */
export function __resetLocks() {
  mem.clear();
}
