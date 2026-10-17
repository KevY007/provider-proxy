/**
 * Admin credits (PLAN 9c): Promotional credit / Refund / Correction. Pure: shared by the server actions, dialogs and the
 * ledger labels (the ledger description carries the kind prefix, metadata.kind stores it for exports/queries).
 */
import { z } from "zod";
import { parseAdjustmentAmount } from "./customers-calc";

export const CREDIT_KINDS = ["promotional", "refund", "correction"] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

export interface CreditKindInfo {
  label: string;
  /** Ledger type used (LedgerType enum). */
  ledger: "ADJUSTMENT" | "REFUND";
  /** Text the ledger description starts with (also shown to the customer in billing history). */
  prefix: string;
  /** May the amount be negative (debit)? Only corrections. */
  signed: boolean;
  hint: string;
}

export const CREDIT_KIND_INFO: Record<CreditKind, CreditKindInfo> = {
  promotional: { label: "Promotional credit", ledger: "ADJUSTMENT", prefix: "Promotional credit", signed: false, hint: "A gift or bonus added to the balance." },
  refund: { label: "Refund", ledger: "REFUND", prefix: "Refund credit", signed: false, hint: "Money given back, e.g. after a failed or overcharged request." },
  correction: { label: "Correction", ledger: "ADJUSTMENT", prefix: "Correction", signed: true, hint: "Fix a balance mistake. Use a negative amount to take money back." },
};

export function creditDescription(kind: CreditKind, reason: string): string {
  return `${CREDIT_KIND_INFO[kind].prefix}: ${reason.trim()}`;
}

/** Clear billing-history label for entries created by the credit dialogs; null for everything else. */
export function creditLabelFromDescription(type: string, description: string | null | undefined): string | null {
  if (!description) return null;
  for (const k of CREDIT_KINDS) {
    const info = CREDIT_KIND_INFO[k];
    if (info.ledger === type && description.startsWith(`${info.prefix}: `)) return info.label === "Refund" ? "Refund credit" : info.label;
  }
  return null;
}

const amountField = z.string({ error: "Enter an amount" }).transform((v, ctx) => {
  const r = parseAdjustmentAmount(v);
  if (!r.ok) {
    ctx.addIssue({ code: "custom", message: r.error });
    return z.NEVER;
  }
  return r.amount;
});

const MAX_CREDIT = 100_000;

function refineAmount(d: { kind: CreditKind; amount: string }, ctx: z.RefinementCtx) {
  const n = Number(d.amount);
  if (!CREDIT_KIND_INFO[d.kind].signed && n <= 0) ctx.addIssue({ code: "custom", path: ["amount"], message: "Enter a positive amount (only a Correction can be negative)" });
  if (Math.abs(n) > MAX_CREDIT) ctx.addIssue({ code: "custom", path: ["amount"], message: `At most $${MAX_CREDIT.toLocaleString("en-US")} at a time` });
}

const base = {
  kind: z.enum(CREDIT_KINDS, { error: "Choose a credit type" }),
  amount: amountField,
  reason: z.string().trim().min(3, "Add a short reason (at least 3 characters)").max(300, "Keep the reason under 300 characters"),
};

export const addCreditSchema = z.object({ userId: z.string().min(1), ...base }).superRefine(refineAmount);
export const grantCreditsSchema = z
  .object({ userIds: z.array(z.string().min(1)).min(1, "Select at least one customer").max(200, "At most 200 customers at a time"), ...base })
  .superRefine(refineAmount);
