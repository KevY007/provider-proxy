/**
 * Live provider setup (idempotent):  pnpm setup:live [--markup 1.30 | --percent-of-official 100]
 *
 * Reads LIVE_OPENAI_API_KEY / LIVE_ANTHROPIC_API_KEY / LIVE_FAL_KEY / LIVE_REPLICATE_API_TOKEN from .env, then
 *   1. enables + configures the OpenAI and Anthropic providers (seeded presets) and creates fal.ai + Replicate,
 *   2. stores ONE encrypted upstream key per provider (label "live-1", 20 concurrent slots) - re-runs update it in place,
 *   3. upserts the public models with real upstream routes: route cost = upstream list price, official prices filled,
 *      model aliases (dated ids such as claude-haiku-4-5-20251001) and server-tool prices stored, pricing rule
 *      DEFAULT "match official" (PERCENT_OF_OFFICIAL 100; MARKUP_OVER_COST +30% for a model without an official price).
 *      `--markup 1.30` sells everything at cost x 1.30 instead, `--percent-of-official 70` at 70% of the official price,
 *   4. creates the cross-provider demo model `smart-fast` (Anthropic haiku first, OpenAI gpt-5-nano as failover).
 * Secrets only ever reach the database through encrypt(); nothing secret is printed.
 *
 * Every number comes from the built-in known-price catalog (src/gateway/price-catalog.ts) - nothing is duplicated here.
 * Before creating models the script asks OpenAI / Anthropic for the models the key can really use (free, read-only,
 * `listUpstreamModels`): a model whose upstream `shutdown_date` has passed is created DISABLED (e.g. sora-2: the Sora
 * video API was shut down on 2026-09-24 and /v1/videos answers 404) and every announced shutdown date is stored in
 * `Model.retiresAt` (admin shows a "retiring" badge).
 *
 * Prices marked "*" are best guesses (post-2025 models) - confirm them in /admin/models.
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { decrypt, encrypt, secretHint } from "../src/lib/crypto";
import { Decimal } from "../src/lib/money";
import { getRedis, publishConfigInvalidate } from "../src/lib/redis";
import { lookupKnownPrice, type KnownPrice } from "../src/gateway/price-catalog";
import { getPreset } from "../src/gateway/providers/presets";
import { defaultRuleForKnown, MARKUP_FALLBACK_RULE, migrateSeededMarkupRules } from "../src/server/pricing/default-policy";
import { listUpstreamModels } from "../src/gateway/upstream-models";
import { knownCostFields, knownOfficialFields, knownSellFields } from "../src/server/pricing/fields";
import type { PriceTable, PricingRule } from "../src/server/pricing/preview";

type ProviderId = "openai" | "anthropic" | "fal" | "replicate";

interface LiveModel {
  slug: string;
  /** overrides the catalog's display name / description */
  displayName?: string;
  description?: string;
  vendor: string;
  provider: ProviderId;
  upstream: string;
  sort: number;
  /** create the model DISABLED (an admin enables it once the price was verified); an existing model keeps its status */
  startDisabled?: boolean;
}

const LIVE: LiveModel[] = [
  // ---- OpenAI --------------------------------------------------------------------------------------------------
  { slug: "gpt-6-astra", vendor: "openai", provider: "openai", upstream: "gpt-6-astra", sort: 10 },
  { slug: "gpt-6.1-sol", vendor: "openai", provider: "openai", upstream: "gpt-6.1-sol", sort: 20 },
  { slug: "gpt-6-luna", vendor: "openai", provider: "openai", upstream: "gpt-6-luna", sort: 40 },
  { slug: "gpt-5-mini", vendor: "openai", provider: "openai", upstream: "gpt-5-mini", sort: 60 },
  { slug: "gpt-5-nano", vendor: "openai", provider: "openai", upstream: "gpt-5-nano", sort: 70 },
  { slug: "gpt-4.1-nano", vendor: "openai", provider: "openai", upstream: "gpt-4.1-nano", sort: 80 },
  { slug: "gpt-4o-mini", vendor: "openai", provider: "openai", upstream: "gpt-4o-mini", sort: 90 },
  // image models: gpt-image-1-mini is billed per token (text in / image out), gpt-image-2 per image (seed price)
  { slug: "gpt-image-1-mini", vendor: "openai", provider: "openai", upstream: "gpt-image-1-mini", sort: 100 },
  { slug: "gpt-image-2", vendor: "openai", provider: "openai", upstream: "gpt-image-2", sort: 110 },
  { slug: "sora-2", vendor: "openai", provider: "openai", upstream: "sora-2", sort: 120 },
  { slug: "tts-1", vendor: "openai", provider: "openai", upstream: "tts-1", sort: 130 },
  { slug: "whisper-1", vendor: "openai", provider: "openai", upstream: "whisper-1", sort: 140 },
  { slug: "text-embedding-3-small", vendor: "openai", provider: "openai", upstream: "text-embedding-3-small", sort: 150 },
  { slug: "omni-moderation-latest", vendor: "openai", provider: "openai", upstream: "omni-moderation-latest", sort: 160 },

  // ---- Anthropic -----------------------------------------------------------------------------------------------
  { slug: "claude-fable-5-1", vendor: "anthropic", provider: "anthropic", upstream: "claude-fable-5-1", sort: 200 },
  { slug: "claude-opus-5-5", vendor: "anthropic", provider: "anthropic", upstream: "claude-opus-5-5", sort: 210 },
  { slug: "claude-sonnet-5-5", vendor: "anthropic", provider: "anthropic", upstream: "claude-sonnet-5-5", sort: 220 },
  { slug: "claude-haiku-5-5", vendor: "anthropic", provider: "anthropic", upstream: "claude-haiku-5-5", sort: 230 },
  { slug: "claude-haiku-4-5", vendor: "anthropic", provider: "anthropic", upstream: "claude-haiku-4-5-20251001", sort: 240 },

  // ---- fal.ai (per image, 1 megapixel) --------------------------------------------------------------------------
  { slug: "flux-schnell", vendor: "black-forest-labs", provider: "fal", upstream: "fal-ai/flux/schnell", sort: 300 },
  { slug: "flux-dev", vendor: "black-forest-labs", provider: "fal", upstream: "fal-ai/flux/dev", sort: 310 },
  { slug: "flux-pro-1.1", vendor: "black-forest-labs", provider: "fal", upstream: "fal-ai/flux-pro/v1.1", sort: 320, displayName: "FLUX1.1 [pro]" },
  { slug: "recraft-v3", vendor: "recraft", provider: "fal", upstream: "fal-ai/recraft/v3/text-to-image", sort: 330 },

  // ---- fal.ai video (queue API behind /v1/videos). Price NOT verified and never live-tested -> created DISABLED ----------
  {
    slug: "kling-2.1-master",
    vendor: "kuaishou",
    provider: "fal",
    upstream: "fal-ai/kling-video/v2.1/master/text-to-video",
    sort: 340,
    startDisabled: true,
    description: "Text-to-video (5 or 10 s). Created disabled: confirm the per-second price, then enable.",
  },

  // ---- Replicate (per image) ------------------------------------------------------------------------------------
  { slug: "flux-schnell-replicate", vendor: "black-forest-labs", provider: "replicate", upstream: "black-forest-labs/flux-schnell", sort: 400 },
  { slug: "flux-dev-replicate", vendor: "black-forest-labs", provider: "replicate", upstream: "black-forest-labs/flux-dev", sort: 410 },
  { slug: "flux-1.1-pro-replicate", vendor: "black-forest-labs", provider: "replicate", upstream: "black-forest-labs/flux-1.1-pro", sort: 420, displayName: "FLUX1.1 [pro] (Replicate)" },
];

// ------------------------------------------------------------------ providers
interface ProviderSpec {
  id: ProviderId;
  slug: string;
  name: string;
  preset: string;
  baseUrl: string;
  authStyle: "BEARER" | "X_API_KEY";
  formats: string[];
  tags: string[];
  settings: Record<string, unknown>;
  timeoutMs: number;
  env: string;
}

const PROVIDERS: ProviderSpec[] = [
  {
    id: "openai",
    slug: "openai",
    name: "OpenAI",
    preset: "openai",
    baseUrl: "https://api.openai.com/v1",
    authStyle: "BEARER",
    formats: ["openai_chat", "openai_completions", "openai_responses", "openai_embeddings", "openai_images", "openai_audio", "openai_moderations", "openai_videos", "openai_files", "openai_batches"],
    tags: ["official"],
    settings: {},
    timeoutMs: 300_000,
    env: "LIVE_OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    slug: "anthropic",
    name: "Anthropic",
    preset: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authStyle: "X_API_KEY",
    formats: ["anthropic_messages", "anthropic_files", "anthropic_batches"],
    tags: ["official"],
    settings: { anthropicVersion: "2023-06-01" },
    timeoutMs: 300_000,
    env: "LIVE_ANTHROPIC_API_KEY",
  },
  {
    id: "fal",
    slug: "fal",
    name: "fal.ai",
    preset: "fal",
    baseUrl: "https://fal.run",
    authStyle: "BEARER",
    formats: ["openai_images", "openai_videos"],
    tags: ["images"],
    settings: { queueBaseUrl: "https://queue.fal.run", falMode: "auto" },
    timeoutMs: 180_000,
    env: "LIVE_FAL_KEY",
  },
  {
    id: "replicate",
    slug: "replicate",
    name: "Replicate",
    preset: "replicate",
    baseUrl: "https://api.replicate.com/v1",
    authStyle: "BEARER",
    formats: ["openai_images"],
    tags: ["images"],
    settings: {},
    timeoutMs: 180_000,
    env: "LIVE_REPLICATE_API_TOKEN",
  },
];

// ------------------------------------------------------------------ helpers
const money = (v: Decimal.Value) => new Decimal(v).toFixed(12);

/** The pricing policy of this run. Default: match official; `--markup N` (cost x N) or `--percent-of-official N` force one rule on every model. */
interface Policy {
  /** the rule of a model: forced, or the default (match official; +30% over cost when the model has no official price) */
  ruleFor(k: KnownPrice): PricingRule;
  /** cost x factor for the summary table (null = depends on the model) */
  describe: string;
  /** set when a markup over cost is forced (also used for models without an official price) */
  markupRule?: PricingRule;
}

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

function parsePolicy(): Policy {
  const markup = flag("--markup");
  const percent = flag("--percent-of-official");
  if (markup !== undefined && percent !== undefined) throw new Error("use either --markup or --percent-of-official, not both");
  if (markup !== undefined) {
    const d = new Decimal(markup);
    if (!d.isFinite() || d.lte(0)) throw new Error(`invalid --markup '${markup}' (expected a number like 1.30)`);
    if (d.lt(1)) console.warn(`WARNING: --markup ${markup} is below 1.0 - models will be sold BELOW cost.`);
    const rule: PricingRule = { mode: "MARKUP_OVER_COST", value: Number(d.minus(1).times(100).toDecimalPlaces(4).toString()) };
    return { ruleFor: () => rule, markupRule: rule, describe: `sell = cost x ${d.toString()} (+${d.minus(1).times(100).toFixed(0)}% over cost)` };
  }
  if (percent !== undefined) {
    const d = new Decimal(percent);
    if (!d.isFinite() || d.lte(0) || d.gt(1000)) throw new Error(`invalid --percent-of-official '${percent}' (expected a number like 100)`);
    const rule: PricingRule = { mode: "PERCENT_OF_OFFICIAL", value: Number(d.toString()) };
    return { ruleFor: (k) => (defaultRuleForKnown(k).mode === "PERCENT_OF_OFFICIAL" ? rule : MARKUP_FALLBACK_RULE), describe: `sell = ${d.toString()}% of the official price (+30% over cost where there is none)` };
  }
  return { ruleFor: defaultRuleForKnown, describe: "sell = the official price (match official); +30% over cost for models without an official price" };
}

interface SummaryRow {
  model: string;
  provider: string;
  upstream: string;
  cost: string;
  sell: string;
  margin: string;
  review: boolean;
  note: string;
}

const usd = (v: Decimal.Value) => {
  const d = new Decimal(v);
  return d.isZero() ? "$0" : `$${d.toSignificantDigits(6).toString()}`;
};

function describeUnits(t: PriceTable, mult: Decimal): string {
  const parts: string[] = [];
  const f = (v: number | null | undefined) => usd(new Decimal(String(v ?? 0)).times(mult));
  if (t.input != null || t.output != null) parts.push(`${f(t.input)} in / ${f(t.output)} out per 1M`);
  if (t.image) parts.push(`${f(t.image)}/image`);
  if (t.perSecond) parts.push(`${f(t.perSecond)}/s`);
  if (t.perMinute) parts.push(`${f(t.perMinute)}/min`);
  if (t.perMillionChars) parts.push(`${f(t.perMillionChars)}/1M chars`);
  return parts.length ? parts.join(" + ") : "free";
}

/** "0% / 0.0%": markup over cost and the resulting margin on the sell price, (sell - cost) / sell, of a rule on a model priced at its list price. */
function marginOf(t: PriceTable, rule: PricingRule): string {
  const hasCost = [t.input, t.output, t.image, t.perSecond, t.perMinute, t.perMillionChars].some((v) => v != null && v > 0);
  if (!hasCost) return "n/a";
  const factor = ruleFactor(rule);
  return `${factor.minus(1).times(100).toFixed(0)}% / ${new Decimal(1).minus(new Decimal(1).div(factor)).times(100).toFixed(1)}%`;
}

/** sell / cost for a model bought at the official price. */
const ruleFactor = (rule: PricingRule): Decimal => (rule.mode === "PERCENT_OF_OFFICIAL" ? new Decimal(rule.value ?? 100).div(100) : new Decimal(rule.value ?? 0).div(100).plus(1));

function printTable(rows: SummaryRow[]): void {
  const head = ["model", "provider", "upstream model", "cost", "sell", "markup / margin", "notes"];
  const body = rows.map((r) => [r.review ? `${r.model} *` : r.model, r.provider, r.upstream, r.cost, r.sell, r.margin, r.note]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of body) console.log(line(r));
  if (rows.some((r) => r.review)) console.log("\n* price is a best guess (post-2025 model or not verifiable): confirm it in /admin/models.");
}

async function waitRedis(ms = 2000): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  for (let i = 0; i < ms / 50 && r.status !== "ready"; i++) await new Promise((res) => setTimeout(res, 50));
  return r.status === "ready";
}

// ------------------------------------------------------------------ upstream availability (read-only)
type ModelIndex = Map<string, { shutdown?: string }>;

/** Models the credential can use, with the upstream `shutdown_date` when it is announced. Null when the list cannot be fetched. */
async function fetchModelIndex(spec: ProviderSpec, providerDbId: string): Promise<ModelIndex | null> {
  if (spec.id !== "openai" && spec.id !== "anthropic") return null;
  try {
    const list = await listUpstreamModels(providerDbId);
    return new Map(list.map((m) => [m.id, { shutdown: m.shutdownDate ?? undefined }]));
  } catch (e) {
    console.warn(`  (could not list ${spec.name} models: ${e instanceof Error ? e.message : e} - availability not checked)`);
    return null;
  }
}

const daysUntil = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);

// ------------------------------------------------------------------ main
async function setupProvider(spec: ProviderSpec): Promise<{ id: string; index: ModelIndex | null } | null> {
  const secret = (process.env[spec.env] ?? "").trim();
  if (!secret) {
    console.warn(`- ${spec.name}: ${spec.env} is not set in .env -> skipped (its models are not created)`);
    return null;
  }
  const existing = await db.provider.findUnique({ where: { slug: spec.slug } });
  // the formats are REFRESHED to the preset's current list (a provider set up by an older run lacks the newer ones: files, batches ...)
  const formats = [...new Set([...(getPreset(spec.preset)?.formats ?? []), ...spec.formats])];
  const dropped = (existing?.formats ?? []).filter((f) => !formats.includes(f));
  if (dropped.length) console.log(`  (formats no longer in the ${spec.name} preset removed: ${dropped.join(", ")})`);
  const added = formats.filter((f) => !(existing?.formats ?? []).includes(f));
  if (existing && added.length) console.log(`  (formats added to ${spec.name}: ${added.join(", ")})`);
  const settings = { ...((existing?.settings as Record<string, unknown> | null) ?? {}), ...spec.settings };
  const tags = [...new Set([...(existing?.tags ?? []), ...spec.tags])];
  const provider = await db.provider.upsert({
    where: { slug: spec.slug },
    create: { slug: spec.slug, name: spec.name, preset: spec.preset, baseUrl: spec.baseUrl, authStyle: spec.authStyle, formats, tags, settings: settings as never, status: "ACTIVE", timeoutMs: spec.timeoutMs },
    update: { name: spec.name, preset: spec.preset, baseUrl: spec.baseUrl, authStyle: spec.authStyle, formats, tags, settings: settings as never, status: "ACTIVE", timeoutMs: spec.timeoutMs },
  });

  const label = "live-1";
  const key = await db.providerKey.findFirst({ where: { providerId: provider.id, label } });
  let action: string;
  if (!key) {
    await db.providerKey.create({ data: { providerId: provider.id, label, secretEncrypted: encrypt(secret), secretHint: secretHint(secret), status: "ACTIVE", weight: 1, priority: 0, maxConcurrency: 20 } });
    action = "key created";
  } else {
    let same = false;
    try {
      same = decrypt(key.secretEncrypted) === secret;
    } catch {
      same = false;
    }
    await db.providerKey.update({
      where: { id: key.id },
      data: { ...(same ? {} : { secretEncrypted: encrypt(secret), secretHint: secretHint(secret) }), status: "ACTIVE", cooldownUntil: null, consecutiveFailures: 0, lastError: null, maxConcurrency: 20 },
    });
    action = same ? "key unchanged (re-activated)" : "key rotated";
  }
  console.log(`- ${spec.name}: provider ACTIVE, ${action}`);
  return { id: provider.id, index: await fetchModelIndex(spec, provider.id) };
}

interface ModelInput {
  slug: string;
  displayName: string;
  description: string;
  vendor: string;
  sort: number;
  known: KnownPrice;
  /** Model.retiresAt candidate (ISO date) */
  retiresAt: string | null;
}

async function upsertModel(m: ModelInput, providerDbId: string, upstream: string, rule: PricingRule, status: "ACTIVE" | "DISABLED" = "ACTIVE") {
  const k = m.known;
  // catalog aliases (dated ids such as claude-haiku-4-5-20251001) resolve to this model; aliases an admin added are kept
  const existing = await db.model.findUnique({ where: { slug: m.slug }, select: { aliases: true } });
  const aliases = [...new Set([...(existing?.aliases ?? []), ...(k.aliases ?? []).filter((a) => a !== m.slug)])];
  const base = {
    aliases,
    displayName: m.displayName,
    vendor: m.vendor,
    description: m.description,
    capabilities: k.capabilities ?? ["chat"],
    contextWindow: k.contextWindow || null,
    maxOutput: k.maxOutput || null,
    sortOrder: m.sort,
    status,
    longContextThreshold: k.longContext?.threshold ?? null,
    longContextMultiplier: k.longContext ? String(k.longContext.multiplier) : null,
    longContextOutputMultiplier: k.longContext?.outputMultiplier ? String(k.longContext.outputMultiplier) : null,
    ...(m.retiresAt ? { retiresAt: new Date(m.retiresAt) } : {}),
    ...knownOfficialFields(k),
    ...knownSellFields(k, rule),
    pricingMode: rule.mode,
    pricingValue: String(rule.value),
  };
  const model = await db.model.upsert({ where: { slug: m.slug }, create: { slug: m.slug, ...base }, update: base });
  const routeCost = knownCostFields(k);
  await db.modelRoute.upsert({
    where: { modelId_providerId_upstreamModel: { modelId: model.id, providerId: providerDbId, upstreamModel: upstream } },
    create: { modelId: model.id, providerId: providerDbId, upstreamModel: upstream, label: "live", enabled: true, ...routeCost },
    update: { enabled: true, ...routeCost },
  });
  return model;
}

async function main() {
  const policy = parsePolicy();
  console.log(`ProviderProxy live setup (${policy.describe})\n`);

  const provIds = new Map<ProviderId, string>();
  const indexes = new Map<ProviderId, ModelIndex | null>();
  for (const spec of PROVIDERS) {
    const r = await setupProvider(spec);
    if (r) {
      provIds.set(spec.id, r.id);
      indexes.set(spec.id, r.index);
    }
  }
  /** availability of one upstream model according to the provider's own model list */
  const availability = (provider: ProviderId, upstream: string): { status: "ACTIVE" | "DISABLED"; note: string; shutdown?: string } => {
    const idx = indexes.get(provider);
    if (!idx) return { status: "ACTIVE", note: "" };
    const hit = idx.get(upstream);
    if (!hit) return { status: "ACTIVE", note: "not in the provider's model list (no access?)" };
    if (hit.shutdown) {
      const d = daysUntil(hit.shutdown);
      if (d <= 0) return { status: "DISABLED", note: `SHUT DOWN ${hit.shutdown} -> disabled`, shutdown: hit.shutdown };
      return { status: "ACTIVE", note: d <= 120 ? `sunset ${hit.shutdown} (${d} d)` : `retires ${hit.shutdown}`, shutdown: hit.shutdown };
    }
    return { status: "ACTIVE", note: "" };
  };

  const rows: SummaryRow[] = [];
  const pName = (id: ProviderId) => PROVIDERS.find((p) => p.id === id)!.name;
  const preset = (id: ProviderId) => PROVIDERS.find((p) => p.id === id)!.preset;
  const knownFor = (p: ProviderId, upstream: string): KnownPrice => {
    const k = lookupKnownPrice(preset(p), upstream);
    if (!k) throw new Error(`no known price for ${preset(p)}/${upstream}: add it to src/gateway/price-catalog.ts`);
    return k;
  };

  for (const m of LIVE) {
    const pid = provIds.get(m.provider);
    if (!pid) continue;
    const known = knownFor(m.provider, m.upstream);
    const rule = policy.ruleFor(known);
    let avail = availability(m.provider, m.upstream);
    if (m.startDisabled) {
      const existing = await db.model.findUnique({ where: { slug: m.slug }, select: { status: true } });
      if (!existing) avail = { ...avail, status: "DISABLED", note: "created DISABLED: verify the price, then enable" };
      else if (avail.status === "ACTIVE") avail = { ...avail, status: existing.status === "DISABLED" ? "DISABLED" : "ACTIVE", note: existing.status === "DISABLED" ? "disabled (enable in /admin/models after checking the price)" : avail.note };
    }
    await upsertModel(
      { slug: m.slug, displayName: m.displayName ?? known.displayName ?? m.slug, description: m.description ?? known.description ?? "", vendor: m.vendor, sort: m.sort, known, retiresAt: avail.shutdown ?? known.retiresAt ?? null },
      pid,
      m.upstream,
      rule,
      avail.status,
    );
    rows.push({
      note: avail.note,
      model: m.slug,
      provider: pName(m.provider),
      upstream: m.upstream,
      cost: describeUnits(known.official, new Decimal(1)),
      sell: describeUnits(known.official, ruleFactor(rule)),
      margin: marginOf(known.official, rule),
      review: !!known.needsReview,
    });
  }

  // ---- smart-fast: one public model, two upstream providers (what customers see vs what runs)
  const anth = provIds.get("anthropic");
  const oai = provIds.get("openai");
  if (anth && oai) {
    const haiku = knownFor("anthropic", "claude-haiku-5-5");
    const nano = knownFor("openai", "gpt-5-nano");
    const num = (k: KnownPrice, key: "input" | "output" | "cachedInput") => k.official[key] ?? 0;
    // one public price per model: it follows the PRIMARY route (priority 10 = Claude Haiku) and covers the most
    // expensive route so BOTH routes keep their margin
    const costFor = (key: "input" | "output" | "cachedInput") => Math.max(num(haiku, key), num(nano, key));
    // no maker price to match: cost-plus (the forced markup of this run, else the +30% fallback)
    const smartRule = policy.markupRule ?? MARKUP_FALLBACK_RULE;
    const smartFactor = ruleFactor(smartRule);
    const top: KnownPrice = { ...haiku, model: "smart-fast", official: { input: costFor("input"), output: costFor("output"), cachedInput: costFor("cachedInput") }, cacheWrite1h: undefined, longContext: undefined };
    const model = await upsertModel(
      { slug: "smart-fast", displayName: "Smart Fast", vendor: "providerproxy", sort: 5, known: top, retiresAt: null, description: "Fast, cheap chat model. Served by the best available provider (Claude Haiku, with GPT-5 nano as automatic failover)." },
      anth,
      "claude-haiku-5-5",
      smartRule,
    );
    // smart-fast is our own product: there is no maker price to compare with
    await db.model.update({
      where: { id: model.id },
      data: { officialInputPrice: null, officialOutputPrice: null, officialCachedPrice: null, officialToolPrices: {}, capabilities: ["chat", "responses", "vision", "tools", "reasoning"], contextWindow: haiku.contextWindow ?? null, maxOutput: haiku.maxOutput ?? null },
    });
    // route 1 (priority 10): Anthropic haiku, its own cost; route 2 (priority 5): OpenAI gpt-5-nano, its own cost
    await db.modelRoute.updateMany({ where: { modelId: model.id, providerId: anth, upstreamModel: "claude-haiku-5-5" }, data: { priority: 10, label: "primary: Claude Haiku", inputCost: money(num(haiku, "input")), outputCost: money(num(haiku, "output")), cachedInputCost: money(num(haiku, "cachedInput")) } });
    const nanoCost = { inputCost: money(num(nano, "input")), outputCost: money(num(nano, "output")), cachedInputCost: money(num(nano, "cachedInput")) };
    await db.modelRoute.upsert({
      where: { modelId_providerId_upstreamModel: { modelId: model.id, providerId: oai, upstreamModel: "gpt-5-nano" } },
      create: { modelId: model.id, providerId: oai, upstreamModel: "gpt-5-nano", priority: 5, label: "failover: GPT-5 nano", enabled: true, ...nanoCost },
      update: { priority: 5, label: "failover: GPT-5 nano", enabled: true, ...nanoCost },
    });
    const sellOut = new Decimal(top.official.output ?? 0).times(smartFactor);
    rows.push({
      model: "smart-fast",
      provider: "Anthropic (10) -> OpenAI (5)",
      upstream: "claude-haiku-5-5 | gpt-5-nano",
      cost: `${describeUnits(haiku.official, new Decimal(1))} | ${describeUnits(nano.official, new Decimal(1))}`,
      sell: describeUnits(top.official, smartFactor),
      note: [availability("anthropic", "claude-haiku-5-5").note, availability("openai", "gpt-5-nano").note].filter(Boolean).join("; "),
      margin: `+${smartFactor.minus(1).times(100).toFixed(0)}%..+${nano.official.output ? smartFactor.times(top.official.output ?? 0).div(nano.official.output).minus(1).times(100).toFixed(0) : "?"}% / ${new Decimal(1).minus(new Decimal(1).div(smartFactor)).times(100).toFixed(1)}%..${nano.official.output && !sellOut.isZero() ? new Decimal(1).minus(new Decimal(nano.official.output).div(sellOut)).times(100).toFixed(1) : "?"}%`,
      review: true,
    });
  }

  console.log(`\nModels upserted: ${rows.length}\n`);
  printTable(rows);

  // other models still carrying the OLD seeded default (+30% over cost, never edited by an admin) -> "match official"
  if (!process.argv.includes("--keep-old-rules")) {
    const m = await migrateSeededMarkupRules();
    if (m.migrated.length) console.log(`\nMoved to "match official" (were on the old +30% default): ${m.migrated.join(", ")}`);
    if (m.kept.length) console.log(`Kept on +30% over cost (edited by an admin or no official price): ${m.kept.join(", ")}`);
  }

  if (await waitRedis()) {
    await publishConfigInvalidate("all");
    console.log("\nRunning gateways were told to reload their config (Redis).");
  } else {
    console.log("\nRedis not reachable: a running gateway picks the changes up within ~30 s.");
  }
}

main()
  .then(async () => {
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await db.$disconnect();
    process.exit(1);
  });
