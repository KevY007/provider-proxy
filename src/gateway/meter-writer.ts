import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Decimal, ZERO, toDecimal, toDbString } from "@/lib/money";
import { maybeSendLowBalanceAlert, triggerAutoRecharge } from "@/server/billing/auto-recharge";
import { settleFlushed } from "./balance";

/**
 * Batched metering writer (PLAN 9b). Request logs and their financial side effects are buffered in-process and
 * flushed every 500ms / 200 entries in ONE transaction:
 *   INSERT RequestLog (skipDuplicates, returning ids)      <- exactly-once: only inserted rows are applied below
 *   UPDATE "User"        SET balance = balance - sum(price)            (RETURNING new balance)
 *   UPDATE "ApiKey"      SET spent += sum(price), lastUsedAt
 *   UPDATE "ProviderKey" SET totalRequests += n, totalCost += sum(cost), lastUsedAt, consecutiveFailures = 0 ...
 * Failures retry with backoff; a poison entry is isolated and (as a last resort) dead-lettered to the log.
 * SIGTERM / process exit flush whatever is buffered (Cloud Run gives 10s).
 */
export interface MeterEntry {
  log: Prisma.RequestLogCreateManyInput;
  userId: string | null;
  apiKeyId: string | null;
  providerKeyId: string | null;
  price: Decimal;
  cost: Decimal;
  /** counts toward ProviderKey.totalRequests/totalCost */
  countForKey: boolean;
  /** resets ProviderKey.consecutiveFailures and clears COOLDOWN */
  keyHealthy: boolean;
  createdAt: Date;
}

const FLUSH_MS = 500;
const MAX_BATCH = 200;
const MAX_BUFFER = 100_000;
const RETRY_DELAYS = [200, 1_000, 3_000, 10_000];

interface Cell {
  buffer: MeterEntry[];
  flushing: Promise<void> | null;
  timer: NodeJS.Timeout | null;
  hooksInstalled: boolean;
  debounce: Map<string, number>;
  failedAttempts: WeakMap<MeterEntry, number>;
  inflight: number;
  nextRetryAt: number;
  flushImpl?: () => Promise<void>;
}
const g = globalThis as unknown as { __ppMeter?: Cell };
const cell: Cell = (g.__ppMeter ??= {
  buffer: [],
  flushing: null,
  timer: null,
  hooksInstalled: false,
  debounce: new Map(),
  failedAttempts: new WeakMap(),
  inflight: 0,
  nextRetryAt: 0,
});

export function pendingMeterCount(): number {
  return cell.buffer.length + cell.inflight;
}

/** Queue one finished request. Never throws, never awaits. */
export function enqueueMeter(entry: MeterEntry): void {
  if (cell.buffer.length >= MAX_BUFFER) {
    const dropped = cell.buffer.shift();
    if (dropped) deadLetter(dropped, "buffer overflow");
  }
  cell.buffer.push(entry);
  ensureTimer();
  installShutdownHooks();
  if (cell.buffer.length >= MAX_BATCH) void flushMeter();
}

function ensureTimer(): void {
  if (cell.timer) return;
  // the timer outlives dev hot-reloads, so it calls through the cell to always reach the newest module code
  cell.timer = setInterval(() => {
    if (cell.buffer.length && Date.now() >= cell.nextRetryAt) void cell.flushImpl?.();
  }, FLUSH_MS);
  cell.timer.unref?.();
}

/** Flush everything currently buffered (concurrent callers share one run). */
export function flushMeter(): Promise<void> {
  if (cell.flushing) return cell.flushing;
  cell.flushing = (async () => {
    while (cell.buffer.length && Date.now() >= cell.nextRetryAt) {
      const batch = cell.buffer.splice(0, MAX_BATCH);
      cell.inflight += batch.length;
      try {
        await writeWithRetry(batch);
      } finally {
        cell.inflight -= batch.length;
      }
    }
  })()
    .catch((err) => logger.error("meter flush crashed", { err }))
    .finally(() => {
      cell.flushing = null;
    });
  return cell.flushing;
}

cell.flushImpl = flushMeter;

/** Flush with an upper time bound (shutdown). */
export async function flushAll(maxMs = 8_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  cell.nextRetryAt = 0;
  while (pendingMeterCount() > 0 && Date.now() < deadline) {
    await Promise.race([flushMeter(), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
    if (cell.buffer.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }
}

async function writeWithRetry(batch: MeterEntry[]): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i <= RETRY_DELAYS.length; i++) {
    try {
      await writeBatch(batch);
      return;
    } catch (err) {
      lastErr = err;
      if (isDataError(err)) break;
      if (i < RETRY_DELAYS.length) await new Promise((r) => setTimeout(r, RETRY_DELAYS[i]));
    }
  }
  if (isDataError(lastErr) && batch.length > 1) {
    // isolate the poison entry: write each one on its own
    logger.warn("meter batch failed with a data error, isolating entries", { err: lastErr });
    for (const e of batch) await writeSingle(e);
    return;
  }
  if (isDataError(lastErr)) {
    await writeSingle(batch[0]);
    return;
  }
  // infrastructure failure (DB down): put the batch back and try again later - never lose metering
  logger.error("meter flush failed, will retry", { err: lastErr, entries: batch.length });
  cell.buffer.unshift(...batch);
  cell.nextRetryAt = Date.now() + 5_000;
}

async function writeSingle(e: MeterEntry): Promise<void> {
  try {
    await writeBatch([e]);
    return;
  } catch (err) {
    if (!isDataError(err)) {
      cell.buffer.unshift(e);
      cell.nextRetryAt = Date.now() + 5_000;
      return;
    }
    if (isForeignKeyError(err) && (e.userId || e.apiKeyId || e.providerKeyId)) {
      // the user / key / provider was deleted meanwhile: keep the log but drop the dangling references
      // (nothing can be debited from a user that no longer exists)
      try {
        const stripped: MeterEntry = {
          ...e,
          log: { ...e.log, userId: null, apiKeyId: null, providerId: null, providerKeyId: null },
          userId: null,
          apiKeyId: null,
          providerKeyId: null,
        };
        await writeBatch([stripped]);
        logger.warn("meter entry written without references (FK target deleted)", { requestId: e.log.id, err });
        if (e.userId) settleFlushed(e.userId, e.price, null);
        return;
      } catch {
        /* fall through to retry / dead letter */
      }
    }
    const n = (cell.failedAttempts.get(e) ?? 0) + 1;
    cell.failedAttempts.set(e, n);
    if (n >= 3) deadLetter(e, String(err));
    else {
      cell.buffer.push(e);
      cell.nextRetryAt = Date.now() + 2_000 * n;
    }
  }
}

function isForeignKeyError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ""}` : String(err);
  return /foreign key|P2003/i.test(msg) || (err as { code?: string }).code === "P2003";
}

/** Data-dependent failures (integrity / data exceptions) - as opposed to infrastructure or programming errors. */
function isDataError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ""}` : String(err);
  const code = (err as { code?: string }).code ?? "";
  if (code === "P2002" || code === "P2003" || code === "P2000" || code === "P2011" || code === "P2012") return true;
  const pg = /Code: `(\d{5})`/.exec(msg)?.[1] ?? /SQLSTATE[: ]+(\d{5})/i.exec(msg)?.[1];
  if (pg && (pg.startsWith("22") || pg.startsWith("23"))) return true;
  return /violates .* constraint|invalid input syntax|out of range|null value in column|numeric field overflow|invalid byte sequence|foreign key/i.test(msg);
}

function deadLetter(e: MeterEntry, reason: string): void {
  logger.error("METER_DEAD_LETTER", {
    reason,
    requestId: e.log.id,
    userId: e.userId,
    apiKeyId: e.apiKeyId,
    providerKeyId: e.providerKeyId,
    price: e.price.toString(),
    cost: e.cost.toString(),
    entry: JSON.stringify(e.log),
  });
  if (e.userId) settleFlushed(e.userId, e.price, null);
}

interface UserRow {
  id: string;
  balance: Prisma.Decimal | string;
  autoRechargeEnabled: boolean;
  autoRechargeThreshold: Prisma.Decimal | string;
  lowBalanceAlertAt: Prisma.Decimal | string | null;
}

async function writeBatch(batch: MeterEntry[]): Promise<void> {
  if (!batch.length) return;
  const result = await db.$transaction(
    async (tx) => {
      const created = await tx.requestLog.createManyAndReturn({ data: batch.map((b) => b.log), skipDuplicates: true, select: { id: true } });
      const ids = new Set(created.map((c) => c.id));
      const applied = batch.filter((b) => ids.has(b.log.id as string));

      const users = new Map<string, Decimal>();
      const keys = new Map<string, { price: Decimal; last: Date }>();
      const pkeys = new Map<string, { n: number; cost: Decimal; last: Date; healthy: boolean }>();
      for (const e of applied) {
        if (e.userId && !e.price.isZero()) users.set(e.userId, (users.get(e.userId) ?? ZERO).plus(e.price));
        if (e.apiKeyId) {
          const k = keys.get(e.apiKeyId) ?? { price: ZERO, last: e.createdAt };
          k.price = k.price.plus(e.price);
          if (e.createdAt > k.last) k.last = e.createdAt;
          keys.set(e.apiKeyId, k);
        }
        if (e.providerKeyId && e.countForKey) {
          const k = pkeys.get(e.providerKeyId) ?? { n: 0, cost: ZERO, last: e.createdAt, healthy: false };
          k.n += 1;
          k.cost = k.cost.plus(e.cost);
          if (e.createdAt > k.last) k.last = e.createdAt;
          if (e.keyHealthy) k.healthy = true;
          pkeys.set(e.providerKeyId, k);
        }
      }

      let userRows: UserRow[] = [];
      if (users.size) {
        const values = Prisma.join([...users].map(([id, amt]) => Prisma.sql`(${id}, ${toDbString(amt)}::numeric)`));
        userRows = await tx.$queryRaw<UserRow[]>`
          UPDATE "User" AS u SET "balance" = u."balance" - v.amt
          FROM (VALUES ${values}) AS v(id, amt)
          WHERE u."id" = v.id
          RETURNING u."id", u."balance", u."autoRechargeEnabled", u."autoRechargeThreshold", u."lowBalanceAlertAt"`;
      }
      if (keys.size) {
        const values = Prisma.join([...keys].map(([id, v]) => Prisma.sql`(${id}, ${toDbString(v.price)}::numeric, ${v.last.toISOString()}::timestamp)`));
        await tx.$executeRaw`
          UPDATE "ApiKey" AS k SET "spent" = k."spent" + v.amt,
            "lastUsedAt" = GREATEST(COALESCE(k."lastUsedAt", v.ts), v.ts)
          FROM (VALUES ${values}) AS v(id, amt, ts)
          WHERE k."id" = v.id`;
      }
      if (pkeys.size) {
        const values = Prisma.join([...pkeys].map(([id, v]) => Prisma.sql`(${id}, ${v.n}::int, ${toDbString(v.cost)}::numeric, ${v.last.toISOString()}::timestamp, ${v.healthy}::boolean)`));
        await tx.$executeRaw`
          UPDATE "ProviderKey" AS p SET
            "totalRequests" = p."totalRequests" + v.n,
            "totalCost" = p."totalCost" + v.cost,
            "lastUsedAt" = GREATEST(COALESCE(p."lastUsedAt", v.ts), v.ts),
            "consecutiveFailures" = CASE WHEN v.healthy THEN 0 ELSE p."consecutiveFailures" END,
            "status" = CASE WHEN v.healthy AND p."status" = 'COOLDOWN' THEN 'ACTIVE'::"ProviderKeyStatus" ELSE p."status" END,
            "cooldownUntil" = CASE WHEN v.healthy AND p."status" = 'COOLDOWN' THEN NULL ELSE p."cooldownUntil" END
          FROM (VALUES ${values}) AS v(id, n, cost, ts, healthy)
          WHERE p."id" = v.id`;
      }
      return { applied, userRows, users };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );

  // ---- post-commit: re-base balance cache + billing hooks (never throw)
  const dbBalances = new Map(result.userRows.map((r) => [r.id, r]));
  for (const [userId, amount] of result.users) {
    const row = dbBalances.get(userId);
    const bal = row ? toDecimal(row.balance) : null;
    settleFlushed(userId, amount, bal);
    if (!row || !bal) continue;
    if (row.autoRechargeEnabled && bal.lt(toDecimal(row.autoRechargeThreshold)) && allow(`ar:${userId}`, 15_000)) {
      safe(() => triggerAutoRecharge(userId));
    }
    const level = row.lowBalanceAlertAt ? toDecimal(row.lowBalanceAlertAt) : toDecimal(row.autoRechargeThreshold);
    if (bal.lt(level) && allow(`lb:${userId}`, 10 * 60_000)) safe(() => maybeSendLowBalanceAlert(userId));
  }
  // entries already present in the DB (duplicate retry) were skipped above; their local pending debit must not linger
  const appliedIds = new Set(result.applied.map((a) => a.log.id));
  for (const e of batch) {
    if (!appliedIds.has(e.log.id) && e.userId && !e.price.isZero()) settleFlushed(e.userId, e.price, null);
  }
}

function allow(key: string, ms: number): boolean {
  const now = Date.now();
  const last = cell.debounce.get(key) ?? 0;
  if (now - last < ms) return false;
  cell.debounce.set(key, now);
  if (cell.debounce.size > 20_000) cell.debounce.clear();
  return true;
}

function safe(fn: () => Promise<void>): void {
  try {
    fn().catch((err) => logger.warn("billing hook failed", { err }));
  } catch (err) {
    logger.warn("billing hook failed", { err });
  }
}

// ------------------------------------------------------------------ shutdown
function installShutdownHooks(): void {
  if (cell.hooksInstalled || process.env.NODE_ENV === "test" || process.env.VITEST) return;
  cell.hooksInstalled = true;
  const origExit = process.exit.bind(process);
  let exiting = false;
  const drainThenExit = (code?: number) => {
    if (exiting) return;
    exiting = true;
    flushAll(8_000)
      .catch(() => undefined)
      .finally(() => origExit(code));
  };
  process.on("SIGTERM", () => void flushAll(8_000).catch(() => undefined));
  process.on("SIGINT", () => void flushAll(8_000).catch(() => undefined));
  process.on("beforeExit", () => void flushAll(8_000).catch(() => undefined));
  // Next's standalone server calls process.exit() right after SIGTERM: hold the exit until the buffer is written.
  process.exit = ((code?: number) => {
    if (pendingMeterCount() === 0) return origExit(code);
    drainThenExit(code);
    return undefined as never;
  }) as typeof process.exit;
}

/** Test hook. */
export function __resetMeterForTests(): void {
  cell.buffer.length = 0;
  cell.nextRetryAt = 0;
  cell.debounce.clear();
}
