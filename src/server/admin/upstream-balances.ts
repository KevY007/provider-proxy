// Upstream account balances (money left at the provider, e.g. the relay credit) for the admin Overview and
// Providers pages. Display only: customer wallets are separate and always credited by hand.
//
// Refreshed by the "balances" background job (Settings > Monitoring, default hourly) or the Refresh button, and stored
// as one snapshot (Setting `upstreamBalanceSnapshot`) so page loads never call the upstream.
//
// Accounts: one upstream account can sit behind several providers (the relay: one wallet, many groups / keys).
// Keys are grouped into one account when
//   1. their providers share `settings.sharedConcurrency.group` or `settings.upstreamAccount` (explicit, preferred), or
//   2. they report the very same balance to the micro-dollar at the same moment (the same wallet).
// Everything else is its own account.
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { emailTemplates, sendTemplate } from "@/lib/email";
import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { assertPublicUrl } from "@/gateway/ssrf";
import { parseUsageDoc, usageEndpoint } from "@/server/admin/upstream-usage";

const SNAPSHOT_KEY = "upstreamBalanceSnapshot";
const TIMEOUT_MS = 10_000;

export interface UpstreamKeyBalance {
  providerId: string;
  providerName: string;
  keyId: string;
  keyLabel: string;
  balance: number | null;
  error?: string;
}

export interface UpstreamAccount {
  /** stable id: the explicit account name, or a hash of the member key ids */
  id: string;
  /** display name: the explicit account name, or the providers it serves */
  name: string;
  balance: number | null;
  providers: Array<{ id: string; name: string }>;
  keys: Array<{ id: string; label: string; providerName: string }>;
  error?: string;
}

export interface BalanceSnapshot {
  at: string | null;
  accounts: UpstreamAccount[];
}

/** Explicit account name of a provider (settings.upstreamAccount, else its shared concurrency group). */
function explicitAccount(settings: unknown): string | null {
  const s = (settings && typeof settings === "object" ? settings : {}) as { upstreamAccount?: unknown; sharedConcurrency?: { group?: unknown } };
  if (typeof s.upstreamAccount === "string" && s.upstreamAccount.trim()) return s.upstreamAccount.trim();
  const g = s.sharedConcurrency?.group;
  return typeof g === "string" && g.trim() ? g.trim() : null;
}

/** Read the balance behind every ACTIVE key of every provider that publishes one. */
async function readKeyBalances(): Promise<Array<UpstreamKeyBalance & { account: string | null }>> {
  const providers = await db.provider.findMany({ where: { status: "ACTIVE" }, include: { keys: { where: { status: { in: ["ACTIVE", "COOLDOWN"] } }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] } }, orderBy: { name: "asc" } });
  const jobs: Array<Promise<UpstreamKeyBalance & { account: string | null }>> = [];
  for (const p of providers) {
    const ep = usageEndpoint(p);
    if (!ep) continue;
    for (const k of p.keys) {
      jobs.push(
        (async () => {
          const base = { providerId: p.id, providerName: p.name, keyId: k.id, keyLabel: k.label, account: explicitAccount(p.settings) };
          try {
            await assertPublicUrl(ep.url, [new URL(p.baseUrl).hostname]);
            const res = await fetch(ep.url, { headers: { authorization: `Bearer ${decrypt(k.secretEncrypted)}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!res.ok) return { ...base, balance: null, error: `HTTP ${res.status}` };
            return { ...base, balance: parseUsageDoc(await res.json()).balance };
          } catch (err) {
            return { ...base, balance: null, error: err instanceof Error ? err.message : String(err) };
          }
        })(),
      );
    }
  }
  return Promise.all(jobs);
}

/** Group key balances into accounts (pure; exported for tests). */
export function groupAccounts(rows: Array<UpstreamKeyBalance & { account: string | null }>): UpstreamAccount[] {
  const groups = new Map<string, Array<UpstreamKeyBalance & { account: string | null }>>();
  for (const r of rows) {
    // explicit name first; else the same balance (to the micro-dollar) = the same wallet; a failed read stays alone
    const key = r.account ? `name:${r.account}` : r.balance !== null ? `bal:${Math.round(r.balance * 1e6)}` : `key:${r.keyId}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  // an explicit account whose balance equals an unnamed group's balance absorbs it (same wallet, partly unnamed)
  for (const [k, members] of [...groups]) {
    if (!k.startsWith("bal:")) continue;
    const named = [...groups].find(([nk, m]) => nk.startsWith("name:") && m.some((x) => x.balance !== null && Math.round(x.balance * 1e6) === Number(k.slice(4))));
    if (named) {
      named[1].push(...members);
      groups.delete(k);
    }
  }
  const out: UpstreamAccount[] = [];
  for (const [k, members] of groups) {
    const ok = members.find((m) => m.balance !== null);
    const providers = [...new Map(members.map((m) => [m.providerId, { id: m.providerId, name: m.providerName }])).values()];
    out.push({
      id: k.startsWith("name:") ? k.slice(5) : members.map((m) => m.keyId).sort().join("+"),
      name: k.startsWith("name:") ? prettyName(k.slice(5)) : providers.map((p) => p.name).join(" + "),
      balance: ok?.balance ?? null,
      providers,
      keys: members.map((m) => ({ id: m.keyId, label: m.keyLabel, providerName: m.providerName })),
      ...(ok ? {} : { error: members[0]?.error ?? "no balance" }),
    });
  }
  return out.sort((a, b) => (a.balance ?? Infinity) - (b.balance ?? Infinity));
}

const prettyName = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Read every upstream balance now and store the snapshot. */
export async function refreshUpstreamBalances(): Promise<BalanceSnapshot> {
  const snap: BalanceSnapshot = { at: new Date().toISOString(), accounts: groupAccounts(await readKeyBalances()) };
  const value = snap as unknown as Prisma.InputJsonValue;
  await db.setting.upsert({ where: { key: SNAPSHOT_KEY }, create: { key: SNAPSHOT_KEY, value }, update: { value } });
  await alertLowBalances(snap).catch((err) => logger.warn("upstream low-balance alert failed", { err }));
  return snap;
}

const ALERTED_KEY = "upstreamBalanceAlerted";

/**
 * Email the admins once when an upstream account drops below `upstreamBalanceLowUsd`. The account is remembered as
 * alerted until a read shows it at or above the level again, so the next drop alerts again (never on every refresh).
 */
export async function alertLowBalances(snap: BalanceSnapshot): Promise<string[]> {
  const { upstreamBalanceLowUsd: limit } = await getSettings();
  const row = await db.setting.findUnique({ where: { key: ALERTED_KEY } });
  const before = new Set(Array.isArray(row?.value) ? (row.value as string[]) : []);
  const after = new Set(before);
  const fresh: UpstreamAccount[] = [];
  for (const a of snap.accounts) {
    if (a.balance === null) continue; // a failed read changes nothing
    if (limit > 0 && a.balance < limit) {
      if (!after.has(a.id)) fresh.push(a);
      after.add(a.id);
    } else after.delete(a.id);
  }
  if (after.size === before.size && [...after].every((id) => before.has(id))) return [];
  const value = [...after] as unknown as Prisma.InputJsonValue;
  await db.setting.upsert({ where: { key: ALERTED_KEY }, create: { key: ALERTED_KEY, value }, update: { value } });
  if (!fresh.length) return [];
  const admins = await db.user.findMany({ where: { role: "ADMIN", status: "ACTIVE" }, select: { email: true } });
  for (const a of fresh) {
    for (const ad of admins) await sendTemplate(ad.email, emailTemplates.upstreamBalanceLow({ account: a.name, balance: a.balance!, limit }));
    await audit(null, "billing.upstream_balance_low", { type: "UpstreamAccount", id: a.id }, { balance: a.balance, limit });
  }
  return fresh.map((a) => a.id);
}

/** The stored snapshot (refreshed on the first read when none exists yet). */
export async function getUpstreamBalances(): Promise<BalanceSnapshot> {
  const row = await db.setting.findUnique({ where: { key: SNAPSHOT_KEY } });
  const v = row?.value as unknown as BalanceSnapshot | undefined;
  if (v && Array.isArray(v.accounts)) return v;
  return refreshUpstreamBalances().catch(() => ({ at: null, accounts: [] }));
}

/** provider id -> the balance of its account (for the Providers table). */
export function balanceByProvider(snap: BalanceSnapshot): Record<string, { balance: number | null; account: string; error?: string }> {
  const out: Record<string, { balance: number | null; account: string; error?: string }> = {};
  for (const a of snap.accounts) for (const p of a.providers) out[p.id] ??= { balance: a.balance, account: a.name, ...(a.error ? { error: a.error } : {}) };
  return out;
}
