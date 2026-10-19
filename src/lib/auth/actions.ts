"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { getClientIp, safeNextPath } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import {
  changePasswordSchema,
  fieldErrorsFrom,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
  totpCodeSchema,
  twoFactorCodeSchema,
  RECOVERY_CODE_RE,
  emailSchema,
} from "./schemas";
import {
  changePassword,
  completeTwoFactor,
  loginUser,
  logAuthError,
  requestEmailChange,
  requestPasswordReset,
  resendVerification,
  resetPasswordWithToken,
  signupUser,
  verifyEmailToken,
} from "./service";
import {
  createSession,
  destroyCurrentSession,
  getCurrentSessionId,
  getPendingTwoFactorSession,
  getSession,
  requireUserForAction,
  revokeOtherSessions,
  revokeSession,
} from "./session";
import { beginTotpSetup, consumeRecoveryCode, disableTotp, enableTotp, verifyUserTotp, type TotpSetup } from "./totp";
import { AuthError, type ActionResult } from "./types";

/**
 * Server actions for authentication & account security. All inputs are validated with zod; results
 * are plain serializable objects ({ ok, data?, message? } | { ok:false, error, fieldErrors? }) so
 * client forms can show inline errors and toasts. Actions never throw for expected failures.
 */

async function meta() {
  const h = await headers();
  return { ip: getClientIp(h), userAgent: h.get("user-agent") };
}

function invalid(err: z.ZodError): ActionResult<never> {
  return { ok: false, error: "Please fix the highlighted fields", fieldErrors: fieldErrorsFrom(err) };
}

function failure(error: string): ActionResult<never> {
  return { ok: false, error };
}

const GENERIC = "Something went wrong. Please try again.";

// --------------------------------------------------------------------------------------------
// Public flows
// --------------------------------------------------------------------------------------------

export async function signupAction(
  input: unknown,
): Promise<ActionResult<{ email: string; verificationRequired: boolean }>> {
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { ip, userAgent } = await meta();
  try {
    const res = await signupUser({ ...parsed.data, ip });
    if (res.kind === "disabled") return failure("Signups are currently closed.");
    if (res.kind === "rate_limited") return failure("Too many sign-up attempts. Please try again later.");
    if (res.kind === "created" && !res.verificationRequired) {
      await createSession(res.userId, { ip, userAgent });
      return { ok: true, data: { email: parsed.data.email, verificationRequired: false } };
    }
    // "created" (needs verification) and "exists" look identical to the caller.
    return { ok: true, data: { email: parsed.data.email, verificationRequired: true } };
  } catch (err) {
    logAuthError("signup", err);
    return failure(GENERIC);
  }
}

export async function loginAction(
  input: unknown,
): Promise<ActionResult<{ redirectTo?: string; requires2fa?: boolean; unverifiedEmail?: string }>> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { ip, userAgent } = await meta();
  try {
    const res = await loginUser({ email: parsed.data.email, password: parsed.data.password, ip, userAgent });
    if (res.kind === "error") {
      return res.code === "unverified"
        ? { ok: false, error: res.message, fieldErrors: { _unverified: res.email ?? "" } }
        : failure(res.message);
    }
    if (res.kind === "two_factor") {
      return { ok: true, data: { requires2fa: true, redirectTo: `/login/2fa${parsed.data.next ? `?next=${encodeURIComponent(parsed.data.next)}` : ""}` } };
    }
    const fallback = res.role === "CUSTOMER" ? "/dashboard" : "/admin";
    return { ok: true, data: { redirectTo: safeNextPath(parsed.data.next, fallback) } };
  } catch (err) {
    logAuthError("login", err);
    return failure(GENERIC);
  }
}

export async function verifyTwoFactorAction(input: unknown): Promise<ActionResult<{ redirectTo: string }>> {
  const parsed = z.object({ code: twoFactorCodeSchema, next: z.string().optional() }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const pending = await getPendingTwoFactorSession();
  if (!pending) return failure("Your login session expired. Please log in again.");
  const { ip } = await meta();
  try {
    const recovery = RECOVERY_CODE_RE.test(parsed.data.code);
    const v = recovery ? await consumeRecoveryCode(pending.user.id, parsed.data.code) : await verifyUserTotp(pending.user.id, parsed.data.code);
    if (v.rateLimited) return failure("Too many attempts. Please wait a few minutes.");
    if (!v.ok) return { ok: false, error: "Invalid code", fieldErrors: { code: "That code is incorrect or expired" } };
    if (recovery) await audit(pending.user.id, "auth.2fa_recovery_code_used", { type: "User", id: pending.user.id }, { remaining: (v as { remaining?: number }).remaining ?? null }, ip);
    await completeTwoFactor(pending.session.id, pending.user.id, ip);
    const fallback = pending.user.role === "CUSTOMER" ? "/dashboard" : "/admin";
    return { ok: true, data: { redirectTo: safeNextPath(parsed.data.next, fallback) } };
  } catch (err) {
    logAuthError("2fa", err);
    return failure(GENERIC);
  }
}

export async function logoutAction(): Promise<ActionResult> {
  try {
    const s = await getSession();
    await destroyCurrentSession();
    if (s) await audit(s.user.id, "auth.logout", { type: "User", id: s.user.id });
  } catch (err) {
    logAuthError("logout", err);
  }
  return { ok: true };
}

export async function verifyEmailAction(
  input: unknown,
): Promise<ActionResult<{ kind: "email_verified" | "email_changed"; email: string }>> {
  const parsed = z.object({ token: z.string().min(10).max(200) }).safeParse(input);
  if (!parsed.success) return failure("This verification link is invalid.");
  try {
    const res = await verifyEmailToken(parsed.data.token);
    if (!res.ok) {
      return failure(
        res.reason === "email_taken"
          ? "That email address is already in use by another account."
          : "This verification link is invalid or has expired. Request a new one.",
      );
    }
    return { ok: true, data: { kind: res.kind, email: res.email } };
  } catch (err) {
    logAuthError("verify", err);
    return failure(GENERIC);
  }
}

export async function resendVerificationAction(input: unknown): Promise<ActionResult> {
  const parsed = z.object({ email: emailSchema }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { ip } = await meta();
  try {
    const res = await resendVerification(parsed.data.email, ip);
    if (res.rateLimited) return failure("Too many requests. Please wait before trying again.");
    return { ok: true, message: "If that address needs verification, a new link is on its way." };
  } catch (err) {
    logAuthError("resend", err);
    return failure(GENERIC);
  }
}

export async function forgotPasswordAction(input: unknown): Promise<ActionResult> {
  const parsed = forgotPasswordSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { ip } = await meta();
  try {
    const res = await requestPasswordReset(parsed.data.email, ip);
    if (res.rateLimited) return failure("Too many requests. Please wait before trying again.");
    return { ok: true, message: "If an account exists for that email, a reset link is on its way." };
  } catch (err) {
    logAuthError("forgot", err);
    return failure(GENERIC);
  }
}

export async function resetPasswordAction(input: unknown): Promise<ActionResult> {
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { ip } = await meta();
  const rl = await rateLimit(`reset:ip:${ip}`, { limit: 15, windowSec: 3600 });
  if (!rl.ok) return failure("Too many attempts. Please try again later.");
  try {
    const res = await resetPasswordWithToken(parsed.data.token, parsed.data.password, ip);
    if (!res.ok) return failure("This reset link is invalid or has expired. Request a new one.");
    return { ok: true, message: "Password updated. You can now log in." };
  } catch (err) {
    logAuthError("reset", err);
    return failure(GENERIC);
  }
}

// --------------------------------------------------------------------------------------------
// Authenticated account security (Settings page uses these)
// --------------------------------------------------------------------------------------------

async function withUser<T>(fn: (s: Awaited<ReturnType<typeof requireUserForAction>>) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    const s = await requireUserForAction();
    // account security belongs to the account owner, not to staff viewing the account
    if (s.impersonatorId) return failure("Account security settings cannot be changed while impersonating.");
    return await fn(s);
  } catch (err) {
    if (err instanceof AuthError) return failure(err.message);
    logAuthError("account action", err);
    return failure(GENERIC);
  }
}

export async function changePasswordAction(input: unknown): Promise<ActionResult> {
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { ip } = await meta();
  return withUser(async (s) => {
    const res = await changePassword(s.user.id, s.session.id, parsed.data.currentPassword, parsed.data.newPassword, ip);
    if (!res.ok) return { ok: false, error: res.error, fieldErrors: { currentPassword: res.error } };
    return { ok: true, message: "Password updated. Other devices were signed out." };
  });
}

export async function requestEmailChangeAction(input: unknown): Promise<ActionResult> {
  const parsed = z.object({ newEmail: emailSchema, password: z.string().min(1, "Enter your password") }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return withUser(async (s) => {
    const res = await requestEmailChange(s.user.id, parsed.data.newEmail, parsed.data.password);
    if (!res.ok) return failure(res.error);
    return { ok: true, message: `Confirmation link sent to ${parsed.data.newEmail}.` };
  });
}

export async function beginTotpSetupAction(): Promise<ActionResult<TotpSetup>> {
  return withUser<TotpSetup>(async (s) => {
    const setup = await beginTotpSetup(s.user.id);
    if (!setup) return failure("Two-factor authentication is already enabled.");
    return { ok: true, data: setup };
  });
}

export async function enableTotpAction(input: unknown): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  const parsed = z.object({ code: totpCodeSchema }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return withUser<{ recoveryCodes: string[] }>(async (s) => {
    const codes = await enableTotp(s.user.id, parsed.data.code);
    if (!codes) return { ok: false, error: "Invalid code", fieldErrors: { code: "That code is incorrect or expired" } };
    await audit(s.user.id, "auth.2fa_enabled", { type: "User", id: s.user.id });
    return { ok: true, data: { recoveryCodes: codes }, message: "Two-factor authentication enabled." };
  });
}

export async function disableTotpAction(input: unknown): Promise<ActionResult> {
  const parsed = z.object({ password: z.string().min(1, "Enter your password"), code: totpCodeSchema }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return withUser(async (s) => {
    const ok = await disableTotp(s.user.id, parsed.data.password, parsed.data.code);
    if (!ok) return failure("Incorrect password or code");
    await audit(s.user.id, "auth.2fa_disabled", { type: "User", id: s.user.id });
    return { ok: true, message: "Two-factor authentication disabled." };
  });
}

export async function revokeSessionAction(input: unknown): Promise<ActionResult> {
  const parsed = z.object({ sessionId: z.string().min(10) }).safeParse(input);
  if (!parsed.success) return failure("Invalid session");
  return withUser(async (s) => {
    const ok = await revokeSession(s.user.id, parsed.data.sessionId);
    return ok ? { ok: true, message: "Session revoked." } : failure("Session not found");
  });
}

export async function revokeOtherSessionsAction(): Promise<ActionResult<{ count: number }>> {
  return withUser<{ count: number }>(async (s) => {
    const count = await revokeOtherSessions(s.user.id, await getCurrentSessionId());
    return { ok: true, data: { count }, message: `Signed out of ${count} other session${count === 1 ? "" : "s"}.` };
  });
}

/** Admin impersonation exit: end the impersonated session and restore the admin's own session. */
export async function stopImpersonationAction(): Promise<ActionResult<{ redirectTo: string }>> {
  const s = await getSession();
  if (!s?.impersonatorId) return failure("Not impersonating");
  const adminId = s.impersonatorId;
  const { ip, userAgent } = await meta();
  await destroyCurrentSession();
  const admin = await db.user.findUnique({ where: { id: adminId }, select: { id: true, status: true, role: true, totpEnabled: true } });
  if (!admin || admin.status !== "ACTIVE" || admin.role === "CUSTOMER") return { ok: true, data: { redirectTo: "/login" } };
  // the admin session is re-created from an impersonation cookie: with 2FA on, the code is asked again
  await createSession(admin.id, { ip, userAgent, twoFactorPassed: !admin.totpEnabled });
  await audit(admin.id, "admin.impersonation_stop", { type: "User", id: s.user.id }, {}, ip);
  const back = `/admin/customers/${s.user.id}`;
  return { ok: true, data: { redirectTo: admin.totpEnabled ? `/login/2fa?next=${encodeURIComponent(back)}` : back } };
}
