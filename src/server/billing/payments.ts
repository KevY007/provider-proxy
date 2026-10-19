import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { emailTemplates, sendTemplate } from "@/lib/email";
import { Decimal, toDbString, toDecimal, type MoneyLike } from "@/lib/money";
import type { LedgerType, Payment, PaymentStatus } from "@/generated/prisma/client";
import { afterLedgerCommit, appendEntryTx } from "./ledger";

/** Payment.kind values. */
export type PaymentKind = "topup" | "auto_recharge" | "postpaid_settlement";

const KIND_TO_LEDGER: Record<string, LedgerType> = {
  topup: "TOPUP",
  auto_recharge: "AUTO_RECHARGE",
  postpaid_settlement: "POSTPAID_SETTLEMENT",
};

const KIND_LABEL: Record<string, string> = {
  topup: "Top-up",
  auto_recharge: "Auto-recharge",
  postpaid_settlement: "Postpaid settlement",
};

export interface SettleInput {
  paymentId: string;
  paymentIntentId?: string | null;
  /** Amount Stripe actually collected, when known (USD). Defaults to the Payment row's amount. */
  amountReceived?: MoneyLike;
  receiptUrl?: string | null;
}

export interface SettleResult {
  userId: string;
  amount: Decimal;
  /** true only the first time this payment moved the balance. */
  credited: boolean;
  duplicate: boolean;
  balance: Decimal;
}

/**
 * Mark a Payment SUCCEEDED and credit the customer exactly once. Safe to call any number of times and from
 * any number of racing callers (webhook replays, synchronous confirm, cron reconciliation): the user row is
 * locked and `LedgerEntry.paymentId` is unique, so the balance moves at most once per Payment.
 */
export async function settleSucceededPayment(input: SettleInput): Promise<SettleResult> {
  const res = await db.$transaction(
    async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: input.paymentId } });
      if (!payment) throw new Error(`Payment ${input.paymentId} not found`);

      const received = input.amountReceived != null ? toDecimal(input.amountReceived) : toDecimal(payment.amount);
      if (!received.eq(toDecimal(payment.amount))) {
        logger.warn("payment amount differs from amount received", {
          paymentId: payment.id,
          recorded: toDecimal(payment.amount).toString(),
          received: received.toString(),
        });
      }
      const label = KIND_LABEL[payment.kind] ?? "Payment";
      const ledger = await appendEntryTx(tx, payment.userId, received, KIND_TO_LEDGER[payment.kind] ?? "TOPUP", `${label} (card)`, {
        paymentId: payment.id,
        metadata: { kind: payment.kind, stripePaymentIntentId: input.paymentIntentId ?? payment.stripePaymentIntentId },
      });

      const keepStatus = payment.status === "REFUNDED" || payment.status === "DISPUTED";
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          ...(keepStatus ? {} : { status: "SUCCEEDED" as PaymentStatus, failureReason: null }),
          amount: toDbString(received),
          ...(input.paymentIntentId && !payment.stripePaymentIntentId ? { stripePaymentIntentId: input.paymentIntentId } : {}),
          ...(input.receiptUrl ? { receiptUrl: input.receiptUrl } : {}),
        },
      });
      return { payment, ledger, received };
    },
    { timeout: 15_000 },
  );

  if (!res.ledger.duplicate) {
    await afterLedgerCommit(res.payment.userId);
    logger.info("payment credited", {
      paymentId: res.payment.id,
      userId: res.payment.userId,
      kind: res.payment.kind,
      amount: res.received.toString(),
    });
  } else {
    logger.info("payment already credited (replay ignored)", { paymentId: res.payment.id });
  }
  return {
    userId: res.payment.userId,
    amount: res.received,
    credited: !res.ledger.duplicate,
    duplicate: res.ledger.duplicate,
    balance: res.ledger.balance,
  };
}

/**
 * PENDING -> FAILED/CANCELED. Returns true only for the caller that performed the transition (use it to
 * send exactly one notification). Never downgrades a SUCCEEDED payment.
 */
export async function markPaymentFailed(
  paymentId: string,
  reason: string | null,
  status: "FAILED" | "CANCELED" = "FAILED",
): Promise<boolean> {
  const res = await db.payment.updateMany({
    where: { id: paymentId, status: "PENDING" },
    data: { status, failureReason: reason ? reason.slice(0, 500) : null },
  });
  return res.count > 0;
}

/** Look up the Payment for a Stripe PaymentIntent (by id, falling back to metadata.paymentId). */
export async function findPaymentForIntent(pi: {
  id: string;
  metadata?: Record<string, string> | null;
}): Promise<Payment | null> {
  const byIntent = await db.payment.findUnique({ where: { stripePaymentIntentId: pi.id } });
  if (byIntent) return byIntent;
  const pid = pi.metadata?.paymentId;
  if (pid) return db.payment.findUnique({ where: { id: pid } });
  return null;
}

/** Email the customer about a failed payment. Never throws. */
export async function notifyPaymentFailed(userId: string, amount: MoneyLike, reason?: string | null): Promise<void> {
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!user) return;
    await sendTemplate(user.email, emailTemplates.paymentFailed({ name: user.name, amount, reason }));
  } catch (err) {
    logger.warn("payment failed email not sent", { userId, err });
  }
}

export { KIND_TO_LEDGER };
