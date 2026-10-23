// Upstream account balances (money left at the provider, e.g. the relay credit) for the admin Providers list and
// the Overview. Display only: customer wallets are separate and always credited by hand. Cached briefly per process so
// page loads do not hit the upstream every time.
import { db } from "@/lib/db";
import { fetchUpstreamBalance, usageEndpoint } from "@/server/admin/upstream-usage";

export interface UpstreamBalance {
  providerId: string;
  name: string;
  /** providers on one upstream account (same settings.sharedConcurrency group) report one balance */
  account: string;
  balance: number | null;
  error?: string;
}

const TTL_MS = 60_000;
let cache: { at: number; rows: UpstreamBalance[] } | null = null;

export async function getUpstreamBalances(opts: { fresh?: boolean } = {}): Promise<UpstreamBalance[]> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const providers = await db.provider.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true, preset: true, baseUrl: true, settings: true },
    orderBy: { name: "asc" },
  });
  const rows = await Promise.all(
    providers
      .filter((p) => usageEndpoint(p))
      .map(async (p): Promise<UpstreamBalance> => {
        const r = await fetchUpstreamBalance(p.id);
        const s = (p.settings ?? {}) as { sharedConcurrency?: { group?: unknown } };
        const group = typeof s.sharedConcurrency?.group === "string" ? s.sharedConcurrency.group : "";
        return { providerId: p.id, name: p.name, account: group || p.id, balance: r.balance, ...(r.error ? { error: r.error } : {}) };
      }),
  );
  cache = { at: Date.now(), rows };
  return rows;
}

/** One row per upstream account: the providers sharing it and its balance (the first one that answered). */
export function byAccount(rows: UpstreamBalance[]): Array<{ account: string; names: string[]; providerId: string; balance: number | null; error?: string }> {
  const out = new Map<string, { account: string; names: string[]; providerId: string; balance: number | null; error?: string }>();
  for (const r of rows) {
    const cur = out.get(r.account);
    if (!cur) out.set(r.account, { account: r.account, names: [r.name], providerId: r.providerId, balance: r.balance, error: r.error });
    else {
      cur.names.push(r.name);
      if (cur.balance == null && r.balance != null) Object.assign(cur, { balance: r.balance, error: undefined, providerId: r.providerId });
    }
  }
  return [...out.values()];
}
