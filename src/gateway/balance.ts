import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Decimal, toDecimal } from "@/lib/money";
import { onGatewayInvalidate } from "./cache";

/**
 * Cached customer balance for the pre-flight check (PLAN 9b): refreshed from the DB at most every 5s
 * (stale-while-revalidate) and debited locally on settle, so the request path does not query the DB.
 *
 *   effective = last DB balance - (debits settled locally but not yet flushed by the meter writer)
 *
 * The DB stays authoritative: the meter-writer's flush returns each user's real new balance
 * (`settleFlushed`) which re-bases the cache and corrects drift between instances.
 */
const REFRESH_MS = 5_000;
const IDLE_EVICT_MS = 10 * 60_000;

interface Entry {
  balance: Decimal; // effective (db - pending)
  at: number; // when `balance` was last re-based on the DB
  touched: number;
  refreshing: Promise<void> | null;
}

interface Store {
  entries: Map<string, Entry>;
  pending: Map<string, Decimal>;
  sweeper?: NodeJS.Timeout;
}
const g = globalThis as unknown as { __ppBal?: Store };
const store: Store = (g.__ppBal ??= { entries: new Map(), pending: new Map() });

function pendingOf(userId: string): Decimal {
  return store.pending.get(userId) ?? new Decimal(0);
}

async function fetchDb(userId: string): Promise<Decimal | null> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { balance: true } });
  return row ? toDecimal(row.balance) : null;
}

function startSweeper(): void {
  if (store.sweeper) return;
  store.sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, e] of store.entries) if (now - e.touched > IDLE_EVICT_MS && !store.pending.has(id)) store.entries.delete(id);
  }, 60_000);
  store.sweeper.unref?.();
}

/**
 * Effective balance of a user. `seed` is the balance read from the DB at `seedAt` (the auth record load);
 * it is used only when there is no cache entry and it is fresh.
 */
export async function getBalance(userId: string, seed?: { balance: Decimal; at: number }): Promise<Decimal> {
  startSweeper();
  const now = Date.now();
  let e = store.entries.get(userId);
  if (!e) {
    if (seed && now - seed.at < REFRESH_MS) {
      e = { balance: seed.balance.minus(pendingOf(userId)), at: seed.at, touched: now, refreshing: null };
    } else {
      const v = (await fetchDb(userId)) ?? new Decimal(0);
      e = { balance: v.minus(pendingOf(userId)), at: Date.now(), touched: now, refreshing: null };
    }
    store.entries.set(userId, e);
    return e.balance;
  }
  e.touched = now;
  if (now - e.at > REFRESH_MS && !e.refreshing) {
    const entry = e;
    entry.refreshing = fetchDb(userId)
      .then((v) => {
        if (v) {
          entry.balance = v.minus(pendingOf(userId));
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
  const v = (await fetchDb(userId)) ?? new Decimal(0);
  const eff = v.minus(pendingOf(userId));
  const e = store.entries.get(userId);
  if (e) {
    e.balance = eff;
    e.at = Date.now();
  } else store.entries.set(userId, { balance: eff, at: Date.now(), touched: Date.now(), refreshing: null });
  return eff;
}

/** Apply a settled charge locally (immediately visible to the next request on this instance). */
export function debitLocal(userId: string, price: Decimal): void {
  if (price.isZero()) return;
  store.pending.set(userId, pendingOf(userId).plus(price));
  const e = store.entries.get(userId);
  if (e) e.balance = e.balance.minus(price);
}

/**
 * The meter writer committed `amount` of this user's charges. `dbBalance` is the authoritative balance after the
 * commit (null if the entries were dropped without being applied).
 */
export function settleFlushed(userId: string, amount: Decimal, dbBalance: Decimal | null): void {
  const left = pendingOf(userId).minus(amount);
  if (left.lte(0)) store.pending.delete(userId);
  else store.pending.set(userId, left);
  if (dbBalance) {
    const e = store.entries.get(userId);
    const eff = dbBalance.minus(pendingOf(userId));
    if (e) {
      e.balance = eff;
      e.at = Date.now();
    }
  }
}

export function dropBalance(userId?: string): void {
  if (userId) store.entries.delete(userId);
  else store.entries.clear();
}

export function pendingDebit(userId: string): Decimal {
  return pendingOf(userId);
}

onGatewayInvalidate((scope, id) => {
  if (scope === "users" || scope === "all") dropBalance(id);
});

export function __resetBalanceForTests(): void {
  store.entries.clear();
  store.pending.clear();
}
