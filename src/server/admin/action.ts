import "server-only";
import { headers } from "next/headers";
import { z } from "zod";
import { requireAdminForAction } from "@/lib/auth/session";
import { AuthError, type ActionResult, type AuthSession } from "@/lib/auth/types";
import { getClientIp } from "@/lib/http";
import { logger } from "@/lib/logger";
import { toDecimal } from "@/lib/money";

/**
 * Shared plumbing for admin server actions.
 *
 *   "use server";
 *   export async function saveThing(input: unknown) {
 *     return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
 *       const data = parseInput(schema, input);          // throws ActionFail with fieldErrors
 *       ...mutate, await audit(admin.id, "thing.update", {...}, {...}, ip)
 *       await invalidateGatewayConfig("models")
 *       return { data: {...}, message: "Saved" };
 *     });
 *   }
 *
 * `adminAction` re-checks the role (ADMIN, or ADMIN|SUPPORT when !adminOnly) on EVERY call, converts
 * AuthError / ActionFail / ZodError / unexpected errors into a serializable ActionResult.
 */

export class ActionFail extends Error {
  constructor(
    message: string,
    public fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "ActionFail";
  }
}

export interface AdminCtx {
  admin: AuthSession["user"];
  session: AuthSession;
  ip: string;
}

export async function adminAction<T = undefined>(
  opts: { adminOnly?: boolean },
  fn: (ctx: AdminCtx) => Promise<{ data?: T; message?: string } | void>,
): Promise<ActionResult<T>> {
  try {
    const session = await requireAdminForAction({ adminOnly: opts.adminOnly });
    const ip = getClientIp(await headers());
    const out = await fn({ admin: session.user, session, ip });
    return { ok: true, data: out?.data, message: out?.message };
  } catch (err) {
    return toActionError(err);
  }
}

export function toActionError(err: unknown): { ok: false; error: string; fieldErrors?: Record<string, string> } {
  if (err instanceof AuthError) return { ok: false, error: err.message };
  if (err instanceof ActionFail) return { ok: false, error: err.message, fieldErrors: err.fieldErrors };
  if (err instanceof z.ZodError) {
    const fieldErrors = zodFieldErrors(err);
    const first = Object.entries(fieldErrors)[0];
    return { ok: false, error: first ? `${first[0]}: ${first[1]}` : "Invalid input", fieldErrors };
  }
  // Unique constraint violations etc. -> readable message
  const code = (err as { code?: string } | null)?.code;
  if (code === "P2002") {
    const target = (err as { meta?: { target?: unknown } }).meta?.target;
    return { ok: false, error: `Already exists${target ? ` (${String(target)})` : ""}` };
  }
  if (code === "P2025") return { ok: false, error: "Record not found" };
  logger.error("admin action failed", { err });
  return { ok: false, error: err instanceof Error ? err.message : "Unexpected error" };
}

export function zodFieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** safeParse that throws ActionFail with per-field errors. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const res = schema.safeParse(input);
  if (!res.success) {
    const fieldErrors = zodFieldErrors(res.error);
    const first = Object.entries(fieldErrors)[0];
    throw new ActionFail(first ? `${first[0]}: ${first[1]}` : "Invalid input", fieldErrors);
  }
  return res.data;
}

// ---------- zod building blocks shared by admin forms ----------

/** Optional money-ish field from a form: "" / null / undefined => null, otherwise a decimal string. */
export const optDecimal = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
    const s = String(v).trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) {
      ctx.addIssue({ code: "custom", message: "Must be a number" });
      return z.NEVER;
    }
    return toDecimal(s).toFixed();
  })
  .default(null);

/** Required non-negative decimal (defaults to "0" when blank). */
export const reqDecimal = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return "0";
    const s = String(v).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) {
      ctx.addIssue({ code: "custom", message: "Must be a non-negative number" });
      return z.NEVER;
    }
    return toDecimal(s).toFixed();
  })
  .default("0");

/** Optional integer from a form ("" => null). */
export const optInt = (min = 0, max = 2_147_483_647) =>
  z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((v, ctx) => {
      if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `Must be a whole number between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    })
    .default(null);

/** JSON-object text from an editor ("" => {}). Rejects arrays/primitives. */
export const jsonObjectText = z
  .union([z.string(), z.record(z.string(), z.unknown()), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v === null || v === undefined) return {} as Record<string, unknown>;
    if (typeof v !== "string") return v;
    if (!v.trim()) return {} as Record<string, unknown>;
    try {
      const parsed = JSON.parse(v);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
      return parsed as Record<string, unknown>;
    } catch {
      ctx.addIssue({ code: "custom", message: "Must be a valid JSON object" });
      return z.NEVER;
    }
  })
  .default({});

export const slugSchema = z
  .string()
  .trim()
  .min(1, "Required")
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/, "Letters, numbers, . _ : / - only");

export const stringList = z.array(z.string().trim().min(1)).transform((a) => [...new Set(a)]).default([]);
