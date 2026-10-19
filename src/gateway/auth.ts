import { sha256 } from "@/lib/crypto";
import { getAuthRecord, peekAuthRecord, type AuthRecord, type ConfigSnapshot, type GroupRec } from "./cache";
import type { Ctx } from "./context";
import { GatewayError } from "./errors";
import { ipAllowed } from "./ip";
import { isAuthThrottled, noteAuthFailure, userMonthlySpend } from "./limits";

const KEY_PREFIX = "sk-pp-";

/** API key from any of the four accepted styles: Authorization Bearer, x-api-key, x-goog-api-key, ?key= */
export function extractApiKey(headers: Headers, url: URL): string | null {
  const candidates: string[] = [];
  const auth = headers.get("authorization");
  if (auth) {
    const m = /^\s*bearer\s+(.+)$/i.exec(auth);
    if (m) candidates.push(m[1].trim());
  }
  for (const h of ["x-api-key", "x-goog-api-key"]) {
    const v = headers.get(h);
    if (v) candidates.push(v.trim());
  }
  const q = url.searchParams.get("key");
  if (q) candidates.push(q.trim());
  const filtered = candidates.filter(Boolean);
  if (!filtered.length) return null;
  return filtered.find((c) => c.startsWith(KEY_PREFIX)) ?? filtered[0];
}

/** Effective group: key override > user group > default group. */
export function effectiveGroup(snap: ConfigSnapshot, rec: AuthRecord): GroupRec | null {
  if (rec.key.groupId) {
    const g = snap.groupsById.get(rec.key.groupId);
    if (g) return g;
  }
  if (rec.user.groupId) {
    const g = snap.groupsById.get(rec.user.groupId);
    if (g) return g;
  }
  return snap.defaultGroup;
}

/** Authenticate the request's API key and run the key / user checks (PLAN 5 step 3). Throws GatewayError. */
export async function authenticate(ctx: Ctx): Promise<void> {
  const snap = ctx.snap!;
  const raw = extractApiKey(ctx.req.headers, ctx.url);
  if (!raw) {
    noteAuthFailure(ctx.ip);
    throw new GatewayError("invalid_api_key", "No API key provided. Send it as 'Authorization: Bearer <key>', 'x-api-key', 'x-goog-api-key' or '?key='.");
  }
  if (!raw.startsWith(KEY_PREFIX) || raw.length > 200) {
    noteAuthFailure(ctx.ip);
    throw new GatewayError("invalid_api_key");
  }
  const hash = sha256(raw);
  // An IP that keeps presenting garbage keys only gets answers from the cache (known good keys keep working,
  // unknown ones are rejected without touching the database).
  const throttled = isAuthThrottled(ctx.ip);
  const rec = throttled ? peekAuthRecord(hash) : await getAuthRecord(hash);
  if (throttled && !rec) throw new GatewayError("rate_limited", "Too many failed authentication attempts. Please retry later.", { retryAfterSec: 30 });
  if (!rec) {
    noteAuthFailure(ctx.ip);
    throw new GatewayError("invalid_api_key");
  }
  ctx.auth = rec;
  ctx.group = effectiveGroup(snap, rec);
  const now = Date.now();
  const { key, user } = rec;

  if (key.status === "DISABLED") throw new GatewayError("key_disabled");
  if (key.status === "REVOKED") throw new GatewayError("key_disabled", "This API key has been revoked.");
  if (key.expiresAt && key.expiresAt <= now) throw new GatewayError("key_expired");
  if (key.ipAllowlist.length && !ipAllowed(ctx.ip, key.ipAllowlist)) throw new GatewayError("ip_not_allowed");
  if (user.status === "SUSPENDED") throw new GatewayError("account_suspended");
  if (user.status === "PENDING_VERIFICATION" && snap.settings.requireEmailVerification) throw new GatewayError("email_not_verified");

  if (key.spendLimit && key.spent.plus(rec.spentDelta).gte(key.spendLimit)) {
    throw new GatewayError("spend_limit_reached", "This API key has reached its spend limit.");
  }
  if (user.monthlySpendLimit) {
    const spent = await userMonthlySpend(user.id);
    if (spent.gte(user.monthlySpendLimit)) throw new GatewayError("spend_limit_reached", "The monthly spend limit for this account has been reached.");
  }
}
