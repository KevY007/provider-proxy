import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Decimal, ZERO, toDecimal, toDbString } from "@/lib/money";
import { maybeSendLowBalanceAlert, triggerAutoRecharge } from "@/server/billing/auto-recharge";
import { rebaseBalance } from "./balance";
import { holdsFlushed, publishBalance } from "./holds";

/**
 * Batched, DURABLE metering writer (PLAN 9b). Request logs and their financial side effects are buffered in-process
 * and flushed every 500ms / 200 entries in ONE transaction:
 *   INSERT RequestLog (skipDuplicates, returning ids)      <- exactly-once: only inserted rows are applied below
 *   UPDATE "User"        SET balance = balance - sum(price)            (RETURNING new balance)
 *   UPDATE "ApiKey"      SET spent += sum(price), lastUsedAt
 *   UPDATE "ProviderKey" SET totalRequests += n, totalCost += sum(cost), lastUsedAt, consecutiveFailures = 0 ...
 *
 * Failure handling (nothing is ever silently lost):
 *   1. A failing batch is retried a few times with backoff. Programming / data errors (Prisma "Unknown argument",
 *      constraint violations, ...) skip the retries: the batch goes straight to PER-ROW isolation.
 *   2. Per-row isolation also starts after BATCH_FAIL_LIMIT failed attempts when the database is reachable (a poison row
 *      must not hold up the rest). When the database is NOT reachable the batch is kept in memory and retried; a long
 *      outage spills the buffer to disk.
 *   3. A row that still cannot be written is DEAD-LETTERED: appended to a JSONL file
 *      (`$METER_DEADLETTER_DIR` or the OS temp dir) AND logged with severity ERROR including the full row.
 *      Its balance debits are applied through a minimal fallback update when possible (`debited: true` in the file).
 *   4. On startup (and from the health cron) the dead-letter file is replayed: rows are inserted with
 *      skipDuplicates; rows already debited are inserted WITHOUT touching balances again.
 *   5. SIGTERM / process exit flush whatever is buffered (Cloud Run gives 10s); entries that did not make it are
 *      spilled to the dead-letter file, so a restart cannot lose them.
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
const RETRY_DELAYS = [200, 1_000, 3_000];
const OUTAGE_SPILL_MS = 30_000;
const DEADLETTER_FILE = "providerproxy-meter-deadletter.jsonl";
/** Rows that failed this many replays are moved to POISON_FILE and no longer retried. */
const MAX_REPLAY_ATTEMPTS = 10;
const POISON_FILE = "providerproxy-meter-poison.jsonl";

const batchFailLimit = (): number => Math.max(1, Number(process.env.METER_BATCH_FAIL_LIMIT) || 3);

interface Cell {
  buffer: MeterEntry[];
  flushing: Promise<void> | null;
  timer: NodeJS.Timeout | null;
  hooksInstalled: boolean;
  debounce: Map<string, number>;
  inflight: number;
  nextRetryAt: number;
  outageSince: number | null;
  spilled: boolean;
  replaying: Promise<ReplayResult> | null;
  startupScheduled: boolean;
  flushImpl?: () => Promise<void>;
}
const g = globalThis as unknown as { __ppMeter2?: Cell };
const cell: Cell = (g.__ppMeter2 ??= {
  buffer: [],
  flushing: null,
  timer: null,
  hooksInstalled: false,
  debounce: new Map(),
  inflight: 0,
  nextRetryAt: 0,
  outageSince: null,
  spilled: false,
  replaying: null,
  startupScheduled: false,
});

export function pendingMeterCount(): number {
  return cell.buffer.length + cell.inflight;
}

/** Queue one finished request. Never throws, never awaits. */
export function enqueueMeter(entry: MeterEntry): void {
  if (cell.buffer.length >= MAX_BUFFER) {
    const dropped = cell.buffer.shift();
    if (dropped) deadLetter(dropped, "buffer overflow", false);
  }
  cell.buffer.push(entry);
  ensureTimer();
  installShutdownHooks();
  scheduleStartupReplay();
  if (cell.buffer.length >= MAX_BATCH) void flushMeter();
}

function ensureTimer(): void {
  if (cell.timer) return;
  // the timer outlives dev hot-reloads, so it calls through the cell to always reach the newest module code
  cell.timer = setInterval(() => {
    if (cell.outageSince && Date.now() - cell.outageSince > OUTAGE_SPILL_MS && cell.buffer.length) spillBuffer("database outage");
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

/** Flush with an upper time bound (shutdown). Whatever is still buffered afterwards is spilled to the dead-letter file. */
export async function flushAll(maxMs = 8_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  cell.nextRetryAt = 0;
  while (pendingMeterCount() > 0 && Date.now() < deadline) {
    await Promise.race([flushMeter(), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
    if (cell.buffer.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }
  if (cell.buffer.length) spillBuffer("shutdown before the database accepted the entries");
}

// ------------------------------------------------------------------ error classification
function errText(err: unknown): string {
  return err instanceof Error ? `${err.name} ${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ""}` : String(err);
}

/** Short reason for the dead letter: Prisma validation errors put the useful line (what is unknown / missing) LAST. */
function reasonOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err).slice(0, 400);
  const lines = err.message.split("\n").map((l) => l.trim()).filter(Boolean);
  const useful = isProgrammingError(err) ? (lines.at(-1) ?? "") : (lines[0] ?? "");
  return `${err.name}: ${useful}`.slice(0, 400);
}

/** The code itself is wrong for this schema (stale client, bad field): retrying can never help. */
export function isProgrammingError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientValidationError) return true;
  return /Unknown argument|Unknown field|Unknown arg |Invalid `prisma\./i.test(errText(err)) && !/ECONN|timed out|terminat/i.test(errText(err));
}

function isForeignKeyError(err: unknown): boolean {
  const msg = errText(err);
  return /foreign key|P2003/i.test(msg) || (err as { code?: string }).code === "P2003";
}

/** Data-dependent failures (integrity / data exceptions) - as opposed to infrastructure errors. */
function isDataError(err: unknown): boolean {
  const msg = errText(err);
  const code = (err as { code?: string }).code ?? "";
  if (code === "P2002" || code === "P2003" || code === "P2000" || code === "P2011" || code === "P2012") return true;
  const pg = /Code: `(\d{5})`/.exec(msg)?.[1] ?? /SQLSTATE[: ]+(\d{5})/i.exec(msg)?.[1];
  if (pg && (pg.startsWith("22") || pg.startsWith("23"))) return true;
  return /violates .* constraint|invalid input syntax|out of range|null value in column|numeric field overflow|invalid byte sequence|foreign key/i.test(msg);
}

function isConnectivityError(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? "";
  if (["P1001", "P1002", "P1008", "P1017", "P2024", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(code)) return true;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|Can't reach database|Connection terminated|connection.*(closed|refused|lost)|server closed the connection|too many clients|timeout exceeded when trying to connect|Timed out fetching a new connection/i.test(errText(err));
}

async function dbReachable(): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ write path
async function writeWithRetry(batch: MeterEntry[]): Promise<void> {
  let lastErr: unknown;
  const limit = batchFailLimit();
  for (let attempt = 1; attempt <= limit; attempt++) {
    try {
      await writeBatch(batch);
      noteHealthy();
      return;
    } catch (err) {
      lastErr = err;
      if (isProgrammingError(err) || isDataError(err)) {
        logger.warn("meter batch failed with a non-retryable error, isolating entries", { err, entries: batch.length });
        await isolate(batch);
        return;
      }
      if (attempt < limit) await new Promise((r) => setTimeout(r, RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]));
    }
  }
  if (await dbReachable()) {
    logger.warn("meter batch kept failing while the database is reachable, isolating entries", { err: lastErr, entries: batch.length });
    await isolate(batch);
    return;
  }
  requeue(batch, lastErr);
}

/** Infrastructure failure (database down): keep the batch in memory and try again later - never lose metering. */
function requeue(batch: MeterEntry[], err: unknown): void {
  logger.error("meter flush failed, will retry", { err, entries: batch.length });
  cell.buffer.unshift(...batch);
  cell.nextRetryAt = Date.now() + 5_000;
  cell.outageSince ??= Date.now();
}

function noteHealthy(): void {
  cell.outageSince = null;
  cell.nextRetryAt = 0;
  if (cell.spilled) {
    cell.spilled = false;
    void replayDeadLetters().catch(() => undefined);
  }
}

async function isolate(batch: MeterEntry[]): Promise<void> {
  for (const e of batch) await writeRow(e);
}

async function writeRow(e: MeterEntry): Promise<void> {
  let err: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      await writeBatch([e]);
      noteHealthy();
      return;
    } catch (x) {
      err = x;
      if (isConnectivityError(x) && !(await dbReachable())) {
        requeue([e], x);
        return;
      }
      if (isProgrammingError(x)) break;
    }
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
      afterFlush([e], new Map());
      return;
    } catch {
      /* fall through to the dead letter */
    }
  }
  // the log row cannot be stored: still debit what the customer owes, then park the row for replay
  let debited = false;
  let balances = new Map<string, Decimal>();
  try {
    ({ debited, balances } = await applyFinancialsOnly(e));
  } catch (x) {
    logger.error("meter fallback debit failed", { requestId: e.log.id, err: x });
  }
  deadLetter(e, reasonOf(err), debited);
  afterFlush([e], balances);
}

interface UserRow {
  id: string;
  balance: Prisma.Decimal | string;
  autoRechargeEnabled: boolean;
  autoRechargeThreshold: Prisma.Decimal | string;
  lowBalanceAlertAt: Prisma.Decimal | string | null;
}

type Tx = Prisma.TransactionClient;

/** Balance / key / upstream-key side effects of `entries`. */
async function applyFinancials(tx: Tx, entries: MeterEntry[]): Promise<{ userRows: UserRow[]; users: Map<string, Decimal> }> {
  const users = new Map<string, Decimal>();
  const keys = new Map<string, { price: Decimal; last: Date }>();
  const pkeys = new Map<string, { n: number; cost: Decimal; last: Date; healthy: boolean }>();
  for (const e of entries) {
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
  return { userRows, users };
}

const TX_OPTS = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * Fallback for a row whose RequestLog cannot be stored: apply only its financial side effects. Returns false when
 * the row turned out to be in the database already (nothing to do) or has nothing to debit.
 */
async function applyFinancialsOnly(e: MeterEntry): Promise<{ debited: boolean; balances: Map<string, Decimal> }> {
  return db.$transaction(async (tx) => {
    const exists = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "RequestLog" WHERE "id" = ${e.log.id as string}`;
    if (exists.length) return { debited: true, balances: new Map<string, Decimal>() }; // the insert actually committed earlier: already debited
    const fin = await applyFinancials(tx, [e]);
    return { debited: true, balances: new Map(fin.userRows.map((r) => [r.id, toDecimal(r.balance)])) };
  }, TX_OPTS);
}

async function writeBatch(batch: MeterEntry[], opts: { financials?: boolean } = {}): Promise<void> {
  if (!batch.length) return;
  const financials = opts.financials !== false;
  const result = await db.$transaction(async (tx) => {
    const created = await tx.requestLog.createManyAndReturn({ data: batch.map((b) => b.log), skipDuplicates: true, select: { id: true } });
    const ids = new Set(created.map((c) => c.id));
    const applied = batch.filter((b) => ids.has(b.log.id as string));
    const fin = financials ? await applyFinancials(tx, applied) : { userRows: [] as UserRow[], users: new Map<string, Decimal>() };
    return { applied, ...fin };
  }, TX_OPTS);

  // ---- post-commit: pending debits -> authoritative balance + billing hooks (never throw)
  const dbBalances = new Map(result.userRows.map((r) => [r.id, r]));
  afterFlush(batch, new Map([...dbBalances].map(([id, r]) => [id, toDecimal(r.balance)])));
  for (const [userId] of result.users) {
    const row = dbBalances.get(userId);
    const bal = row ? toDecimal(row.balance) : null;
    if (!row || !bal) continue;
    if (row.autoRechargeEnabled && bal.lt(toDecimal(row.autoRechargeThreshold)) && allow(`ar:${userId}`, 15_000)) {
      safe(() => triggerAutoRecharge(userId));
    }
    const level = row.lowBalanceAlertAt ? toDecimal(row.lowBalanceAlertAt) : toDecimal(row.autoRechargeThreshold);
    if (bal.lt(level) && allow(`lb:${userId}`, 10 * 60_000)) safe(() => maybeSendLowBalanceAlert(userId));
  }
}

/** The entries left the buffer for good (committed, replayed or parked): the funds module can forget their pending debits. */
function afterFlush(entries: MeterEntry[], balances: Map<string, Decimal>): void {
  const byUser = new Map<string, string[]>();
  for (const e of entries) {
    if (!e.userId) continue;
    const arr = byUser.get(e.userId) ?? [];
    arr.push(e.log.id as string);
    byUser.set(e.userId, arr);
  }
  for (const [userId, ids] of byUser) {
    try {
      const bal = balances.get(userId);
      if (bal) {
        rebaseBalance(userId, bal);
        void publishBalance(userId, bal, ids).catch(() => undefined);
      } else void holdsFlushed(userId, ids).catch(() => undefined);
    } catch (err) {
      logger.warn("meter post-flush bookkeeping failed", { err });
    }
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

// ------------------------------------------------------------------ dead letter (append-only JSONL)
export function deadLetterPath(): string {
  return path.join(process.env.METER_DEADLETTER_DIR || tmpdir(), DEADLETTER_FILE);
}

interface DeadLetterRecord {
  v: 1;
  at: string;
  reason: string;
  /** the balance / key / upstream-key side effects were already applied (replay must only insert the log row) */
  debited: boolean;
  replayAttempts: number;
  entry: {
    log: Record<string, unknown>;
    userId: string | null;
    apiKeyId: string | null;
    providerKeyId: string | null;
    price: string;
    cost: string;
    countForKey: boolean;
    keyHealthy: boolean;
    createdAt: string;
  };
}

function toRecord(e: MeterEntry, reason: string, debited: boolean, replayAttempts = 0): DeadLetterRecord {
  return {
    v: 1,
    at: new Date().toISOString(),
    reason,
    debited,
    replayAttempts,
    entry: {
      log: JSON.parse(JSON.stringify(e.log)) as Record<string, unknown>,
      userId: e.userId,
      apiKeyId: e.apiKeyId,
      providerKeyId: e.providerKeyId,
      price: toDbString(e.price),
      cost: toDbString(e.cost),
      countForKey: e.countForKey,
      keyHealthy: e.keyHealthy,
      createdAt: e.createdAt.toISOString(),
    },
  };
}

function fromRecord(r: DeadLetterRecord): MeterEntry {
  const log = { ...r.entry.log } as Record<string, unknown>;
  if (typeof log.createdAt === "string") log.createdAt = new Date(log.createdAt);
  return {
    log: log as unknown as Prisma.RequestLogCreateManyInput,
    userId: r.entry.userId,
    apiKeyId: r.entry.apiKeyId,
    providerKeyId: r.entry.providerKeyId,
    price: new Decimal(r.entry.price),
    cost: new Decimal(r.entry.cost),
    countForKey: r.entry.countForKey,
    keyHealthy: r.entry.keyHealthy,
    createdAt: new Date(r.entry.createdAt),
  };
}

function appendRecords(records: DeadLetterRecord[], fileName = DEADLETTER_FILE): boolean {
  if (!records.length) return true;
  try {
    const file = path.join(path.dirname(deadLetterPath()), fileName);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    return true;
  } catch (err) {
    logger.error("METER_DEAD_LETTER_FILE_WRITE_FAILED", { err, rows: records.length });
    return false;
  }
}

/** Park a row that could not be written. Also logged (ERROR, full row) so log-based tooling can recover it. */
function deadLetter(e: MeterEntry, reason: string, debited: boolean): void {
  logger.error("METER_DEAD_LETTER", {
    reason,
    debited,
    requestId: e.log.id,
    userId: e.userId,
    apiKeyId: e.apiKeyId,
    providerKeyId: e.providerKeyId,
    price: e.price.toString(),
    cost: e.cost.toString(),
    entry: JSON.stringify(e.log),
  });
  appendRecords([toRecord(e, reason, debited)]);
}

/** Move the whole in-memory buffer to the dead-letter file (long outage / shutdown); it is replayed when the DB is back. */
function spillBuffer(reason: string): void {
  if (!cell.buffer.length) return;
  const entries = cell.buffer.splice(0, cell.buffer.length);
  const ok = appendRecords(entries.map((e) => toRecord(e, reason, false)));
  if (!ok) {
    cell.buffer.unshift(...entries); // could not persist: keep them in memory
    return;
  }
  cell.spilled = true;
  logger.error("METER_BUFFER_SPILLED", { reason, rows: entries.length, file: deadLetterPath() });
}

export interface ReplayResult {
  found: number;
  replayed: number;
  failed: number;
}

/**
 * Replay the dead-letter file. Safe to call concurrently / repeatedly: the file is claimed by renaming it, rows that
 * still fail are appended back, rows already in the database are skipped (skipDuplicates).
 */
export function replayDeadLetters(): Promise<ReplayResult> {
  if (cell.replaying) return cell.replaying;
  cell.replaying = replayOnce().finally(() => {
    cell.replaying = null;
  });
  return cell.replaying;
}

async function replayOnce(): Promise<ReplayResult> {
  const result: ReplayResult = { found: 0, replayed: 0, failed: 0 };
  const file = deadLetterPath();
  if (!existsSync(file)) return result;
  const claimed = `${file}.replay-${process.pid}-${Date.now()}`;
  try {
    renameSync(file, claimed);
  } catch {
    return result; // another instance claimed it
  }
  let lines: string[];
  try {
    lines = readFileSync(claimed, "utf8").split("\n").filter((l) => l.trim());
  } catch (err) {
    logger.error("meter dead letter unreadable", { err });
    return result;
  }
  const keep: DeadLetterRecord[] = [];
  const poisoned: DeadLetterRecord[] = [];
  let outage = false;
  for (const line of lines) {
    let rec: DeadLetterRecord;
    try {
      rec = JSON.parse(line) as DeadLetterRecord;
      if (!rec?.entry?.log) throw new Error("not a dead-letter record");
    } catch {
      logger.error("METER_DEAD_LETTER_UNPARSEABLE", { line: line.slice(0, 2000) });
      continue;
    }
    result.found++;
    if (outage) {
      keep.push(rec);
      continue;
    }
    const entry = fromRecord(rec);
    try {
      await writeBatch([entry], { financials: !rec.debited });
      result.replayed++;
    } catch (err) {
      if (isConnectivityError(err)) {
        outage = true;
        keep.push(rec);
        continue;
      }
      result.failed++;
      const attempts = (rec.replayAttempts ?? 0) + 1;
      logger.error("METER_DEAD_LETTER_REPLAY_FAILED", { requestId: entry.log.id, attempts, err: errText(err).slice(0, 500) });
      if (attempts >= MAX_REPLAY_ATTEMPTS) poisoned.push({ ...rec, replayAttempts: attempts });
      else keep.push({ ...rec, replayAttempts: attempts });
    }
  }
  if (keep.length) appendRecords(keep);
  if (poisoned.length) {
    // Permanently unwritable rows stop being retried; they stay in a separate file + the ERROR log for manual recovery.
    appendRecords(poisoned, POISON_FILE);
    for (const p of poisoned) logger.error("METER_DEAD_LETTER_POISONED", { requestId: p.entry.log.id, attempts: p.replayAttempts, entry: JSON.stringify(p.entry) });
  }
  try {
    unlinkSync(claimed);
  } catch {
    /* ignore */
  }
  if (result.found) logger.info("meter dead letter replayed", { ...result, kept: keep.length });
  return result;
}

function scheduleStartupReplay(): void {
  // `next build` imports this module while collecting page data; billing data must never be touched at build time.
  if (cell.startupScheduled || process.env.VITEST || process.env.NODE_ENV === "test" || process.env.NEXT_PHASE === "phase-production-build") return;
  cell.startupScheduled = true;
  const t = setTimeout(() => void replayDeadLetters().catch((err) => logger.warn("dead letter replay failed", { err })), 3_000);
  t.unref?.();
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
  cell.outageSince = null;
  cell.spilled = false;
  cell.debounce.clear();
}
