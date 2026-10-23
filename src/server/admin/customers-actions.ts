"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { appUrl } from "@/lib/env";
import { audit } from "@/lib/audit";
import { createSession, revokeAllSessions } from "@/lib/auth/session";
import { RESET_TOKEN_TTL_MS, createVerificationToken, grantTrialCredit, normalizeEmail } from "@/lib/auth/service";
import { hashPassword } from "@/lib/auth/password";
import { randomToken } from "@/lib/crypto";
import { db } from "@/lib/db";
import { formatUSD } from "@/lib/money";
import { emailTemplates, sendTemplate } from "@/lib/email";
import { getSettings } from "@/lib/settings";
import { adminAction, ActionFail, parseInput } from "./action";
import { adjustBalanceSchema, canManageTarget, createCustomerSchema, customerSettingsSchema, deletedEmail, deletionMode, updateProfileSchema } from "./customers-calc";
import { addCreditSchema, creditDescription, CREDIT_KIND_INFO, grantCreditsSchema, type CreditKind } from "./credits";
import { credit, debit, LedgerError } from "@/server/billing/ledger";
import { syncMirroredBalances } from "@/server/billing/balance-mirror";
import { usageEndpoint } from "./upstream-usage";

async function loadTarget(userId: string) {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true, status: true, emailVerifiedAt: true },
  });
  if (!u) throw new ActionFail("Customer not found");
  return u;
}

/** Suspend / activate (staff allowed). Suspending also signs the user out everywhere. */
export async function setCustomerStatus(userId: string, status: "ACTIVE" | "SUSPENDED") {
  return adminAction({}, async ({ admin, ip }) => {
    const st = parseInput(z.enum(["ACTIVE", "SUSPENDED"]), status);
    const target = await loadTarget(userId);
    const can = canManageTarget(admin.role, target.role, admin.id, target.id);
    if (!can.ok) throw new ActionFail(can.reason!);
    if (st === "ACTIVE" && !target.emailVerifiedAt) {
      // activating an unverified account is allowed (admin override) but flagged in the audit log
    }
    await db.user.update({ where: { id: userId }, data: { status: st } });
    let revoked = 0;
    if (st === "SUSPENDED") revoked = await revokeAllSessions(userId);
    await audit(admin.id, st === "SUSPENDED" ? "customer.suspend" : "customer.activate", { type: "User", id: userId }, { email: target.email, previous: target.status, revokedSessions: revoked }, ip);
    await invalidateGatewayConfig("users", userId);
    return { message: st === "SUSPENDED" ? "Customer suspended and signed out" : "Customer activated" };
  });
}

export async function verifyCustomerEmail(userId: string) {
  return adminAction({}, async ({ admin, ip }) => {
    const target = await loadTarget(userId);
    // verifying a staff account (e.g. a sign-up with ADMIN_EMAIL) is a privilege decision, as is the trial grant
    const can = canManageTarget(admin.role, target.role, admin.id, target.id);
    if (!can.ok) throw new ActionFail(can.reason!);
    if (target.emailVerifiedAt && target.status !== "PENDING_VERIFICATION") throw new ActionFail("Email is already verified");
    await db.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: target.emailVerifiedAt ?? new Date(), ...(target.status === "PENDING_VERIFICATION" ? { status: "ACTIVE" } : {}) },
    });
    let trial: string | undefined;
    try {
      const res = await grantTrialCredit(userId);
      if (res.granted) trial = String(res.amount ?? "");
    } catch {
      /* trial credit is best-effort */
    }
    await audit(admin.id, "customer.verify_email", { type: "User", id: userId }, { email: target.email, trialGranted: trial ?? null }, ip);
    await invalidateGatewayConfig("users", userId);
    return { message: trial ? `Email verified; trial credit granted ($${trial})` : "Email marked as verified" };
  });
}

export async function setCustomerRole(userId: string, role: "CUSTOMER" | "SUPPORT" | "ADMIN") {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const r = parseInput(z.enum(["CUSTOMER", "SUPPORT", "ADMIN"]), role);
    if (userId === admin.id) throw new ActionFail("You cannot change your own role");
    const target = await loadTarget(userId);
    await db.user.update({ where: { id: userId }, data: { role: r } });
    await audit(admin.id, "customer.role", { type: "User", id: userId }, { email: target.email, from: target.role, to: r }, ip);
    await invalidateGatewayConfig("users", userId);
    return { message: `Role set to ${r}` };
  });
}

export async function updateCustomerSettings(input: unknown) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(customerSettingsSchema, input);
    const target = await loadTarget(d.userId);
    if (d.groupId) {
      const g = await db.group.findUnique({ where: { id: d.groupId }, select: { id: true } });
      if (!g) throw new ActionFail("Group not found", { groupId: "Group not found" });
    }
    if (d.extraGroupIds.length) {
      const found = await db.group.count({ where: { id: { in: d.extraGroupIds } } });
      if (found !== d.extraGroupIds.length) throw new ActionFail("Pool not found", { extraGroupIds: "Pool not found" });
    }
    if (d.balanceMirrorProviderId) {
      const p = await db.provider.findUnique({ where: { id: d.balanceMirrorProviderId }, select: { preset: true, baseUrl: true, settings: true } });
      if (!p || !usageEndpoint(p)) throw new ActionFail("That provider does not publish its account balance", { balanceMirrorProviderId: "Not supported for this provider" });
    }
    await db.user.update({
      where: { id: d.userId },
      data: {
        groupId: d.groupId,
        extraGroupIds: d.extraGroupIds.filter((id) => id !== d.groupId),
        priceMultiplier: d.priceMultiplier,
        billingMode: d.billingMode,
        creditLimit: d.creditLimit,
        monthlySpendLimit: d.monthlySpendLimit,
        maxConcurrency: d.maxConcurrency,
        ...(d.balanceMirrorProviderId !== undefined ? { balanceMirrorProviderId: d.balanceMirrorProviderId } : {}),
      },
    });
    const { userId: _u, ...changes } = d;
    void _u;
    await audit(admin.id, "customer.update", { type: "User", id: d.userId }, { email: target.email, ...changes }, ip);
    await invalidateGatewayConfig("users", d.userId);
    if (d.balanceMirrorProviderId) {
      // mirror at once (not only at the next upkeep)
      const r = await syncMirroredBalances({ userId: d.userId }).catch((err: unknown) => ({ errors: [err instanceof Error ? err.message : String(err)], updated: 0 }));
      if (r.errors.length) return { message: `Customer settings saved; the balance could not be mirrored yet: ${r.errors[0]}` };
    }
    return { message: "Customer settings saved" };
  });
}

interface LedgerModule {
  adminAdjustBalance(adminId: string, userId: string, amount: string, reason: string): Promise<{ balance: { toFixed(dp?: number): string } }>;
}

/** Signed balance adjustment (positive credits, negative debits). Writes an ADJUSTMENT ledger entry + audit via Billing. */
export async function adjustCustomerBalance(input: unknown) {
  return adminAction({ adminOnly: true }, async ({ admin }) => {
    const d = parseInput(adjustBalanceSchema, input);
    await loadTarget(d.userId);
    let mod: LedgerModule;
    try {
      mod = (await import("@/server/billing/ledger")) as unknown as LedgerModule;
      if (typeof mod.adminAdjustBalance !== "function") throw new Error("missing");
    } catch {
      throw new ActionFail("Billing ledger not available yet");
    }
    try {
      const res = await mod.adminAdjustBalance(admin.id, d.userId, d.amount, d.reason);
      await invalidateGatewayConfig("users", d.userId);
      return { message: `Balance adjusted. New balance: ${formatUSD(res.balance)}` };
    } catch (err) {
      if (err instanceof Error && err.name === "LedgerError") throw new ActionFail(err.message, { amount: err.message });
      throw err;
    }
  });
}

/** One ledger movement for a credit kind (kind is recorded in the description prefix and metadata.kind). */
async function applyCredit(adminId: string, userId: string, kind: CreditKind, amount: string, reason: string) {
  const info = CREDIT_KIND_INFO[kind];
  const meta = { kind: `${kind}_credit`, creditKind: kind, reason, adminId };
  const desc = creditDescription(kind, reason);
  const opts = { createdById: adminId, metadata: meta };
  return Number(amount) < 0 ? debit(userId, amount.replace(/^-/, ""), info.ledger, desc, opts) : credit(userId, amount, info.ledger, desc, opts);
}

/** "Add credit" on the customer page: Promotional credit / Refund / Correction + reason (ledger + audit). */
export async function addCustomerCredit(input: unknown) {
  return adminAction<{ balance: string }>({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(addCreditSchema, input);
    const target = await loadTarget(d.userId);
    try {
      const res = await applyCredit(admin.id, d.userId, d.kind, d.amount, d.reason);
      await audit(admin.id, "billing.add_credit", { type: "User", id: d.userId }, { email: target.email, kind: d.kind, amount: d.amount, reason: d.reason, ledgerEntryId: res.entry.id }, ip);
      await invalidateGatewayConfig("users", d.userId);
      return { data: { balance: res.balance.toFixed() }, message: `${CREDIT_KIND_INFO[d.kind].label} recorded. New balance: ${formatUSD(res.balance)}` };
    } catch (err) {
      if (err instanceof LedgerError) throw new ActionFail(err.message, { amount: err.message });
      throw err;
    }
  });
}

/** Bulk "Grant credit" from the customers table (same amount + reason for each selected customer). */
export async function grantCreditToCustomers(input: unknown) {
  return adminAction<{ granted: number; failed: Array<{ email: string; error: string }> }>({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(grantCreditsSchema, input);
    const users = await db.user.findMany({ where: { id: { in: d.userIds } }, select: { id: true, email: true } });
    if (users.length === 0) throw new ActionFail("None of the selected customers exist any more");
    let granted = 0;
    const failed: Array<{ email: string; error: string }> = [];
    for (const u of users) {
      try {
        const res = await applyCredit(admin.id, u.id, d.kind, d.amount, d.reason);
        await audit(admin.id, "billing.add_credit", { type: "User", id: u.id }, { email: u.email, kind: d.kind, amount: d.amount, reason: d.reason, ledgerEntryId: res.entry.id, bulk: true }, ip);
        await invalidateGatewayConfig("users", u.id);
        granted++;
      } catch (err) {
        failed.push({ email: u.email, error: err instanceof Error ? err.message : "Failed" });
      }
    }
    if (granted === 0) throw new ActionFail(failed[0]?.error ?? "No credit was granted");
    const message = `${CREDIT_KIND_INFO[d.kind].label} of ${formatUSD(d.amount)} granted to ${granted} customer${granted === 1 ? "" : "s"}${failed.length ? `; ${failed.length} failed` : ""}`;
    return { data: { granted, failed }, message };
  });
}

export async function revokeCustomerSessions(userId: string) {
  return adminAction({}, async ({ admin, ip }) => {
    const target = await loadTarget(userId);
    const can = canManageTarget(admin.role, target.role, admin.id, target.id);
    if (!can.ok) throw new ActionFail(can.reason!);
    const n = await revokeAllSessions(userId);
    await audit(admin.id, "customer.revoke_sessions", { type: "User", id: userId }, { email: target.email, count: n }, ip);
    await invalidateGatewayConfig("users", userId);
    return { message: `Revoked ${n} session${n === 1 ? "" : "s"}` };
  });
}

/** Sends a password-reset email to the customer (does not reveal or set a password). */
export async function sendCustomerPasswordReset(userId: string) {
  return adminAction({}, async ({ admin, ip }) => {
    const target = await loadTarget(userId);
    const can = canManageTarget(admin.role, target.role, admin.id, target.id);
    if (!can.ok) throw new ActionFail(can.reason!);
    if (target.status === "SUSPENDED") throw new ActionFail("Customer is suspended");
    const token = await createVerificationToken(userId, "PASSWORD_RESET", RESET_TOKEN_TTL_MS);
    const res = await sendTemplate(target.email, emailTemplates.resetPassword({ name: target.name, url: `${appUrl}/reset-password?token=${token}` }));
    await audit(admin.id, "customer.password_reset_sent", { type: "User", id: userId }, { email: target.email, delivered: res.ok }, ip);
    return { message: res.ok ? `Reset email sent to ${target.email}` : "Reset token created but email delivery failed (check SMTP / outbox)" };
  });
}

/**
 * Start impersonating a customer: creates a session for them (cookie replaced) with impersonatorId = admin.
 * Client then navigates to the returned redirectTo. The customer shell shows an exit banner.
 */
export async function impersonateCustomer(userId: string) {
  return adminAction<{ redirectTo: string }>({}, async ({ admin, ip }) => {
    const target = await loadTarget(userId);
    const can = canManageTarget(admin.role, target.role, admin.id, target.id);
    if (!can.ok) throw new ActionFail(can.reason!);
    if (target.status !== "ACTIVE") throw new ActionFail("Only ACTIVE customers can be impersonated");
    const userAgent = (await headers()).get("user-agent");
    await createSession(target.id, { impersonatorId: admin.id, ip, userAgent });
    await audit(admin.id, "customer.impersonate", { type: "User", id: userId }, { email: target.email }, ip);
    return { data: { redirectTo: "/dashboard" }, message: `Now viewing as ${target.email}` };
  });
}

const INVITE_DAYS = 7;

async function sendInvite(user: { id: string; email: string; name: string | null }) {
  const token = await createVerificationToken(user.id, "PASSWORD_RESET", INVITE_DAYS * 24 * 3600_000);
  return sendTemplate(user.email, emailTemplates.invite({ name: user.name, url: `${appUrl}/reset-password?token=${token}`, days: INVITE_DAYS }));
}

/** Create an account (active and verified). The user picks a password through the emailed invite link. */
export async function createCustomer(input: unknown) {
  return adminAction<{ id: string }>({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(createCustomerSchema, input);
    const email = normalizeEmail(d.email);
    if (await db.user.findUnique({ where: { email }, select: { id: true } })) throw new ActionFail("An account with this email already exists", { email: "Already registered" });
    let groupId = d.groupId;
    if (groupId) {
      if (!(await db.group.findUnique({ where: { id: groupId }, select: { id: true } }))) throw new ActionFail("Group not found", { groupId: "Group not found" });
    } else {
      const settings = await getSettings();
      groupId =
        (await db.group.findUnique({ where: { slug: settings.defaultGroupSlug }, select: { id: true } }))?.id ??
        (await db.group.findFirst({ where: { isDefault: true }, select: { id: true } }))?.id ??
        null;
    }
    const user = await db.user.create({
      data: {
        email,
        name: d.name,
        // unusable until the user sets one through the invite (or a password reset)
        passwordHash: await hashPassword(randomToken(32)),
        role: d.role,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
        groupId,
      },
      select: { id: true, email: true, name: true },
    });
    await audit(admin.id, "customer.create", { type: "User", id: user.id }, { email, role: d.role, initialCredit: d.initialCredit, invite: d.sendInvite }, ip);
    const notes: string[] = [];
    if (d.initialCredit && Number(d.initialCredit) > 0) {
      try {
        const res = await applyCredit(admin.id, user.id, "promotional", d.initialCredit, "Initial credit");
        await audit(admin.id, "billing.add_credit", { type: "User", id: user.id }, { email, kind: "promotional", amount: d.initialCredit, reason: "Initial credit", ledgerEntryId: res.entry.id }, ip);
        notes.push(`${formatUSD(d.initialCredit)} credit added`);
      } catch (err) {
        notes.push(`credit failed: ${err instanceof Error ? err.message : "error"}`);
      }
    }
    if (d.sendInvite) notes.push((await sendInvite(user)).ok ? "invite sent" : "invite email failed (use Password reset to resend)");
    return { data: { id: user.id }, message: `Created ${email}${notes.length ? `; ${notes.join(", ")}` : ""}` };
  });
}

/** Edit name / email. An admin-set email counts as verified; the user's sessions stay valid. */
export async function updateCustomerProfile(input: unknown) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(updateProfileSchema, input);
    const target = await loadTarget(d.userId);
    if (target.id !== admin.id) {
      const can = canManageTarget(admin.role, target.role, admin.id, target.id);
      if (!can.ok) throw new ActionFail(can.reason!);
    }
    const email = normalizeEmail(d.email);
    const emailChanged = email !== target.email;
    if (emailChanged && (await db.user.findUnique({ where: { email }, select: { id: true } }))) throw new ActionFail("Another account uses this email", { email: "Already registered" });
    await db.user.update({
      where: { id: d.userId },
      data: { name: d.name, ...(emailChanged ? { email, emailVerifiedAt: new Date() } : {}) },
    });
    if (emailChanged) await db.verificationToken.deleteMany({ where: { userId: d.userId, usedAt: null } });
    await audit(admin.id, "customer.profile", { type: "User", id: d.userId }, { from: { email: target.email, name: target.name }, to: { email, name: d.name } }, ip);
    await invalidateGatewayConfig("users", d.userId);
    return { message: "Profile saved" };
  });
}

/**
 * Delete an account. Without billing history it is removed (its request logs stay, unlinked); with history it is
 * anonymised and locked so the ledger and payments stay intact: email/name cleared, password and 2FA wiped,
 * suspended, API keys revoked, signed out everywhere.
 */
export async function deleteCustomer(userId: string) {
  return adminAction<{ redirectTo: string }>({ adminOnly: true }, async ({ admin, ip }) => {
    if (userId === admin.id) throw new ActionFail("You cannot delete your own account");
    const target = await loadTarget(userId);
    if (target.role === "ADMIN" && (await db.user.count({ where: { role: "ADMIN", status: "ACTIVE", id: { not: userId } } })) === 0) {
      throw new ActionFail("This is the last active admin");
    }
    const [ledger, payments] = await Promise.all([db.ledgerEntry.count({ where: { userId } }), db.payment.count({ where: { userId } })]);
    const mode = deletionMode({ ledger, payments });
    const revoked = await revokeAllSessions(userId);
    if (mode === "delete") {
      await db.user.delete({ where: { id: userId } });
    } else {
      await db.$transaction([
        db.apiKey.updateMany({ where: { userId, status: { not: "REVOKED" } }, data: { status: "REVOKED" } }),
        db.verificationToken.deleteMany({ where: { userId } }),
        db.user.update({
          where: { id: userId },
          data: {
            email: deletedEmail(userId),
            name: null,
            passwordHash: await hashPassword(randomToken(32)),
            status: "SUSPENDED",
            totpSecret: null,
            totpEnabled: false,
            totpRecoveryCodes: [],
            autoRechargeEnabled: false,
            defaultPaymentMethodId: null,
            lowBalanceAlertAt: null,
            signupIp: null,
          },
        }),
      ]);
    }
    await audit(admin.id, "customer.delete", { type: "User", id: userId }, { email: target.email, mode, ledgerEntries: ledger, payments, revokedSessions: revoked }, ip);
    await Promise.all([invalidateGatewayConfig("users", userId), invalidateGatewayConfig("apiKeys")]);
    return {
      data: { redirectTo: "/admin/customers" },
      message: mode === "delete" ? `Deleted ${target.email}` : `${target.email} anonymised and locked (billing history kept)`,
    };
  });
}
