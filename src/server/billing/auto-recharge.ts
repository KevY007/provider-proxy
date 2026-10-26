import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { emailTemplates, sendTemplate } from "@/lib/email";
import { logger } from "@/lib/logger";
import { getSetting } from "@/lib/settings";
import { formatUSD, toDbString, toDecimal } from "@/lib/money";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { acquireLock, once } from "./locks";
import { markPaymentFailed, notifyPaymentFailed } from "./payments";
import { getStripe, isStripeConfigured, stripeErrorCode, stripeErrorMessage, toCents } from "./stripe";
import { settleFromIntent, STRIPE_MAX_USD, STRIPE_MIN_USD } from "./topup";

/** Consecutive failed auto-recharges after which the feature is switched off for the customer. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** Minimum spacing between two auto-recharge attempts for one customer (protects Stripe + the card). */
const MIN_RETRY_GAP_MS = 5 * 60_000;
const LOCK_TTL_MS = 2 * 60_000;
const DISABLED_AUDIT_ACTION = "billing.auto_recharge_disabled";

export type AutoRechargeOutcome =
  | { status: "succeeded"; paymentId: string }
  | { status: "failed"; paymentId: string; reason: string; disabled: boolean }
  | {
      status: "skipped";
      reason:
        | "not_configured"
        | "billing_off"
        | "locked"
        | "user_not_found"
        | "not_eligible"
        | "balance_ok"
        | "no_card"
        | "daily_limit"
        | "in_flight"
        | "cooldown";
    };

/**
 * Called by the gateway after a request pushes the balance below the customer's auto-recharge threshold.
 * Idempotent (per-user lock + DB-derived in-flight / daily-cap / cooldown checks) and NEVER throws.
 */
export async function triggerAutoRecharge(userId: string): Promise<void> {
  try {
    await runAutoRecharge(userId);
  } catch (err) {
    logger.error("auto-recharge crashed", { userId, err });
  }
}

/** Number of auto-recharge Payments that FAILED in a row (newest first), ignoring ones before the last auto-disable. */
export async function countConsecutiveFailures(userId: string): Promise<number> {
  const lastDisabled = await db.auditLog.findFirst({
    where: { action: DISABLED_AUDIT_ACTION, targetType: "User", targetId: userId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const recent = await db.payment.findMany({
    where: { userId, kind: "auto_recharge", ...(lastDisabled ? { createdAt: { gt: lastDisabled.createdAt } } : {}) },
    orderBy: { createdAt: "desc" },
    take: MAX_CONSECUTIVE_FAILURES + 2,
    select: { status: true },
  });
  let n = 0;
  for (const p of recent) {
    if (p.status === "FAILED") n++;
    else if (p.status === "PENDING") continue;
    else break;
  }
  return n;
}

/** The actual flow; exposed for tests and the cron sweep (which wants the outcome). */
export async function runAutoRecharge(userId: string): Promise<AutoRechargeOutcome> {
  if (!isStripeConfigured()) return { status: "skipped", reason: "not_configured" };
  // customer billing pages off: never charge a saved card (admins set balances by hand)
  if (!(await getSetting("customerBilling"))) return { status: "skipped", reason: "billing_off" };

  const release = await acquireLock(`autorecharge:${userId}`, LOCK_TTL_MS);
  if (!release) return { status: "skipped", reason: "locked" };
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        balance: true,
        autoRechargeEnabled: true,
        autoRechargeThreshold: true,
        autoRechargeAmount: true,
        stripeCustomerId: true,
        defaultPaymentMethodId: true,
      },
    });
    if (!user) return { status: "skipped", reason: "user_not_found" };
    if (!user.autoRechargeEnabled || user.status !== "ACTIVE") return { status: "skipped", reason: "not_eligible" };
    if (!toDecimal(user.balance).lt(toDecimal(user.autoRechargeThreshold))) return { status: "skipped", reason: "balance_ok" };
    if (!user.stripeCustomerId || !user.defaultPaymentMethodId) return { status: "skipped", reason: "no_card" };

    const maxPerDay = await getSetting("autoRechargeMaxPerDay");
    const amount = toDecimal(user.autoRechargeAmount);
    const clamped = amount.lt(STRIPE_MIN_USD) ? toDecimal(STRIPE_MIN_USD) : amount.gt(STRIPE_MAX_USD) ? toDecimal(STRIPE_MAX_USD) : amount;
    // check + create the PENDING payment under a database lock: two instances can never both pass the in-flight check
    // (the Redis lock above is only an optimisation and degrades to a per-instance lock without Redis)
    const gate = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`autorecharge:${userId}`}))`;
      const now = Date.now();
      const last24h = await tx.payment.findMany({
        where: { userId, kind: "auto_recharge", createdAt: { gt: new Date(now - 24 * 3600_000) } },
        orderBy: { createdAt: "desc" },
        select: { status: true, createdAt: true },
      });
      if (last24h.some((p) => p.status === "PENDING" && now - p.createdAt.getTime() < 10 * 60_000)) return { skip: "in_flight" as const };
      if (last24h.length >= maxPerDay) return { skip: "daily_limit" as const };
      if (last24h[0] && now - last24h[0].createdAt.getTime() < MIN_RETRY_GAP_MS) return { skip: "cooldown" as const };
      return { payment: await tx.payment.create({ data: { userId, amount: toDbString(clamped), kind: "auto_recharge", status: "PENDING" } }) };
    });
    if ("skip" in gate) return { status: "skipped", reason: gate.skip! };
    const payment = gate.payment;

    try {
      const pi = await getStripe().paymentIntents.create(
        {
          amount: toCents(clamped),
          currency: "usd",
          customer: user.stripeCustomerId,
          payment_method: user.defaultPaymentMethodId,
          off_session: true,
          confirm: true,
          description: "Auto-recharge",
          metadata: { userId, paymentId: payment.id, kind: "auto_recharge" },
        },
        { idempotencyKey: `autorecharge:${payment.id}` },
      );
      await db.payment.update({ where: { id: payment.id }, data: { stripePaymentIntentId: pi.id } });

      if (pi.status === "succeeded") {
        await settleFromIntent(payment.id, pi);
        logger.info("auto-recharge succeeded", { userId, paymentId: payment.id, amount: clamped.toString() });
        return { status: "succeeded", paymentId: payment.id };
      }
      if (pi.status === "processing") {
        // The webhook (or the cron reconciliation) will settle it.
        return { status: "succeeded", paymentId: payment.id };
      }
      const reason =
        pi.status === "requires_action"
          ? "Your bank requires authentication for this payment"
          : (pi.last_payment_error?.message ?? `Payment ${pi.status.replace(/_/g, " ")}`);
      return await failed(user, payment.id, clamped.toString(), reason);
    } catch (err) {
      const reason = stripeErrorMessage(err);
      logger.warn("auto-recharge charge failed", { userId, paymentId: payment.id, code: stripeErrorCode(err), reason });
      return await failed(user, payment.id, clamped.toString(), reason);
    }
  } finally {
    await release();
  }
}

async function failed(
  user: { id: string; email: string; name: string | null },
  paymentId: string,
  amount: string,
  reason: string,
): Promise<AutoRechargeOutcome> {
  const changed = await markPaymentFailed(paymentId, reason);
  let disabled = false;
  if (changed) {
    const streak = await countConsecutiveFailures(user.id);
    if (streak >= MAX_CONSECUTIVE_FAILURES) {
      await db.user.update({ where: { id: user.id }, data: { autoRechargeEnabled: false } });
      await audit(null, DISABLED_AUDIT_ACTION, { type: "User", id: user.id }, { failures: streak, reason });
      await invalidateGatewayConfig("users", user.id).catch(() => undefined);
      await sendTemplate(user.email, emailTemplates.autoRechargeDisabled({ name: user.name, reason })).catch(() => undefined);
      disabled = true;
      logger.warn("auto-recharge disabled after repeated failures", { userId: user.id, failures: streak });
    } else {
      await notifyPaymentFailed(user.id, amount, reason);
    }
  }
  return { status: "failed", paymentId, reason, disabled };
}

const LOW_BALANCE_AUDIT_ACTION = "billing.low_balance_alert";
const LOW_BALANCE_DEDUPE_MS = 24 * 3600_000;

const BALANCE_EXHAUSTED_AUDIT_ACTION = "billing.balance_exhausted_alert";

/**
 * Email the customer about their balance (deduped to one email of each kind per 24h per customer, by a Redis/memory
 * gate plus an audit-log check so it also holds across restarts). Never throws.
 *  - below their alert level (`lowBalanceAlertAt`, falling back to the auto-recharge threshold): "running low";
 *  - at zero or below: "has run out" - its own email, so a customer warned earlier the same day still hears that
 *    requests are now being rejected (sent even with auto-recharge on: if they are at zero, it did not top them up).
 */
export async function maybeSendLowBalanceAlert(userId: string): Promise<void> {
  try {
    if (!(await getSetting("lowBalanceEmail"))) return;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        name: true,
        status: true,
        balance: true,
        creditLimit: true,
        lowBalanceAlertAt: true,
        autoRechargeEnabled: true,
        autoRechargeThreshold: true,
        defaultPaymentMethodId: true,
      },
    });
    if (!user || user.status !== "ACTIVE" || user.email.endsWith("@system.internal")) return; // internal customers (Pricing fetch AI)
    const balance = toDecimal(user.balance);
    const exhausted = balance.lte(0);
    const level = user.lowBalanceAlertAt ?? user.autoRechargeThreshold;
    if (!exhausted && !balance.lt(toDecimal(level))) return;
    // Auto-recharge will top them up silently unless they set an explicit alert level.
    if (!exhausted && user.autoRechargeEnabled && user.defaultPaymentMethodId && !user.lowBalanceAlertAt && isStripeConfigured()) return;

    const action = exhausted ? BALANCE_EXHAUSTED_AUDIT_ACTION : LOW_BALANCE_AUDIT_ACTION;
    if (!(await once(`${exhausted ? "zerobal" : "lowbal"}:${userId}`, LOW_BALANCE_DEDUPE_MS))) return;
    const recent = await db.auditLog.findFirst({
      where: { action, targetType: "User", targetId: userId, createdAt: { gt: new Date(Date.now() - LOW_BALANCE_DEDUPE_MS) } },
      select: { id: true },
    });
    if (recent) return;

    const template = exhausted
      ? emailTemplates.balanceExhausted({ name: user.name, balance: user.balance, creditLeft: balance.add(toDecimal(user.creditLimit)) })
      : emailTemplates.lowBalance({ name: user.name, balance: user.balance });
    await sendTemplate(user.email, await template);
    await audit(null, action, { type: "User", id: userId }, { balance: toDbString(user.balance), level: toDbString(level) });
    logger.info(exhausted ? "balance exhausted alert sent" : "low balance alert sent", { userId, balance: formatUSD(user.balance) });
  } catch (err) {
    logger.error("low balance alert failed", { userId, err });
  }
}
