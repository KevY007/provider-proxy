import { z } from "zod";
import { db } from "./db";
import { logger } from "./logger";
import { CONFIG_INVALIDATE_CHANNEL, getRedisSubscriber, publishConfigInvalidate } from "./redis";

/**
 * Typed runtime settings stored in the `Setting` table (key -> JSON value) with defaults and a 30s
 * in-process cache (invalidated on write and via Redis pub/sub `config:invalidate`).
 *
 *   const trial = await getSetting("trialCredit")        // number
 *   const all = await getSettings()                      // fully typed object with defaults applied
 *   await setSetting("signupEnabled", false)
 *
 * Money-valued settings are plain JSON numbers in USD; wrap with toDecimal() from lib/money.
 */
export interface SettingDef<T = unknown> {
  default: T;
  schema: z.ZodType<T>;
  label: string;
  description: string;
  group: "access" | "billing" | "gateway" | "monitoring" | "general";
  type: "boolean" | "number" | "string";
}

function def<T>(
  type: SettingDef["type"],
  group: SettingDef["group"],
  label: string,
  description: string,
  schema: z.ZodType<T>,
  dflt: T,
): SettingDef<T> {
  return { default: dflt, schema, label, description, group, type };
}

export const SETTING_DEFS = {
  // --- access ---
  signupEnabled: def("boolean", "access", "Signups enabled", "Allow new customers to register.", z.boolean(), true),
  requireEmailVerification: def("boolean", "access", "Require email verification", "Customers must verify their email before they can log in and use API keys.", z.boolean(), true),
  requireStaffTwoFactor: def("boolean", "access", "Require 2FA for staff", "Admins and support staff must enable two-factor authentication before they can use the admin console.", z.boolean(), process.env.NODE_ENV === "production"),
  publicPricing: def("boolean", "access", "Public pricing", "Show prices to visitors who are not signed in: the price table and savings on the home page, /pricing and the /api/pricing feed. Off: prices are only shown after signing in (customers still see their own prices in the dashboard).", z.boolean(), true),
  publicModels: def("boolean", "access", "Public model list", "Show which models you offer (model names, counts and vendors on the home page, docs examples) to visitors who are not signed in. Off also hides public pricing, which lists every model. Signed-in customers always see the models they can use.", z.boolean(), true),
  publicStatus: def("boolean", "access", "Public status page", "Show /status to visitors who are not signed in. Off: only signed-in users can open it.", z.boolean(), true),
  portalOnly: def("boolean", "access", "Portal only (no public site)", "For an internal service: visitors who are not signed in get the login page and nothing else. The home page, docs, pricing, status and the /api/pricing feed all require signing in (overrides the three public switches above), the home page sends signed-in users straight to their dashboard and search engines are told to index nothing.", z.boolean(), false),
  defaultGroupSlug: def("string", "access", "Default group slug", "Group (pool) assigned to new customers.", z.string().min(1).max(64), "standard"),
  // --- billing ---
  customerBilling: def("boolean", "billing", "Customer billing pages", "Off = customers never see Billing, Add funds, top-ups, auto-recharge, payment methods or redeem codes; their balance is still shown and admins set it from the customer page.", z.boolean(), true),
  trialCredit: def("number", "billing", "Trial credit (USD)", "Credit granted when a customer verifies their email (or adds a card when required).", z.number().min(0).max(100000), 0),
  requireCardForTrial: def("boolean", "billing", "Require card for trial", "Only grant the trial credit after a payment method is attached.", z.boolean(), false),
  minTopup: def("number", "billing", "Minimum top-up (USD)", "Smallest amount a customer can add.", z.number().min(0).max(100000), 5),
  maxTopup: def("number", "billing", "Maximum top-up (USD)", "Largest amount a customer can add in one payment.", z.number().min(0).max(1000000), 1000),
  minBalanceToCall: def("number", "billing", "Minimum balance to call (USD)", "Requests are rejected when balance + credit limit <= this value.", z.number().min(-1000000).max(1000000), 0),
  lowBalanceEmail: def("boolean", "billing", "Low balance emails", "Email customers when their balance runs low.", z.boolean(), true),
  autoRechargeMaxPerDay: def("number", "billing", "Auto-recharge max per day", "Maximum automatic recharges per customer per 24h.", z.number().int().min(1).max(100), 3),
  // --- gateway ---
  logBodies: def("boolean", "gateway", "Log request/response bodies", "Store full request and response bodies in request logs (privacy + storage impact).", z.boolean(), false),
  maxAttempts: def("number", "gateway", "Max upstream attempts", "How many keys/routes to try before failing a request.", z.number().int().min(1).max(10), 3),
  keyCooldownSeconds: def("number", "gateway", "Key cooldown (s)", "Default cooldown applied to an upstream key after a 429/repeated failures.", z.number().int().min(1).max(86400), 60),
  failuresBeforeCooldown: def("number", "gateway", "Failures before cooldown", "Consecutive 5xx/timeouts before a key is put on cooldown.", z.number().int().min(1).max(100), 3),
  queueTimeoutMs: def("number", "gateway", "Queue timeout (ms)", "How long a request waits for a free upstream slot before getting a 429.", z.number().int().min(0).max(600000), 20000),
  defaultKeyConcurrency: def("number", "gateway", "Default key concurrency", "Concurrent request slots per upstream key when not set on the key.", z.number().int().min(1).max(100000), 50),
  defaultCustomerConcurrency: def("number", "gateway", "Default customer concurrency", "Concurrent request slots per customer when not set on key/user/group.", z.number().int().min(1).max(100000), 20),
  passUpstreamRateLimits: def("boolean", "gateway", "Pass upstream rate-limit headers", "Forward upstream retry-after / x-ratelimit-* headers to clients (responses and errors).", z.boolean(), true),
  streamStartHoldSec: def("number", "gateway", "Stream start hold (s)", "Hold a streaming response back from the client until real output arrives (not just the upstream's opening bookkeeping events), for up to this long, counted from the request's arrival (retries do not restart it). A failure in that window is retried invisibly on the next key or a fresh attempt (some relays fail seconds or minutes after accepting a request); reasoning streamed before the answer is held too. Nothing, not even the HTTP headers, reaches the client while it is held, so keep it below your clients' time-to-first-byte timeout (Node fetch: 300 s). Longer silences commit the response and heartbeats keep it alive. Never shorter than one heartbeat interval.", z.number().int().min(0).max(1800), 120),
  streamHeartbeatSec: def("number", "gateway", "Stream heartbeat (s)", "While an already-started SSE stream is silent for this long, send a ': keep-alive' comment line so no proxy or load balancer drops the connection. Never sent on non-SSE responses; 0 = off.", z.number().int().min(0).max(600), 15),
  maxRequestBodyMb: def("number", "gateway", "Max request body (MB)", "Largest request body the gateway accepts. 0 = unlimited (the upstream provider's own limit applies and its error is passed through).", z.number().int().min(0).max(1000000), 0),
  upstreamIdleTimeoutSec: def("number", "gateway", "Upstream stream idle timeout (s)", "Abort a stream when the upstream sends nothing for this long; the client connection is then dropped like on any upstream failure. 0 = never. A provider can override it with settings.idleTimeoutSec.", z.number().int().min(0).max(86400), 0),
  autoPriceSyncHours: def("number", "gateway", "Auto-updated prices: refresh after (hours)", "Routes with an auto-updated cost re-read the provider's published price at most this often - lazily, during a call on that route (nothing runs on a timer).", z.number().min(0.1).max(8760), 6),
  autoPriceSyncCalls: def("number", "gateway", "Auto-updated prices: refresh every N calls", "...or after this many calls on the route since the last refresh, whichever comes first.", z.number().int().min(1).max(10_000_000), 100),
  priceSyncPool: def("string", "gateway", "Price sync AI: pool", "Pool (group slug) whose providers run the AI that reads pricing pages (provider page > Price sync). Billed at our own cost: the runs are logged under the customer \"Pricing fetch AI\" at price 0, so their upstream cost shows in the analytics.", z.string().min(1).max(64), "coding"),
  priceSyncModel: def("string", "gateway", "Price sync AI: model", "Model (slug) that reads the pricing pages. A capable, inexpensive model is enough: every number it returns is checked against the page text before it is used.", z.string().min(1).max(128), "claude-sonnet-5"),
  // --- monitoring (everything off by default: an idle server makes no request and runs no timer) ---
  activeHealthChecks: def("boolean", "monitoring", "Uptime monitoring (timed pings)", "Every interval, check every upstream key with a free request (its model list) and record uptime + ping history, even when nobody calls. Off = health, uptime and latency come only from real customer calls and no provider is ever contacted on a timer. Needs a running instance (Cloud Run min-instances 1) or the Cloud Scheduler health job to fire while idle.", z.boolean(), false),
  healthCheckIntervalMin: def("number", "monitoring", "Uptime ping interval (minutes)", "How often the timed pings run when uptime monitoring is on.", z.number().int().min(1).max(1440), 5),
  backgroundJobs: def("boolean", "monitoring", "Background jobs on a timer", "Run upkeep (provider health from traffic, batch and video sweeps, metering dead-letter replay) and billing (auto-recharge, postpaid, stale payments) on a timer. Off = they run only while the server is handling calls or admin pages, at most every 5 minutes (billing: hourly), so an idle server stays idle.", z.boolean(), false),
  maintenanceIntervalMin: def("number", "monitoring", "Background job interval (minutes)", "How often upkeep runs when background jobs are on (billing stays hourly).", z.number().int().min(1).max(1440), 5),
  priceSyncAuto: def("boolean", "monitoring", "AI price sync: automatic updates", "Re-read the pricing pages of every provider whose Price sync has \"Update automatically\" ticked, and apply clean changes (every price found on the page, within the provider's change limit; the rest waits for review). Runs while the server handles calls or admin pages (checked hourly), and on the timer when background jobs are on. Off = only the \"Check prices now\" button.", z.boolean(), true),
  upstreamBalanceIntervalMin: def("number", "monitoring", "Upstream balances: refresh interval (minutes)", "How often the remaining balance of upstream accounts that publish one (the relay) is read for the Overview and Providers pages. 0 = only when you press Refresh. Runs while the server handles calls or admin pages, and on the timer when background jobs are on.", z.number().int().min(0).max(1440), 60),
  upstreamBalanceLowUsd: def("number", "monitoring", "Upstream balances: low balance warning (USD)", "An upstream account below this balance is shown in red on the Overview.", z.number().min(0).max(100000), 5),
  priceSyncIntervalHours: def("number", "monitoring", "AI price sync: interval (hours)", "How often each provider's pricing pages are re-read when automatic updates are on.", z.number().min(1).max(720), 6),
  // --- general ---
  siteName: def("string", "general", "Site name", "Shown in the UI, emails and page titles.", z.string().min(1).max(80), "ProviderProxy"),
  supportEmail: def("string", "general", "Support email", "Shown to customers for help; used as reply-to.", z.string().max(200), ""),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, SettingDef<any>>;

export type SettingKey = keyof typeof SETTING_DEFS;
export type SettingValues = {
  [K in SettingKey]: (typeof SETTING_DEFS)[K] extends SettingDef<infer T> ? T : never;
};

export const SETTING_KEYS = Object.keys(SETTING_DEFS) as SettingKey[];

/** Defaults object (new copy each call). */
export function settingDefaults(): SettingValues {
  const out: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) out[k] = SETTING_DEFS[k].default;
  return out as SettingValues;
}

const TTL_MS = 30_000;
const g = globalThis as unknown as {
  __settingsCache?: { at: number; values: SettingValues } | null;
  __settingsSub?: boolean;
  __settingsInflight?: Promise<SettingValues> | null;
};

function ensureSubscribed() {
  if (g.__settingsSub) return;
  g.__settingsSub = true;
  const sub = getRedisSubscriber();
  if (!sub) return;
  sub.subscribe(CONFIG_INVALIDATE_CHANNEL).catch(() => undefined);
  sub.on("message", (channel, message) => {
    if (channel === CONFIG_INVALIDATE_CHANNEL && (message === "settings" || message === "all")) {
      g.__settingsCache = null;
    }
  });
}

async function load(): Promise<SettingValues> {
  const values = settingDefaults();
  const rows = await db.setting.findMany();
  for (const row of rows) {
    if (!(row.key in SETTING_DEFS)) continue;
    const key = row.key as SettingKey;
    const parsed = (SETTING_DEFS[key].schema as z.ZodType).safeParse(row.value);
    if (parsed.success) (values as Record<string, unknown>)[key] = parsed.data;
  }
  return values;
}

/** All settings with defaults applied (cached 30s). Falls back to defaults if the DB is unreachable. */
export async function getSettings(): Promise<SettingValues> {
  ensureSubscribed();
  const c = g.__settingsCache;
  if (c && Date.now() - c.at < TTL_MS) return c.values;
  if (g.__settingsInflight) return g.__settingsInflight;
  g.__settingsInflight = load()
    .then((values) => {
      g.__settingsCache = { at: Date.now(), values };
      return values;
    })
    .catch((err) => {
      logger.error("failed to load settings", { err });
      return c?.values ?? settingDefaults();
    })
    .finally(() => {
      g.__settingsInflight = null;
    });
  return g.__settingsInflight;
}

/** One typed setting. */
export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValues[K]> {
  return (await getSettings())[key];
}

/** Drop the local cache (next read hits the DB). */
export function invalidateSettingsCache(): void {
  g.__settingsCache = null;
}

/** Validate + persist one setting. Throws a ZodError on invalid input. */
export async function setSetting<K extends SettingKey>(key: K, value: SettingValues[K]): Promise<void> {
  await setSettings({ [key]: value } as Partial<SettingValues>);
}

/** Validate + persist several settings atomically. Throws a ZodError on invalid input. */
export async function setSettings(partial: Partial<SettingValues>): Promise<void> {
  const entries: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(partial)) {
    if (!(k in SETTING_DEFS)) throw new Error(`Unknown setting: ${k}`);
    entries.push([k, (SETTING_DEFS[k as SettingKey].schema as z.ZodType).parse(v)]);
  }
  await db.$transaction(
    entries.map(([key, value]) =>
      db.setting.upsert({
        where: { key },
        create: { key, value: value as never },
        update: { value: value as never },
      }),
    ),
  );
  invalidateSettingsCache();
  await publishConfigInvalidate("settings");
}
