import type { User, Session } from "@/generated/prisma/client";

/** User record without secrets (never ship passwordHash / totpSecret to callers or the client). */
export type SessionUser = Omit<User, "passwordHash" | "totpSecret">;

export interface AuthSession {
  session: Session;
  user: SessionUser;
  /** Set when an admin is impersonating this user. */
  impersonatorId: string | null;
}

/** Standard result returned by server actions (serializable). */
export type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export class AuthError extends Error {
  constructor(
    public code: "unauthenticated" | "forbidden",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AuthError";
  }
}
