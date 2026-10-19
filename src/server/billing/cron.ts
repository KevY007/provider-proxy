import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Decimal, toDbString, toDecimal } from "@/lib/money";
import { Prisma } from "@/generated/prisma/client";
import { runAutoRecharge } from "./auto-recharge";
import { withLock } from "./locks";
import { markPaymentFailed, notifyPaymentFailed } from "./payments";
import { getStripe, isStripeConfigured, stripeErrorMessage, toCents } from "./stripe";
import { settleCheckoutSession, settleFromIntent } from "./topup";

/** Smallest postpaid balance we bother to charge (avoids Stripe's $0.50 floor + fee churn). */
export const MIN_SETTLEMENT_USD = 1;
const STALE_PENDING_MS = 24 * 3600_000;

export interface BillingCronSummary {
  stripeConfigured: boolean;
  autoRecharge: { candidates: number; succeeded: number; failed: number; skipped: number };
  postpaid: { candidates: number; charged: number; failed: number; skipped: number };
  stale: { checked: number; settled: number; failed: number; canceled: number };
}

/** Hourly billing sweep: auto-recharge candidates, postpaid settlement, stale PENDING payments. */
export async function runBillingCron(): Promise<BillingCronSummary> {
  const summary: BillingCronSummary = {
    stripeConfigured: isStripeConfigured(),
    autoRecharge: { candidates: 0, succeeded: 0, failed: 0, skipped: 0 },
    postpaid: { candidates: 0, charged: 0, failed: 0, skipped: 0 },
    stale: { checked: 0, settled: 0, failed: 0, canceled: 0 },
  };
  if (!summary.stripeConfigured) return summary;

  await step("auto-recharge sweep", () => sweepAutoRecharge(summary));
  await step("postpaid settlement", () => settlePostpaid(summary));
  await step("stale payments", async () => {
    await reconcileStalePayments(summary);
  });
  return summary;
}

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    logger.error(`billing cron step failed: ${name}`, { err });
  }
}

async function sweepAutoRecharge(summary: BillingCronSummary) {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "User"
    WHERE "autoRechargeEnabled" = true AND "status" = 'ACTIVE'
      AND "defaultPaymentMethodId" IS NOT NULL
      AND "balance" < "autoRechargeThreshold"
    ORDER BY "balance" ASC
    LIMIT 500`);
  summary.autoRecharge.candidates = rows.length;
  for (const { id } of rows) {
    try {
      const out = await runAutoRecharge(id);
      if (out.status === "succeeded") summary.autoRecharge.succeeded++;
      else if (out.status === "failed") summary.autoRecharge.failed++;
      else summary.autoRecharge.skipped++;
    } catch (err) {
      summary.autoRecharge.failed++;
      logger.error("cron auto-recharge failed", { userId: id, err });
    }
  }
}

export type SettlementOutcome = "charged" | "failed" | "skipped";

/** Charge one postpaid customer's outstanding negative balance to their saved card. */
export async function settlePostpaidUser(userId: string): Promise<SettlementOutcome> {
  const lock = await withLock(`settle:${userId}`, 2 * 60_000, async (): Promise<SettlementOutcome> => {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        balance: true,
        billingMode: true,
        stripeCustomerId: true,
        defaultPaymentMethodId: true,
      },
    });
    if (!user || user.billingMode !== "POSTPAID" || user.status === "SUSPENDED") return "skipped";
    if (!user.stripeCustomerId || !user.defaultPaymentMethodId) return "skipped";
    const owed = toDecimal(user.balance).neg();
    if (owed.lt(MIN_SETTLEMENT_USD)) return "skipped";

    const recent = await db.payment.findFirst({
      where: { userId, kind: "postpaid_settlement", createdAt: { gt: new Date(Date.now() - 20 * 3600_000) } },
      select: { id: true },
    });
    if (recent) return "skipped";

    const amount = owed.toDecimalPlaces(2, Decimal.ROUND_UP);
    const payment = await db.payment.create({
      data: { userId, amount: toDbString(amount), kind: "postpaid_settlement", status: "PENDING" },
    });
    try {
      const pi = await getStripe().paymentIntents.create(
        {
          amount: toCents(amount),
          currency: "usd",
          customer: user.stripeCustomerId,
          payment_method: user.defaultPaymentMethodId,
          off_session: true,
          confirm: true,
          description: "Postpaid usage settlement",
          metadata: { userId, paymentId: payment.id, kind: "postpaid_settlement" },
        },
        { idempotencyKey: `settle:${payment.id}` },
      );
      await db.payment.update({ where: { id: payment.id }, data: { stripePaymentIntentId: pi.id } });
      if (pi.status === "succeeded") {
        await settleFromIntent(payment.id, pi);
        return "charged";
      }
      if (pi.status === "processing") return "charged";
      const reason = pi.last_payment_error?.message ?? `Payment ${pi.status.replace(/_/g, " ")}`;
      if (await markPaymentFailed(payment.id, reason)) await notifyPaymentFailed(userId, amount, reason);
      return "failed";
    } catch (err) {
      const reason = stripeErrorMessage(err);
      logger.warn("postpaid settlement failed", { userId, paymentId: payment.id, reason });
      if (await markPaymentFailed(payment.id, reason)) await notifyPaymentFailed(userId, amount, reason);
      return "failed";
    }
  });
  return lock.ran ? lock.value : "skipped";
}

async function settlePostpaid(summary: BillingCronSummary) {
  const rows = await db.user.findMany({
    where: { billingMode: "POSTPAID", balance: { lt: 0 }, status: { not: "SUSPENDED" } },
    select: { id: true },
    take: 500,
  });
  summary.postpaid.candidates = rows.length;
  for (const { id } of rows) {
    try {
      const out = await settlePostpaidUser(id);
      if (out === "charged") summary.postpaid.charged++;
      else if (out === "failed") summary.postpaid.failed++;
      else summary.postpaid.skipped++;
    } catch (err) {
      summary.postpaid.failed++;
      logger.error("cron settlement failed", { userId: id, err });
    }
  }
}

/** PENDING for > 24h: ask Stripe what really happened, then settle / fail / cancel. */
export async function reconcileStalePayments(summary?: Pick<BillingCronSummary, "stale">) {
  const stale = await db.payment.findMany({
    where: { status: "PENDING", createdAt: { lt: new Date(Date.now() - STALE_PENDING_MS) } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const stats = summary?.stale ?? { checked: 0, settled: 0, failed: 0, canceled: 0 };
  const stripe = getStripe();
  for (const p of stale) {
    stats.checked++;
    try {
      if (p.stripePaymentIntentId) {
        const pi = await stripe.paymentIntents.retrieve(p.stripePaymentIntentId, { expand: ["latest_charge"] });
        if (pi.status === "succeeded") {
          await settleFromIntent(p.id, pi);
          stats.settled++;
          continue;
        }
        if (pi.status !== "canceled" && pi.status !== "requires_payment_method") {
          await stripe.paymentIntents.cancel(pi.id).catch(() => undefined);
        }
        await markPaymentFailed(p.id, pi.last_payment_error?.message ?? "Payment was not completed", pi.status === "requires_payment_method" ? "FAILED" : "CANCELED");
        if (pi.status === "requires_payment_method") stats.failed++;
        else stats.canceled++;
      } else if (p.stripeCheckoutId) {
        const session = await stripe.checkout.sessions.retrieve(p.stripeCheckoutId, { expand: ["payment_intent.latest_charge"] });
        if (session.payment_status === "paid") {
          await settleCheckoutSession(session, p.id);
          stats.settled++;
          continue;
        }
        if (session.status === "open") await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
        await markPaymentFailed(p.id, "Checkout was not completed", "CANCELED");
        stats.canceled++;
      } else {
        await markPaymentFailed(p.id, "Payment was never submitted", "CANCELED");
        stats.canceled++;
      }
    } catch (err) {
      logger.error("stale payment reconciliation failed", { paymentId: p.id, err });
    }
  }
  return stats;
}
