/** Pure helpers for the admin customers pages (no server-only imports; unit tested). */
import { z } from "zod";

export const CUSTOMER_SORTS = ["created", "balance", "spend", "active"] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];
export const CUSTOMER_STATUSES = ["PENDING_VERIFICATION", "ACTIVE", "SUSPENDED"] as const;
export const CUSTOMER_ROLES = ["CUSTOMER", "SUPPORT", "ADMIN"] as const;
export const PAGE_SIZE = 25;

export interface CustomerListParams {
  q: string;
  status: (typeof CUSTOMER_STATUSES)[number] | "";
  role: (typeof CUSTOMER_ROLES)[number] | "";
  group: string;
  sort: CustomerSort;
  dir: "asc" | "desc";
  page: number; // 0-based
  pageSize: number;
}

type SP = Record<string, string | string[] | undefined> | URLSearchParams;
function one(sp: SP, k: string): string {
  const v = sp instanceof URLSearchParams ? sp.get(k) : sp[k];
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
}

export function parseCustomerListParams(sp: SP): CustomerListParams {
  const status = one(sp, "status");
  const role = one(sp, "role");
  const sort = one(sp, "sort");
  const page = Number.parseInt(one(sp, "page"), 10);
  return {
    q: one(sp, "q").slice(0, 120),
    status: (CUSTOMER_STATUSES as readonly string[]).includes(status) ? (status as CustomerListParams["status"]) : "",
    role: (CUSTOMER_ROLES as readonly string[]).includes(role) ? (role as CustomerListParams["role"]) : "",
    group: one(sp, "group").slice(0, 64),
    sort: (CUSTOMER_SORTS as readonly string[]).includes(sort) ? (sort as CustomerSort) : "created",
    dir: one(sp, "dir") === "asc" ? "asc" : "desc",
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 100000) : 0,
    pageSize: PAGE_SIZE,
  };
}

/**
 * Parse a signed balance adjustment typed by an admin ("12.5", "-3", "+0.25", "$5").
 * Returns a canonical decimal string (no exponent) or an error.
 */
export function parseAdjustmentAmount(input: string): { ok: true; amount: string } | { ok: false; error: string } {
  const s = input.trim().replace(/^([+-]?)\$/, "$1").replace(/,/g, "");
  if (!/^[+-]?\d+(\.\d{1,12})?$/.test(s)) return { ok: false, error: "Enter a number like 25, -10 or 0.5 (max 12 decimals)" };
  const neg = s.startsWith("-");
  const body = s.replace(/^[+-]/, "");
  const [i, f = ""] = body.split(".");
  const intPart = i.replace(/^0+(?=\d)/, "");
  const frac = f.replace(/0+$/, "");
  if (intPart === "0" && !frac) return { ok: false, error: "Amount must not be zero" };
  if (intPart.length > 7) return { ok: false, error: "Amount is too large (max 9,999,999)" };
  return { ok: true, amount: `${neg ? "-" : ""}${intPart}${frac ? "." + frac : ""}` };
}

const optMoney = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
    const s = String(v).trim();
    if (!/^\d+(\.\d{1,12})?$/.test(s)) {
      ctx.addIssue({ code: "custom", message: "Must be a non-negative number" });
      return z.NEVER;
    }
    return s;
  });

const optIntField = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
      ctx.addIssue({ code: "custom", message: "Must be a whole number >= 1" });
      return z.NEVER;
    }
    return n;
  });

export const customerSettingsSchema = z.object({
  userId: z.string().min(1),
  groupId: z.string().nullable().optional().transform((v) => v || null),
  /** Private pools this customer may also put keys in. */
  extraGroupIds: z.array(z.string().min(1)).max(50).optional().transform((v) => [...new Set(v ?? [])]),
  priceMultiplier: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((v, ctx) => {
      if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 1000) {
        ctx.addIssue({ code: "custom", message: "Must be between 0 and 1000 (blank = use group)" });
        return z.NEVER;
      }
      return String(n);
    }),
  billingMode: z.enum(["PREPAID", "POSTPAID"]),
  creditLimit: optMoney.transform((v) => v ?? "0"),
  monthlySpendLimit: optMoney,
  maxConcurrency: optIntField,
  freeWhenEmpty: z.boolean().default(false),
});
export type CustomerSettingsInput = z.input<typeof customerSettingsSchema>;

export const adjustBalanceSchema = z.object({
  userId: z.string().min(1),
  amount: z.string().transform((v, ctx) => {
    const r = parseAdjustmentAmount(v);
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.error });
      return z.NEVER;
    }
    return r.amount;
  }),
  reason: z.string().trim().min(3, "A reason is required (min 3 characters)").max(500),
});

/** Whether `actor` may act on a target with `targetRole` (staff accounts can only be touched by ADMIN). */
export function canManageTarget(actorRole: string, targetRole: string, actorId: string, targetId: string): { ok: boolean; reason?: string } {
  if (actorId === targetId) return { ok: false, reason: "You cannot do this to your own account" };
  if (targetRole !== "CUSTOMER" && actorRole !== "ADMIN") return { ok: false, reason: "Only an admin can manage staff accounts" };
  return { ok: true };
}

const emailField = z.string().trim().toLowerCase().min(3, "Required").max(254).email("Enter a valid email address");
const nameField = z
  .string()
  .trim()
  .max(120)
  .nullable()
  .optional()
  .transform((v) => v || null);

/** Admin "Create user": the account is active right away; the user sets a password through the invite link. */
export const createCustomerSchema = z.object({
  email: emailField,
  name: nameField,
  role: z.enum(CUSTOMER_ROLES).default("CUSTOMER"),
  groupId: z.string().nullable().optional().transform((v) => v || null),
  initialCredit: optMoney,
  sendInvite: z.boolean().default(true),
});
export type CreateCustomerInput = z.input<typeof createCustomerSchema>;

export const updateProfileSchema = z.object({
  userId: z.string().min(1),
  email: emailField,
  name: nameField,
});

/** Placeholder email for an account that was deleted but keeps its billing history. */
export const deletedEmail = (userId: string) => `deleted-${userId}@deleted.invalid`;

/**
 * Deleting an account with money history (ledger entries, payments) would cascade that history away, so such
 * accounts are anonymised and locked instead; accounts without it are removed for good.
 */
export function deletionMode(history: { ledger: number; payments: number }): "delete" | "anonymize" {
  return history.ledger > 0 || history.payments > 0 ? "anonymize" : "delete";
}
