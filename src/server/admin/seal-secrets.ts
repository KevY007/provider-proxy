import "server-only";
import { db } from "@/lib/db";
import { encrypt, PENDING_SECRET_PREFIX, secretHint } from "@/lib/crypto";
import { logger } from "@/lib/logger";

/**
 * Encrypt upstream keys that were inserted as `plain:<secret>` (see PENDING_SECRET_PREFIX). Runs with upkeep, so a key
 * added by SQL is stored in clear only until the next upkeep pass. Returns how many were sealed.
 */
export async function sealPendingProviderSecrets(): Promise<number> {
  const rows = await db.providerKey.findMany({ where: { secretEncrypted: { startsWith: PENDING_SECRET_PREFIX } }, select: { id: true, secretEncrypted: true } });
  let sealed = 0;
  for (const r of rows) {
    const plain = r.secretEncrypted.slice(PENDING_SECRET_PREFIX.length);
    if (!plain) continue;
    // only replace the row we read (a concurrent admin edit wins)
    const u = await db.providerKey.updateMany({ where: { id: r.id, secretEncrypted: r.secretEncrypted }, data: { secretEncrypted: encrypt(plain), secretHint: secretHint(plain) } });
    sealed += u.count;
  }
  if (sealed) logger.info("sealed plain upstream keys", { count: sealed });
  return sealed;
}
