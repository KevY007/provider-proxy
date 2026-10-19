import { createHash } from "node:crypto";
import { logger } from "@/lib/logger";
import { Decimal, ZERO } from "@/lib/money";
import { getRedis, redisReady } from "@/lib/redis";

/**
 * Credit reservations ("holds", PLAN 9c funds protection).
 *
 * Before a request is sent upstream we RESERVE the worst-case price of that request against the customer's
 * available funds:
 *
 *     available = balance + creditLimit - minBalanceToCall - (open holds + settled-but-not-yet-flushed debits)
 *
 * so N concurrent requests can never jointly spend more than the customer owns. The reservation is atomic:
 *   - Redis  : one Lua call per reservation over the hash `hold:{userId}` (field = hold id = request id,
 *              value = "H|<micro-USD>|<expiry ms>") + the authoritative balance string `bal:{userId}`.
 *              Every hold has its own expiry (safety net for crashed instances; live holds are renewed by a heartbeat).
 *   - Memory : identical semantics in-process (single instance) - used without REDIS_URL or when Redis errors.
 *
 * Settle  : the hold turns into a pending debit ("P") worth the actual price. It stays visible to every instance
 *           until the meter writer committed the debit to the database (`holdsFlushed`), which also publishes the new
 *           authoritative balance. Without that step another instance could admit requests during the flush window.
 * Release : the hold is dropped (request failed before any charge).
 *
 * Amounts are integers in micro-USD inside Redis (holds rounded UP, balances rounded DOWN = conservative).
 */
export type HoldBackend = "redis" | "memory";

export interface HoldRef {
  id: string;
  userId: string;
  keyId: string | null;
  backend: HoldBackend;
  createdAt: number;
}

export interface ReserveInput {
  id: string;
  userId: string;
  keyId: string | null;
  /** Worst-case price of the request (>= 0). 0 = only check that funds are available (> 0). */
  amount: Decimal;
  /** Last known DB balance: authoritative in memory mode, only the seed of `bal:{userId}` in Redis mode. */
  base: Decimal;
  /** creditLimit - minBalanceToCall */
  headroomExtra: Decimal;
  /** monthlySpendLimit - spent this month (null = no limit) */
  monthlyRemaining: Decimal | null;
  /** key.spendLimit - key.spent (null = no limit) */
  keyRemaining: Decimal | null;
  /**
   * Long-lived hold (Batch API): kept for `ttlMs` without a heartbeat (the batch outlives the request that created it);
   * released by `releaseHold` once its results are metered, re-placed by the batch sweep (`restoreHold`).
   */
  ttlMs?: number;
}

export interface ReserveOutcome {
  ok: boolean;
  backend: HoldBackend;
  /** balance-based available funds BEFORE this reservation */
  available: Decimal;
  monthlyAvailable: Decimal | null;
  keyAvailable: Decimal | null;
  reason?: "balance" | "monthly" | "key";
  /** the balance the check used (Redis: the shared `bal:{userId}`; memory: the cached DB balance) */
  sharedBalance?: Decimal;
}

const HOLD_TTL_MS = 5 * 60_000; // renewed by the heartbeat while the request is alive
const PENDING_TTL_MS = 10 * 60_000; // settled debit waiting for the meter writer
const BAL_TTL_MS = 10 * 60_000;
const HEARTBEAT_MS = 60_000;
const MAX_HOLD_AGE_MS = 65 * 60_000;
const MICRO = new Decimal(1_000_000);

// ---------------------------------------------------------------- state
interface MemEntry {
  kind: "H" | "P";
  amount: Decimal;
  keyId: string | null;
  exp: number;
}
interface OpenHold extends HoldRef {
  ttlRenewedAt: number;
}
interface State {
  mem: Map<string, Map<string, MemEntry>>;
  open: Map<string, OpenHold>;
  settling: Map<string, Promise<void>>;
  timer: NodeJS.Timeout | null;
  scriptsTag: string;
  warnedAt: number;
}
const g = globalThis as unknown as { __ppHolds?: State };
const state: State = (g.__ppHolds ??= { mem: new Map(), open: new Map(), settling: new Map(), timer: null, scriptsTag: "", warnedAt: 0 });

const holdKey = (userId: string) => `hold:${userId}`;
const keyHoldKey = (keyId: string) => `hold:key:${keyId}`;
const balKey = (userId: string) => `bal:${userId}`;

const microUp = (d: Decimal): number => Math.max(0, d.times(MICRO).ceil().toNumber());
const microDown = (d: Decimal): number => d.times(MICRO).floor().toNumber();
const fromMicro = (n: number): Decimal => new Decimal(n).div(MICRO);

// ---------------------------------------------------------------- Redis scripts
const LUA_SCAN = `
local function scan(key, now)
  local sumH, sumP = 0, 0
  local all = redis.call('HGETALL', key)
  for i = 1, #all, 2 do
    local kind, amt, exp = string.match(all[i + 1], '^(%a)|(%-?%d+)|(%d+)$')
    if (not kind) or tonumber(exp) <= now then
      redis.call('HDEL', key, all[i])
    elseif kind == 'H' then
      sumH = sumH + tonumber(amt)
    else
      sumP = sumP + tonumber(amt)
    end
  end
  return sumH, sumP
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

/** Lengthen (never shorten) the expiry of a hash: long-lived batch holds share it with short request holds. */
const LUA_EXTEND = `
local function extend(key, ms)
  local cur = redis.call('PTTL', key)
  if cur == -1 or (cur >= 0 and cur < ms) then redis.call('PEXPIRE', key, ms) end
end
`;

// KEYS: 1 hold hash, 2 bal, [3 key hold hash]
// ARGV: 1 id, 2 amount, 3 seed balance, 4 extra headroom, 5 monthly remaining|'x', 6 key remaining|'x', 7 hold ttl ms, 8 bal ttl ms
const LUA_RESERVE =
  LUA_SCAN +
  LUA_EXTEND +
  `
local uH, uP = scan(KEYS[1], now)
local bal = redis.call('GET', KEYS[2])
if not bal then
  bal = ARGV[3]
  redis.call('SET', KEYS[2], bal, 'PX', ARGV[8])
end
local available = tonumber(bal) + tonumber(ARGV[4]) - uH - uP
local amount = tonumber(ARGV[2])
local monthlyAvail = 0
local hasMonthly = ARGV[5] ~= 'x'
if hasMonthly then monthlyAvail = tonumber(ARGV[5]) - uH end
local keyAvail = 0
local hasKey = #KEYS >= 3
if hasKey then
  local kH = scan(KEYS[3], now)
  keyAvail = tonumber(ARGV[6]) - kH
end
local reason = 0
if available <= 0 or available < amount then reason = 1
elseif hasMonthly and monthlyAvail < amount then reason = 2
elseif hasKey and keyAvail < amount then reason = 3 end
if reason == 0 and amount > 0 then
  local v = 'H|' .. string.format('%d', amount) .. '|' .. string.format('%d', now + tonumber(ARGV[7]))
  redis.call('HSET', KEYS[1], ARGV[1], v)
  extend(KEYS[1], tonumber(ARGV[7]) * 3)
  if hasKey then
    redis.call('HSET', KEYS[3], ARGV[1], v)
    extend(KEYS[3], tonumber(ARGV[7]) * 3)
  end
end
return {reason, available, monthlyAvail, keyAvail, tonumber(bal)}
`;

// KEYS: 1 hold hash, [2 key hold hash]; ARGV: 1 id, 2 price (micro), 3 pending ttl ms
const LUA_SETTLE =
  LUA_EXTEND +
  `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if tonumber(ARGV[2]) > 0 then
  redis.call('HSET', KEYS[1], ARGV[1], 'P|' .. string.format('%d', ARGV[2]) .. '|' .. string.format('%d', now + tonumber(ARGV[3])))
  extend(KEYS[1], tonumber(ARGV[3]) * 2)
else
  redis.call('HDEL', KEYS[1], ARGV[1])
end
if #KEYS >= 2 then redis.call('HDEL', KEYS[2], ARGV[1]) end
return 1
`;

// KEYS: 1 hold hash, 2 bal; ARGV: 1 new balance (micro) | 'x', 2 bal ttl, 3.. ids
const LUA_FLUSHED = `
for i = 3, #ARGV do redis.call('HDEL', KEYS[1], ARGV[i]) end
if ARGV[1] ~= 'x' then
  local cur = redis.call('GET', KEYS[2])
  if (not cur) or tonumber(cur) > tonumber(ARGV[1]) then redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2]) end
end
return 1
`;

// KEYS: 1 hold hash; ARGV: 1 ttl ms, 2.. ids   (extends only open holds "H")
const LUA_RENEW =
  LUA_EXTEND +
  `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
for i = 2, #ARGV do
  local v = redis.call('HGET', KEYS[1], ARGV[i])
  if v then
    local kind, amt = string.match(v, '^(%a)|(%-?%d+)|')
    if kind == 'H' then redis.call('HSET', KEYS[1], ARGV[i], 'H|' .. amt .. '|' .. string.format('%d', now + tonumber(ARGV[1]))) end
  end
end
extend(KEYS[1], tonumber(ARGV[1]) * 3)
return 1
`;

// KEYS: 1 hold hash; ARGV: 1 id, 2 amount (micro), 3 ttl ms   (re-place a long-lived hold unless it was settled meanwhile)
const LUA_RESTORE =
  LUA_EXTEND +
  `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur and string.sub(cur, 1, 1) == 'P' then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], 'H|' .. string.format('%d', ARGV[2]) .. '|' .. string.format('%d', now + tonumber(ARGV[3])))
extend(KEYS[1], tonumber(ARGV[3]) * 3)
return 1
`;

type RedisScripts = {
  ppHoldReserve(...a: Array<string | number>): Promise<number[]>;
  ppHoldSettle(...a: Array<string | number>): Promise<number>;
  ppHoldFlushed(...a: Array<string | number>): Promise<number>;
  ppHoldRenew(...a: Array<string | number>): Promise<number>;
  ppHoldRestore(...a: Array<string | number>): Promise<number>;
  set(key: string, value: string, mode: "PX", ms: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
};

/** Identity of the script set: after a code reload (dev HMR) the long-lived Redis client must get the NEW scripts. */
const SCRIPT_TAG = createHash("sha1").update([LUA_RESERVE, LUA_SETTLE, LUA_FLUSHED, LUA_RENEW, LUA_RESTORE].join("\u0000")).digest("hex");

function scripted(): RedisScripts | null {
  const r = getRedis();
  if (!r || !redisReady()) return null;
  if (state.scriptsTag !== SCRIPT_TAG || !(r as unknown as { ppHoldReserve?: unknown }).ppHoldReserve) {
    r.defineCommand("ppHoldReserve", { lua: LUA_RESERVE });
    r.defineCommand("ppHoldSettle", { lua: LUA_SETTLE });
    r.defineCommand("ppHoldFlushed", { lua: LUA_FLUSHED });
    r.defineCommand("ppHoldRenew", { lua: LUA_RENEW });
    r.defineCommand("ppHoldRestore", { lua: LUA_RESTORE });
    state.scriptsTag = SCRIPT_TAG;
  }
  return r as unknown as RedisScripts;
}

function warnOnce(msg: string, err: unknown): void {
  const now = Date.now();
  if (now - state.warnedAt < 30_000) return;
  state.warnedAt = now;
  logger.warn(msg, { err });
}

// ---------------------------------------------------------------- memory backend
function memEntries(userId: string): Map<string, MemEntry> {
  let m = state.mem.get(userId);
  if (!m) state.mem.set(userId, (m = new Map()));
  return m;
}

function memScan(m: Map<string, MemEntry>, now: number): { h: Decimal; p: Decimal } {
  let h = ZERO;
  let p = ZERO;
  for (const [id, e] of m) {
    if (e.exp <= now) m.delete(id);
    else if (e.kind === "H") h = h.plus(e.amount);
    else p = p.plus(e.amount);
  }
  return { h, p };
}

function memReserve(i: ReserveInput): ReserveOutcome {
  const now = Date.now();
  const m = memEntries(i.userId);
  const { h, p } = memScan(m, now);
  const available = i.base.plus(i.headroomExtra).minus(h).minus(p);
  const monthlyAvailable = i.monthlyRemaining ? i.monthlyRemaining.minus(h) : null;
  let keyAvailable: Decimal | null = null;
  if (i.keyId && i.keyRemaining) {
    let kh = ZERO;
    for (const e of m.values()) if (e.kind === "H" && e.keyId === i.keyId) kh = kh.plus(e.amount);
    keyAvailable = i.keyRemaining.minus(kh);
  }
  let reason: ReserveOutcome["reason"];
  if (available.lte(0) || available.lt(i.amount)) reason = "balance";
  else if (monthlyAvailable && monthlyAvailable.lt(i.amount)) reason = "monthly";
  else if (keyAvailable && keyAvailable.lt(i.amount)) reason = "key";
  if (!reason && i.amount.gt(0)) m.set(i.id, { kind: "H", amount: i.amount, keyId: i.keyId, exp: now + (i.ttlMs ?? HOLD_TTL_MS) });
  return { ok: !reason, backend: "memory", available, monthlyAvailable, keyAvailable, reason, sharedBalance: i.base };
}

// ---------------------------------------------------------------- public API
/** Atomically check the funds and, when they suffice, place the hold. Never throws. */
export async function reserveHold(i: ReserveInput): Promise<ReserveOutcome> {
  const r = scripted();
  if (r) {
    try {
      const keys = [holdKey(i.userId), balKey(i.userId), ...(i.keyId && i.keyRemaining ? [keyHoldKey(i.keyId)] : [])];
      const res = await r.ppHoldReserve(
        keys.length,
        ...keys,
        i.id,
        microUp(i.amount),
        microDown(i.base),
        microDown(i.headroomExtra),
        i.monthlyRemaining ? microDown(i.monthlyRemaining) : "x",
        i.keyId && i.keyRemaining ? microDown(i.keyRemaining) : "x",
        i.ttlMs ?? HOLD_TTL_MS,
        BAL_TTL_MS,
      );
      const [reason, available, monthly, key, bal] = res.map(Number);
      const ok = reason === 0;
      if (ok && i.amount.gt(0) && !i.ttlMs) trackOpen({ id: i.id, userId: i.userId, keyId: i.keyId, backend: "redis", createdAt: Date.now() });
      return {
        ok,
        backend: "redis",
        available: fromMicro(available),
        monthlyAvailable: i.monthlyRemaining ? fromMicro(monthly) : null,
        keyAvailable: i.keyId && i.keyRemaining ? fromMicro(key) : null,
        reason: reason === 1 ? "balance" : reason === 2 ? "monthly" : reason === 3 ? "key" : undefined,
        sharedBalance: fromMicro(bal),
      };
    } catch (err) {
      warnOnce("redis hold reserve failed, using in-memory holds", err);
    }
  }
  const out = memReserve(i);
  if (out.ok && i.amount.gt(0) && !i.ttlMs) trackOpen({ id: i.id, userId: i.userId, keyId: i.keyId, backend: "memory", createdAt: Date.now() });
  return out;
}

function trackOpen(ref: HoldRef): void {
  state.open.set(ref.id, { ...ref, ttlRenewedAt: Date.now() });
  ensureHeartbeat();
}

/** The hold of a request is replaced by a pending debit of `price` (0 = nothing to debit). Fire-and-forget but ordered with `holdsFlushed`. */
export function settleHold(ref: HoldRef, price: Decimal): void {
  state.open.delete(ref.id);
  if (ref.backend === "memory") {
    const m = state.mem.get(ref.userId);
    if (!m) {
      if (price.gt(0)) memEntries(ref.userId).set(ref.id, { kind: "P", amount: price, keyId: null, exp: Date.now() + PENDING_TTL_MS });
      return;
    }
    if (price.gt(0)) m.set(ref.id, { kind: "P", amount: price, keyId: null, exp: Date.now() + PENDING_TTL_MS });
    else m.delete(ref.id);
    if (m.size === 0) state.mem.delete(ref.userId);
    return;
  }
  const r = scripted();
  if (!r) return; // hold expires on its own
  const keys = [holdKey(ref.userId), ...(ref.keyId ? [keyHoldKey(ref.keyId)] : [])];
  const p = r
    .ppHoldSettle(keys.length, ...keys, ref.id, microUp(price), PENDING_TTL_MS)
    .then(() => undefined)
    .catch((err) => warnOnce("redis hold settle failed (the hold expires on its own)", err))
    .finally(() => {
      state.settling.delete(ref.id);
    });
  state.settling.set(ref.id, p);
}

/** Drop a hold without any debit (failed before charge / abandoned). Idempotent. */
export function releaseHold(ref: HoldRef): void {
  settleHold(ref, ZERO);
}

/**
 * Re-place a long-lived hold (Batch API) with a fresh expiry: after an instance restart (memory backend) or a Redis
 * flush the hold of a still-running batch would otherwise be gone. A hold that was settled meanwhile stays settled.
 */
export async function restoreHold(ref: HoldRef, amount: Decimal, ttlMs: number): Promise<void> {
  if (amount.lte(0)) return;
  if (ref.backend === "redis") {
    const r = scripted();
    if (r) {
      try {
        await r.ppHoldRestore(1, holdKey(ref.userId), ref.id, microUp(amount), ttlMs);
        return;
      } catch (err) {
        warnOnce("redis hold restore failed, using in-memory holds", err);
      }
    }
  }
  const m = memEntries(ref.userId);
  const cur = m.get(ref.id);
  if (cur?.kind === "P") return;
  m.set(ref.id, { kind: "H", amount, keyId: ref.keyId, exp: Date.now() + ttlMs });
}

/** True while the hold of this request is still open (not yet settled / released). */
export function isHoldOpen(id: string): boolean {
  return state.open.has(id);
}

/**
 * The meter writer committed these requests' debits: forget their pending entries and publish the authoritative
 * balance (Redis: `bal:{userId}`, only ever lowered here - credits arrive through the invalidation hook).
 */
export async function holdsFlushed(userId: string, ids: string[]): Promise<void> {
  const mem = state.mem.get(userId);
  if (mem) {
    for (const id of ids) {
      const e = mem.get(id);
      if (e && e.kind === "P") mem.delete(id);
    }
    if (mem.size === 0) state.mem.delete(userId);
  }
  if (!ids.length) return;
  const r = scripted();
  if (!r) return;
  try {
    const waits = ids.map((id) => state.settling.get(id)).filter((p): p is Promise<void> => !!p);
    if (waits.length) await Promise.all(waits);
    await r.ppHoldFlushed(2, holdKey(userId), balKey(userId), "x", BAL_TTL_MS, ...ids);
  } catch (err) {
    warnOnce("redis hold cleanup failed", err);
  }
}

/** Publish the authoritative DB balance after a flush (never raises the shared value; see LUA_FLUSHED). */
export async function publishBalance(userId: string, balance: Decimal, ids: string[]): Promise<void> {
  const r = scripted();
  if (!r) return holdsFlushed(userId, ids);
  try {
    const waits = ids.map((id) => state.settling.get(id)).filter((p): p is Promise<void> => !!p);
    if (waits.length) await Promise.all(waits);
    await r.ppHoldFlushed(2, holdKey(userId), balKey(userId), microDown(balance), BAL_TTL_MS, ...ids);
  } catch (err) {
    warnOnce("redis balance publish failed", err);
  }
  const mem = state.mem.get(userId);
  if (mem) {
    for (const id of ids) {
      const e = mem.get(id);
      if (e && e.kind === "P") mem.delete(id);
    }
    if (mem.size === 0) state.mem.delete(userId);
  }
}

/** Forget the shared balance of a user (top-up / adjustment): the next reservation re-seeds it from the DB. */
export function forgetSharedBalance(userId: string): void {
  const r = scripted();
  if (!r) return;
  r.del(balKey(userId)).catch((err) => warnOnce("redis bal delete failed", err));
}

/** Overwrite the shared balance with a value just read from the DB (used before rejecting with 402). */
export async function forceSharedBalance(userId: string, balance: Decimal): Promise<void> {
  const r = scripted();
  if (!r) return;
  try {
    await r.set(balKey(userId), String(microDown(balance)), "PX", BAL_TTL_MS);
  } catch (err) {
    warnOnce("redis bal set failed", err);
  }
}

/** Total of the open holds + pending debits we know for a user (introspection / tests). Memory backend only. */
export function memoryObligations(userId: string): { holds: Decimal; pending: Decimal } {
  const m = state.mem.get(userId);
  if (!m) return { holds: ZERO, pending: ZERO };
  const { h, p } = memScan(m, Date.now());
  return { holds: h, pending: p };
}

// ---------------------------------------------------------------- heartbeat
function ensureHeartbeat(): void {
  if (state.timer) return;
  state.timer = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  state.timer.unref?.();
}

async function heartbeat(): Promise<void> {
  const now = Date.now();
  const byUser = new Map<string, string[]>();
  for (const h of state.open.values()) {
    if (now - h.createdAt > MAX_HOLD_AGE_MS) {
      state.open.delete(h.id); // leaked: stop renewing, the expiry cleans it up
      continue;
    }
    if (h.backend === "memory") {
      const e = state.mem.get(h.userId)?.get(h.id);
      if (e && e.kind === "H") e.exp = now + HOLD_TTL_MS;
    } else {
      const arr = byUser.get(h.userId) ?? [];
      arr.push(h.id);
      byUser.set(h.userId, arr);
    }
  }
  const r = scripted();
  if (!r) return;
  for (const [userId, ids] of byUser) {
    try {
      await r.ppHoldRenew(1, holdKey(userId), HOLD_TTL_MS, ...ids);
    } catch (err) {
      warnOnce("redis hold renew failed", err);
    }
  }
  if (!state.open.size && state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

/** Test hook. */
export function __resetHoldsForTests(): void {
  state.mem.clear();
  state.open.clear();
  state.settling.clear();
}
