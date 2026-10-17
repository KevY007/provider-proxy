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
  group: "access" | "billing" | "gateway" | "general";
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
  defaultGroupSlug: def("string", "access", "Default group slug", "Group (pool) assigned to new customers.", z.string().min(1).max(64), "standard"),
  // --- billing ---
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
  passUpstreamRateLimits: def("boolean", "gateway", "Pass upstream rate-limit headers", "Forward upstream retry-after / x-ratelimit-* headers to clients on 429.", z.boolean(), true),
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
