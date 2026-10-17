import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { appUrl, isProd } from "@/lib/env";
import { randomToken, sha256 } from "@/lib/crypto";
import { AuthError, type AuthSession } from "./types";

/** Cookie holding the raw session token; the DB stores only sha256(token) as Session.id. */
export const SESSION_COOKIE = "pp_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000; // rolling: extend DB expiry at most once a day

export function sessionCookieOptions(maxAgeMs = SESSION_TTL_MS) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProd && appUrl.startsWith("https://"),
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

export interface CreateSessionOptions {
  ip?: string | null;
  userAgent?: string | null;
  /** false => "half-logged-in", waiting for the TOTP step. */
  twoFactorPassed?: boolean;
  impersonatorId?: string | null;
  /** Set to false to create the DB row only (don't touch cookies). */
  setCookie?: boolean;
}

/** Create a DB session (+ cookie). Call only from server actions / route handlers. */
export async function createSession(userId: string, opts: CreateSessionOptions = {}): Promise<{ id: string; token: string }> {
  const token = randomToken(32);
  const id = sha256(token);
  await db.session.create({
    data: {
      id,
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ip: opts.ip ?? null,
      userAgent: opts.userAgent?.slice(0, 300) ?? null,
      twoFactorPassed: opts.twoFactorPassed ?? true,
      impersonatorId: opts.impersonatorId ?? null,
    },
  });
  if (opts.setCookie !== false) {
    (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions());
  }
  // opportunistic cleanup of this user's expired sessions
  db.session.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } }).catch(() => undefined);
  return { id, token };
}

/** Hash of the current session cookie (the Session.id) or null. */
export async function getCurrentSessionId(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? sha256(token) : null;
}

/** Raw lookup of the cookie's session incl. user; cached per request. Does NOT enforce 2FA/status. */
const readSession = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const id = sha256(token);
  const row = await db.session.findUnique({
    where: { id },
    include: { user: { omit: { passwordHash: true, totpSecret: true } } },
  });
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt.getTime() <= now) {
    db.session.delete({ where: { id } }).catch(() => undefined);
    return null;
  }
  if (row.expiresAt.getTime() - now < SESSION_TTL_MS - REFRESH_AFTER_MS) {
    db.session
      .update({ where: { id }, data: { expiresAt: new Date(now + SESSION_TTL_MS) } })
      .catch(() => undefined);
  }
  return row;
});

/**
 * Current session + user, or null. Returns null for unauthenticated, expired, SUSPENDED/PENDING users,
 * and for sessions still waiting on the 2FA step.
 */
export async function getSession(): Promise<AuthSession | null> {
  const row = await readSession();
  if (!row) return null;
  const { user, ...session } = row;
  if (user.status !== "ACTIVE") return null;
  if (user.totpEnabled && !session.twoFactorPassed) return null;
  return { session, user, impersonatorId: session.impersonatorId };
}

/** The half-open session of a user who passed the password step and must now enter a TOTP code. */
export async function getPendingTwoFactorSession(): Promise<AuthSession | null> {
  const row = await readSession();
  if (!row) return null;
  const { user, ...session } = row;
  if (user.status !== "ACTIVE" || !user.totpEnabled || session.twoFactorPassed) return null;
  return { session, user, impersonatorId: session.impersonatorId };
}

/** For pages/layouts: returns the session or redirects to /login. */
export async function requireUser(): Promise<AuthSession> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

export interface RequireAdminOptions {
  /** true => only ADMIN (SUPPORT is rejected). Default: ADMIN or SUPPORT. */
  adminOnly?: boolean;
}

/**
 * For admin pages/layouts: ADMIN or SUPPORT (or only ADMIN with `{adminOnly:true}`).
 * Redirects unauthenticated users to /login and non-admins to /dashboard (SUPPORT hitting an admin-only page => /admin).
 */
export async function requireAdmin(opts: RequireAdminOptions = {}): Promise<AuthSession> {
  const s = await getSession();
  if (!s) redirect("/login?next=/admin");
  const role = s.user.role;
  if (role === "CUSTOMER") redirect("/dashboard");
  if (opts.adminOnly && role !== "ADMIN") redirect("/admin");
  return s;
}

/** For server actions: like requireUser but throws AuthError instead of redirecting. */
export async function requireUserForAction(): Promise<AuthSession> {
  const s = await getSession();
  if (!s) throw new AuthError("unauthenticated", "You need to log in");
  return s;
}

/** For server actions / route handlers: like requireAdmin but throws AuthError. */
export async function requireAdminForAction(opts: RequireAdminOptions = {}): Promise<AuthSession> {
  const s = await requireUserForAction();
  if (s.user.role === "CUSTOMER" || (opts.adminOnly && s.user.role !== "ADMIN")) {
    throw new AuthError("forbidden", "You don't have permission to do that");
  }
  return s;
}

/** Delete the current session and clear the cookie. */
export async function destroyCurrentSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { id: sha256(token) } });
  jar.delete(SESSION_COOKIE);
}

export interface SessionInfo {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  current: boolean;
}

/** All active sessions of a user (for the Settings > Sessions list). */
export async function listSessions(userId: string, currentSessionId?: string | null): Promise<SessionInfo[]> {
  const rows = await db.session.findMany({
    where: { userId, expiresAt: { gt: new Date() }, twoFactorPassed: true },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    ip: r.ip,
    userAgent: r.userAgent,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    current: r.id === currentSessionId,
  }));
}

/** Revoke one session of `userId` (ownership enforced). Returns true if something was deleted. */
export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const res = await db.session.deleteMany({ where: { id: sessionId, userId } });
  return res.count > 0;
}

/** Revoke all of a user's sessions except `exceptSessionId`. Returns the number revoked. */
export async function revokeOtherSessions(userId: string, exceptSessionId?: string | null): Promise<number> {
  const res = await db.session.deleteMany({
    where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
  });
  return res.count;
}

/** Revoke every session of a user (suspension, password reset). */
export async function revokeAllSessions(userId: string): Promise<number> {
  return (await db.session.deleteMany({ where: { userId } })).count;
}
