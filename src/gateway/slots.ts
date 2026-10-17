import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getRedis, redisReady } from "@/lib/redis";
import { getConfig } from "./cache";

/**
 * Distributed counting semaphore ("slots", PLAN 9b).
 *
 *  - Redis mode : one sorted set per pool `slots:{kind}:{id}`; member = lease id, score = expiry (ms, Redis TIME).
 *    Acquire is ONE Lua call for all pools of a lease (all-or-nothing): purge expired -> check ZCARD < max -> ZADD.
 *    Leases live 60s and are renewed by a heartbeat every 20s while the request/stream is alive, so a crashed
 *    instance's leases self-heal through the TTL.
 *  - Memory mode: identical semantics in-process (single instance) - used when REDIS_URL is unset or Redis errors.
 *
 * Pools: customer side `key` / `user` / `group`; upstream side `pkey` (provider key) / `provider`.
 */
export type SlotKind = "key" | "user" | "group" | "pkey" | "provider";
export interface SlotPool {
  kind: SlotKind;
  id: string;
  max: number;
}

export interface SlotLease {
  readonly id: string;
  readonly pools: readonly SlotPool[];
  /** Idempotent, never throws, does not await. */
  release(): void;
}

export type AcquireResult = { ok: true; lease: SlotLease } | { ok: false; fullIndex: number };

const cfg = { ttlMs: 60_000, heartbeatMs: 20_000, maxAgeMs: 65 * 60_000 };

interface LeaseImpl extends SlotLease {
  mode: "redis" | "memory";
  released: boolean;
  createdAt: number;
}

interface State {
  mem: Map<string, Map<string, number>>;
  leases: Set<LeaseImpl>;
  waiters: Array<() => void>;
  timer: NodeJS.Timeout | null;
  queued: number;
  scriptsDefined: boolean;
}

const g = globalThis as unknown as { __ppSlots?: State };
const state: State = (g.__ppSlots ??= { mem: new Map(), leases: new Set(), waiters: [], timer: null, queued: 0, scriptsDefined: false });

const poolKey = (p: Pick<SlotPool, "kind" | "id">) => `slots:${p.kind}:${p.id}`;

// ---------------------------------------------------------------- Redis scripts
const LUA_ACQUIRE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[1])
local lease = ARGV[2]
local n = #KEYS
for i = 1, n do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
  if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[2 + i]) then return i end
end
for i = 1, n do
  redis.call('ZADD', KEYS[i], now + ttl, lease)
  redis.call('PEXPIRE', KEYS[i], ttl * 3)
end
return 0
`;

const LUA_RENEW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[1])
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], 'XX', now + ttl, ARGV[2])
  redis.call('PEXPIRE', KEYS[i], ttl * 3)
end
return 1
`;

type RedisWithScripts = {
  ppSlotAcquire(...args: Array<string | number>): Promise<number>;
  ppSlotRenew(...args: Array<string | number>): Promise<number>;
  pipeline(): { ppSlotRenew(...args: Array<string | number>): unknown; zrem(key: string, member: string): unknown; exec(): Promise<unknown> };
  zrem(key: string, member: string): Promise<number>;
};

function scripted(): RedisWithScripts | null {
  const r = getRedis();
  if (!r || !redisReady()) return null;
  if (!state.scriptsDefined || !(r as unknown as { ppSlotAcquire?: unknown }).ppSlotAcquire) {
    r.defineCommand("ppSlotAcquire", { lua: LUA_ACQUIRE });
    r.defineCommand("ppSlotRenew", { lua: LUA_RENEW });
    state.scriptsDefined = true;
  }
  return r as unknown as RedisWithScripts;
}

// ---------------------------------------------------------------- memory backend
function memPurge(m: Map<string, number>, now: number): void {
  for (const [id, exp] of m) if (exp <= now) m.delete(id);
}

function memAcquire(pools: readonly SlotPool[], leaseId: string): number {
  const now = Date.now();
  for (let i = 0; i < pools.length; i++) {
    const m = state.mem.get(poolKey(pools[i]));
    if (!m) continue;
    if (m.size >= pools[i].max) memPurge(m, now);
    if (m.size >= pools[i].max) return i + 1;
  }
  for (const p of pools) {
    const k = poolKey(p);
    let m = state.mem.get(k);
    if (!m) state.mem.set(k, (m = new Map()));
    m.set(leaseId, now + cfg.ttlMs);
  }
  return 0;
}

function memRelease(pools: readonly SlotPool[], leaseId: string): void {
  for (const p of pools) {
    const k = poolKey(p);
    const m = state.mem.get(k);
    if (!m) continue;
    m.delete(leaseId);
    if (m.size === 0) state.mem.delete(k);
  }
}

// ---------------------------------------------------------------- heartbeat
function ensureHeartbeat(): void {
  if (state.timer) return;
  state.timer = setInterval(() => void heartbeat(), cfg.heartbeatMs);
  state.timer.unref?.();
}

async function heartbeat(): Promise<void> {
  if (!state.leases.size) return;
  const now = Date.now();
  const redisLeases: LeaseImpl[] = [];
  for (const l of [...state.leases]) {
    if (now - l.createdAt > cfg.maxAgeMs) {
      // safety net: a lease that outlives any possible request is a leak - stop renewing it and let it expire
      logger.warn("slot lease exceeded max age, releasing", { lease: l.id, pools: l.pools.map(poolKey) });
      l.release();
      continue;
    }
    if (l.mode === "memory") {
      for (const p of l.pools) state.mem.get(poolKey(p))?.set(l.id, now + cfg.ttlMs);
    } else redisLeases.push(l);
  }
  if (!redisLeases.length) return;
  const r = scripted();
  if (!r) return;
  try {
    const pipe = r.pipeline();
    for (const l of redisLeases) pipe.ppSlotRenew(l.pools.length, ...l.pools.map(poolKey), cfg.ttlMs, l.id);
    await pipe.exec();
  } catch (err) {
    logger.warn("slot heartbeat failed", { err });
  }
}

// ---------------------------------------------------------------- public API
function notifyRelease(): void {
  const w = state.waiters.shift();
  if (w) w();
}

/**
 * Try to take one slot in EVERY pool (all-or-nothing). Never throws: a Redis failure falls back to the
 * in-memory backend. Pools with max <= 0 are skipped.
 */
export async function acquireSlots(poolsIn: readonly SlotPool[]): Promise<AcquireResult> {
  const pools = poolsIn.filter((p) => p.max > 0);
  const id = randomUUID();
  let mode: "redis" | "memory" = "memory";
  let full = 0;

  const r = pools.length ? scripted() : null;
  let done = false;
  if (r) {
    try {
      full = await r.ppSlotAcquire(pools.length, ...pools.map(poolKey), cfg.ttlMs, id, ...pools.map((p) => p.max));
      mode = "redis";
      done = true;
    } catch (err) {
      logger.warn("redis slot acquire failed, using memory fallback", { err });
    }
  }
  if (!done) {
    mode = "memory";
    full = pools.length ? memAcquire(pools, id) : 0;
  }
  if (full > 0) return { ok: false, fullIndex: poolsIn.indexOf(pools[full - 1]) };

  const lease: LeaseImpl = {
    id,
    pools,
    mode,
    released: false,
    createdAt: Date.now(),
    release() {
      if (lease.released) return;
      lease.released = true;
      state.leases.delete(lease);
      if (lease.mode === "memory") memRelease(lease.pools, lease.id);
      else {
        const rr = scripted();
        if (rr) {
          try {
            const pipe = rr.pipeline();
            for (const p of lease.pools) pipe.zrem(poolKey(p), lease.id);
            pipe.exec().catch(() => undefined);
          } catch {
            /* TTL will reap it */
          }
        }
      }
      notifyRelease();
    },
  };
  if (pools.length) {
    state.leases.add(lease);
    ensureHeartbeat();
  }
  return { ok: true, lease };
}

/** Resolve when a local slot is released (FIFO: one waiter per release), after `timeoutMs`, or on abort. */
export function waitForRelease(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      const i = state.waiters.indexOf(finish);
      if (i >= 0) state.waiters.splice(i, 1);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    state.waiters.push(finish);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function trackQueued(delta: number): void {
  state.queued = Math.max(0, state.queued + delta);
}

export function queuedCount(): number {
  return state.queued;
}

/** Current in-use count of one pool (memory + Redis aware). */
export async function slotInUse(kind: SlotKind, id: string): Promise<number> {
  const k = poolKey({ kind, id });
  const r = scripted();
  if (r) {
    try {
      const n = await (getRedis() as unknown as { zcount(k: string, a: string | number, b: string | number): Promise<number> }).zcount(k, Date.now(), "+inf");
      return n;
    } catch {
      /* fall through */
    }
  }
  const m = state.mem.get(k);
  if (!m) return 0;
  memPurge(m, Date.now());
  return m.size;
}

/** Test hook: clear all state and optionally shorten TTL/heartbeat. */
export function __resetSlotsForTests(opts: { ttlMs?: number; heartbeatMs?: number; maxAgeMs?: number } = {}): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.mem.clear();
  state.leases.clear();
  state.waiters.length = 0;
  state.queued = 0;
  cfg.ttlMs = opts.ttlMs ?? 60_000;
  cfg.heartbeatMs = opts.heartbeatMs ?? 20_000;
  cfg.maxAgeMs = opts.maxAgeMs ?? 65 * 60_000;
}

/** Test hook: run one heartbeat pass now. */
export function __heartbeatForTests(): Promise<void> {
  return heartbeat();
}

// ---------------------------------------------------------------- admin snapshot
export type SlotUsage = { id: string; label: string; inUse: number; max: number | null };

export type SlotSnapshot = {
  providerKeys: (SlotUsage & { providerId: string })[];
  providers: SlotUsage[];
  customers: SlotUsage[]; // top users by in-use slots
  queued: number;
  at: string;
};

async function countMany(kind: SlotKind, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const r = scripted();
  if (r && ids.length) {
    try {
      const pipe = (getRedis() as unknown as { pipeline(): { zcount(k: string, a: number, b: string): unknown; exec(): Promise<Array<[Error | null, number]>> } }).pipeline();
      const now = Date.now();
      for (const id of ids) pipe.zcount(poolKey({ kind, id }), now, "+inf");
      const res = await pipe.exec();
      ids.forEach((id, i) => out.set(id, Number(res?.[i]?.[1] ?? 0)));
      return out;
    } catch {
      /* fall back to memory */
    }
  }
  const now = Date.now();
  for (const id of ids) {
    const m = state.mem.get(poolKey({ kind, id }));
    if (m) memPurge(m, now);
    out.set(id, m?.size ?? 0);
  }
  return out;
}

async function topUsers(limit: number): Promise<Array<{ id: string; inUse: number }>> {
  const rows: Array<{ id: string; inUse: number }> = [];
  const r = scripted();
  if (r) {
    try {
      const redis = getRedis() as unknown as {
        scan(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]>;
      };
      const keys: string[] = [];
      let cursor = "0";
      let rounds = 0;
      do {
        const [next, batch] = await redis.scan(cursor, "MATCH", "slots:user:*", "COUNT", 500);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== "0" && ++rounds < 20 && keys.length < 5000);
      const ids = keys.map((k) => k.slice("slots:user:".length));
      const counts = await countMany("user", ids);
      for (const [id, n] of counts) if (n > 0) rows.push({ id, inUse: n });
    } catch {
      /* fall back to memory */
    }
  }
  if (!rows.length) {
    const now = Date.now();
    for (const [k, m] of state.mem) {
      if (!k.startsWith("slots:user:")) continue;
      memPurge(m, now);
      if (m.size) rows.push({ id: k.slice("slots:user:".length), inUse: m.size });
    }
  }
  return rows.sort((a, b) => b.inUse - a.inUse).slice(0, limit);
}

/** Live slot usage for the admin console (`GET /api/admin/slots`). */
export async function getSlotSnapshot(): Promise<SlotSnapshot> {
  const at = new Date().toISOString();
  try {
    const cfgSnap = await getConfig();
    const defaultKeyConc = cfgSnap.settings.defaultKeyConcurrency;
    const allKeys = [...cfgSnap.keysByProvider.values()].flat();
    const keyCounts = await countMany("pkey", allKeys.map((k) => k.id));
    const providers: SlotUsage[] = [];
    const providerKeys: (SlotUsage & { providerId: string })[] = allKeys.map((k) => ({
      id: k.id,
      providerId: k.providerId,
      label: `${cfgSnap.providers.get(k.providerId)?.name ?? k.providerId} / ${k.label}`,
      inUse: keyCounts.get(k.id) ?? 0,
      max: k.maxConcurrency ?? defaultKeyConc,
    }));
    for (const p of cfgSnap.providers.values()) {
      const used = providerKeys.filter((k) => k.providerId === p.id).reduce((a, k) => a + k.inUse, 0);
      providers.push({ id: p.id, label: p.name, inUse: used, max: p.maxConcurrency ?? null });
    }
    const top = await topUsers(20);
    let customers: SlotUsage[] = top.map((t) => ({ id: t.id, label: t.id, inUse: t.inUse, max: null }));
    if (top.length) {
      const users = await db.user.findMany({ where: { id: { in: top.map((t) => t.id) } }, select: { id: true, email: true, maxConcurrency: true } });
      const byId = new Map(users.map((u) => [u.id, u]));
      customers = top.map((t) => ({ id: t.id, label: byId.get(t.id)?.email ?? t.id, inUse: t.inUse, max: byId.get(t.id)?.maxConcurrency ?? cfgSnap.settings.defaultCustomerConcurrency }));
    }
    return { providerKeys, providers, customers, queued: state.queued, at };
  } catch (err) {
    logger.warn("slot snapshot failed", { err });
    return { providerKeys: [], providers: [], customers: [], queued: state.queued, at };
  }
}
