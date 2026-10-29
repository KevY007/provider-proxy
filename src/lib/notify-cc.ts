import { z } from "zod";

/**
 * Notification copies: extra addresses that get a BCC copy of every notification email sent to an account (balance
 * and billing alerts). Never used for the owner-only security emails. Pure (no DB) so forms and tests can use it.
 */
export const NOTIFY_CC_MAX = 10;

const email = z.email();

export type NotifyCcResult = { ok: true; value: string[] } | { ok: false; error: string };

/**
 * Accepts a list or a text with one address per line (commas and semicolons work too). Trims, lowercases and
 * de-duplicates; rejects invalid addresses, more than NOTIFY_CC_MAX, and the account's own address (`ownEmail`).
 */
export function parseNotifyCc(input: unknown, ownEmail?: string | null): NotifyCcResult {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (typeof input === "string" && input.length > 5000) return { ok: false, error: `Up to ${NOTIFY_CC_MAX} addresses` };
  const parts = typeof input === "string" ? input.split(/[\n,;]/) : Array.isArray(input) ? input : null;
  if (!parts || parts.length > 100) return { ok: false, error: `Up to ${NOTIFY_CC_MAX} addresses` };
  const out = new Set<string>();
  for (const raw of parts) {
    if (typeof raw !== "string") return { ok: false, error: "Enter email addresses" };
    const a = raw.trim().toLowerCase();
    if (!a) continue;
    if (a.length > 254 || !email.safeParse(a).success) return { ok: false, error: `Not a valid email address: ${a.slice(0, 80)}` };
    out.add(a);
  }
  const own = ownEmail?.trim().toLowerCase();
  if (own && out.has(own)) return { ok: false, error: "The account's own address already gets these emails; remove it from the list" };
  if (out.size > NOTIFY_CC_MAX) return { ok: false, error: `Up to ${NOTIFY_CC_MAX} addresses` };
  return { ok: true, value: [...out] };
}

/** Zod field for forms (format, count, de-duplication); the own-address check needs the account and runs in the action. */
export const notifyCcField = z.unknown().transform((v, ctx) => {
  const r = parseNotifyCc(v);
  if (!r.ok) {
    ctx.addIssue({ code: "custom", message: r.error });
    return z.NEVER;
  }
  return r.value;
});
