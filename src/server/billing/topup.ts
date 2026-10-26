import type Stripe from "stripe";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { Decimal, toDbString } from "@/lib/money";
import { STRIPE_MAX_USD, STRIPE_MIN_USD, validateTopupAmount } from "./amount";

export { STRIPE_MAX_USD, STRIPE_MIN_USD, validateTopupAmount };
export type { AmountCheck } from "./amount";
import {
  ensureStripeCustomer,
  fromCents,
  getStripe,
  isStripeConfigured,
  registerPaymentMethod,
  stripeErrorCode,
  stripeErrorMessage,
  toCents,
} from "./stripe";
import {
  findPaymentForIntent,
  markPaymentFailed,
  settleSucceededPayment,
  type SettleResult,
} from "./payments";

export async function getTopupLimits(): Promise<{ min: number; max: number }> {
  const s = await getSettings();
  return { min: Math.max(s.minTopup, STRIPE_MIN_USD), max: s.maxTopup > 0 ? s.maxTopup : STRIPE_MAX_USD };
}

export type TopupResult =
  | { ok: true; status: "succeeded"; paymentId: string }
  | { ok: true; status: "processing"; paymentId: string }
  | { ok: true; status: "requires_action"; paymentId: string; paymentIntentId: string; clientSecret: string }
  | { ok: true; status: "checkout"; paymentId: string; url: string }
  | { ok: false; error: string; code?: "not_configured" | "invalid_amount" | "declined" | "error" };

/** Receipt URL of the PaymentIntent's latest charge (best effort). */
export async function fetchReceiptUrl(pi: Stripe.PaymentIntent): Promise<string | null> {
  try {
    const ch = pi.latest_charge;
    if (!ch) return null;
    if (typeof ch === "object") return ch.receipt_url ?? null;
    const charge = await getStripe().charges.retrieve(ch);
    return charge.receipt_url ?? null;
  } catch {
    return null;
  }
}

/** Settle a Payment from a succeeded PaymentIntent (credits once). */
export async function settleFromIntent(paymentId: string, pi: Stripe.PaymentIntent): Promise<SettleResult> {
  const receiptUrl = await fetchReceiptUrl(pi);
  return settleSucceededPayment({
    paymentId,
    paymentIntentId: pi.id,
    amountReceived: pi.currency === "usd" ? fromCents(pi.amount_received || pi.amount) : undefined,
    receiptUrl,
  });
}

/**
 * Start a top-up. With a saved default card: PaymentIntent confirmed immediately (3DS => `requires_action`
 * with a client secret for the UI). Without one: a Stripe Checkout Session. The Payment row is created
 * PENDING first; the balance is only ever credited via `settleSucceededPayment`.
 */
export async function createTopup(userId: string, rawAmount: unknown): Promise<TopupResult> {
  if (!isStripeConfigured()) return { ok: false, error: "Card payments are not configured yet.", code: "not_configured" };
  if (!(await getSettings()).customerBilling) return { ok: false, error: "Billing is managed by your admin.", code: "error" };

  const check = validateTopupAmount(rawAmount, await getTopupLimits());
  if (!check.ok) return { ok: false, error: check.error, code: "invalid_amount" };
  const amount = check.amount;

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, status: true, stripeCustomerId: true, defaultPaymentMethodId: true },
  });
  if (!user || user.status !== "ACTIVE") return { ok: false, error: "Your account cannot make payments right now.", code: "error" };

  const stripe = getStripe();
  let payment;
  try {
    const customer = await ensureStripeCustomer(user);
    payment = await db.payment.create({
      data: { userId, amount: toDbString(amount), kind: "topup", status: "PENDING" },
    });
    const metadata = { userId, paymentId: payment.id, kind: "topup" };

    if (user.defaultPaymentMethodId) {
      try {
        const pi = await stripe.paymentIntents.create(
          {
            amount: toCents(amount),
            currency: "usd",
            customer,
            payment_method: user.defaultPaymentMethodId,
            confirm: true,
            automatic_payment_methods: { enabled: true, allow_redirects: "never" },
            description: "Account top-up",
            metadata,
          },
          { idempotencyKey: `topup:${payment.id}` },
        );
        await db.payment.update({ where: { id: payment.id }, data: { stripePaymentIntentId: pi.id } });
        return await interpretIntent(payment.id, userId, amount, pi);
      } catch (err) {
        const reason = stripeErrorMessage(err);
        logger.warn("top-up charge failed", { userId, paymentId: payment.id, code: stripeErrorCode(err), reason });
        await markPaymentFailed(payment.id, reason);
        return { ok: false, error: reason, code: "declined" };
      }
    }

    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: toCents(amount),
              product_data: { name: "Account credit" },
            },
          },
        ],
        payment_intent_data: { metadata, setup_future_usage: "off_session" },
        metadata,
        success_url: `${appUrl}/dashboard/billing?topup=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/dashboard/billing?topup=cancelled`,
      },
      { idempotencyKey: `topup-checkout:${payment.id}` },
    );
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    await db.payment.update({ where: { id: payment.id }, data: { stripeCheckoutId: session.id } });
    return { ok: true, status: "checkout", paymentId: payment.id, url: session.url };
  } catch (err) {
    logger.error("createTopup failed", { userId, err });
    if (payment) await markPaymentFailed(payment.id, stripeErrorMessage(err));
    return { ok: false, error: "We couldn't start the payment. Please try again.", code: "error" };
  }
}

async function interpretIntent(
  paymentId: string,
  userId: string,
  amount: Decimal,
  pi: Stripe.PaymentIntent,
): Promise<TopupResult> {
  switch (pi.status) {
    case "succeeded":
      await settleFromIntent(paymentId, pi);
      return { ok: true, status: "succeeded", paymentId };
    case "processing":
      return { ok: true, status: "processing", paymentId };
    case "requires_action":
      if (!pi.client_secret) break;
      return { ok: true, status: "requires_action", paymentId, paymentIntentId: pi.id, clientSecret: pi.client_secret };
    default:
      break;
  }
  const reason = pi.last_payment_error?.message ?? `Payment ${pi.status.replace(/_/g, " ")}`;
  await markPaymentFailed(paymentId, reason);
  logger.warn("top-up not completed", { userId, paymentId, status: pi.status, amount: amount.toString() });
  return { ok: false, error: reason, code: "declined" };
}

/**
 * After the browser finished 3D Secure: pull the PaymentIntent from Stripe and settle/fail the Payment.
 * Idempotent with the webhook. Ownership is enforced (the Payment must belong to `userId`).
 */
export async function syncPaymentIntent(
  userId: string,
  paymentIntentId: string,
): Promise<{ status: "succeeded" | "processing" | "failed" | "pending"; error?: string }> {
  const pi = await getStripe().paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
  const payment = await findPaymentForIntent({ id: pi.id, metadata: pi.metadata });
  if (!payment || payment.userId !== userId) throw new Error("Payment not found");
  if (!payment.stripePaymentIntentId) {
    await db.payment.updateMany({ where: { id: payment.id, stripePaymentIntentId: null }, data: { stripePaymentIntentId: pi.id } });
  }
  if (pi.status === "succeeded") {
    await settleFromIntent(payment.id, pi);
    return { status: "succeeded" };
  }
  if (pi.status === "processing") return { status: "processing" };
  if (pi.status === "requires_payment_method" || pi.status === "canceled") {
    const reason = pi.last_payment_error?.message ?? "Payment was not completed";
    await markPaymentFailed(payment.id, reason, pi.status === "canceled" ? "CANCELED" : "FAILED");
    return { status: "failed", error: reason };
  }
  return { status: "pending" };
}

/** After returning from Stripe Checkout: settle the session's Payment if it was paid (idempotent with the webhook). */
export async function syncCheckoutSession(userId: string, sessionId: string): Promise<{ status: "succeeded" | "pending" | "failed" }> {
  const session = await getStripe().checkout.sessions.retrieve(sessionId, { expand: ["payment_intent.latest_charge"] });
  const payment = await db.payment.findUnique({ where: { stripeCheckoutId: session.id } });
  if (!payment || payment.userId !== userId) throw new Error("Payment not found");
  const result = await settleCheckoutSession(session, payment.id);
  return { status: result };
}

/** Shared by the webhook and the checkout return sync. */
export async function settleCheckoutSession(
  session: Stripe.Checkout.Session,
  paymentId: string,
): Promise<"succeeded" | "pending" | "failed"> {
  const pi = session.payment_intent && typeof session.payment_intent === "object" ? session.payment_intent : null;
  const piId = typeof session.payment_intent === "string" ? session.payment_intent : pi?.id ?? null;
  if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
    const receiptUrl = pi ? await fetchReceiptUrl(pi) : null;
    await settleSucceededPayment({
      paymentId,
      paymentIntentId: piId,
      amountReceived: session.currency === "usd" && session.amount_total != null ? fromCents(session.amount_total) : undefined,
      receiptUrl,
    });
    // Remember the card they just paid with, so the next top-up is one click.
    const pmId = pi ? (typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id) : null;
    if (pmId) {
      const p = await db.payment.findUnique({ where: { id: paymentId }, select: { userId: true } });
      if (p) {
        await registerPaymentMethod(p.userId, pmId).catch((err) => logger.warn("register payment method failed", { err }));
      }
    }
    return "succeeded";
  }
  if (session.status === "expired") {
    await markPaymentFailed(paymentId, "Checkout session expired", "CANCELED");
    return "failed";
  }
  return "pending";
}
