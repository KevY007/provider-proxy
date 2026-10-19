import { db } from "@/lib/db";
import { appUrl, env } from "@/lib/env";
import { randomToken, sha256 } from "@/lib/crypto";
import { emailTemplates, sendTemplate } from "@/lib/email";
import { logger } from "@/lib/logger";
import { Decimal, toDbString, toDecimal } from "@/lib/money";
import { rateLimit, resetRateLimit } from "@/lib/ratelimit";
import { getSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";
import type { TokenType } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import { burnPasswordCheck, hashPassword, verifyPassword } from "./password";
import { createSession, revokeAllSessions, revokeOtherSessions } from "./session";

/**
 * Auth business logic. These functions call cookies() via createSession, so invoke them only from
 * server actions or route handlers (see ./actions.ts for the zod-validated action wrappers).
 */

const HOUR = 60 * 60 * 1000;
export const VERIFY_TOKEN_TTL_MS = 24 * HOUR;
export const RESET_TOKEN_TTL_MS = 1 * HOUR;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// --------------------------------------------------------------------------------------------
// Tokens
// --------------------------------------------------------------------------------------------

/** Create a single-use token (previous unused tokens of the same type for the user are discarded). Returns the raw token. */
export async function createVerificationToken(
  userId: string,
  type: TokenType,
  ttlMs: number,
  newEmail?: string,
): Promise<string> {
  const token = randomToken(32);
  await db.$transaction([
    db.verificationToken.deleteMany({ where: { userId, type, usedAt: null } }),
    db.verificationToken.create({
      data: { userId, type, tokenHash: sha256(token), newEmail: newEmail ?? null, expiresAt: new Date(Date.now() + ttlMs) },
    }),
  ]);
  return token;
}

async function findValidToken(token: string, type: TokenType) {
  const row = await db.verificationToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.type !== type || row.usedAt || row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

// --------------------------------------------------------------------------------------------
// Trial credit
// --------------------------------------------------------------------------------------------

export interface TrialGrantResult {
  granted: boolean;
  amount?: Decimal;
  reason?: "no_trial_configured" | "already_granted" | "user_not_active" | "not_found";
}

/**
 * Grant `settings.trialCredit` as a TRIAL_CREDIT ledger entry, at most once per user (trialGrantedAt).
 * Idempotent and safe to call from anywhere (e.g. Billing after a card is attached when
 * `requireCardForTrial` is on). Row-locks the user for the balance update.
 */
export async function grantTrialCredit(userId: string): Promise<TrialGrantResult> {
  const { trialCredit } = await getSettings();
  const amount = toDecimal(trialCredit);
  if (!amount.gt(0)) return { granted: false, reason: "no_trial_configured" };

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ trialGrantedAt: Date | null; status: string }>>(
      Prisma.sql`SELECT "trialGrantedAt", "status"::text AS "status" FROM "User" WHERE "id" = ${userId} FOR UPDATE`,
    );
    const row = rows[0];
    if (!row) return { granted: false, reason: "not_found" as const };
    if (row.trialGrantedAt) return { granted: false, reason: "already_granted" as const };
    if (row.status !== "ACTIVE") return { granted: false, reason: "user_not_active" as const };
    const updated = await tx.user.update({
      where: { id: userId },
      data: { balance: { increment: toDbString(amount) }, trialGrantedAt: new Date() },
      select: { balance: true },
    });
    await tx.ledgerEntry.create({
      data: {
        userId,
        type: "TRIAL_CREDIT",
        amount: toDbString(amount),
        balanceAfter: updated.balance,
        description: "Trial credit",
      },
    });
    return { granted: true, amount };
  });
}

// --------------------------------------------------------------------------------------------
// Signup / verification
// --------------------------------------------------------------------------------------------

export type SignupOutcome =
  | { kind: "created"; userId: string; verificationRequired: boolean }
  | { kind: "exists" }
  | { kind: "disabled" }
  | { kind: "rate_limited"; retryAfterSec: number };

export async function sendVerificationEmail(userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } });
  if (!user) return;
  const token = await createVerificationToken(user.id, "EMAIL_VERIFY", VERIFY_TOKEN_TTL_MS);
  await sendTemplate(user.email, emailTemplates.verifyEmail({ name: user.name, url: `${appUrl}/verify-email?token=${token}` }));
}

export async function signupUser(input: {
  email: string;
  password: string;
  name?: string | null;
  ip: string;
}): Promise<SignupOutcome> {
  const email = normalizeEmail(input.email);
  const settings = await getSettings();

  const rl = await rateLimit(`signup:ip:${input.ip}`, { limit: 10, windowSec: 3600 });
  if (!rl.ok) return { kind: "rate_limited", retryAfterSec: rl.retryAfterSec };

  const existingCount = await db.user.count();
  const isAdminEmail = !!env.ADMIN_EMAIL && normalizeEmail(env.ADMIN_EMAIL) === email;
  // The very first account and the ADMIN_EMAIL account are always allowed, even with signups closed.
  const bootstrap = existingCount === 0 || isAdminEmail;
  if (!settings.signupEnabled && !bootstrap) return { kind: "disabled" };

  const existing = await db.user.findUnique({ where: { email }, select: { id: true, name: true } });
  if (existing) {
    // Don't reveal that the email is registered; tell the owner instead.
    await sendTemplate(email, emailTemplates.accountExists({ name: existing.name }));
    return { kind: "exists" };
  }

  const group =
    (await db.group.findUnique({ where: { slug: settings.defaultGroupSlug }, select: { id: true } })) ??
    (await db.group.findFirst({ where: { isDefault: true }, select: { id: true } }));

  const role = bootstrap ? "ADMIN" : "CUSTOMER";
  // ADMIN_EMAIL accounts must always verify their email (prevents squatting the admin address).
  const needsVerification = settings.requireEmailVerification || isAdminEmail;

  let userId: string;
  try {
    const user = await db.user.create({
      data: {
        email,
        name: input.name?.trim() || null,
        passwordHash: await hashPassword(input.password),
        role,
        status: needsVerification ? "PENDING_VERIFICATION" : "ACTIVE",
        emailVerifiedAt: needsVerification ? null : new Date(),
        groupId: group?.id ?? null,
        signupIp: input.ip === "unknown" ? null : input.ip,
      },
      select: { id: true },
    });
    userId = user.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { kind: "exists" };
    throw err;
  }

  await audit(userId, "auth.signup", { type: "User", id: userId }, { role }, input.ip);

  if (needsVerification) {
    await sendVerificationEmail(userId);
  } else {
    if (!settings.requireCardForTrial) await grantTrialCredit(userId);
    await sendTemplate(email, emailTemplates.welcome({ name: input.name }));
  }
  return { kind: "created", userId, verificationRequired: needsVerification };
}

export type VerifyOutcome =
  | { ok: true; kind: "email_verified" | "email_changed"; email: string }
  | { ok: false; reason: "invalid" | "email_taken" };

/** Consume an EMAIL_VERIFY or EMAIL_CHANGE token. On verify: status ACTIVE, trial credit granted, welcome mail sent. */
export async function verifyEmailToken(token: string): Promise<VerifyOutcome> {
  const hash = sha256(token);
  const row = await db.verificationToken.findUnique({ where: { tokenHash: hash }, include: { user: true } });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now() || (row.type !== "EMAIL_VERIFY" && row.type !== "EMAIL_CHANGE")) {
    return { ok: false, reason: "invalid" };
  }

  // Atomically claim the token so double-clicks / scanners can't use it twice.
  const claimed = await db.verificationToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count === 0) return { ok: false, reason: "invalid" };

  if (row.type === "EMAIL_CHANGE") {
    const newEmail = row.newEmail ? normalizeEmail(row.newEmail) : null;
    if (!newEmail) return { ok: false, reason: "invalid" };
    try {
      await db.user.update({ where: { id: row.userId }, data: { email: newEmail, emailVerifiedAt: new Date() } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, reason: "email_taken" };
      throw err;
    }
    // the account moved: sessions and links issued for the old address end here
    await revokeAllSessions(row.userId);
    await db.verificationToken.deleteMany({ where: { userId: row.userId, usedAt: null, type: { in: ["PASSWORD_RESET", "EMAIL_CHANGE"] } } });
    await audit(row.userId, "auth.email_change", { type: "User", id: row.userId }, { to: newEmail });
    return { ok: true, kind: "email_changed", email: newEmail };
  }

  const wasPending = row.user.status === "PENDING_VERIFICATION";
  await db.user.update({
    where: { id: row.userId },
    data: {
      emailVerifiedAt: row.user.emailVerifiedAt ?? new Date(),
      status: wasPending ? "ACTIVE" : row.user.status,
    },
  });
  await audit(row.userId, "auth.email_verified", { type: "User", id: row.userId });
  if (wasPending) {
    const settings = await getSettings();
    if (!settings.requireCardForTrial) await grantTrialCredit(row.userId);
    await sendTemplate(row.user.email, emailTemplates.welcome({ name: row.user.name }));
  }
  return { ok: true, kind: "email_verified", email: row.user.email };
}

/** Re-send the verification email. Always "succeeds" from the caller's view (no account enumeration). */
export async function resendVerification(emailRaw: string, ip: string): Promise<{ rateLimited: boolean; retryAfterSec: number }> {
  const email = normalizeEmail(emailRaw);
  const [a, b] = await Promise.all([
    rateLimit(`resend:email:${email}`, { limit: 3, windowSec: 3600 }),
    rateLimit(`resend:ip:${ip}`, { limit: 10, windowSec: 3600 }),
  ]);
  if (!a.ok || !b.ok) return { rateLimited: true, retryAfterSec: Math.max(a.retryAfterSec, b.retryAfterSec) };
  const user = await db.user.findUnique({ where: { email }, select: { id: true, status: true } });
  if (user && user.status === "PENDING_VERIFICATION") await sendVerificationEmail(user.id);
  return { rateLimited: false, retryAfterSec: 0 };
}

/** Start an email change: verifies the password, mails a confirmation link to the NEW address. */
export async function requestEmailChange(
  userId: string,
  newEmailRaw: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const newEmail = normalizeEmail(newEmailRaw);
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, error: "Account not found" };
  if (!(await verifyPassword(user.passwordHash, password))) return { ok: false, error: "Incorrect password" };
  if (newEmail === user.email) return { ok: false, error: "That is already your email address" };
  const rl = await rateLimit(`emailchange:${userId}`, { limit: 5, windowSec: 3600 });
  if (!rl.ok) return { ok: false, error: "Too many attempts. Try again later." };
  const taken = await db.user.findUnique({ where: { email: newEmail }, select: { id: true } });
  // (same answer as success: whether an address is registered is not disclosed; the confirmation would fail anyway)
  if (taken) return { ok: true };
  const token = await createVerificationToken(userId, "EMAIL_CHANGE", VERIFY_TOKEN_TTL_MS, newEmail);
  await sendTemplate(newEmail, emailTemplates.emailChange({ name: user.name, newEmail, url: `${appUrl}/verify-email?token=${token}` }));
  // the owner of the current address hears about it (a hijacked session cannot move the account silently)
  await sendTemplate(user.email, emailTemplates.emailChangeNotice({ name: user.name, newEmail })).catch(() => undefined);
  return { ok: true };
}

// --------------------------------------------------------------------------------------------
// Login
// --------------------------------------------------------------------------------------------

export type LoginOutcome =
  | { kind: "ok"; role: "CUSTOMER" | "SUPPORT" | "ADMIN" }
  | { kind: "two_factor" }
  | { kind: "error"; code: "invalid" | "unverified" | "suspended" | "rate_limited"; message: string; email?: string };

const INVALID: LoginOutcome = { kind: "error", code: "invalid", message: "Invalid email or password" };

export async function loginUser(input: {
  email: string;
  password: string;
  ip: string;
  userAgent: string | null;
}): Promise<LoginOutcome> {
  const email = normalizeEmail(input.email);

  const [byIp, byPair, byAccount] = await Promise.all([
    rateLimit(`login:ip:${input.ip}`, { limit: 40, windowSec: 600 }),
    rateLimit(`login:pair:${input.ip}:${email}`, { limit: 8, windowSec: 900 }),
    // per account, whatever the source address (rotating IPs must not give unlimited guesses)
    rateLimit(`login:email:${email}`, { limit: 30, windowSec: 3600 }),
  ]);
  if (!byIp.ok || !byPair.ok || !byAccount.ok) {
    const wait = Math.max(byIp.retryAfterSec, byPair.retryAfterSec, byAccount.retryAfterSec);
    return { kind: "error", code: "rate_limited", message: `Too many attempts. Try again in ${Math.max(1, Math.ceil(wait / 60))} min.` };
  }

  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    await burnPasswordCheck(input.password);
    return INVALID;
  }
  if (!(await verifyPassword(user.passwordHash, input.password))) return INVALID;

  // Credentials are correct from here on, so specific states can be disclosed.
  if (user.status === "SUSPENDED") {
    return { kind: "error", code: "suspended", message: "This account is suspended. Contact support." };
  }
  if (user.status === "PENDING_VERIFICATION") {
    const { requireEmailVerification } = await getSettings();
    if (requireEmailVerification || user.role !== "CUSTOMER") {
      return { kind: "error", code: "unverified", message: "Please verify your email address before logging in.", email: user.email };
    }
    await db.user.update({ where: { id: user.id }, data: { status: "ACTIVE" } });
  }

  await resetRateLimit(`login:pair:${input.ip}:${email}`);

  if (user.totpEnabled) {
    await createSession(user.id, { ip: input.ip, userAgent: input.userAgent, twoFactorPassed: false });
    return { kind: "two_factor" };
  }

  await createSession(user.id, { ip: input.ip, userAgent: input.userAgent });
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit(user.id, "auth.login", { type: "User", id: user.id }, {}, input.ip);
  return { kind: "ok", role: user.role };
}

/** Mark the current half-open session as fully authenticated (after a valid TOTP code). */
export async function completeTwoFactor(sessionId: string, userId: string, ip: string): Promise<void> {
  await db.session.update({ where: { id: sessionId }, data: { twoFactorPassed: true } });
  await db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  await audit(userId, "auth.login", { type: "User", id: userId }, { twoFactor: true }, ip);
}

// --------------------------------------------------------------------------------------------
// Password reset / change
// --------------------------------------------------------------------------------------------

export async function requestPasswordReset(emailRaw: string, ip: string): Promise<{ rateLimited: boolean }> {
  const email = normalizeEmail(emailRaw);
  const [a, b] = await Promise.all([
    rateLimit(`forgot:email:${email}`, { limit: 3, windowSec: 3600 }),
    rateLimit(`forgot:ip:${ip}`, { limit: 10, windowSec: 3600 }),
  ]);
  if (!a.ok || !b.ok) return { rateLimited: true };
  const user = await db.user.findUnique({ where: { email }, select: { id: true, name: true, email: true, status: true } });
  if (user && user.status !== "SUSPENDED") {
    const token = await createVerificationToken(user.id, "PASSWORD_RESET", RESET_TOKEN_TTL_MS);
    await sendTemplate(user.email, emailTemplates.resetPassword({ name: user.name, url: `${appUrl}/reset-password?token=${token}` }));
    await audit(user.id, "auth.password_reset_requested", { type: "User", id: user.id }, {}, ip);
  }
  return { rateLimited: false };
}

/** Validate a reset token without consuming it (for the reset page). */
export async function isResetTokenValid(token: string): Promise<boolean> {
  return !!(await findValidToken(token, "PASSWORD_RESET"));
}

export async function resetPasswordWithToken(token: string, newPassword: string, ip: string): Promise<{ ok: boolean }> {
  const row = await findValidToken(token, "PASSWORD_RESET");
  if (!row) return { ok: false };
  const claimed = await db.verificationToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count === 0) return { ok: false };
  await db.user.update({ where: { id: row.userId }, data: { passwordHash: await hashPassword(newPassword) } });
  await revokeAllSessions(row.userId);
  await db.verificationToken.deleteMany({ where: { userId: row.userId, usedAt: null, type: { in: ["PASSWORD_RESET", "EMAIL_CHANGE"] } } });
  await audit(row.userId, "auth.password_reset", { type: "User", id: row.userId }, {}, ip);
  return { ok: true };
}

/** Change password for a logged-in user; revokes every other session. */
export async function changePassword(
  userId: string,
  currentSessionId: string,
  currentPassword: string,
  newPassword: string,
  ip: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rl = await rateLimit(`chpw:${userId}`, { limit: 6, windowSec: 900 });
  if (!rl.ok) return { ok: false, error: "Too many attempts. Try again later." };
  const user = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) return { ok: false, error: "Current password is incorrect" };
  await db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } });
  await revokeOtherSessions(userId, currentSessionId);
  await db.verificationToken.deleteMany({ where: { userId, usedAt: null, type: { in: ["PASSWORD_RESET", "EMAIL_CHANGE"] } } });
  await audit(userId, "auth.password_change", { type: "User", id: userId }, {}, ip);
  return { ok: true };
}

/** Log (and swallow) unexpected failures so actions can return a friendly generic error. */
export function logAuthError(where: string, err: unknown) {
  logger.error(`auth: ${where} failed`, { err });
}
