import Stripe from "stripe";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { Decimal, toDecimal, type MoneyLike } from "@/lib/money";
import { invalidateGatewayConfig } from "@/gateway/cache";

/**
 * Stripe access. The client is created lazily so the app boots (and billing degrades gracefully) when
 * STRIPE_* are unset. Tests inject a fake with `setStripeClientForTests`.
 */
export class StripeNotConfiguredError extends Error {
  constructor() {
    super("Stripe is not configured");
    this.name = "StripeNotConfiguredError";
  }
}

let client: Stripe | null = null;
let override: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return !!override || !!env.STRIPE_SECRET_KEY;
}

export function getStripe(): Stripe {
  if (override) return override;
  if (!env.STRIPE_SECRET_KEY) throw new StripeNotConfiguredError();
  if (!client) {
    client = new Stripe(env.STRIPE_SECRET_KEY, {
      maxNetworkRetries: 2,
      timeout: 20_000,
      appInfo: { name: "ProviderProxy", version: "0.1.0" },
    });
  }
  return client;
}

/** Inject a mocked Stripe client (unit tests). Pass null to reset. */
export function setStripeClientForTests(c: unknown | null): void {
  override = (c as Stripe | null) ?? null;
}

export function publishableKey(): string | null {
  return env.STRIPE_PUBLISHABLE_KEY ?? null;
}

// --------------------------------------------------------------------------------------------
// Money <-> cents
// --------------------------------------------------------------------------------------------

export function toCents(amount: MoneyLike): number {
  return toDecimal(amount).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

export function fromCents(cents: number): Decimal {
  return new Decimal(cents).div(100);
}

/** Best-effort human message from a Stripe (or any) error. */
export function stripeErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: string; code?: string; raw?: { message?: string } };
    return e.raw?.message ?? e.message ?? "Payment failed";
  }
  return "Payment failed";
}

/** Stripe error code/decline code for logging and decisions. */
export function stripeErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const e = err as { code?: string; decline_code?: string };
    return e.decline_code ?? e.code;
  }
  return undefined;
}

// --------------------------------------------------------------------------------------------
// Customers & payment methods
// --------------------------------------------------------------------------------------------

export interface StripeUserRef {
  id: string;
  email: string;
  name: string | null;
  stripeCustomerId: string | null;
}

/** Return the user's Stripe customer id, creating the customer on first use. */
export async function ensureStripeCustomer(user: StripeUserRef): Promise<string> {
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const stripe = getStripe();
  // Re-read: another request may have created it a moment ago.
  const fresh = await db.user.findUnique({ where: { id: user.id }, select: { stripeCustomerId: true } });
  if (fresh?.stripeCustomerId) return fresh.stripeCustomerId;

  const customer = await stripe.customers.create(
    { email: user.email, name: user.name ?? undefined, metadata: { userId: user.id } },
    { idempotencyKey: `customer:${user.id}` },
  );
  const res = await db.user.updateMany({
    where: { id: user.id, stripeCustomerId: null },
    data: { stripeCustomerId: customer.id },
  });
  if (res.count === 0) {
    const again = await db.user.findUnique({ where: { id: user.id }, select: { stripeCustomerId: true } });
    if (again?.stripeCustomerId) return again.stripeCustomerId;
  }
  return customer.id;
}

export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

export async function listPaymentMethods(userId: string): Promise<SavedCard[]> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true, defaultPaymentMethodId: true },
  });
  if (!user?.stripeCustomerId) return [];
  const list = await getStripe().paymentMethods.list({ customer: user.stripeCustomerId, type: "card", limit: 20 });
  return list.data
    .filter((pm) => pm.card)
    .map((pm) => ({
      id: pm.id,
      brand: pm.card!.brand,
      last4: pm.card!.last4,
      expMonth: pm.card!.exp_month,
      expYear: pm.card!.exp_year,
      isDefault: pm.id === user.defaultPaymentMethodId,
    }));
}

/** SetupIntent for the Payment Element "add a card" dialog. */
export async function createSetupIntent(userId: string): Promise<{ clientSecret: string }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, stripeCustomerId: true },
  });
  if (!user) throw new Error("User not found");
  const customer = await ensureStripeCustomer(user);
  const si = await getStripe().setupIntents.create({
    customer,
    allowed_payment_method_types: ["card"],
    usage: "off_session",
    metadata: { userId },
  });
  if (!si.client_secret) throw new Error("Stripe did not return a client secret");
  return { clientSecret: si.client_secret };
}

/**
 * Record that `paymentMethodId` now belongs to the user: makes it the default when they have none, and
 * (when `requireCardForTrial` is on) grants the trial credit. Idempotent; used by the webhook and by the
 * UI's post-setup sync so it works without webhooks in dev.
 */
export async function registerPaymentMethod(
  userId: string,
  paymentMethodId: string,
): Promise<{ madeDefault: boolean }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, stripeCustomerId: true, defaultPaymentMethodId: true },
  });
  if (!user) return { madeDefault: false };
  let madeDefault = false;
  if (!user.defaultPaymentMethodId) {
    const res = await db.user.updateMany({
      where: { id: userId, defaultPaymentMethodId: null },
      data: { defaultPaymentMethodId: paymentMethodId },
    });
    madeDefault = res.count > 0;
    if (madeDefault && user.stripeCustomerId) {
      try {
        await getStripe().customers.update(user.stripeCustomerId, {
          invoice_settings: { default_payment_method: paymentMethodId },
        });
      } catch (err) {
        logger.warn("could not set stripe customer default payment method", { userId, err });
      }
    }
  }
  try {
    const { getSetting } = await import("@/lib/settings");
    if (await getSetting("requireCardForTrial")) {
      const { grantTrialCredit } = await import("@/lib/auth/service");
      const r = await grantTrialCredit(userId);
      if (r.granted) logger.info("trial credit granted after card attached", { userId });
    }
  } catch (err) {
    logger.error("trial grant after card attach failed", { userId, err });
  }
  await invalidateGatewayConfig("users", userId).catch(() => undefined);
  return { madeDefault };
}

async function assertOwnsPaymentMethod(userId: string, paymentMethodId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true, defaultPaymentMethodId: true },
  });
  if (!user?.stripeCustomerId) throw new Error("No payment methods on file");
  const pm = await getStripe().paymentMethods.retrieve(paymentMethodId);
  const owner = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
  if (owner !== user.stripeCustomerId) throw new Error("Payment method not found");
  return { user, pm };
}

export async function setDefaultPaymentMethod(userId: string, paymentMethodId: string): Promise<void> {
  const { user } = await assertOwnsPaymentMethod(userId, paymentMethodId);
  await db.user.update({ where: { id: userId }, data: { defaultPaymentMethodId: paymentMethodId } });
  try {
    await getStripe().customers.update(user.stripeCustomerId!, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  } catch (err) {
    logger.warn("could not set stripe customer default payment method", { userId, err });
  }
  await invalidateGatewayConfig("users", userId).catch(() => undefined);
}

export async function removePaymentMethod(userId: string, paymentMethodId: string): Promise<void> {
  await assertOwnsPaymentMethod(userId, paymentMethodId);
  await getStripe().paymentMethods.detach(paymentMethodId);
  await handlePaymentMethodGone(paymentMethodId);
}

/**
 * A payment method was detached. If it was somebody's default, switch them to another saved card, or
 * clear it (and turn auto-recharge off, since there's nothing left to charge).
 */
export async function handlePaymentMethodGone(paymentMethodId: string): Promise<void> {
  const users = await db.user.findMany({
    where: { defaultPaymentMethodId: paymentMethodId },
    select: { id: true, stripeCustomerId: true },
  });
  for (const u of users) {
    let replacement: string | null = null;
    if (u.stripeCustomerId && isStripeConfigured()) {
      try {
        const list = await getStripe().paymentMethods.list({ customer: u.stripeCustomerId, type: "card", limit: 5 });
        replacement = list.data.find((pm) => pm.id !== paymentMethodId)?.id ?? null;
      } catch (err) {
        logger.warn("could not list payment methods after detach", { userId: u.id, err });
      }
    }
    await db.user.update({
      where: { id: u.id },
      data: replacement
        ? { defaultPaymentMethodId: replacement }
        : { defaultPaymentMethodId: null, autoRechargeEnabled: false },
    });
    if (replacement && u.stripeCustomerId) {
      await getStripe()
        .customers.update(u.stripeCustomerId, { invoice_settings: { default_payment_method: replacement } })
        .catch(() => undefined);
    }
    await invalidateGatewayConfig("users", u.id).catch(() => undefined);
  }
}
