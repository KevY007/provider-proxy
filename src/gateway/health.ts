import { openHeaders } from "@/lib/secret-headers";
import { describeNetworkError } from "./util";
import type { HealthStatus } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { broadcastKeyState, invalidateGatewayConfig } from "./cache";
import { buildUpstreamHeaders, type AdapterProvider } from "./providers/adapters";
import { maxTokensParamFor, parseRetryAfter } from "./shape";
import type { InboundFormat, JsonObject } from "./types";
import { ClientAbortError, UpstreamTimeoutError, readErrorBody, sendUpstream } from "./upstream";
import { isObject } from "./util";

export type HealthResult = { ok: boolean; latencyMs: number | null; error?: string };

const CHECK_TIMEOUT_MS = 15_000;
const trimSlash = (s: string) => s.replace(/\/+$/, "");

type ProviderRow = NonNullable<Awaited<ReturnType<typeof loadKey>>>["provider"];

async function loadKey(id: string) {
  return db.providerKey.findUnique({ where: { id }, include: { provider: true } });
}

/** The provider fields an adapter needs (a saved row or an admin-form draft). */
export type AdapterSource = Pick<ProviderRow, "slug" | "preset" | "baseUrl" | "authStyle" | "tags" | "extraHeaders" | "settings">;

export function toAdapter(p: AdapterSource): AdapterProvider {
  const headers = openHeaders(p.extraHeaders);
  return {
    slug: p.slug,
    preset: p.preset,
    baseUrl: trimSlash(p.baseUrl),
    authStyle: p.authStyle,
    tags: p.tags,
    extraHeaders: headers,
    settings: isObject(p.settings) ? p.settings : {},
  };
}

interface Probe {
  url: string;
  format: InboundFormat;
  method: "GET" | "POST";
  body?: JsonObject;
  /** Extra statuses that still prove the credential works (e.g. 404 for "no such job" on fal). */
  accept?: number[];
}

/** Cheap "list models" probe for the provider's primary surface. */
function listProbe(p: AdapterProvider, formats: string[]): Probe {
  const s = p.settings;
  const str = (v: unknown) => (typeof v === "string" && v ? trimSlash(v) : undefined);
  // fal.ai has no cheap authenticated "whoami": ask the queue for a job that cannot exist. A valid key answers 404
  // (NOT_FOUND), a bad one 401. Free, no job is created.
  if (p.preset === "fal") {
    const queue = str(s.queueBaseUrl) ?? "https://queue.fal.run";
    return { url: `${queue}/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status`, format: "openai_images", method: "GET", accept: [404] };
  }
  if (p.preset === "replicate") return { url: `${p.baseUrl}/account`, format: "openai_images", method: "GET" };
  const hasOpenAI = formats.some((f) => f.startsWith("openai_"));
  if (p.preset === "azure" || p.authStyle === "AZURE_API_KEY") {
    return { url: `${p.baseUrl}/openai/models?api-version=${encodeURIComponent(str(s.azureApiVersion) ?? "2025-04-01-preview")}`, format: "openai_chat", method: "GET" };
  }
  if (p.preset === "google") {
    return { url: `${p.baseUrl.replace(/\/v1(beta)?$/, "")}/v1beta/models?pageSize=1`, format: "gemini", method: "GET" };
  }
  if (hasOpenAI) return { url: `${str(s.openaiBaseUrl) ?? p.baseUrl}/models`, format: "openai_chat", method: "GET" };
  if (formats.includes("anthropic_messages")) {
    return { url: `${(str(s.anthropicBaseUrl) ?? p.baseUrl).replace(/\/v1$/, "")}/v1/models?limit=1`, format: "anthropic_messages", method: "GET" };
  }
  const root = (str(s.geminiBaseUrl) ?? p.baseUrl).replace(/\/v1(beta)?$/, "");
  return { url: `${root}/v1beta/models?pageSize=1`, format: "gemini", method: "GET" };
}

/** 1-token completion probe for providers that do not expose a models list. */
function completionProbe(p: AdapterProvider, formats: string[], upstreamModel: string): Probe {
  const s = p.settings;
  const str = (v: unknown) => (typeof v === "string" && v ? trimSlash(v) : undefined);
  if (formats.some((f) => f.startsWith("openai_"))) {
    const param = maxTokensParamFor({ preset: p.preset, settings: s });
    const root = p.preset === "google" ? `${p.baseUrl.replace(/\/v1(beta)?$/, "")}/v1beta/openai` : (str(s.openaiBaseUrl) ?? p.baseUrl);
    return { url: `${root}/chat/completions`, format: "openai_chat", method: "POST", body: { model: upstreamModel, messages: [{ role: "user", content: "ping" }], [param]: 1 } };
  }
  if (formats.includes("anthropic_messages")) {
    return {
      url: `${(str(s.anthropicBaseUrl) ?? p.baseUrl).replace(/\/v1$/, "")}/v1/messages`,
      format: "anthropic_messages",
      method: "POST",
      body: { model: upstreamModel, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    };
  }
  const root = (str(s.geminiBaseUrl) ?? p.baseUrl).replace(/\/v1(beta)?$/, "");
  return {
    url: `${root}/v1beta/models/${encodeURIComponent(upstreamModel)}:generateContent`,
    format: "gemini",
    method: "POST",
    body: { contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1 } },
  };
}

async function runProbe(adapter: AdapterProvider, probe: Probe, secret: string, keyExtra: JsonObject, timeoutMs: number) {
  const headers = buildUpstreamHeaders({ provider: adapter, format: probe.format, secret, stream: false, keyExtra, hasBody: !!probe.body });
  let url = probe.url;
  if (adapter.authStyle === "QUERY_KEY") url += (url.includes("?") ? "&" : "?") + `key=${encodeURIComponent(secret)}`;
  const t0 = Date.now();
  try {
    const h = await sendUpstream({ url, method: probe.method, headers, body: probe.body ? JSON.stringify(probe.body) : null, timeoutMs });
    const text = await readErrorBody(h.res, 4096);
    const retryAfterSec = parseRetryAfter(h.res.headers);
    h.dispose();
    return { status: h.res.status, latencyMs: Date.now() - t0, text, retryAfterSec };
  } catch (err) {
    if (err instanceof UpstreamTimeoutError) return { status: 0, latencyMs: Date.now() - t0, text: `timeout after ${timeoutMs}ms`, retryAfterSec: undefined };
    if (err instanceof ClientAbortError) return { status: 0, latencyMs: Date.now() - t0, text: "aborted", retryAfterSec: undefined };
    return { status: 0, latencyMs: Date.now() - t0, text: describeNetworkError(err), retryAfterSec: undefined };
  }
}

type ProbeResult = Awaited<ReturnType<typeof runProbe>>;

/** What a failed probe says about the credential. */
export type ProbeVerdict = { kind: "invalid" } | { kind: "cooldown"; seconds: number; why: string } | { kind: "none" };

/** 401/403 = bad credential (INVALID), 429 = rate limited (COOLDOWN with retry-after), 402 / "balance exhausted" = COOLDOWN 10 min. */
export function judgeProbe(preset: string, r: Pick<ProbeResult, "status" | "text" | "retryAfterSec">, keyCooldownSeconds: number): ProbeVerdict {
  const paymentLike = /locked|exhaust|balance|insufficient|quota|billing|payment/i.test(r.text);
  if (r.status === 429) return { kind: "cooldown", seconds: Math.min(3600, Math.max(1, r.retryAfterSec ?? keyCooldownSeconds)), why: "rate limited" };
  if (r.status === 402 || (r.status === 403 && preset === "fal" && paymentLike)) return { kind: "cooldown", seconds: 600, why: "account out of credit" };
  if (r.status === 401 || r.status === 403) return { kind: "invalid" };
  return { kind: "none" };
}

/** Check one upstream key: records a HealthCheck row, refreshes key state and the provider's aggregate health. */
export async function checkProviderKey(providerKeyId: string): Promise<HealthResult> {
  const row = await loadKey(providerKeyId);
  if (!row) return { ok: false, latencyMs: null, error: "provider key not found" };
  const provider = row.provider;
  const adapter = toAdapter(provider);
  let secret: string;
  try {
    secret = decrypt(row.secretEncrypted);
  } catch {
    const res: HealthResult = { ok: false, latencyMs: null, error: "secret could not be decrypted (ENCRYPTION_KEY mismatch?)" };
    await record(provider.id, row.id, res);
    return res;
  }
  const keyExtra = isObject(row.extra) ? row.extra : {};
  const timeout = Math.min(provider.timeoutMs, CHECK_TIMEOUT_MS);

  const probe = listProbe(adapter, provider.formats);
  let r = await runProbe(adapter, probe, secret, keyExtra, timeout);
  const accepted = !!probe.accept?.includes(r.status);
  const hasChatProbe = adapter.preset !== "fal" && adapter.preset !== "replicate";
  if (!accepted && hasChatProbe && (r.status === 404 || r.status === 405 || r.status === 400 || r.status === 501)) {
    const route = await db.modelRoute.findFirst({ where: { providerId: provider.id, enabled: true }, orderBy: { priority: "desc" } });
    if (route) r = await runProbe(adapter, completionProbe(adapter, provider.formats, route.upstreamModel), secret, keyExtra, timeout);
  }
  // 401 / 403 on the models list: a key restricted to specific scopes may still be able to call the model, so confirm
  // with a 1-token completion before declaring it invalid
  if (!accepted && hasChatProbe && (r.status === 401 || r.status === 403)) {
    const route = await db.modelRoute.findFirst({ where: { providerId: provider.id, enabled: true }, orderBy: { priority: "desc" } });
    if (route) r = await runProbe(adapter, completionProbe(adapter, provider.formats, route.upstreamModel), secret, keyExtra, timeout);
  }
  const ok = (r.status >= 200 && r.status < 300) || accepted;
  const result: HealthResult = ok ? { ok, latencyMs: r.latencyMs } : { ok, latencyMs: r.latencyMs, error: `${r.status || "network"}: ${r.text.replace(/\s+/g, " ").slice(0, 200)}` };
  await record(provider.id, row.id, result);

  // key state
  try {
    if (ok) {
      const revive = row.status === "INVALID" || (row.status === "COOLDOWN" && (!row.cooldownUntil || row.cooldownUntil.getTime() <= Date.now()));
      if (revive || row.consecutiveFailures > 0) {
        await db.providerKey.update({
          where: { id: row.id },
          data: { consecutiveFailures: 0, ...(revive ? { status: "ACTIVE" as const, cooldownUntil: null } : {}) },
        });
        void invalidateGatewayConfig("providers", row.id);
      }
    } else if (result.error) {
      const data: { lastError: string; status?: "INVALID" | "COOLDOWN"; cooldownUntil?: Date | null } = { lastError: `health: ${result.error}`.slice(0, 500) };
      let cooldownUntil: number | null = null;
      if (row.status !== "DISABLED") {
        const verdict = judgeProbe(provider.preset, r, (await getSettings()).keyCooldownSeconds);
        if (verdict.kind === "invalid") {
          data.status = "INVALID";
          data.cooldownUntil = null;
        } else if (verdict.kind === "cooldown") {
          cooldownUntil = Date.now() + verdict.seconds * 1000;
          data.status = "COOLDOWN";
          data.cooldownUntil = new Date(cooldownUntil);
        }
      }
      await db.providerKey.update({ where: { id: row.id }, data });
      if (data.status) {
        logger.warn("health check changed an upstream key state", { providerKeyId: row.id, status: data.status, httpStatus: r.status });
        await invalidateGatewayConfig("providers", row.id);
        void broadcastKeyState(row.id, data.status, cooldownUntil, row.consecutiveFailures).catch(() => undefined);
      }
    }
  } catch (err) {
    logger.warn("health: key update failed", { providerKeyId: row.id, err });
  }
  await refreshProviderHealth(provider.id);
  return result;
}

async function record(providerId: string, providerKeyId: string, r: HealthResult): Promise<void> {
  try {
    await db.healthCheck.create({ data: { providerId, providerKeyId, ok: r.ok, latencyMs: r.latencyMs, error: r.error ?? null } });
  } catch (err) {
    logger.warn("health: could not store HealthCheck", { err });
  }
}

/** Provider.healthStatus from the latest check of each key (+ passive request error rate). */
export async function refreshProviderHealth(providerId: string): Promise<HealthStatus> {
  const keys = await db.providerKey.findMany({ where: { providerId, status: { not: "DISABLED" } }, select: { id: true } });
  if (!keys.length) {
    await db.provider.update({ where: { id: providerId }, data: { healthStatus: "UNKNOWN", lastCheckAt: new Date() } }).catch(() => undefined);
    return "UNKNOWN";
  }
  const latest = await db.healthCheck.findMany({
    where: { providerId, providerKeyId: { in: keys.map((k) => k.id) } },
    orderBy: { createdAt: "desc" },
    take: keys.length * 3,
  });
  const seen = new Set<string>();
  const results: Array<{ ok: boolean; latencyMs: number | null }> = [];
  for (const c of latest) {
    if (!c.providerKeyId || seen.has(c.providerKeyId)) continue;
    seen.add(c.providerKeyId);
    results.push({ ok: c.ok, latencyMs: c.latencyMs });
  }
  let status: HealthStatus = "UNKNOWN";
  if (results.length) {
    const okCount = results.filter((r) => r.ok).length;
    status = okCount === results.length ? "OPERATIONAL" : okCount === 0 ? "DOWN" : "DEGRADED";
  }
  // passive signal: recent error rate on real traffic
  try {
    const since = new Date(Date.now() - 10 * 60_000);
    const [total, bad] = await Promise.all([
      db.requestLog.count({ where: { providerId, createdAt: { gte: since } } }),
      db.requestLog.count({ where: { providerId, createdAt: { gte: since }, status: "UPSTREAM_ERROR" } }),
    ]);
    if (total >= 10) {
      const rate = bad / total;
      if (rate > 0.5) status = "DOWN";
      else if (rate > 0.2 && status === "OPERATIONAL") status = "DEGRADED";
    }
  } catch {
    /* passive signal is best effort */
  }
  const lat = results.filter((r) => r.ok && r.latencyMs !== null).map((r) => r.latencyMs as number);
  await db.provider
    .update({
      where: { id: providerId },
      data: { healthStatus: status, lastCheckAt: new Date(), ...(lat.length ? { lastLatencyMs: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) } : {}) },
    })
    .catch((err) => logger.warn("health: provider update failed", { providerId, err }));
  return status;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Check every non-disabled key of a provider. */
export async function checkProvider(providerId: string): Promise<HealthResult[]> {
  const keys = await db.providerKey.findMany({ where: { providerId, status: { not: "DISABLED" } }, select: { id: true } });
  const results = await mapLimit(keys, 4, (k) =>
    checkProviderKey(k.id).catch((err): HealthResult => ({ ok: false, latencyMs: null, error: err instanceof Error ? err.message : String(err) })),
  );
  if (!keys.length) await refreshProviderHealth(providerId);
  return results;
}

/** Cron entry: check all keys of all ACTIVE providers; prunes old HealthCheck rows. */
export async function runAllHealthChecks(): Promise<{ checked: number; failed: number }> {
  const providers = await db.provider.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  const all = await mapLimit(providers, 4, (p) => checkProvider(p.id).catch(() => [] as HealthResult[]));
  const flat = all.flat();
  db.healthCheck.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 14 * 86_400_000) } } }).catch(() => undefined);
  return { checked: flat.length, failed: flat.filter((r) => !r.ok).length };
}

/**
 * Provider.healthStatus / lastLatencyMs from REAL traffic only (no upstream request is made): the last 15 minutes of
 * calls per active provider. A provider without calls keeps its previous status. Used by the cron when active health
 * probes are off (the default).
 */
export async function refreshPassiveHealth(windowMs = 15 * 60_000): Promise<{ updated: number }> {
  const since = new Date(Date.now() - windowMs);
  const rows = await db.$queryRaw<Array<{ providerId: string; total: number; bad: number; p50: number | null }>>`
    SELECT r."providerId" AS "providerId",
      count(*)::float8 AS total,
      (count(*) FILTER (WHERE r."status" = 'UPSTREAM_ERROR'))::float8 AS bad,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY r."latencyMs") FILTER (WHERE r."status" = 'SUCCESS' AND r."latencyMs" > 0) AS p50
    FROM "RequestLog" r
    JOIN "Provider" p ON p."id" = r."providerId" AND p."status" = 'ACTIVE'
    WHERE r."createdAt" >= ${since} AND r."batchId" IS NULL AND r."status" IN ('SUCCESS', 'UPSTREAM_ERROR')
    GROUP BY 1`;
  let updated = 0;
  for (const r of rows) {
    const total = Number(r.total);
    if (!total) continue;
    const rate = Number(r.bad) / total;
    const status: HealthStatus = rate > 0.5 ? "DOWN" : rate > 0.2 ? "DEGRADED" : "OPERATIONAL";
    await db.provider
      .update({ where: { id: r.providerId }, data: { healthStatus: status, lastCheckAt: new Date(), ...(r.p50 !== null ? { lastLatencyMs: Math.round(Number(r.p50)) } : {}) } })
      .then(() => updated++)
      .catch((err) => logger.warn("health: passive update failed", { providerId: r.providerId, err }));
  }
  return { updated };
}
