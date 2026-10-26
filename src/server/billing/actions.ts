"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUserForAction } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/auth/types";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/ratelimit";
import { getSetting, getSettings } from "@/lib/settings";
import { toDbString } from "@/lib/money";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { ActionFail, parseInput, toActionResult } from "./action-utils";
import { redeemCode } from "./redeem";
import {
  createSetupIntent,
  getStripe,
  isStripeConfigured,
  publishableKey,
  registerPaymentMethod,
  removePaymentMethod,
  setDefaultPaymentMethod,
  StripeNotConfiguredError,
} from "./stripe";
import { createTopup, getTopupLimits, syncCheckoutSession, syncPaymentIntent, validateTopupAmount, STRIPE_MAX_USD, STRIPE_MIN_USD } from "./topup";

/**
 * Customer billing server actions. Each one re-checks the session (`requireUserForAction`), validates input
 * with zod and returns a serializable ActionResult - never throws for expected failures.
 */
const BILLING_OFF_ERROR = "Billing is managed by your admin. Contact them to change your balance.";

async function run<T>(name: string, fn: (user: { id: string }) => Promise<{ data?: T; message?: string } | void>): Promise<ActionResult<T>> {
  try {
    const { user, impersonatorId } = await requireUserForAction();
    if (impersonatorId) return { ok: false, error: "Billing actions are disabled while impersonating." };
    // internal tracking mode: customers cannot pay, redeem or change billing; admins set the balance
    if (!(await getSetting("customerBilling"))) return { ok: false, error: BILLING_OFF_ERROR };
    const out = await fn(user);
    return { ok: true, data: out?.data, message: out?.message };
  } catch (err) {
    return toActionResult(err, name);
  }
}

function refresh() {
  revalidatePath("/dashboard/billing");
  revalidatePath("/dashboard", "layout");
}

function requireStripe() {
  if (!isStripeConfigured()) throw new StripeNotConfiguredError();
}

// --------------------------------------------------------------------------------------------
// Payment methods
// --------------------------------------------------------------------------------------------

export async function createSetupIntentAction(): Promise<ActionResult<{ clientSecret: string; publishableKey: string }>> {
  return run("createSetupIntent", async (user) => {
    requireStripe();
    const pk = publishableKey();
    if (!pk) throw new ActionFail("Card entry is unavailable (publishable key missing).");
    const rl = await rateLimit(`billing:setupintent:${user.id}`, { limit: 10, windowSec: 600 });
    if (!rl.ok) throw new ActionFail("Too many attempts. Please wait a few minutes.");
    const { clientSecret } = await createSetupIntent(user.id);
    return { data: { clientSecret, publishableKey: pk } };
  });
}

/** After the browser confirmed a SetupIntent: make the new card the default if there's none (works without webhooks). */
export async function syncSetupIntentAction(input: unknown): Promise<ActionResult> {
  const { setupIntentId } = (input ?? {}) as { setupIntentId?: string };
  return run("syncSetupIntent", async (user) => {
    requireStripe();
    const id = parseInput(z.string().min(5).max(255), setupIntentId);
    const si = await getStripe().setupIntents.retrieve(id);
    const owner = await db.user.findUnique({ where: { id: user.id }, select: { stripeCustomerId: true } });
    const customerId = typeof si.customer === "string" ? si.customer : si.customer?.id;
    if (!owner?.stripeCustomerId || customerId !== owner.stripeCustomerId) throw new ActionFail("Setup not found");
    if (si.status !== "succeeded") throw new ActionFail("The card could not be saved.");
    const pm = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
    if (pm) await registerPaymentMethod(user.id, pm);
    refresh();
    return { message: "Card saved" };
  });
}

export async function setDefaultCardAction(paymentMethodId: unknown): Promise<ActionResult> {
  return run("setDefaultCard", async (user) => {
    requireStripe();
    await setDefaultPaymentMethod(user.id, parseInput(z.string().min(3).max(255), paymentMethodId));
    refresh();
    return { message: "Default card updated" };
  });
}

export async function removeCardAction(paymentMethodId: unknown): Promise<ActionResult> {
  return run("removeCard", async (user) => {
    requireStripe();
    await removePaymentMethod(user.id, parseInput(z.string().min(3).max(255), paymentMethodId));
    refresh();
    return { message: "Card removed" };
  });
}

// --------------------------------------------------------------------------------------------
// Top-up
// --------------------------------------------------------------------------------------------

export type TopupActionData =
  | { status: "succeeded" | "processing" }
  | { status: "requires_action"; clientSecret: string; paymentIntentId: string; publishableKey: string }
  | { status: "checkout"; url: string };

export async function topUpAction(input: unknown): Promise<ActionResult<TopupActionData>> {
  const { amount } = (input ?? {}) as { amount?: unknown };
  return run<TopupActionData>("topUp", async (user) => {
    requireStripe();
    const check = validateTopupAmount(amount, await getTopupLimits());
    if (!check.ok) throw new ActionFail(check.error, { amount: check.error });
    const rl = await rateLimit(`billing:topup:${user.id}`, { limit: 10, windowSec: 600 });
    if (!rl.ok) throw new ActionFail("Too many payment attempts. Please wait a few minutes.");

    const res = await createTopup(user.id, check.amount.toString());
    if (!res.ok) throw new ActionFail(res.error);
    refresh();
    switch (res.status) {
      case "succeeded":
        return { data: { status: "succeeded" }, message: "Payment received - your balance has been updated" };
      case "processing":
        return { data: { status: "processing" }, message: "Payment is processing - your balance will update shortly" };
      case "checkout":
        return { data: { status: "checkout", url: res.url } };
      case "requires_action": {
        const pk = publishableKey();
        if (!pk) throw new ActionFail("Your bank needs to verify this payment, but card entry is unavailable.");
        return { data: { status: "requires_action", clientSecret: res.clientSecret, paymentIntentId: res.paymentIntentId, publishableKey: pk } };
      }
    }
  });
}

/** Called by the browser after 3D Secure completes. */
export async function confirmTopupAction(input: unknown): Promise<ActionResult<{ status: string }>> {
  const { paymentIntentId } = (input ?? {}) as { paymentIntentId?: string };
  return run("confirmTopup", async (user) => {
    requireStripe();
    const id = parseInput(z.string().min(5).max(255), paymentIntentId);
    const r = await syncPaymentIntent(user.id, id);
    refresh();
    if (r.status === "failed") throw new ActionFail(r.error ?? "The payment was not completed.");
    return {
      data: { status: r.status },
      message: r.status === "succeeded" ? "Payment received - your balance has been updated" : "Payment is processing",
    };
  });
}

/** After returning from Stripe Checkout (dev-friendly: settles without waiting for the webhook). */
export async function syncCheckoutAction(input: unknown): Promise<ActionResult<{ status: string }>> {
  const { sessionId } = (input ?? {}) as { sessionId?: string };
  return run("syncCheckout", async (user) => {
    requireStripe();
    const id = parseInput(z.string().min(5).max(255), sessionId);
    const r = await syncCheckoutSession(user.id, id);
    refresh();
    return { data: { status: r.status } };
  });
}

// --------------------------------------------------------------------------------------------
// Auto-recharge & spend controls
// --------------------------------------------------------------------------------------------

const money = (max = 1_000_000) => z.coerce.number({ error: "Enter a valid amount" }).finite().min(0, "Must be 0 or more").max(max, "Too large");

export async function saveAutoRechargeAction(input: unknown): Promise<ActionResult> {
  return run("saveAutoRecharge", async (user) => {
    const settings = await getSettings();
    const minAmt = Math.max(settings.minTopup, STRIPE_MIN_USD);
    const maxAmt = Math.min(settings.maxTopup > 0 ? settings.maxTopup : STRIPE_MAX_USD, STRIPE_MAX_USD);
    const data = parseInput(
      z.object({
        enabled: z.boolean(),
        threshold: money(100_000),
        amount: money(maxAmt).min(minAmt, `Minimum is $${minAmt}`),
      }),
      input,
    );
    if (data.enabled) {
      requireStripe();
      const u = await db.user.findUnique({ where: { id: user.id }, select: { defaultPaymentMethodId: true } });
      if (!u?.defaultPaymentMethodId) throw new ActionFail("Add a card before turning on auto-recharge.");
    }
    await db.user.update({
      where: { id: user.id },
      data: {
        autoRechargeEnabled: data.enabled,
        autoRechargeThreshold: toDbString(data.threshold),
        autoRechargeAmount: toDbString(data.amount),
      },
    });
    await invalidateGatewayConfig("users", user.id).catch(() => undefined);
    refresh();
    return { message: data.enabled ? "Auto-recharge is on" : "Auto-recharge settings saved" };
  });
}

export async function saveSpendControlsAction(input: unknown): Promise<ActionResult> {
  return run("saveSpendControls", async (user) => {
    const optionalMoney = z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? null : v),
      z.coerce.number({ error: "Enter a valid amount" }).finite().min(0, "Must be 0 or more").max(10_000_000, "Too large").nullable(),
    );
    const data = parseInput(z.object({ monthlySpendLimit: optionalMoney, lowBalanceAlertAt: optionalMoney }), input);
    await db.user.update({
      where: { id: user.id },
      data: {
        // 0 / empty = no limit
        monthlySpendLimit: data.monthlySpendLimit ? toDbString(data.monthlySpendLimit) : null,
        lowBalanceAlertAt: data.lowBalanceAlertAt ? toDbString(data.lowBalanceAlertAt) : null,
      },
    });
    await invalidateGatewayConfig("users", user.id).catch(() => undefined);
    refresh();
    return { message: "Spend controls saved" };
  });
}

// --------------------------------------------------------------------------------------------
// Redeem
// --------------------------------------------------------------------------------------------

export async function redeemCodeAction(input: unknown): Promise<ActionResult<{ amount: string; balance: string }>> {
  const { code } = (input ?? {}) as { code?: unknown };
  return run("redeemCode", async (user) => {
    const parsed = parseInput(z.string().trim().min(3, "Enter a code").max(64, "That code is too long"), code);
    const rl = await rateLimit(`billing:redeem:${user.id}`, { limit: 10, windowSec: 3600 });
    if (!rl.ok) throw new ActionFail("Too many attempts. Try again later.");
    const res = await redeemCode(user.id, parsed);
    if (!res.ok) throw new ActionFail(res.error, { code: res.error });
    refresh();
    return { data: { amount: res.amount.toString(), balance: res.balance.toString() }, message: `Code redeemed - $${res.amount.toFixed(2)} added to your balance` };
  });
}
