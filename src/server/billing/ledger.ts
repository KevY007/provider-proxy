import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { Decimal, toDbString, toDecimal, type MoneyLike } from "@/lib/money";
import { Prisma, type LedgerEntry, type LedgerType } from "@/generated/prisma/client";
import { invalidateGatewayConfig } from "@/gateway/cache";

/**
 * THE ONLY way to move a customer's balance outside per-request usage metering.
 * Every movement = row lock on the user (SELECT ... FOR UPDATE) + atomic increment + LedgerEntry with
 * balanceAfter, all in one transaction. After commit the gateway's cached balance is invalidated.
 *
 * Idempotency: pass `paymentId` -> LedgerEntry.paymentId is unique, so the same payment can only ever
 * move the balance once (replays return `{ duplicate: true }` without touching the balance).
 */
export type Tx = Prisma.TransactionClient;

export interface LedgerOptions {
  paymentId?: string | null;
  createdById?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LedgerResult {
  entry: LedgerEntry;
  /** Balance after this movement (or at the time of the original movement for duplicates). */
  balance: Decimal;
  /** True when `paymentId` was already applied - nothing changed. */
  duplicate: boolean;
}

export class LedgerError extends Error {
  constructor(
    public code: "invalid_amount" | "user_not_found",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "LedgerError";
  }
}

/** Lock the user row for the rest of the transaction and return the current balance. */
export async function lockUser(tx: Tx, userId: string): Promise<Decimal> {
  const rows = await tx.$queryRaw<Array<{ balance: Prisma.Decimal }>>(
    Prisma.sql`SELECT "balance" FROM "User" WHERE "id" = ${userId} FOR UPDATE`,
  );
  if (!rows[0]) throw new LedgerError("user_not_found", "User not found");
  return toDecimal(rows[0].balance);
}

/**
 * Apply a signed movement inside an existing transaction (locks the user first). Use `credit`/`debit`
 * unless you must do other writes atomically with the ledger entry (e.g. settling a Payment).
 * Call `afterLedgerCommit(userId)` once the surrounding transaction has committed.
 */
export async function appendEntryTx(
  tx: Tx,
  userId: string,
  signedAmount: MoneyLike,
  type: LedgerType,
  description: string,
  opts: LedgerOptions = {},
): Promise<LedgerResult> {
  const amount = toDecimal(signedAmount);
  if (!amount.isFinite() || amount.isZero()) throw new LedgerError("invalid_amount", "Amount must be a non-zero number");

  await lockUser(tx, userId);

  if (opts.paymentId) {
    const existing = await tx.ledgerEntry.findUnique({ where: { paymentId: opts.paymentId } });
    if (existing) return { entry: existing, balance: toDecimal(existing.balanceAfter), duplicate: true };
  }

  const updated = await tx.user.update({
    where: { id: userId },
    data: { balance: { increment: toDbString(amount) } },
    select: { balance: true },
  });
  const entry = await tx.ledgerEntry.create({
    data: {
      userId,
      type,
      amount: toDbString(amount),
      balanceAfter: updated.balance,
      description: description.slice(0, 500),
      paymentId: opts.paymentId ?? null,
      createdById: opts.createdById ?? null,
      metadata: (opts.metadata ?? {}) as never,
    },
  });
  return { entry, balance: toDecimal(updated.balance), duplicate: false };
}

/** Tell the gateway its cached balance for this user is stale. Never throws. */
export async function afterLedgerCommit(userId: string): Promise<void> {
  try {
    await invalidateGatewayConfig("users", userId);
  } catch (err) {
    logger.warn("gateway invalidate failed after ledger write", { userId, err });
  }
}

async function run(
  userId: string,
  signed: Decimal,
  type: LedgerType,
  description: string,
  opts: LedgerOptions,
): Promise<LedgerResult> {
  const res = await db.$transaction((tx) => appendEntryTx(tx, userId, signed, type, description, opts), {
    timeout: 15_000,
  });
  if (!res.duplicate) await afterLedgerCommit(userId);
  return res;
}

/** Add `amount` (> 0) USD to the balance. */
export async function credit(
  userId: string,
  amount: MoneyLike,
  type: LedgerType,
  description: string,
  opts: LedgerOptions = {},
): Promise<LedgerResult> {
  const a = toDecimal(amount);
  if (!a.isFinite() || a.lte(0)) throw new LedgerError("invalid_amount", "Credit amount must be positive");
  return run(userId, a, type, description, opts);
}

/** Remove `amount` (> 0) USD from the balance. May push the balance negative (refunds, chargebacks, corrections). */
export async function debit(
  userId: string,
  amount: MoneyLike,
  type: LedgerType,
  description: string,
  opts: LedgerOptions = {},
): Promise<LedgerResult> {
  const a = toDecimal(amount);
  if (!a.isFinite() || a.lte(0)) throw new LedgerError("invalid_amount", "Debit amount must be positive");
  return run(userId, a.neg(), type, description, opts);
}

/**
 * Manual balance adjustment by an admin (positive = credit, negative = debit). Requires a reason, writes an
 * ADJUSTMENT ledger entry and an audit log row. Callers must have verified the admin's role (use
 * `requireAdminForAction({ adminOnly: true })`).
 */
export async function adminAdjustBalance(
  adminId: string,
  userId: string,
  amount: MoneyLike,
  reason: string,
): Promise<LedgerResult> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) throw new LedgerError("invalid_amount", "A reason is required");
  const a = toDecimal(amount);
  if (!a.isFinite() || a.isZero()) throw new LedgerError("invalid_amount", "Amount must be a non-zero number");
  const res = await run(userId, a, "ADJUSTMENT", trimmed, {
    createdById: adminId,
    metadata: { reason: trimmed, adminId },
  });
  await audit(adminId, "billing.adjust_balance", { type: "User", id: userId }, {
    amount: toDbString(a),
    reason: trimmed,
    balanceAfter: res.balance.toFixed(12),
    ledgerEntryId: res.entry.id,
  });
  return res;
}
