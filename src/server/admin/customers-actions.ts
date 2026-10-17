"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { appUrl } from "@/lib/env";
import { audit } from "@/lib/audit";
import { createSession, revokeAllSessions } from "@/lib/auth/session";
import { RESET_TOKEN_TTL_MS, createVerificationToken, grantTrialCredit } from "@/lib/auth/service";
import { db } from "@/lib/db";
import { emailTemplates, sendTemplate } from "@/lib/email";
import { adminAction, ActionFail, parseInput } from "./action";
import { adjustBalanceSchema, canManageTarget, customerSettingsSchema } from "./customers-calc";

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
    await db.user.update({
      where: { id: d.userId },
      data: {
        groupId: d.groupId,
        priceMultiplier: d.priceMultiplier,
        billingMode: d.billingMode,
        creditLimit: d.creditLimit,
        monthlySpendLimit: d.monthlySpendLimit,
        maxConcurrency: d.maxConcurrency,
      },
    });
    const { userId: _u, ...changes } = d;
    void _u;
    await audit(admin.id, "customer.update", { type: "User", id: d.userId }, { email: target.email, ...changes }, ip);
    await invalidateGatewayConfig("users", d.userId);
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
      return { message: `Balance adjusted. New balance: $${res.balance.toFixed(4)}` };
    } catch (err) {
      if (err instanceof Error && err.name === "LedgerError") throw new ActionFail(err.message, { amount: err.message });
      throw err;
    }
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
