import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { countConsecutiveFailures, maybeSendLowBalanceAlert, runAutoRecharge, triggerAutoRecharge } from "@/server/billing/auto-recharge";
import { __resetLocks, acquireLock } from "@/server/billing/locks";
import { setStripeClientForTests } from "@/server/billing/stripe";
import { balanceOf, cleanupUsers, dbAvailable, makeUser, mockStripe } from "./helpers";

const up = await dbAvailable();

const okIntent = async (params: { amount: number; metadata: Record<string, string> }) => ({
  id: `pi_${params.metadata.paymentId}`,
  status: "succeeded",
  amount: params.amount,
  amount_received: params.amount,
  currency: "usd",
  latest_charge: "ch_x",
  metadata: params.metadata,
});

const declined = () => Promise.reject(Object.assign(new Error("Your card was declined."), { code: "card_declined" }));

describe.skipIf(!up)("auto-recharge (mocked Stripe)", () => {
  let stripe: ReturnType<typeof mockStripe>;
  beforeEach(() => {
    __resetLocks();
    stripe = mockStripe();
    setStripeClientForTests(stripe);
  });
  afterEach(() => setStripeClientForTests(null));
  afterAll(async () => {
    await cleanupUsers();
    await db.$disconnect();
  });

  const lowUser = (extra: Record<string, unknown> = {}) =>
    makeUser({
      balance: "2",
      autoRechargeEnabled: true,
      autoRechargeThreshold: "5",
      autoRechargeAmount: "20",
      stripeCustomerId: `cus_ar_${Math.random().toString(36).slice(2)}`,
      defaultPaymentMethodId: "pm_ar",
      ...extra,
    });

  /** Move existing attempts out of the 5 minute retry gap (but keep them inside the 24h window). */
  const age = (userId: string) => db.payment.updateMany({ where: { userId }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });

  it("recharges the saved card off-session and credits as AUTO_RECHARGE", async () => {
    const u = await lowUser();
    stripe.paymentIntents.create.mockImplementation(okIntent);
    const out = await runAutoRecharge(u.id);
    expect(out.status).toBe("succeeded");
    expect(await balanceOf(u.id)).toBe("22.00");
    expect(stripe.paymentIntents.create.mock.calls[0][0]).toMatchObject({ amount: 2000, off_session: true, confirm: true, payment_method: "pm_ar" });
    expect((await db.ledgerEntry.findFirstOrThrow({ where: { userId: u.id } })).type).toBe("AUTO_RECHARGE");
  });

  it("only one recharge happens when triggered concurrently (per-user lock + in-flight guard)", async () => {
    const u = await lowUser();
    stripe.paymentIntents.create.mockImplementation(async (p: { amount: number; metadata: Record<string, string> }) => {
      await new Promise((r) => setTimeout(r, 60));
      return okIntent(p);
    });
    await Promise.all(Array.from({ length: 10 }, () => triggerAutoRecharge(u.id)));
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(await balanceOf(u.id)).toBe("22.00");
    // sequential triggers afterwards are no-ops too (balance is above the threshold)
    await triggerAutoRecharge(u.id);
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  });

  it("skips while another worker holds the lock", async () => {
    const u = await lowUser();
    const release = await acquireLock(`autorecharge:${u.id}`, 10_000);
    expect(await runAutoRecharge(u.id)).toEqual({ status: "skipped", reason: "locked" });
    await release!();
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("does nothing when disabled, above threshold, without a card, suspended, or Stripe is off", async () => {
    stripe.paymentIntents.create.mockImplementation(okIntent);
    expect(await runAutoRecharge((await lowUser({ autoRechargeEnabled: false })).id)).toMatchObject({ reason: "not_eligible" });
    expect(await runAutoRecharge((await lowUser({ balance: "50" })).id)).toMatchObject({ reason: "balance_ok" });
    expect(await runAutoRecharge((await lowUser({ defaultPaymentMethodId: null })).id)).toMatchObject({ reason: "no_card" });
    expect(await runAutoRecharge((await lowUser({ status: "SUSPENDED" })).id)).toMatchObject({ reason: "not_eligible" });
    setStripeClientForTests(null);
    expect(await runAutoRecharge((await lowUser()).id)).toMatchObject({ reason: "not_configured" });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("is capped at autoRechargeMaxPerDay per 24h", async () => {
    const u = await lowUser();
    stripe.paymentIntents.create.mockImplementation(okIntent);
    for (let i = 0; i < 3; i++) {
      expect((await runAutoRecharge(u.id)).status).toBe("succeeded");
      await db.user.update({ where: { id: u.id }, data: { balance: "1" } }); // usage burned it down again
      await age(u.id);
    }
    expect(await runAutoRecharge(u.id)).toEqual({ status: "skipped", reason: "daily_limit" });
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(3);
    // a payment older than 24h no longer counts
    await db.payment.updateMany({ where: { userId: u.id }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    expect((await runAutoRecharge(u.id)).status).toBe("succeeded");
  });

  it("waits a few minutes between attempts after a failure", async () => {
    const u = await lowUser();
    stripe.paymentIntents.create.mockImplementation(declined);
    expect((await runAutoRecharge(u.id)).status).toBe("failed");
    expect(await runAutoRecharge(u.id)).toEqual({ status: "skipped", reason: "cooldown" });
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  });

  it("emails on failure, and disables auto-recharge + emails after 3 consecutive failures", async () => {
    const u = await lowUser();
    const user = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    stripe.paymentIntents.create.mockImplementation(declined);

    const first = await runAutoRecharge(u.id);
    expect(first).toMatchObject({ status: "failed", disabled: false, reason: "Your card was declined." });
    expect(await db.emailOutbox.findMany({ where: { to: user.email } })).toHaveLength(1);
    expect((await db.emailOutbox.findFirstOrThrow({ where: { to: user.email } })).subject).toMatch(/Payment failed/);
    await age(u.id);

    expect(await runAutoRecharge(u.id)).toMatchObject({ status: "failed", disabled: false });
    await age(u.id);
    expect(await countConsecutiveFailures(u.id)).toBe(2);

    const third = await runAutoRecharge(u.id);
    expect(third).toMatchObject({ status: "failed", disabled: true });
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).autoRechargeEnabled).toBe(false);
    const subjects = (await db.emailOutbox.findMany({ where: { to: user.email } })).map((e) => e.subject);
    expect(subjects.some((s) => /Auto-recharge was turned off/.test(s))).toBe(true);
    expect(await db.auditLog.count({ where: { targetId: u.id, action: "billing.auto_recharge_disabled" } })).toBe(1);
    expect(await balanceOf(u.id)).toBe("2.00");

    // once the user re-enables it, the old failures don't count against them any more
    expect(await countConsecutiveFailures(u.id)).toBe(0);
  });

  it("a success resets the failure streak", async () => {
    const u = await lowUser();
    stripe.paymentIntents.create.mockImplementationOnce(declined).mockImplementationOnce(declined).mockImplementation(okIntent);
    await runAutoRecharge(u.id);
    await age(u.id);
    await runAutoRecharge(u.id);
    await age(u.id);
    expect(await countConsecutiveFailures(u.id)).toBe(2);
    expect((await runAutoRecharge(u.id)).status).toBe("succeeded");
    expect(await countConsecutiveFailures(u.id)).toBe(0);
  });

  it("treats a 3DS-required intent as a failure (no on-session customer to authenticate)", async () => {
    const u = await lowUser();
    stripe.paymentIntents.create.mockResolvedValue({ id: "pi_sca", status: "requires_action", amount: 2000, currency: "usd", metadata: {} });
    expect(await runAutoRecharge(u.id)).toMatchObject({ status: "failed" });
    expect(await balanceOf(u.id)).toBe("2.00");
  });
});

describe.skipIf(!up)("low balance alert", () => {
  beforeEach(() => __resetLocks());
  afterAll(async () => {
    await cleanupUsers();
    await db.$disconnect();
  });

  it("sends one email per crossing (24h dedupe) and only when below the level", async () => {
    const low = await makeUser({ balance: "1", autoRechargeThreshold: "5" });
    const fine = await makeUser({ balance: "100", autoRechargeThreshold: "5" });
    const email = (await db.user.findUniqueOrThrow({ where: { id: low.id } })).email;

    await maybeSendLowBalanceAlert(fine.id);
    await maybeSendLowBalanceAlert(low.id);
    await maybeSendLowBalanceAlert(low.id);
    __resetLocks(); // simulate a restart: the audit-log check still dedupes
    await maybeSendLowBalanceAlert(low.id);
    expect(await db.emailOutbox.count({ where: { to: email } })).toBe(1);
    expect(await db.emailOutbox.count({ where: { to: (await db.user.findUniqueOrThrow({ where: { id: fine.id } })).email } })).toBe(0);
  });

  it("a balance that runs out gets its own 'has run out' email, even after the low-balance one", async () => {
    const u = await makeUser({ balance: "1", autoRechargeThreshold: "5" });
    const email = (await db.user.findUniqueOrThrow({ where: { id: u.id } })).email;
    await maybeSendLowBalanceAlert(u.id);
    await db.user.update({ where: { id: u.id }, data: { balance: "-0.25" } });
    await maybeSendLowBalanceAlert(u.id);
    await maybeSendLowBalanceAlert(u.id);
    __resetLocks();
    await maybeSendLowBalanceAlert(u.id);
    const sent = await db.emailOutbox.findMany({ where: { to: email }, orderBy: { createdAt: "asc" }, select: { subject: true } });
    expect(sent.map((m) => m.subject)).toEqual([expect.stringMatching(/running low/), expect.stringMatching(/has run out/)]);
  });

  it("a zero balance is emailed even with auto-recharge on", async () => {
    const u = await makeUser({ balance: "0", autoRechargeThreshold: "5" });
    await db.user.update({ where: { id: u.id }, data: { autoRechargeEnabled: true, defaultPaymentMethodId: "pm_x" } });
    await maybeSendLowBalanceAlert(u.id);
    const sent = await db.emailOutbox.findMany({ where: { to: (await db.user.findUniqueOrThrow({ where: { id: u.id } })).email }, select: { subject: true } });
    expect(sent.map((m) => m.subject)).toEqual([expect.stringMatching(/has run out/)]);
  });

  it("uses lowBalanceAlertAt when set and never throws for unknown users", async () => {
    const u = await makeUser({ balance: "8" });
    await db.user.update({ where: { id: u.id }, data: { lowBalanceAlertAt: "10" } });
    await maybeSendLowBalanceAlert(u.id);
    expect(await db.emailOutbox.count({ where: { to: (await db.user.findUniqueOrThrow({ where: { id: u.id } })).email } })).toBe(1);
    await expect(maybeSendLowBalanceAlert("nope")).resolves.toBeUndefined();
    await expect(triggerAutoRecharge("nope")).resolves.toBeUndefined();
  });
});
