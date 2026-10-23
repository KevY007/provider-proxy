// Balance mirror: a customer whose `balanceMirrorProviderId` is set has the balance of that provider's upstream account
// (e.g. the studio's account on Codex Everywhere: what it really has left to spend there). Upkeep refreshes it; every
// change is an ADJUSTMENT ledger entry, so the ledger still explains the balance. Usage keeps being metered normally in
// between - the next refresh brings the balance back to the upstream figure.
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Decimal, toDecimal } from "@/lib/money";
import { fetchUpstreamBalance } from "@/server/admin/upstream-usage";
import { afterLedgerCommit, appendEntryTx, lockUser } from "./ledger";

const MIN_CHANGE = new Decimal("0.000001");

export async function syncMirroredBalances(opts: { userId?: string } = {}): Promise<{ users: number; updated: number; errors: string[] }> {
  const users = await db.user.findMany({ where: { balanceMirrorProviderId: { not: null }, ...(opts.userId ? { id: opts.userId } : {}) }, select: { id: true, email: true, balanceMirrorProviderId: true } });
  const errors: string[] = [];
  let updated = 0;
  const balances = new Map<string, Awaited<ReturnType<typeof fetchUpstreamBalance>>>();
  for (const u of users) {
    const pid = u.balanceMirrorProviderId!;
    if (!balances.has(pid)) balances.set(pid, await fetchUpstreamBalance(pid));
    const b = balances.get(pid)!;
    if (b.balance === null) {
      errors.push(`${u.email}: ${b.error ?? "no balance"}`);
      continue;
    }
    const target = toDecimal(String(b.balance));
    const changed = await db.$transaction(
      async (tx) => {
        const current = await lockUser(tx, u.id);
        const delta = target.minus(current);
        if (delta.abs().lt(MIN_CHANGE)) return false;
        await appendEntryTx(tx, u.id, delta, "ADJUSTMENT", `Balance mirrored from the upstream account ($${target.toFixed(4)} available there)`, { metadata: { balanceMirror: pid, upstreamBalance: b.balance } });
        return true;
      },
      { timeout: 15_000 },
    );
    if (changed) {
      updated++;
      await afterLedgerCommit(u.id);
    }
  }
  if (errors.length) logger.warn("balance mirror: some balances could not be read", { errors });
  return { users: users.length, updated, errors };
}
