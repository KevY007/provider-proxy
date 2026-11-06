import { z } from "zod";
import { cleanUserAgent, isPassthrough } from "@/lib/user-agents";

/** Validation shared by the key form (client UX) and the server actions (security). */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const IPV6 = /^[0-9a-fA-F:.]+(?:\/(\d{1,3}))?$/;

export function isValidIpOrCidr(value: string): boolean {
  const v = value.trim();
  const m4 = IPV4.exec(v);
  if (m4) {
    if ([m4[1], m4[2], m4[3], m4[4]].some((o) => Number(o) > 255)) return false;
    return m4[5] === undefined || Number(m4[5]) <= 32;
  }
  const m6 = IPV6.exec(v);
  if (m6 && v.includes(":") && (v.match(/:/g)?.length ?? 0) >= 2) {
    return m6[1] === undefined || Number(m6[1]) <= 128;
  }
  return false;
}

const optInt = (max: number) => z.number().int("Must be a whole number").min(1, "Must be at least 1").max(max, `Must be at most ${max.toLocaleString()}`).nullable().optional();

export const keyFormSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name").max(60, "Name is too long (max 60)"),
  /** null/undefined = account default pool. */
  groupId: z.string().min(1).nullable().optional(),
  allowedModels: z.array(z.string().min(1).max(120)).max(300).default([]),
  rpmLimit: optInt(10_000_000),
  tpmLimit: optInt(1_000_000_000),
  maxConcurrency: optInt(10_000),
  spendLimit: z.number().positive("Must be greater than 0").max(1_000_000, "Must be at most 1,000,000").nullable().optional(),
  /** ISO timestamp; must be in the future. */
  expiresAt: z
    .string()
    .nullable()
    .optional()
    .refine((v) => !v || !Number.isNaN(new Date(v).getTime()), "Invalid date")
    .refine((v) => !v || new Date(v).getTime() > Date.now(), "Expiry must be in the future"),
  ipAllowlist: z
    .array(z.string().trim().min(1))
    .max(50, "At most 50 entries")
    .default([])
    .refine((list) => list.every(isValidIpOrCidr), "Use valid IPs or CIDR ranges (e.g. 203.0.113.7 or 10.0.0.0/8)"),
  /** Client identity sent upstream: a preset id or custom text. Blank / "passthrough" = the caller's own (stored as null). */
  userAgent: z
    .string()
    .max(300, "At most 300 characters")
    .nullable()
    .optional()
    .transform((v) => (isPassthrough(v) ? null : cleanUserAgent(v as string) || null)),
});

export type KeyFormInput = z.input<typeof keyFormSchema>;
export type KeyFormValues = z.output<typeof keyFormSchema>;

export const keyIdSchema = z.object({ id: z.string().min(5).max(64) });
export const keyUpdateSchema = keyFormSchema.extend({ id: z.string().min(5).max(64) });

/** Split "a, b\nc" into trimmed unique IP entries. */
export function parseIpList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * May this customer put a key in pool `g`? A public pool, their own pool, a private pool an admin allowed for their
 * account, or the pool the key is already in (an edit never has to move a key out of the pool it is in).
 */
export function canUsePool(
  g: { id: string; isPublic: boolean },
  user: { groupId: string | null; extraGroupIds?: string[] | null },
  currentGroupId: string | null = null,
): boolean {
  return g.isPublic || g.id === user.groupId || (user.extraGroupIds ?? []).includes(g.id) || g.id === currentGroupId;
}
