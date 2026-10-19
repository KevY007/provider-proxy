import { z } from "zod";
import { AuthError, type ActionResult } from "@/lib/auth/types";
import { fieldErrorsFrom } from "@/lib/auth/schemas";
import { logger } from "@/lib/logger";
import { LedgerError } from "./ledger";
import { StripeNotConfiguredError } from "./stripe";
import { RedeemInputError } from "./redeem";

/** Thrown inside an action body to return a friendly error (optionally with per-field errors). */
export class ActionFail extends Error {
  constructor(
    message: string,
    public fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "ActionFail";
  }
}

export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw new ActionFail("Please fix the highlighted fields", fieldErrorsFrom(r.error));
  return r.data;
}

/** Convert anything thrown by an action body into a serializable ActionResult. */
export function toActionResult(err: unknown, name: string): { ok: false; error: string; fieldErrors?: Record<string, string> } {
  if (err instanceof AuthError) return { ok: false, error: err.message };
  if (err instanceof ActionFail) return { ok: false, error: err.message, fieldErrors: err.fieldErrors };
  if (err instanceof z.ZodError) return { ok: false, error: "Please fix the highlighted fields", fieldErrors: fieldErrorsFrom(err) };
  if (err instanceof StripeNotConfiguredError) return { ok: false, error: "Card payments are not configured yet." };
  if (err instanceof LedgerError || err instanceof RedeemInputError) return { ok: false, error: err.message };
  logger.error(`billing action failed: ${name}`, { err });
  return { ok: false, error: "Something went wrong. Please try again." };
}

export type { ActionResult };
