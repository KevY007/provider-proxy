import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";
import { rateLimit } from "@/lib/ratelimit";
import { verifyPassword } from "./password";

async function buildTotp(secretBase32: string, label: string) {
  const issuer = await getSetting("siteName");
  return new OTPAuth.TOTP({
    issuer,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

/** Validate a 6-digit code against a plaintext base32 secret (+-1 step tolerance). */
export async function validateTotpCode(secretBase32: string, code: string, label = "user"): Promise<boolean> {
  return (await matchTotpStep(secretBase32, code, label)) !== null;
}

/** The time step a valid code belongs to (null = invalid). */
async function matchTotpStep(secretBase32: string, code: string, label: string): Promise<number | null> {
  const totp = await buildTotp(secretBase32, label);
  const delta = totp.validate({ token: code.replace(/\s/g, ""), window: 1 });
  return delta === null ? null : Math.floor(Date.now() / 30_000) + delta;
}

/** A code is good for one sign-in only: the step it matched is marked used (a captured code cannot be replayed). */
async function claimStep(userId: string, step: number): Promise<boolean> {
  const r = await rateLimit(`totpstep:${userId}:${step}`, { limit: 1, windowSec: 180 });
  return r.ok;
}

/** Verify a user's TOTP code (rate limited per user). Returns false when 2FA isn't set up. */
export async function verifyUserTotp(userId: string, code: string): Promise<{ ok: boolean; rateLimited?: boolean }> {
  const rl = await rateLimit(`totp:${userId}`, { limit: 8, windowSec: 300 });
  if (!rl.ok) return { ok: false, rateLimited: true };
  const user = await db.user.findUnique({ where: { id: userId }, select: { totpSecret: true, email: true } });
  if (!user?.totpSecret) return { ok: false };
  const step = await matchTotpStep(decrypt(user.totpSecret), code, user.email);
  return { ok: step !== null && (await claimStep(userId, step)) };
}

export interface TotpSetup {
  /** Base32 secret to show for manual entry. */
  secret: string;
  otpauthUrl: string;
  /** PNG data URL of the QR code. */
  qrDataUrl: string;
}

/**
 * Start 2FA setup: generates a secret, stores it encrypted (totpEnabled stays false until
 * {@link enableTotp} confirms a valid code). Calling again replaces an unconfirmed secret.
 */
export async function beginTotpSetup(userId: string): Promise<TotpSetup | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, totpEnabled: true } });
  if (!user || user.totpEnabled) return null;
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  await db.user.update({ where: { id: userId }, data: { totpSecret: encrypt(secret) } });
  const totp = await buildTotp(secret, user.email);
  const otpauthUrl = totp.toString();
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
  return { secret, otpauthUrl, qrDataUrl };
}

/** Confirm setup with a code from the authenticator app and turn 2FA on. */
export async function enableTotp(userId: string, code: string): Promise<boolean> {
  const rl = await rateLimit(`totp:${userId}`, { limit: 8, windowSec: 300 });
  if (!rl.ok) return false;
  const user = await db.user.findUnique({ where: { id: userId }, select: { totpSecret: true, totpEnabled: true, email: true } });
  if (!user?.totpSecret || user.totpEnabled) return false;
  if (!(await validateTotpCode(decrypt(user.totpSecret), code, user.email))) return false;
  await db.user.update({ where: { id: userId }, data: { totpEnabled: true } });
  await db.session.deleteMany({ where: { userId, twoFactorPassed: false } });
  return true;
}

/** Turn 2FA off; requires the account password AND a current code. */
export async function disableTotp(userId: string, password: string, code: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true, totpEnabled: true } });
  if (!user?.totpEnabled) return false;
  if (!(await verifyPassword(user.passwordHash, password))) return false;
  const v = await verifyUserTotp(userId, code);
  if (!v.ok) return false;
  await db.user.update({ where: { id: userId }, data: { totpEnabled: false, totpSecret: null } });
  // half-open sessions (password step passed, waiting for a code) must not turn into full sessions now
  await db.session.deleteMany({ where: { userId, twoFactorPassed: false } });
  return true;
}
