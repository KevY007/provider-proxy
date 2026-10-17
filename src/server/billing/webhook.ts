import type Stripe from "stripe";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { Decimal, toDecimal } from "@/lib/money";
import { afterLedgerCommit, appendEntryTx, lockUser } from "./ledger";
import { findPaymentForIntent, markPaymentFailed, notifyPaymentFailed } from "./payments";
import { fromCents, getStripe, handlePaymentMethodGone, registerPaymentMethod } from "./stripe";
import { settleCheckoutSession, settleFromIntent } from "./topup";

/**
 * Stripe webhook event handling. Every handler is idempotent (events are delivered at-least-once):
 *  - credits go through `settleSucceededPayment` (unique LedgerEntry.paymentId + user row lock)
 *  - refunds/chargebacks are de-duplicated by Stripe charge/dispute id stored in LedgerEntry.metadata
 * Throwing => the route answers 500 and Stripe retries; unknown event types are ignored (200).
 */
export interface HandleResult {
  handled: boolean;
  note?: string;
}

export const HANDLED_EVENTS = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "checkout.session.completed",
  "checkout.session.expired",
  "charge.refunded",
  "charge.dispute.created",
  "setup_intent.succeeded",
  "payment_method.detached",
] as const;

export async function handleStripeEvent(event: Stripe.Event): Promise<HandleResult> {
  const log = logger.child({ stripeEventId: event.id, stripeEventType: event.type });
  switch (event.type) {
    case "payment_intent.succeeded": {
      const pi = event.data.object;
      const payment = await findPaymentForIntent(pi);
      if (!payment) {
        log.warn("payment_intent.succeeded for unknown payment (not created by us?)", { paymentIntentId: pi.id });
        return { handled: false, note: "unknown_payment" };
      }
      const r = await settleFromIntent(payment.id, pi);
      log.info("payment_intent.succeeded processed", { paymentId: payment.id, credited: r.credited, duplicate: r.duplicate });
      return { handled: true, note: r.credited ? "credited" : "duplicate" };
    }

    case "payment_intent.payment_failed":
    case "payment_intent.canceled": {
      const pi = event.data.object;
      const payment = await findPaymentForIntent(pi);
      if (!payment) return { handled: false, note: "unknown_payment" };
      const reason = pi.last_payment_error?.message ?? (event.type === "payment_intent.canceled" ? "Payment canceled" : "Payment failed");
      const changed = await markPaymentFailed(payment.id, reason, event.type === "payment_intent.canceled" ? "CANCELED" : "FAILED");
      if (changed) {
        log.info("payment marked failed", { paymentId: payment.id, reason });
        // Auto-recharge failures are handled (and emailed) by the auto-recharge flow itself.
        if (payment.kind === "topup" && event.type === "payment_intent.payment_failed") {
          await notifyPaymentFailed(payment.userId, payment.amount, reason);
        }
      }
      return { handled: true, note: changed ? "failed" : "no_change" };
    }

    case "checkout.session.completed": {
      const sess = event.data.object;
      const payment =
        (await db.payment.findUnique({ where: { stripeCheckoutId: sess.id } })) ??
        (sess.metadata?.paymentId ? await db.payment.findUnique({ where: { id: sess.metadata.paymentId } }) : null);
      if (!payment) {
        log.warn("checkout.session.completed for unknown payment", { sessionId: sess.id });
        return { handled: false, note: "unknown_payment" };
      }
      if (!payment.stripeCheckoutId) {
        await db.payment.updateMany({ where: { id: payment.id, stripeCheckoutId: null }, data: { stripeCheckoutId: sess.id } });
      }
      let full: Stripe.Checkout.Session = sess;
      try {
        full = await getStripe().checkout.sessions.retrieve(sess.id, { expand: ["payment_intent.latest_charge"] });
      } catch (err) {
        log.warn("could not expand checkout session; using event payload", { err });
      }
      const status = await settleCheckoutSession(full, payment.id);
      return { handled: true, note: status };
    }

    case "checkout.session.expired": {
      const sess = event.data.object;
      const payment = await db.payment.findUnique({ where: { stripeCheckoutId: sess.id } });
      if (!payment) return { handled: false, note: "unknown_payment" };
      await markPaymentFailed(payment.id, "Checkout session expired", "CANCELED");
      return { handled: true };
    }

    case "charge.refunded":
      return handleRefund(event.data.object, log);

    case "charge.dispute.created":
      return handleDispute(event.data.object, log);

    case "setup_intent.succeeded": {
      const si = event.data.object;
      const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
      const customerId = typeof si.customer === "string" ? si.customer : si.customer?.id;
      if (!pmId) return { handled: false, note: "no_payment_method" };
      const user = await db.user.findFirst({
        where: si.metadata?.userId ? { id: si.metadata.userId } : customerId ? { stripeCustomerId: customerId } : { id: "-" },
        select: { id: true },
      });
      if (!user) {
        log.warn("setup_intent.succeeded for unknown customer", { customerId });
        return { handled: false, note: "unknown_user" };
      }
      const r = await registerPaymentMethod(user.id, pmId);
      log.info("payment method attached", { userId: user.id, paymentMethodId: pmId, madeDefault: r.madeDefault });
      return { handled: true };
    }

    case "payment_method.detached": {
      await handlePaymentMethodGone(event.data.object.id);
      return { handled: true };
    }

    default:
      log.debug("ignoring unhandled stripe event");
      return { handled: false, note: "ignored" };
  }
}

type Log = ReturnType<typeof logger.child>;

async function handleRefund(charge: Stripe.Charge, log: Log): Promise<HandleResult> {
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  const payment = piId ? await db.payment.findUnique({ where: { stripePaymentIntentId: piId } }) : null;
  if (!payment) {
    log.warn("charge.refunded for unknown payment", { chargeId: charge.id, paymentIntentId: piId });
    return { handled: false, note: "unknown_payment" };
  }
  const refundedTotal = fromCents(charge.amount_refunded);

  const outcome = await db.$transaction(async (tx) => {
    await lockUser(tx, payment.userId);
    const prior = await tx.ledgerEntry.findMany({
      where: { userId: payment.userId, type: "REFUND", metadata: { path: ["stripeChargeId"], equals: charge.id } },
      select: { amount: true },
    });
    const already = prior.reduce((acc, e) => acc.plus(toDecimal(e.amount).neg()), new Decimal(0));
    const delta = refundedTotal.minus(already);
    if (delta.lte(0)) return { applied: false as const };
    await appendEntryTx(tx, payment.userId, delta.neg(), "REFUND", `Refund of ${payment.kind.replace(/_/g, " ")}`, {
      metadata: { stripeChargeId: charge.id, paymentId: payment.id, refundedTotal: refundedTotal.toString() },
    });
    if (charge.refunded) {
      await tx.payment.updateMany({ where: { id: payment.id, status: { in: ["SUCCEEDED", "REFUNDED"] } }, data: { status: "REFUNDED" } });
    }
    return { applied: true as const, delta };
  });

  if (outcome.applied) {
    await afterLedgerCommit(payment.userId);
    await audit(null, "billing.refund", { type: "Payment", id: payment.id }, { chargeId: charge.id, amount: outcome.delta.toString() });
    log.info("refund debited", { paymentId: payment.id, amount: outcome.delta.toString() });
  }
  return { handled: true, note: outcome.applied ? "debited" : "duplicate" };
}

async function handleDispute(dispute: Stripe.Dispute, log: Log): Promise<HandleResult> {
  let piId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!piId) {
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
    if (chargeId) {
      try {
        const ch = await getStripe().charges.retrieve(chargeId);
        piId = typeof ch.payment_intent === "string" ? ch.payment_intent : ch.payment_intent?.id;
      } catch (err) {
        log.warn("could not resolve dispute charge", { chargeId, err });
      }
    }
  }
  const payment = piId ? await db.payment.findUnique({ where: { stripePaymentIntentId: piId } }) : null;
  if (!payment) {
    log.warn("charge.dispute.created for unknown payment", { disputeId: dispute.id });
    return { handled: false, note: "unknown_payment" };
  }
  const amount = fromCents(dispute.amount);

  const outcome = await db.$transaction(async (tx) => {
    await lockUser(tx, payment.userId);
    const prior = await tx.ledgerEntry.findFirst({
      where: { userId: payment.userId, type: "CHARGEBACK", metadata: { path: ["stripeDisputeId"], equals: dispute.id } },
      select: { id: true },
    });
    if (prior) return { applied: false as const };
    await appendEntryTx(tx, payment.userId, amount.neg(), "CHARGEBACK", `Chargeback (${dispute.reason ?? "dispute"})`, {
      metadata: { stripeDisputeId: dispute.id, paymentId: payment.id, reason: dispute.reason },
    });
    await tx.payment.updateMany({ where: { id: payment.id, status: { in: ["SUCCEEDED", "REFUNDED"] } }, data: { status: "DISPUTED" } });
    await tx.user.updateMany({ where: { id: payment.userId, status: "ACTIVE" }, data: { status: "SUSPENDED" } });
    return { applied: true as const };
  });

  if (outcome.applied) {
    await afterLedgerCommit(payment.userId);
    await audit(null, "billing.chargeback", { type: "User", id: payment.userId }, {
      disputeId: dispute.id,
      paymentId: payment.id,
      amount: amount.toString(),
      reason: dispute.reason,
      suspended: true,
    });
    log.warn("dispute opened: customer debited and suspended", { userId: payment.userId, disputeId: dispute.id });
  }
  return { handled: true, note: outcome.applied ? "debited_and_suspended" : "duplicate" };
}
