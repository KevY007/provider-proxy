import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Decimal, toDecimal } from "@/lib/money";
import { onGatewayInvalidate } from "./cache";
import { forgetSharedBalance } from "./holds";

/**
 * Cached DB balance of a customer (PLAN 9b): refreshed from the DB at most every 5s (stale-while-revalidate) and
 * re-based on the authoritative balance every time the meter writer commits a debit (`rebaseBalance`), so the request
 * path does not query the DB.
 *
 * This is ONLY the database side of the equation. What is owed but not yet in the database (open credit holds and
 * settled debits waiting for the meter writer) lives in `holds.ts`; the funds check is
 *
 *     available = getBalance() + creditLimit - minBalanceToCall - holds.obligations
 *
 * (see `reserve.ts`). That is why this value must NOT be reduced by local debits any more.
 */
const REFRESH_MS = 5_000;
const IDLE_EVICT_MS = 10 * 60_000;

interface Entry {
  balance: Decimal; // last known DB balance
  at: number; // when `balance` was read from / re-based on the DB
  touched: number;
  refreshing: Promise<void> | null;
  rebasedAt: number;
}

interface Store {
  entries: Map<string, Entry>;
  sweeper?: NodeJS.Timeout;
}
const g = globalThis as unknown as { __ppBal2?: Store };
const store: Store = (g.__ppBal2 ??= { entries: new Map() });

async function fetchDb(userId: string): Promise<Decimal | null> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { balance: true } });
  return row ? toDecimal(row.balance) : null;
}

function startSweeper(): void {
  if (store.sweeper) return;
  store.sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, e] of store.entries) if (now - e.touched > IDLE_EVICT_MS) store.entries.delete(id);
  }, 60_000);
  store.sweeper.unref?.();
}

/**
 * Last known DB balance of a user. `seed` is the balance read from the DB at `seedAt` (the auth record load); it is
 * used only when there is no cache entry and it is fresh.
 */
export async function getBalance(userId: string, seed?: { balance: Decimal; at: number }): Promise<Decimal> {
  startSweeper();
  const now = Date.now();
  let e = store.entries.get(userId);
  if (!e) {
    if (seed && now - seed.at < REFRESH_MS) {
      e = { balance: seed.balance, at: seed.at, touched: now, refreshing: null, rebasedAt: 0 };
    } else {
      const v = (await fetchDb(userId)) ?? new Decimal(0);
      e = { balance: v, at: Date.now(), touched: now, refreshing: null, rebasedAt: 0 };
    }
    store.entries.set(userId, e);
    return e.balance;
  }
  e.touched = now;
  if (now - e.at > REFRESH_MS && !e.refreshing) {
    const entry = e;
    const startedAt = Date.now();
    entry.refreshing = fetchDb(userId)
      .then((v) => {
        // a flush re-based the entry while we were reading: our (older) read must not overwrite it
        if (v && entry.rebasedAt < startedAt) {
          entry.balance = v;
          entry.at = Date.now();
        }
      })
      .catch((err) => logger.warn("balance refresh failed", { err }))
      .finally(() => {
        entry.refreshing = null;
      });
  }
  return e.balance;
}

/** Re-read the balance from the DB right now (used before rejecting with 402 so top-ups are never missed). */
export async function refreshBalanceNow(userId: string): Promise<Decimal> {
  // a user hammering the API with an empty balance must not turn into one DB read per request
  const cur = store.entries.get(userId);
  if (cur && Date.now() - cur.at < 1_000) return cur.balance;
  const startedAt = Date.now();
  const v = (await fetchDb(userId)) ?? new Decimal(0);
  const e = store.entries.get(userId);
  if (e) {
    if (e.rebasedAt < startedAt) {
      e.balance = v;
      e.at = Date.now();
    }
    return e.balance;
  }
  store.entries.set(userId, { balance: v, at: Date.now(), touched: Date.now(), refreshing: null, rebasedAt: 0 });
  return v;
}

/** The meter writer committed debits: `dbBalance` is the authoritative balance after the commit. */
export function rebaseBalance(userId: string, dbBalance: Decimal): void {
  const now = Date.now();
  const e = store.entries.get(userId);
  if (e) {
    e.balance = dbBalance;
    e.at = now;
    e.rebasedAt = now;
  }
}

export function dropBalance(userId?: string): void {
  if (userId) store.entries.delete(userId);
  else store.entries.clear();
}

onGatewayInvalidate((scope, id) => {
  if (scope === "users" || scope === "all") {
    dropBalance(id);
    if (id) forgetSharedBalance(id);
  }
});

export function __resetBalanceForTests(): void {
  store.entries.clear();
}
