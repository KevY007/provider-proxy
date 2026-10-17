import "server-only";
import type { z } from "zod";
import { fieldErrorsFrom } from "@/lib/auth/schemas";
import { requireUserForAction } from "@/lib/auth/session";
import { AuthError, type ActionResult, type AuthSession } from "@/lib/auth/types";
import { logger } from "@/lib/logger";

export function invalidInput(err: z.ZodError): ActionResult<never> {
  return { ok: false, error: "Please fix the highlighted fields", fieldErrors: fieldErrorsFrom(err) };
}

export function fail(error: string, fieldErrors?: Record<string, string>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/** Runs a server-action body for the signed-in user; maps auth/unexpected errors to ActionResult failures. */
export async function withUser<T = undefined>(where: string, fn: (s: AuthSession) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    const s = await requireUserForAction();
    return await fn(s);
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.code === "unauthenticated" ? "Your session expired. Please log in again." : err.message };
    logger.error(`customer action failed: ${where}`, { err });
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
