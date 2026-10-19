import { openHeaders } from "@/lib/secret-headers";
import type { BillingMode, KeyStatus, ModelStatus, ProviderKeyStatus, ProviderStatus, Role, UserStatus } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { Decimal, toDecimal } from "@/lib/money";
import { logger } from "@/lib/logger";
import { CONFIG_INVALIDATE_CHANNEL, getRedis, getRedisSubscriber, publishConfigInvalidate } from "@/lib/redis";
import { getSettings, invalidateSettingsCache, type SettingValues } from "@/lib/settings";
import { costTable, officialTable, sellTable, type LongContext, type OptTable, type PriceTable } from "./pricing";
import type { JsonObject } from "./types";
import { isObject } from "./util";

/**
 * Hot-path config cache (PLAN 9b): providers, upstream keys (secrets decrypted lazily, once), models, routes,
 * groups and settings live in ONE in-process snapshot with a 30s TTL (stale-while-revalidate, so requests never
 * block on the DB once warm). API keys + their user are cached per key hash (30s).
 *
 * Invalidation: `invalidateGatewayConfig()` clears local caches immediately and broadcasts on the Redis
 * `config:invalidate` channel so every instance drops its caches too.
 */
export type InvalidateScope = "all" | "providers" | "models" | "groups" | "settings" | "users" | "apiKeys";

const TTL_MS = 30_000;
const NEG_TTL_MS = 3_000;

// ------------------------------------------------------------------ record types
export interface ProviderRec {
  id: string;
  name: string;
  slug: string;
  preset: string;
  baseUrl: string;
  authStyle: "BEARER" | "X_API_KEY" | "X_GOOG_API_KEY" | "AZURE_API_KEY" | "QUERY_KEY";
  formats: Set<string>;
  tags: string[];
  extraHeaders: Record<string, string>;
  settings: JsonObject;
  status: ProviderStatus;
  timeoutMs: number;
  priority: number;
  maxConcurrency: number | null;
}

export interface KeyRec {
  id: string;
  providerId: string;
  label: string;
  secretEncrypted: string;
  status: ProviderKeyStatus;
  weight: number;
  priority: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  maxConcurrency: number | null;
  dailyBudget: Decimal | null;
  cooldownUntil: number | null;
  consecutiveFailures: number;
  extra: JsonObject;
}

export interface ModelRec {
  id: string;
  slug: string;
  aliases: string[];
  displayName: string;
  vendor: string;
  description: string | null;
  capabilities: Set<string>;
  contextWindow: number | null;
  maxOutput: number | null;
  status: ModelStatus;
  sortOrder: number;
  maskUpstreamModel: boolean;
  sell: PriceTable;
  /** Official (maker list) prices; null per unit = unknown. Used for the per-request savings (`RequestLog.officialPrice`). */
  official: OptTable;
  /** Upstream retirement date (ms) when announced. */
  retiresAt: number | null;
  longContext: LongContext;
  /** Batch API: percent taken off the token prices of batch results (null = the vendors' 50). */
  batchDiscountPct?: Decimal | null;
  createdAt: number;
}

export interface RouteRec {
  id: string;
  modelId: string;
  providerId: string;
  provider: ProviderRec;
  upstreamModel: string;
  label: string | null;
  priority: number;
  weight: number;
  groupSlugs: string[];
  paramOverrides: JsonObject;
  maxOutputTokens: number | null;
  cost: PriceTable;
  /** Batch API: percent the supplier takes off the token prices of batch results. */
  batchCostDiscountPct?: Decimal;
  /** The route cost follows the provider's published price (re-read lazily during calls). */
  autoCostSync?: boolean;
  autoCostSyncedAt?: number | null;
}

export interface GroupRec {
  id: string;
  slug: string;
  name: string;
  priceMultiplier: Decimal;
  providerTags: string[];
  allowedModels: Set<string> | null;
  isDefault: boolean;
  isPublic: boolean;
  rpmLimit: number | null;
  maxConcurrency: number | null;
}

export interface ConfigSnapshot {
  loadedAt: number;
  settings: SettingValues;
  providers: Map<string, ProviderRec>;
  keysByProvider: Map<string, KeyRec[]>;
  modelsById: Map<string, ModelRec>;
  modelsBySlug: Map<string, ModelRec>;
  modelsByAlias: Map<string, ModelRec>; // lower-cased alias or slug
  routesByModel: Map<string, RouteRec[]>;
  groupsById: Map<string, GroupRec>;
  groupsBySlug: Map<string, GroupRec>;
  defaultGroup: GroupRec | null;
}

// ------------------------------------------------------------------ state
interface Cell {
  snapshot: ConfigSnapshot | null;
  dirty: boolean;
  loading: Promise<ConfigSnapshot> | null;
  auth: Map<string, { rec: AuthRecord; at: number }>;
  authLoading: Map<string, Promise<AuthRecord | null>>;
  negative: Map<string, number>;
  secrets: Map<string, { enc: string; plain: string }>;
  runtime: Map<string, KeyRuntime>;
  subscribed: boolean;
  version: number;
}

const g = globalThis as unknown as { __ppCache?: Cell };
const cell: Cell = (g.__ppCache ??= {
  snapshot: null,
  dirty: false,
  loading: null,
  auth: new Map(),
  authLoading: new Map(),
  negative: new Map(),
  secrets: new Map(),
  runtime: new Map(),
  subscribed: false,
  version: 0,
});

// ------------------------------------------------------------------ snapshot loading
function asRecord(v: unknown): JsonObject {
  return isObject(v) ? v : {};
}

function headersRecord(v: unknown): Record<string, string> {
  return openHeaders(v); // (credential-like values are stored encrypted)
}

async function loadSnapshot(): Promise<ConfigSnapshot> {
  invalidateSettingsCache();
  const [settings, providerRows, keyRows, modelRows, routeRows, groupRows] = await Promise.all([
    getSettings(),
    db.provider.findMany(),
    db.providerKey.findMany(),
    db.model.findMany({ where: { status: { not: "DISABLED" } } }),
    db.modelRoute.findMany({ where: { enabled: true } }),
    db.group.findMany(),
  ]);

  const providers = new Map<string, ProviderRec>();
  for (const p of providerRows) {
    providers.set(p.id, {
      id: p.id,
      name: p.name,
      slug: p.slug,
      preset: p.preset,
      baseUrl: p.baseUrl.replace(/\/+$/, ""),
      authStyle: p.authStyle,
      formats: new Set(p.formats),
      tags: p.tags,
      extraHeaders: headersRecord(p.extraHeaders),
      settings: asRecord(p.settings),
      status: p.status,
      timeoutMs: p.timeoutMs,
      priority: p.priority,
      maxConcurrency: p.maxConcurrency,
    });
  }

  const keysByProvider = new Map<string, KeyRec[]>();
  for (const k of keyRows) {
    const rec: KeyRec = {
      id: k.id,
      providerId: k.providerId,
      label: k.label,
      secretEncrypted: k.secretEncrypted,
      status: k.status,
      weight: Math.max(1, k.weight),
      priority: k.priority,
      rpmLimit: k.rpmLimit,
      tpmLimit: k.tpmLimit,
      maxConcurrency: k.maxConcurrency,
      dailyBudget: k.dailyBudget ? toDecimal(k.dailyBudget) : null,
      cooldownUntil: k.cooldownUntil ? k.cooldownUntil.getTime() : null,
      consecutiveFailures: k.consecutiveFailures,
      extra: asRecord(k.extra),
    };
    const arr = keysByProvider.get(k.providerId);
    if (arr) arr.push(rec);
    else keysByProvider.set(k.providerId, [rec]);
  }

  const modelsById = new Map<string, ModelRec>();
  const modelsBySlug = new Map<string, ModelRec>();
  const modelsByAlias = new Map<string, ModelRec>();
  for (const m of modelRows) {
    const rec: ModelRec = {
      id: m.id,
      slug: m.slug,
      aliases: m.aliases,
      displayName: m.displayName,
      vendor: m.vendor,
      description: m.description,
      capabilities: new Set(m.capabilities),
      contextWindow: m.contextWindow,
      maxOutput: m.maxOutput,
      status: m.status,
      sortOrder: m.sortOrder,
      maskUpstreamModel: m.maskUpstreamModel,
      sell: sellTable(m),
      official: officialTable(m),
      retiresAt: m.retiresAt ? m.retiresAt.getTime() : null,
      longContext: { threshold: m.longContextThreshold, multiplier: m.longContextMultiplier ? toDecimal(m.longContextMultiplier) : null },
      batchDiscountPct: m.batchDiscountPct === null ? null : toDecimal(m.batchDiscountPct),
      createdAt: m.createdAt.getTime(),
    };
    modelsById.set(m.id, rec);
    modelsBySlug.set(m.slug, rec);
  }
  for (const m of modelsById.values()) {
    modelsByAlias.set(m.slug.toLowerCase(), m);
  }
  for (const m of modelsById.values()) {
    for (const a of m.aliases) if (!modelsByAlias.has(a.toLowerCase())) modelsByAlias.set(a.toLowerCase(), m);
  }

  const routesByModel = new Map<string, RouteRec[]>();
  for (const r of routeRows) {
    const provider = providers.get(r.providerId);
    if (!provider || !modelsById.has(r.modelId)) continue;
    const rec: RouteRec = {
      id: r.id,
      modelId: r.modelId,
      providerId: r.providerId,
      provider,
      upstreamModel: r.upstreamModel,
      label: r.label,
      priority: r.priority,
      weight: Math.max(1, r.weight),
      groupSlugs: r.groupSlugs,
      paramOverrides: asRecord(r.paramOverrides),
      maxOutputTokens: r.maxOutputTokens,
      cost: costTable(r),
      batchCostDiscountPct: toDecimal(r.batchCostDiscountPct, 50),
      autoCostSync: r.autoCostSync,
      autoCostSyncedAt: r.autoCostSyncedAt ? r.autoCostSyncedAt.getTime() : null,
    };
    const arr = routesByModel.get(r.modelId);
    if (arr) arr.push(rec);
    else routesByModel.set(r.modelId, [rec]);
  }

  const groupsById = new Map<string, GroupRec>();
  const groupsBySlug = new Map<string, GroupRec>();
  let defaultGroup: GroupRec | null = null;
  for (const gr of groupRows) {
    const rec: GroupRec = {
      id: gr.id,
      slug: gr.slug,
      name: gr.name,
      priceMultiplier: toDecimal(gr.priceMultiplier, 1),
      providerTags: gr.providerTags,
      allowedModels: gr.allowedModels.length ? new Set(gr.allowedModels) : null,
      isDefault: gr.isDefault,
      isPublic: gr.isPublic,
      rpmLimit: gr.rpmLimit,
      maxConcurrency: gr.maxConcurrency,
    };
    groupsById.set(gr.id, rec);
    groupsBySlug.set(gr.slug, rec);
    if (gr.isDefault && !defaultGroup) defaultGroup = rec;
  }
  if (!defaultGroup) defaultGroup = groupsBySlug.get(settings.defaultGroupSlug) ?? null;

  return { loadedAt: Date.now(), settings, providers, keysByProvider, modelsById, modelsBySlug, modelsByAlias, routesByModel, groupsById, groupsBySlug, defaultGroup };
}

async function refresh(): Promise<ConfigSnapshot> {
  if (cell.loading) return cell.loading;
  const startedAt = Date.now();
  cell.dirty = false;
  cell.loading = loadSnapshot()
    .then((snap) => {
      cell.snapshot = snap;
      // DB now reflects older runtime key-state changes
      for (const [id, rt] of cell.runtime) if (rt.at < startedAt - 1000) cell.runtime.delete(id);
      return snap;
    })
    .catch((err) => {
      logger.error("gateway config load failed", { err });
      if (cell.snapshot) {
        cell.dirty = true; // retry on next request
        return cell.snapshot;
      }
      throw err;
    })
    .finally(() => {
      cell.loading = null;
    });
  return cell.loading;
}

/** The current config snapshot (SWR: stale snapshots are served while a background refresh runs). */
export async function getConfig(): Promise<ConfigSnapshot> {
  ensureSubscribed();
  const s = cell.snapshot;
  if (s && !cell.dirty) {
    if (Date.now() - s.loadedAt > TTL_MS && !cell.loading) void refresh().catch(() => undefined);
    return s;
  }
  return refresh();
}

/** Look a model up by slug or alias (case-insensitive fallback). Accepts Gemini-style "models/<id>". */
export function resolveModel(snap: ConfigSnapshot, name: string): ModelRec | null {
  const n = name.startsWith("models/") ? name.slice(7) : name;
  return snap.modelsBySlug.get(n) ?? snap.modelsByAlias.get(n.toLowerCase()) ?? null;
}

/** Decrypt an upstream key's secret (memoised per key id + ciphertext). Null when it cannot be decrypted. */
export function getKeySecret(k: KeyRec): string | null {
  const hit = cell.secrets.get(k.id);
  if (hit && hit.enc === k.secretEncrypted) return hit.plain;
  try {
    const plain = decrypt(k.secretEncrypted);
    cell.secrets.set(k.id, { enc: k.secretEncrypted, plain });
    return plain;
  } catch (err) {
    logger.error("failed to decrypt upstream key", { providerKeyId: k.id, err });
    return null;
  }
}

// ------------------------------------------------------------------ runtime upstream-key state (overlay)
export interface KeyRuntime {
  status?: ProviderKeyStatus;
  cooldownUntil?: number | null;
  consecutiveFailures?: number;
  authFailStreak?: number;
  lastError?: string;
  at: number;
}

export function getKeyRuntime(id: string): KeyRuntime | undefined {
  return cell.runtime.get(id);
}

export function setKeyRuntime(id: string, patch: Partial<KeyRuntime>): KeyRuntime {
  const cur = cell.runtime.get(id) ?? { at: Date.now() };
  const next = { ...cur, ...patch, at: Date.now() };
  cell.runtime.set(id, next);
  return next;
}

/** Effective status of an upstream key after applying in-process runtime changes. */
export function effectiveKeyState(k: KeyRec): { status: ProviderKeyStatus; cooldownUntil: number | null; consecutiveFailures: number } {
  const rt = cell.runtime.get(k.id);
  return {
    status: rt?.status ?? k.status,
    cooldownUntil: rt?.cooldownUntil !== undefined ? rt.cooldownUntil : k.cooldownUntil,
    consecutiveFailures: rt?.consecutiveFailures ?? k.consecutiveFailures,
  };
}

/** Usable now? (ACTIVE, or COOLDOWN whose cooldown elapsed; EXHAUSTED/INVALID/DISABLED never.) */
export function isKeyUsable(k: KeyRec, now = Date.now()): boolean {
  const s = effectiveKeyState(k);
  if (s.status === "DISABLED" || s.status === "INVALID" || s.status === "EXHAUSTED") return false;
  if (s.cooldownUntil && s.cooldownUntil > now) return false;
  return true;
}

// ------------------------------------------------------------------ API-key authentication cache
export interface AuthUser {
  id: string;
  email: string;
  status: UserStatus;
  role: Role;
  emailVerifiedAt: Date | null;
  groupId: string | null;
  priceMultiplier: Decimal | null;
  balance: Decimal;
  creditLimit: Decimal;
  billingMode: BillingMode;
  monthlySpendLimit: Decimal | null;
  autoRechargeEnabled: boolean;
  autoRechargeThreshold: Decimal;
  lowBalanceAlertAt: Decimal | null;
  maxConcurrency: number | null;
}

export interface AuthKey {
  id: string;
  userId: string;
  name: string;
  status: KeyStatus;
  groupId: string | null;
  allowedModels: Set<string> | null;
  ipAllowlist: string[];
  rpmLimit: number | null;
  tpmLimit: number | null;
  maxConcurrency: number | null;
  spendLimit: Decimal | null;
  spent: Decimal;
  expiresAt: number | null;
  isPlayground: boolean;
}

export interface AuthRecord {
  key: AuthKey;
  user: AuthUser;
  loadedAt: number;
  /** Price settled locally since this record was loaded (keeps spendLimit checks current between reloads). */
  spentDelta: Decimal;
}

async function loadAuth(hash: string): Promise<AuthRecord | null> {
  const row = await db.apiKey.findUnique({
    where: { keyHash: hash },
    select: {
      id: true,
      userId: true,
      name: true,
      status: true,
      groupId: true,
      allowedModels: true,
      ipAllowlist: true,
      rpmLimit: true,
      tpmLimit: true,
      maxConcurrency: true,
      spendLimit: true,
      spent: true,
      expiresAt: true,
      isPlayground: true,
      user: {
        select: {
          id: true,
          email: true,
          status: true,
          role: true,
          emailVerifiedAt: true,
          groupId: true,
          priceMultiplier: true,
          balance: true,
          creditLimit: true,
          billingMode: true,
          monthlySpendLimit: true,
          autoRechargeEnabled: true,
          autoRechargeThreshold: true,
          lowBalanceAlertAt: true,
          maxConcurrency: true,
        },
      },
    },
  });
  if (!row) return null;
  const u = row.user;
  return {
    loadedAt: Date.now(),
    spentDelta: new Decimal(0),
    key: {
      id: row.id,
      userId: row.userId,
      name: row.name,
      status: row.status,
      groupId: row.groupId,
      allowedModels: row.allowedModels.length ? new Set(row.allowedModels) : null,
      ipAllowlist: row.ipAllowlist,
      rpmLimit: row.rpmLimit,
      tpmLimit: row.tpmLimit,
      maxConcurrency: row.maxConcurrency,
      spendLimit: row.spendLimit ? toDecimal(row.spendLimit) : null,
      spent: toDecimal(row.spent),
      expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
      isPlayground: row.isPlayground,
    },
    user: {
      id: u.id,
      email: u.email,
      status: u.status,
      role: u.role,
      emailVerifiedAt: u.emailVerifiedAt,
      groupId: u.groupId,
      priceMultiplier: u.priceMultiplier ? toDecimal(u.priceMultiplier) : null,
      balance: toDecimal(u.balance),
      creditLimit: toDecimal(u.creditLimit),
      billingMode: u.billingMode,
      monthlySpendLimit: u.monthlySpendLimit ? toDecimal(u.monthlySpendLimit) : null,
      autoRechargeEnabled: u.autoRechargeEnabled,
      autoRechargeThreshold: toDecimal(u.autoRechargeThreshold),
      lowBalanceAlertAt: u.lowBalanceAlertAt ? toDecimal(u.lowBalanceAlertAt) : null,
      maxConcurrency: u.maxConcurrency,
    },
  };
}

/**
 * Cached lookup of an API key (by sha256 hash) with its user. Unknown hashes are negative-cached briefly so a
 * flood of garbage keys cannot hammer the database.
 */
export async function getAuthRecord(hash: string): Promise<AuthRecord | null> {
  ensureSubscribed();
  const now = Date.now();
  const hit = cell.auth.get(hash);
  if (hit && now - hit.at < TTL_MS) return hit.rec;
  const neg = cell.negative.get(hash);
  if (neg && neg > now) return null;

  const inflight = cell.authLoading.get(hash);
  if (inflight) return inflight;
  const p = loadAuth(hash)
    .then((rec) => {
      if (rec) {
        cell.auth.set(hash, { rec, at: Date.now() });
        if (cell.auth.size > 50_000) {
          // crude bound: drop the oldest entries
          const drop = [...cell.auth.keys()].slice(0, 5_000);
          for (const k of drop) cell.auth.delete(k);
        }
      } else {
        cell.negative.set(hash, Date.now() + NEG_TTL_MS);
        if (cell.negative.size > 20_000) cell.negative.clear();
      }
      return rec;
    })
    .finally(() => {
      cell.authLoading.delete(hash);
    });
  cell.authLoading.set(hash, p);
  return p;
}

/** Cached auth record without any database access (null when not cached / expired). */
export function peekAuthRecord(hash: string): AuthRecord | null {
  const hit = cell.auth.get(hash);
  return hit && Date.now() - hit.at < TTL_MS ? hit.rec : null;
}

/** Drop the cached auth records of one API key (`revalidateKeyCache(keyId)`) or all of them. */
export function revalidateKeyCache(keyId?: string): void {
  cell.negative.clear();
  if (!keyId) {
    cell.auth.clear();
    return;
  }
  for (const [h, v] of cell.auth) if (v.rec.key.id === keyId) cell.auth.delete(h);
}

function dropAuthForUser(userId?: string): void {
  cell.negative.clear();
  if (!userId) {
    cell.auth.clear();
    return;
  }
  for (const [h, v] of cell.auth) if (v.rec.user.id === userId) cell.auth.delete(h);
}

// ------------------------------------------------------------------ invalidation
type LocalHook = (scope: InvalidateScope, id?: string) => void;
const hooks: LocalHook[] = [];
/** Other gateway modules (balance cache, spend trackers) register to be told about invalidations. */
export function onGatewayInvalidate(hook: LocalHook): void {
  if (!hooks.includes(hook)) hooks.push(hook);
}

function normalizeScope(s: string): InvalidateScope | null {
  switch (s) {
    case "all":
      return "all";
    case "provider":
    case "providers":
    case "providerKey":
    case "providerKeys":
    case "route":
    case "routes":
      return "providers";
    case "model":
    case "models":
      return "models";
    case "group":
    case "groups":
      return "groups";
    case "setting":
    case "settings":
      return "settings";
    case "user":
    case "users":
    case "balance":
      return "users";
    case "apikey":
    case "apikeys":
    case "apiKey":
    case "apiKeys":
      return "apiKeys";
    default:
      return null;
  }
}

function applyLocal(scope: InvalidateScope, id?: string): void {
  cell.version++;
  switch (scope) {
    case "all":
      cell.dirty = true;
      cell.auth.clear();
      cell.negative.clear();
      cell.runtime.clear();
      break;
    case "providers":
      cell.dirty = true;
      if (id) cell.runtime.delete(id);
      break;
    case "models":
    case "groups":
      cell.dirty = true;
      break;
    case "settings":
      invalidateSettingsCache();
      cell.dirty = true;
      break;
    case "users":
      dropAuthForUser(id);
      break;
    case "apiKeys":
      revalidateKeyCache(id);
      break;
  }
  for (const h of hooks) {
    try {
      h(scope, id);
    } catch {
      /* hooks must not break invalidation */
    }
  }
}

/** Subscribe to cross-instance invalidations (idempotent; also started lazily by getConfig / getAuthRecord). */
export function startInvalidationListener(): void {
  ensureSubscribed();
}

function ensureSubscribed(): void {
  if (cell.subscribed) return;
  cell.subscribed = true;
  const sub = getRedisSubscriber();
  if (!sub) return;
  sub.subscribe(CONFIG_INVALIDATE_CHANNEL).catch(() => undefined);
  sub.on("message", (channel: string, message: string) => {
    if (channel !== CONFIG_INVALIDATE_CHANNEL) return;
    handleRemoteMessage(message);
  });
}

function handleRemoteMessage(message: string): void {
  if (message.startsWith("pkh:")) {
    // pkh:<providerKeyId>:<status>:<cooldownUntilMs|0>:<failures>
    const [, id, status, until, failures] = message.split(":");
    if (id && status) {
      setKeyRuntime(id, {
        status: status as ProviderKeyStatus,
        cooldownUntil: Number(until) > 0 ? Number(until) : null,
        consecutiveFailures: Number(failures) || 0,
      });
    }
    return;
  }
  const i = message.indexOf(":");
  const scope = normalizeScope(i === -1 ? message : message.slice(0, i));
  if (!scope) return;
  applyLocal(scope, i === -1 ? undefined : message.slice(i + 1) || undefined);
}

/**
 * Call after ANY admin/customer mutation of providers, provider keys, models, routes, groups, settings, users
 * (status/group/multiplier/limits/balance) or API keys. Never throws.
 */
export async function invalidateGatewayConfig(scope: InvalidateScope = "all", id?: string): Promise<void> {
  try {
    applyLocal(scope, id);
    await publishWhenReady(id ? `${scope}:${id}` : scope);
  } catch (err) {
    logger.warn("invalidateGatewayConfig failed", { err });
  }
}

/** Publish on the invalidation channel; a Redis client that is still connecting gets up to 1.5s to become ready. */
async function publishWhenReady(message: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  for (let i = 0; i < 60 && r.status !== "ready"; i++) {
    if (r.status === "end") return;
    await new Promise((res) => setTimeout(res, 25));
  }
  await publishConfigInvalidate(message);
}

/** Broadcast a runtime upstream-key state change (cooldown / INVALID) to the other instances. */
export async function broadcastKeyState(id: string, status: ProviderKeyStatus, cooldownUntil: number | null, failures: number): Promise<void> {
  await publishWhenReady(`pkh:${id}:${status}:${cooldownUntil ?? 0}:${failures}`);
}

/** Test hook. */
export function __resetCacheForTests(): void {
  cell.snapshot = null;
  cell.dirty = false;
  cell.loading = null;
  cell.auth.clear();
  cell.authLoading.clear();
  cell.negative.clear();
  cell.secrets.clear();
  cell.runtime.clear();
}

export function cacheVersion(): number {
  return cell.version;
}
