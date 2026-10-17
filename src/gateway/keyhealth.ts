import type { ProviderKeyStatus } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { SettingValues } from "@/lib/settings";
import { broadcastKeyState, effectiveKeyState, getKeyRuntime, setKeyRuntime, type KeyRec } from "./cache";

/**
 * Upstream key health (PLAN 5 step 10).
 *   429                    -> COOLDOWN until retry-after (or settings.keyCooldownSeconds)
 *   401 / 403              -> INVALID after 2 consecutive auth failures
 *   402                    -> COOLDOWN for 10 minutes (upstream account out of credit)
 *   5xx / network / timeout-> consecutiveFailures++, COOLDOWN after settings.failuresBeforeCooldown
 *   success                -> counters reset (the meter writer also resets them in the DB)
 * State changes apply to the in-process overlay immediately, are broadcast to other instances and persisted
 * (coalesced, 1s) so the admin console sees them.
 */
export type FailureKind = "rate_limit" | "auth" | "payment" | "server" | "network" | "timeout";

export interface FailureInfo {
  status: number; // 0 for network errors
  retryAfterSec?: number;
  message: string;
  /** When the failed request started: failures that predate a later success do not count as "consecutive". */
  startedAt?: number;
}

/** Last successful response per upstream key (cheap, in-process). */
const lastOk = new Map<string, number>();

const MAX_COOLDOWN_MS = 60 * 60_000;

interface Pending {
  status?: ProviderKeyStatus;
  cooldownUntil?: Date | null;
  consecutiveFailures?: number;
  lastError?: string | null;
}

const g = globalThis as unknown as { __ppKeyPersist?: { pending: Map<string, Pending>; timer: NodeJS.Timeout | null } };
const persist = (g.__ppKeyPersist ??= { pending: new Map(), timer: null });

function queuePersist(id: string, patch: Pending): void {
  if (process.env.VITEST && !process.env.GW_TEST_PERSIST) return; // unit tests use fake key ids
  persist.pending.set(id, { ...(persist.pending.get(id) ?? {}), ...patch });
  if (persist.timer) return;
  persist.timer = setTimeout(() => {
    persist.timer = null;
    const batch = [...persist.pending];
    persist.pending.clear();
    for (const [keyId, data] of batch) {
      db.providerKey.update({ where: { id: keyId }, data }).catch((err) => logger.warn("persist key health failed", { providerKeyId: keyId, err }));
    }
  }, 1000);
  persist.timer.unref?.();
}

export function classifyStatus(status: number): FailureKind {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "payment";
  if (status === 0) return "network";
  return "server";
}

/** Record a failed attempt against an upstream key. Returns the resulting state (for logging/tests). */
export function recordKeyFailure(
  key: KeyRec,
  kind: FailureKind,
  info: FailureInfo,
  settings: Pick<SettingValues, "keyCooldownSeconds" | "failuresBeforeCooldown">,
  now = Date.now(),
): { status: ProviderKeyStatus; cooldownUntil: number | null; consecutiveFailures: number } {
  const cur = effectiveKeyState(key);
  const rt = getKeyRuntime(key.id);
  // A transient failure of a request that started BEFORE the key last answered successfully says nothing about the
  // key's current health (typical for connection bursts) - do not let it trip the cooldown.
  if ((kind === "server" || kind === "network" || kind === "timeout") && info.startedAt !== undefined && (lastOk.get(key.id) ?? 0) > info.startedAt) {
    return { status: cur.status, cooldownUntil: cur.cooldownUntil, consecutiveFailures: cur.consecutiveFailures };
  }
  const lastError = `${info.status || "network"}: ${info.message}`.slice(0, 500);
  let status: ProviderKeyStatus = cur.status;
  let cooldownUntil: number | null = cur.cooldownUntil && cur.cooldownUntil > now ? cur.cooldownUntil : null;
  let failures = cur.consecutiveFailures;
  let authStreak = rt?.authFailStreak ?? 0;

  switch (kind) {
    case "rate_limit": {
      const secs = Math.min(MAX_COOLDOWN_MS / 1000, Math.max(1, info.retryAfterSec ?? settings.keyCooldownSeconds));
      cooldownUntil = Math.max(cooldownUntil ?? 0, now + secs * 1000);
      status = "COOLDOWN";
      authStreak = 0;
      break;
    }
    case "auth":
      authStreak += 1;
      failures += 1;
      if (authStreak >= 2) status = "INVALID";
      break;
    case "payment":
      cooldownUntil = now + 10 * 60_000;
      status = "COOLDOWN";
      break;
    default:
      authStreak = 0;
      failures += 1;
      if (failures >= settings.failuresBeforeCooldown) {
        cooldownUntil = now + Math.min(MAX_COOLDOWN_MS, settings.keyCooldownSeconds * 1000);
        status = "COOLDOWN";
      }
  }

  setKeyRuntime(key.id, { status, cooldownUntil, consecutiveFailures: failures, authFailStreak: authStreak, lastError });
  queuePersist(key.id, {
    status,
    cooldownUntil: cooldownUntil ? new Date(cooldownUntil) : null,
    consecutiveFailures: failures,
    lastError,
  });
  if (status !== cur.status || cooldownUntil !== cur.cooldownUntil) {
    void broadcastKeyState(key.id, status, cooldownUntil, failures).catch(() => undefined);
    if (status === "INVALID") logger.warn("upstream key marked INVALID", { providerKeyId: key.id, label: key.label });
  }
  return { status, cooldownUntil, consecutiveFailures: failures };
}

/** A request succeeded through `key`: clear transient failure state (cheap no-op when healthy). */
export function recordKeySuccess(key: KeyRec): void {
  lastOk.set(key.id, Date.now());
  const cur = effectiveKeyState(key);
  const rt = getKeyRuntime(key.id);
  if (cur.consecutiveFailures === 0 && (rt?.authFailStreak ?? 0) === 0 && cur.status === "ACTIVE") return;
  const status: ProviderKeyStatus = cur.status === "COOLDOWN" ? "ACTIVE" : cur.status;
  setKeyRuntime(key.id, { status, cooldownUntil: null, consecutiveFailures: 0, authFailStreak: 0 });
  // the meter writer resets failures/COOLDOWN in the DB together with the usage counters
}
