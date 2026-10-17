/**
 * Live provider setup (idempotent):  pnpm setup:live [--markup 1.30]
 *
 * Reads LIVE_OPENAI_API_KEY / LIVE_ANTHROPIC_API_KEY / LIVE_FAL_KEY / LIVE_REPLICATE_API_TOKEN from .env, then
 *   1. enables + configures the OpenAI and Anthropic providers (seeded presets) and creates fal.ai + Replicate,
 *   2. stores ONE encrypted upstream key per provider (label "live-1", 20 concurrent slots) - re-runs update it in place,
 *   3. upserts the public models with real upstream routes: route cost = upstream list price,
 *      sell price = cost x markup (default 1.30 = 30% margin; official* fields keep the vendor list price),
 *   4. creates the cross-provider demo model `smart-fast` (Anthropic haiku first, OpenAI gpt-5-nano as failover).
 * Secrets only ever reach the database through encrypt(); nothing secret is printed.
 * Before creating models the script asks OpenAI / Anthropic for the models the key can really use (free, read-only):
 * a model whose upstream `shutdown_date` has passed is created DISABLED (e.g. sora-2: the Sora video API was shut down
 * on 2026-09-24 and /v1/videos answers 404), and upcoming shutdown dates are reported in the notes column.
 *
 * Prices marked "review" belong to models newer than the public price lists this script was written against -
 * they come from the project seed (prisma/seed-data.ts); the admin should confirm them in /admin/models.
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { decrypt, encrypt, secretHint } from "../src/lib/crypto";
import { Decimal } from "../src/lib/money";
import { getRedis, publishConfigInvalidate } from "../src/lib/redis";

type ProviderId = "openai" | "anthropic" | "fal" | "replicate";

/** Upstream list prices: USD per 1M tokens unless noted. */
interface Cost {
  in?: string;
  out?: string;
  cached?: string;
  cacheWrite?: string;
  cacheWrite1h?: string;
  /** USD per generated image */
  image?: string;
  /** USD per generated video second */
  perSecond?: string;
  /** USD per audio minute (transcription) */
  perMinute?: string;
  /** USD per 1M input characters (TTS) */
  perMillionChars?: string;
}

interface LiveModel {
  slug: string;
  displayName: string;
  vendor: string;
  provider: ProviderId;
  upstream: string;
  caps: string[];
  ctx: number;
  maxOut: number;
  cost: Cost;
  sort: number;
  description: string;
  /** price not verifiable against a public list (post-2025 model): admin should confirm */
  review?: boolean;
  /** create the model DISABLED (an admin enables it once the price was verified); an existing model keeps its status */
  startDisabled?: boolean;
}

const CHAT = ["chat", "responses", "vision", "tools", "reasoning"];
const CHAT_NO_RESP = ["chat", "vision", "tools"];

const MODELS: LiveModel[] = [
  // ---- OpenAI --------------------------------------------------------------------------------------------------
  { slug: "gpt-6-astra", displayName: "GPT-6 Astra", vendor: "openai", provider: "openai", upstream: "gpt-6-astra", caps: CHAT, ctx: 1_000_000, maxOut: 128_000, cost: { in: "10", out: "50", cached: "1" }, sort: 10, description: "OpenAI flagship reasoning model.", review: true },
  { slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", vendor: "openai", provider: "openai", upstream: "gpt-6.1-sol", caps: CHAT, ctx: 1_000_000, maxOut: 128_000, cost: { in: "2", out: "10", cached: "0.10" }, sort: 20, description: "Balanced GPT-6.1 model for everyday workloads.", review: true },
  { slug: "gpt-6-luna", displayName: "GPT-6 Luna", vendor: "openai", provider: "openai", upstream: "gpt-6-luna", caps: CHAT, ctx: 400_000, maxOut: 64_000, cost: { in: "0.10", out: "0.50", cached: "0.01" }, sort: 40, description: "Fast, low-cost GPT-6 model.", review: true },
  { slug: "gpt-5-mini", displayName: "GPT-5 mini", vendor: "openai", provider: "openai", upstream: "gpt-5-mini", caps: CHAT, ctx: 400_000, maxOut: 128_000, cost: { in: "0.25", out: "2", cached: "0.025" }, sort: 60, description: "Faster, cheaper GPT-5 for well-defined tasks." },
  { slug: "gpt-5-nano", displayName: "GPT-5 nano", vendor: "openai", provider: "openai", upstream: "gpt-5-nano", caps: CHAT, ctx: 400_000, maxOut: 128_000, cost: { in: "0.05", out: "0.40", cached: "0.005" }, sort: 70, description: "Fastest, cheapest GPT-5 for summarization and classification." },
  { slug: "gpt-4.1-nano", displayName: "GPT-4.1 nano", vendor: "openai", provider: "openai", upstream: "gpt-4.1-nano", caps: CHAT_NO_RESP.concat("responses", "completions"), ctx: 1_047_576, maxOut: 32_768, cost: { in: "0.10", out: "0.40", cached: "0.025" }, sort: 80, description: "Smallest GPT-4.1: very low latency." },
  { slug: "gpt-4o-mini", displayName: "GPT-4o mini", vendor: "openai", provider: "openai", upstream: "gpt-4o-mini", caps: CHAT_NO_RESP.concat("responses", "completions"), ctx: 128_000, maxOut: 16_384, cost: { in: "0.15", out: "0.60", cached: "0.075" }, sort: 90, description: "Affordable small model for focused tasks." },
  // image models: gpt-image-1-mini is billed per token (text in / image out), gpt-image-2 per image (seed price)
  { slug: "gpt-image-1-mini", displayName: "GPT Image 1 mini", vendor: "openai", provider: "openai", upstream: "gpt-image-1-mini", caps: ["images"], ctx: 0, maxOut: 0, cost: { in: "2", out: "8", cached: "0.20" }, sort: 100, description: "Low-cost image generation and editing (token-billed)." },
  { slug: "gpt-image-2", displayName: "GPT Image 2", vendor: "openai", provider: "openai", upstream: "gpt-image-2", caps: ["images"], ctx: 0, maxOut: 0, cost: { image: "0.04" }, sort: 110, description: "Image generation and editing (flat per image).", review: true },
  { slug: "sora-2", displayName: "Sora 2", vendor: "openai", provider: "openai", upstream: "sora-2", caps: ["video"], ctx: 0, maxOut: 0, cost: { perSecond: "0.10" }, sort: 120, description: "Text/image-to-video with synced audio (720p, 4-12 s)." },
  { slug: "tts-1", displayName: "TTS-1", vendor: "openai", provider: "openai", upstream: "tts-1", caps: ["audio_speech"], ctx: 0, maxOut: 0, cost: { perMillionChars: "15" }, sort: 130, description: "Text-to-speech." },
  { slug: "whisper-1", displayName: "Whisper", vendor: "openai", provider: "openai", upstream: "whisper-1", caps: ["audio_transcription"], ctx: 0, maxOut: 0, cost: { perMinute: "0.006" }, sort: 140, description: "Speech-to-text and translation." },
  { slug: "text-embedding-3-small", displayName: "Text Embedding 3 Small", vendor: "openai", provider: "openai", upstream: "text-embedding-3-small", caps: ["embeddings"], ctx: 8_191, maxOut: 0, cost: { in: "0.02", out: "0" }, sort: 150, description: "Low-cost text embeddings." },
  { slug: "omni-moderation-latest", displayName: "Omni Moderation", vendor: "openai", provider: "openai", upstream: "omni-moderation-latest", caps: ["moderation"], ctx: 0, maxOut: 0, cost: {}, sort: 160, description: "Text and image moderation (free upstream)." },

  // ---- Anthropic -----------------------------------------------------------------------------------------------
  { slug: "claude-fable-5-1", displayName: "Claude Fable 5.1", vendor: "anthropic", provider: "anthropic", upstream: "claude-fable-5-1", caps: CHAT, ctx: 1_000_000, maxOut: 128_000, cost: { in: "10", out: "50", cached: "0.25", cacheWrite: "12.5", cacheWrite1h: "20" }, sort: 200, description: "Anthropic's most capable model.", review: true },
  { slug: "claude-opus-5-5", displayName: "Claude Opus 5.5", vendor: "anthropic", provider: "anthropic", upstream: "claude-opus-5-5", caps: CHAT, ctx: 500_000, maxOut: 64_000, cost: { in: "4", out: "20", cached: "0.20", cacheWrite: "5", cacheWrite1h: "8" }, sort: 210, description: "Frontier reasoning and coding.", review: true },
  { slug: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", vendor: "anthropic", provider: "anthropic", upstream: "claude-sonnet-5-5", caps: CHAT, ctx: 500_000, maxOut: 64_000, cost: { in: "2", out: "10", cached: "0.10", cacheWrite: "2.5", cacheWrite1h: "4" }, sort: 220, description: "Best balance of speed and intelligence.", review: true },
  { slug: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", vendor: "anthropic", provider: "anthropic", upstream: "claude-haiku-5-5", caps: CHAT, ctx: 200_000, maxOut: 32_000, cost: { in: "0.10", out: "0.50", cached: "0.01", cacheWrite: "0.125", cacheWrite1h: "0.20" }, sort: 230, description: "Fastest, most affordable Claude.", review: true },
  { slug: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", vendor: "anthropic", provider: "anthropic", upstream: "claude-haiku-4-5-20251001", caps: CHAT, ctx: 200_000, maxOut: 64_000, cost: { in: "1", out: "5", cached: "0.10", cacheWrite: "1.25", cacheWrite1h: "2" }, sort: 240, description: "Fast and affordable Claude 4.5 Haiku." },

  // ---- fal.ai (per image, 1 megapixel) --------------------------------------------------------------------------
  { slug: "flux-schnell", displayName: "FLUX.1 schnell", vendor: "black-forest-labs", provider: "fal", upstream: "fal-ai/flux/schnell", caps: ["images"], ctx: 0, maxOut: 0, cost: { image: "0.003" }, sort: 300, description: "Fastest FLUX image model (1-4 steps)." },
  { slug: "flux-dev", displayName: "FLUX.1 dev", vendor: "black-forest-labs", provider: "fal", upstream: "fal-ai/flux/dev", caps: ["images"], ctx: 0, maxOut: 0, cost: { image: "0.025" }, sort: 310, description: "High-quality 12B FLUX image model." },
  { slug: "flux-pro-1.1", displayName: "FLUX1.1 [pro]", vendor: "black-forest-labs", provider: "fal", upstream: "fal-ai/flux-pro/v1.1", caps: ["images"], ctx: 0, maxOut: 0, cost: { image: "0.04" }, sort: 320, description: "FLUX1.1 pro: top prompt adherence and quality." },
  { slug: "recraft-v3", displayName: "Recraft V3", vendor: "recraft", provider: "fal", upstream: "fal-ai/recraft/v3/text-to-image", caps: ["images"], ctx: 0, maxOut: 0, cost: { image: "0.04" }, sort: 330, description: "Design-grade images with strong text rendering." },

  // ---- fal.ai video (queue API behind /v1/videos). Price NOT verified and never live-tested -> created DISABLED ----------
  { slug: "kling-2.1-master", displayName: "Kling 2.1 Master", vendor: "kuaishou", provider: "fal", upstream: "fal-ai/kling-video/v2.1/master/text-to-video", caps: ["video"], ctx: 0, maxOut: 0, cost: { perSecond: "0.28" }, sort: 340, description: "Text-to-video (5 or 10 s). Created disabled: confirm the per-second price, then enable.", review: true, startDisabled: true },

  // ---- Replicate (per image) ------------------------------------------------------------------------------------
  { slug: "flux-schnell-replicate", displayName: "FLUX.1 schnell (Replicate)", vendor: "black-forest-labs", provider: "replicate", upstream: "black-forest-labs/flux-schnell", caps: ["images"], ctx: 0, maxOut: 0, cost: { image: "0.003" }, sort: 400, description: "FLUX.1 schnell served by Replicate." },
  { slug: "flux-dev-replicate", displayName: "FLUX.1 dev (Replicate)", vendor: "black-forest-labs", provider: "replicate", upstream: "black-forest-labs/flux-dev", caps: ["images"], ctx: 0, maxOut: 0, cost: { image: "0.025" }, sort: 410, description: "FLUX.1 dev served by Replicate." },
  { slug: "flux-1.1-pro-replicate", displayName: "FLUX1.1 [pro] (Replicate)", vendor: "black-forest-labs", provider: "replicate", upstream: "black-forest-labs/flux-1.1-pro", caps: ["images"], ctx: 0, maxOut: 0, cost: { image: "0.04" }, sort: 420, description: "FLUX1.1 pro served by Replicate." },
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
    formats: ["openai_chat", "openai_completions", "openai_responses", "openai_embeddings", "openai_images", "openai_audio", "openai_moderations", "openai_videos"],
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
    formats: ["anthropic_messages"],
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
const opt = (v: string | undefined, f: Decimal) => (v === undefined ? null : money(new Decimal(v).times(f)));
const optCost = (v: string | undefined) => (v === undefined ? null : money(v));

function parseMarkup(): Decimal {
  const argv = process.argv.slice(2);
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--markup") raw = argv[i + 1];
    else if (argv[i].startsWith("--markup=")) raw = argv[i].slice("--markup=".length);
  }
  if (raw === undefined) return new Decimal("1.30");
  const d = new Decimal(raw);
  if (!d.isFinite() || d.lte(0)) throw new Error(`invalid --markup '${raw}' (expected a number like 1.30)`);
  if (d.lt(1)) console.warn(`WARNING: --markup ${raw} is below 1.0 - models will be sold BELOW cost.`);
  return d;
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

function describeUnits(c: Cost, mult: Decimal): string {
  const parts: string[] = [];
  const f = (v: string) => usd(new Decimal(v).times(mult));
  if (c.in !== undefined || c.out !== undefined) parts.push(`${f(c.in ?? "0")} in / ${f(c.out ?? "0")} out per 1M`);
  if (c.image) parts.push(`${f(c.image)}/image`);
  if (c.perSecond) parts.push(`${f(c.perSecond)}/s`);
  if (c.perMinute) parts.push(`${f(c.perMinute)}/min`);
  if (c.perMillionChars) parts.push(`${f(c.perMillionChars)}/1M chars`);
  return parts.length ? parts.join(" + ") : "free";
}

/** "+30% / 23.1%": markup over cost and the resulting margin on the sell price, (sell - cost) / sell. */
function marginOf(c: Cost, markup: Decimal): string {
  const hasCost = [c.in, c.out, c.image, c.perSecond, c.perMinute, c.perMillionChars].some((v) => v !== undefined && new Decimal(v).gt(0));
  if (!hasCost) return "n/a";
  return `+${markup.minus(1).times(100).toFixed(0)}% / ${new Decimal(1).minus(new Decimal(1).div(markup)).times(100).toFixed(1)}%`;
}

function printTable(rows: SummaryRow[]): void {
  const head = ["model", "provider", "upstream model", "cost", "sell", "markup / margin", "notes"];
  const body = rows.map((r) => [r.review ? `${r.model} *` : r.model, r.provider, r.upstream, r.cost, r.sell, r.margin, r.note]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of body) console.log(line(r));
  if (rows.some((r) => r.review)) console.log("\n* price taken from the project seed for a post-2025 model: confirm it in /admin/models.");
}

async function waitRedis(ms = 2000): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  for (let i = 0; i < ms / 50 && r.status !== "ready"; i++) await new Promise((res) => setTimeout(res, 50));
  return r.status === "ready";
}

// ------------------------------------------------------------------ upstream availability (read-only)
type ModelIndex = Map<string, { shutdown?: string }>;

/** Models the credential can use, with OpenAI's `shutdown_date` when present. Null when the list cannot be fetched. */
async function fetchModelIndex(spec: ProviderSpec, secret: string): Promise<ModelIndex | null> {
  let url: string;
  let headers: Record<string, string>;
  if (spec.id === "openai") {
    url = `${spec.baseUrl}/models`;
    headers = { authorization: `Bearer ${secret}` };
  } else if (spec.id === "anthropic") {
    url = `${spec.baseUrl}/v1/models?limit=1000`;
    headers = { "x-api-key": secret, "anthropic-version": "2023-06-01" };
  } else return null;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { data?: Array<{ id?: string; shutdown_date?: string }> };
    return new Map((j.data ?? []).filter((m) => m.id).map((m) => [m.id!, { shutdown: m.shutdown_date }]));
  } catch (e) {
    console.warn(`  (could not list ${spec.name} models: ${e instanceof Error ? e.message : e} - availability not checked)`);
    return null;
  }
}

const daysUntil = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);

// ------------------------------------------------------------------ main
async function setupProvider(spec: ProviderSpec): Promise<{ id: string; configured: boolean; index: ModelIndex | null } | null> {
  const secret = (process.env[spec.env] ?? "").trim();
  if (!secret) {
    console.warn(`- ${spec.name}: ${spec.env} is not set in .env -> skipped (its models are not created)`);
    return null;
  }
  const existing = await db.provider.findUnique({ where: { slug: spec.slug } });
  const formats = [...new Set([...(existing?.formats ?? []), ...spec.formats])];
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
  return { id: provider.id, configured: true, index: await fetchModelIndex(spec, secret) };
}

async function upsertModel(m: LiveModel, providerDbId: string, markup: Decimal, status: "ACTIVE" | "DISABLED" = "ACTIVE") {
  const f = markup;
  const c = m.cost;
  const sellData = {
    inputPrice: money(new Decimal(c.in ?? "0").times(f)),
    outputPrice: money(new Decimal(c.out ?? "0").times(f)),
    cachedInputPrice: opt(c.cached, f),
    cacheWritePrice: opt(c.cacheWrite, f),
    cacheWrite1hPrice: opt(c.cacheWrite1h, f),
    imagePrice: opt(c.image, f),
    perSecondPrice: opt(c.perSecond, f),
    perMinutePrice: opt(c.perMinute, f),
    perMillionChars: opt(c.perMillionChars, f),
  };
  const base = {
    displayName: m.displayName,
    vendor: m.vendor,
    description: m.description,
    capabilities: m.caps,
    contextWindow: m.ctx || null,
    maxOutput: m.maxOut || null,
    sortOrder: m.sort,
    status,
    officialInputPrice: optCost(c.in),
    officialOutputPrice: optCost(c.out),
    officialCachedPrice: optCost(c.cached),
    ...sellData,
  };
  const model = await db.model.upsert({ where: { slug: m.slug }, create: { slug: m.slug, ...base }, update: base });
  const routeCost = {
    inputCost: money(c.in ?? "0"),
    outputCost: money(c.out ?? "0"),
    cachedInputCost: optCost(c.cached),
    cacheWriteCost: optCost(c.cacheWrite),
    cacheWrite1hCost: optCost(c.cacheWrite1h),
    imageCost: optCost(c.image),
    perSecondCost: optCost(c.perSecond),
    perMinuteCost: optCost(c.perMinute),
    perMillionCharsCost: optCost(c.perMillionChars),
  };
  await db.modelRoute.upsert({
    where: { modelId_providerId_upstreamModel: { modelId: model.id, providerId: providerDbId, upstreamModel: m.upstream } },
    create: { modelId: model.id, providerId: providerDbId, upstreamModel: m.upstream, label: "live", enabled: true, ...routeCost },
    update: { enabled: true, ...routeCost },
  });
  return model;
}

async function main() {
  const markup = parseMarkup();
  console.log(`ProviderProxy live setup (sell = cost x ${markup.toString()}: +${markup.minus(1).times(100).toFixed(0)}% over cost = ${new Decimal(1).minus(new Decimal(1).div(markup)).times(100).toFixed(1)}% margin on the sell price)\n`);

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
  const availability = (provider: ProviderId, upstream: string): { status: "ACTIVE" | "DISABLED"; note: string } => {
    const idx = indexes.get(provider);
    if (!idx) return { status: "ACTIVE", note: "" };
    const hit = idx.get(upstream);
    if (!hit) return { status: "ACTIVE", note: "not in the provider's model list (no access?)" };
    if (hit.shutdown) {
      const d = daysUntil(hit.shutdown);
      if (d <= 0) return { status: "DISABLED", note: `SHUT DOWN ${hit.shutdown} -> disabled` };
      if (d <= 120) return { status: "ACTIVE", note: `sunset ${hit.shutdown} (${d} d)` };
    }
    return { status: "ACTIVE", note: "" };
  };

  const rows: SummaryRow[] = [];
  const pName = (id: ProviderId) => PROVIDERS.find((p) => p.id === id)!.name;
  for (const m of MODELS) {
    const pid = provIds.get(m.provider);
    if (!pid) continue;
    let avail = availability(m.provider, m.upstream);
    if (m.startDisabled) {
      const existing = await db.model.findUnique({ where: { slug: m.slug }, select: { status: true } });
      if (!existing) avail = { status: "DISABLED", note: "created DISABLED: verify the price, then enable" };
      else if (avail.status === "ACTIVE") avail = { status: existing.status === "DISABLED" ? "DISABLED" : "ACTIVE", note: existing.status === "DISABLED" ? "disabled (enable in /admin/models after checking the price)" : "" };
    }
    await upsertModel(m, pid, markup, avail.status);
    rows.push({
      note: avail.note,
      model: m.slug,
      provider: pName(m.provider),
      upstream: m.upstream,
      cost: describeUnits(m.cost, new Decimal(1)),
      sell: describeUnits(m.cost, markup),
      margin: marginOf(m.cost, markup),
      review: !!m.review,
    });
  }

  // ---- smart-fast: one public model, two upstream providers (what customers see vs what runs)
  const anth = provIds.get("anthropic");
  const oai = provIds.get("openai");
  if (anth && oai) {
    const haiku = MODELS.find((m) => m.slug === "claude-haiku-5-5")!;
    const nano = MODELS.find((m) => m.slug === "gpt-5-nano")!;
    const top = (a?: string, b?: string) => (a === undefined ? b : b === undefined ? a : new Decimal(a).gt(b) ? a : b);
    // one public price per model: cover the most expensive route so BOTH routes keep their margin
    const sellCost: Cost = { in: top(haiku.cost.in, nano.cost.in), out: top(haiku.cost.out, nano.cost.out), cached: top(haiku.cost.cached, nano.cost.cached) };
    const model = await upsertModel(
      { slug: "smart-fast", displayName: "Smart Fast", vendor: "providerproxy", provider: "anthropic", upstream: haiku.upstream, caps: CHAT, ctx: 200_000, maxOut: 32_000, cost: sellCost, sort: 5, description: "Fast, cheap chat model. Served by the best available provider (Claude Haiku, with GPT-5 nano as automatic failover)." },
      anth,
      markup,
    );
    // route 1 (priority 10): Anthropic haiku, its own cost; route 2 (priority 5): OpenAI gpt-5-nano, its own cost
    await db.modelRoute.updateMany({ where: { modelId: model.id, providerId: anth, upstreamModel: haiku.upstream }, data: { priority: 10, label: "primary: Claude Haiku", inputCost: money(haiku.cost.in!), outputCost: money(haiku.cost.out!), cachedInputCost: money(haiku.cost.cached!) } });
    const nanoCost = { inputCost: money(nano.cost.in!), outputCost: money(nano.cost.out!), cachedInputCost: money(nano.cost.cached!) };
    await db.modelRoute.upsert({
      where: { modelId_providerId_upstreamModel: { modelId: model.id, providerId: oai, upstreamModel: nano.upstream } },
      create: { modelId: model.id, providerId: oai, upstreamModel: nano.upstream, priority: 5, label: "failover: GPT-5 nano", enabled: true, ...nanoCost },
      update: { priority: 5, label: "failover: GPT-5 nano", enabled: true, ...nanoCost },
    });
    rows.push({
      model: "smart-fast",
      provider: "Anthropic (10) -> OpenAI (5)",
      upstream: `${haiku.upstream} | ${nano.upstream}`,
      cost: `${describeUnits(haiku.cost, new Decimal(1))} | ${describeUnits(nano.cost, new Decimal(1))}`,
      sell: describeUnits(sellCost, markup),
      note: [availability("anthropic", haiku.upstream).note, availability("openai", nano.upstream).note].filter(Boolean).join("; "),
      margin: `+${markup.minus(1).times(100).toFixed(0)}%..+${new Decimal(nano.cost.out!).gt(0) ? markup.times(sellCost.out!).div(nano.cost.out!).minus(1).times(100).toFixed(0) : "?"}% / ${new Decimal(1).minus(new Decimal(1).div(markup)).times(100).toFixed(1)}%..${new Decimal(1).minus(new Decimal(nano.cost.out!).div(new Decimal(sellCost.out!).times(markup))).times(100).toFixed(1)}%`,
      review: true,
    });
  }

  console.log(`\nModels upserted: ${rows.length}\n`);
  printTable(rows);

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
