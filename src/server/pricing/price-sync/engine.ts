// AI price sync: our route costs (and, for a vendor's own provider, the official list prices) kept in line with the
// pricing pages the providers publish - OpenAI, Anthropic and resellers like the relay have no pricing API, so
// the pages are read by an AI (see ./ai.ts: one of our own pools, billed at our cost) and turned into PROPOSALS.
//
// Accuracy first:
//  - every number the AI reports must be written on the page it came from (and every model / pool name too); a price
//    that is not on the page is never applied automatically
//  - promotional prices are not used (the regular list price is, when the page states it)
//  - an automatic run applies only clean changes ("update"): anything promotional, unverified, not listed for the
//    pool, or bigger than maxAutoChangePct waits for an admin ("review")
//  - a price the page does not give is left alone (never cleared)
//
// Two bases:
//  - "official": the page lists this provider's own prices (OpenAI, Anthropic). Route cost = page price; when the
//    provider is the model's vendor the model's official list price is updated too (customer prices that are
//    "% of official" follow through recomputeModelPrices).
//  - "pool": a reseller billing a % of the official price (the relay "Pro Pool 0.05x"). The AI reads the
//    pool's percentage, which models it serves and whether it charges cache writes; route cost = official x percent.
import { z } from "zod";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/audit";
import { Decimal, toDbString } from "@/lib/money";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { getSettings } from "@/lib/settings";
import { recomputeModelPrices } from "../rules";
import { askPricingAi, type AskAi } from "./ai";
import { fetchPageText, nameOnPage, numbersIn, onPage, round, type PageText } from "./text";

// ------------------------------------------------------------------------------------------------ config

export type Basis = "official" | "pool";

export interface PriceSyncConfig {
  providerId: string;
  sources: Array<{ url: string; label?: string }>;
  basis: Basis;
  poolName: string | null;
  modelSources: Record<string, string>; // routeId -> url | "off"
  auto: boolean;
  intervalHours: number;
  maxAutoChangePct: number;
  lastRunAt: string | null;
  saved: boolean;
}

export const DEFAULT_SOURCES: Record<string, string[]> = {
  openai: ["https://platform.openai.com/docs/pricing.md"],
  anthropic: ["https://platform.claude.com/docs/en/about-claude/pricing.md"],
  "codex-everywhere": ["https://docs.codex-everywhere.com/models/"],
};

/** "CE Pro Pool (0.05x)" -> "Pro Pool". */
export function poolNameFromProvider(name: string): string {
  return name.replace(/^\s*CE\s+/i, "").replace(/\([^)]*\)/g, "").trim();
}

export function defaultConfig(p: { id: string; preset: string; name: string }): PriceSyncConfig {
  const pool = p.preset === "codex-everywhere";
  return {
    providerId: p.id,
    sources: (DEFAULT_SOURCES[p.preset] ?? []).map((url) => ({ url })),
    basis: pool ? "pool" : "official",
    poolName: pool ? poolNameFromProvider(p.name) : null,
    modelSources: {},
    auto: false,
    intervalHours: 10,
    maxAutoChangePct: 50,
    lastRunAt: null,
    saved: false,
  };
}

const sourcesSchema = z.array(z.object({ url: z.string(), label: z.string().optional() })).catch([]);
const modelSourcesSchema = z.record(z.string(), z.string()).catch({});

export async function getPriceSyncConfig(providerId: string): Promise<PriceSyncConfig | null> {
  const p = await db.provider.findUnique({ where: { id: providerId }, select: { id: true, preset: true, name: true, priceSync: true } });
  if (!p) return null;
  const s = p.priceSync;
  if (!s) return defaultConfig(p);
  return {
    providerId,
    sources: sourcesSchema.parse(s.sources),
    basis: s.basis === "pool" ? "pool" : "official",
    poolName: s.poolName,
    modelSources: modelSourcesSchema.parse(s.modelSources),
    auto: s.auto,
    intervalHours: s.intervalHours,
    maxAutoChangePct: s.maxAutoChangePct,
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    saved: true,
  };
}

// ------------------------------------------------------------------------------------------------ units

/** The units a pricing page gives per model, and where they live. */
export const SYNC_UNITS = [
  { unit: "input", ai: "input", cost: "inputCost", official: "officialInputPrice", label: "Input" },
  { unit: "output", ai: "output", cost: "outputCost", official: "officialOutputPrice", label: "Output" },
  { unit: "cachedInput", ai: "cached_input", cost: "cachedInputCost", official: "officialCachedPrice", label: "Cached input" },
  { unit: "cacheWrite", ai: "cache_write", cost: "cacheWriteCost", official: "officialCacheWritePrice", label: "Cache write" },
  { unit: "cacheWrite1h", ai: "cache_write_1h", cost: "cacheWrite1hCost", official: null, label: "Cache write 1h" },
  { unit: "image", ai: "image", cost: "imageCost", official: "officialImagePrice", label: "Per image" },
] as const;
export type SyncUnit = (typeof SYNC_UNITS)[number]["unit"];

export interface UnitChange {
  unit: SyncUnit;
  current: string | null;
  next: string | null; // null = left as is
  currentOfficial?: string | null;
  nextOfficial?: string | null;
  verified: boolean;
  changePct: number | null;
}

export type ProposalStatus = "same" | "update" | "review" | "missing" | "excluded";

export interface Proposal {
  routeId: string;
  modelId: string;
  modelSlug: string;
  upstreamModel: string;
  source: string | null;
  pageModel: string | null;
  status: ProposalStatus;
  reasons: string[];
  units: UnitChange[];
  updatesOfficial: boolean;
}

export interface PoolFinding {
  name: string;
  percent: number | null;
  chargesCacheWrites: boolean | null;
  imagePrice: number | null;
  models: string[];
  verified: boolean;
}

// ------------------------------------------------------------------------------------------------ AI contract

const num = z.preprocess((v) => (typeof v === "string" && v.trim() !== "" ? Number(v.replace(/[$,]/g, "")) : v), z.number().finite().nonnegative().nullable()).catch(null);

const aiSchema = z.object({
  models: z
    .array(
      z.object({
        id: z.string(),
        found: z.boolean().catch(true),
        page_model: z.string().nullable().catch(null),
        source: z.string().nullable().catch(null),
        input: num.optional(),
        output: num.optional(),
        cached_input: num.optional(),
        cache_write: num.optional(),
        cache_write_1h: num.optional(),
        image: num.optional(),
        promotional: z.boolean().catch(false),
        note: z.string().nullable().catch(null),
      }),
    )
    .catch([]),
  pool: z
    .object({
      name: z.string().catch(""),
      percent: num,
      charges_cache_writes: z.boolean().nullable().catch(null),
      image_price: num.optional(),
      models: z.array(z.string()).catch([]),
    })
    .nullable()
    .optional()
    .catch(null),
});
export type AiResult = z.infer<typeof aiSchema>;

/** The JSON object in an AI answer (tolerates code fences and prose around it). */
export function parseAiJson(text: string): AiResult {
  // the first balanced {...} that parses and has "models" (string-aware: braces inside strings do not count)
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const doc = JSON.parse(text.slice(start, i + 1)) as unknown;
          if (doc && typeof doc === "object" && "models" in doc) return aiSchema.parse(doc);
        } catch {
          /* not JSON: try the next "{" */
        }
        break;
      }
    }
  }
  throw new Error("the AI answer contains no JSON object with the prices");
}

interface RouteRow {
  id: string;
  upstreamModel: string;
  enabled: boolean;
  model: { id: string; slug: string; displayName: string; vendor: string; capabilities: string[] } & Record<string, unknown>;
  [k: string]: unknown;
}

const fmt = (v: unknown): string | null => (v === null || v === undefined ? null : new Decimal(String(v)).toString());

export function buildPrompt(cfg: Pick<PriceSyncConfig, "basis" | "poolName">, providerName: string, routes: RouteRow[], pages: PageText[], sourceOf: (r: RouteRow) => string | null): { system: string; user: string } {
  const system = [
    "You read AI model pricing pages and report prices as JSON. You are precise and never guess.",
    "Rules:",
    "- Prices are USD per 1M tokens (images: USD per image). Copy numbers exactly as written on the page (no arithmetic, no rounding).",
    "- Use the standard tier: not Batch, Flex, Priority/Fast, regional/data-residency or long-context rates. Use the short-context column.",
    "- Each model comes with the values we currently store: report the page value from the SAME column / kind of price (e.g. for an image model whose current input matches the text-token input, report the text-token input).",
    "- Image-generation models priced per token with separate Text and Image rows: input and cached_input = the Text row, output = the Image row's output.",
    "- A unit the page does not give for that model: null. A model the page does not list: found=false.",
    "- If the page marks a model's price as promotional / temporary / discounted: promotional=true and report the REGULAR price if the page states it, otherwise null for those units.",
    "- cache_write = the shortest cache-write duration (Anthropic 5-minute, OpenAI 30-minute). cache_write_1h = ONLY Anthropic's 1-hour cache write (null for every other vendor; never a 12-hour or other duration).",
    "- page_model = the model name exactly as the page writes it. source = the URL of the page you took it from.",
    "Answer with ONE JSON object and nothing else.",
  ].join("\n");

  const models = routes.map((r) => {
    const cur: Record<string, string | null> = {};
    for (const u of SYNC_UNITS) cur[u.ai] = fmt(r[u.cost]);
    const src = sourceOf(r);
    return { id: r.upstreamModel, name: r.model.displayName, vendor: r.model.vendor, ...(src ? { only_source: src } : {}), current: cur };
  });

  const poolAsk =
    cfg.basis === "pool"
      ? [
          "",
          `This provider ("${providerName}") is a reseller pool named "${cfg.poolName ?? providerName}" that bills a percentage of the official vendor price.`,
          'Also report "pool": { "name": the pool name as written, "percent": the percentage of official pricing it bills (e.g. 0.05x -> 5, 8% -> 8), "charges_cache_writes": false if the page says this pool (or the reseller, for the models of this vendor) does not charge cache writes, true if it gives cache-write prices or rules for the models of this vendor without excluding the pool, null only if the page says nothing about cache writes, "image_price": flat USD per generated image if the page gives one for this pool, else null, "models": every model id the page lists for this pool }.',
          "For pool providers the per-model prices are the OFFICIAL vendor prices shown on the page (not the pool's discounted prices), or null if the page has none.",
        ].join("\n")
      : "";

  const user = [
    `Provider: ${providerName}`,
    `Models (id = our id for it; match the page's name for the same model, ignoring date suffixes):`,
    JSON.stringify(models, null, 1),
    poolAsk,
    "",
    'Answer shape: { "models": [ { "id", "found", "page_model", "source", "input", "output", "cached_input", "cache_write", "cache_write_1h", "image", "promotional", "note" } ]' + (cfg.basis === "pool" ? ', "pool": { ... } }' : " }"),
    "",
    ...pages.filter((p) => p.ok).map((p) => `===== PAGE ${p.url} =====\n${p.text}\n===== END PAGE =====`),
  ].join("\n");
  return { system, user };
}

// ------------------------------------------------------------------------------------------------ proposals

const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(String(v)));
const pct = (cur: number | null, next: number | null): number | null => {
  if (next === null) return null;
  if (cur === null || cur === 0) return next === 0 ? 0 : null;
  return Math.round((Math.abs(next - cur) / cur) * 1000) / 10;
};
const dec = (n: number): string => toDbString(new Decimal(String(round(n))));

export interface ProposalInput {
  basis: Basis;
  /** basis "pool": the pool's name as configured (checked on the page, like the AI's reading of it) */
  poolName?: string | null;
  providerPreset: string;
  maxAutoChangePct: number;
  routes: RouteRow[];
  modelSources: Record<string, string>;
  pages: PageText[];
  ai: AiResult;
  /** basis "pool": the vendor's own 1h cache-write cost per model id (the official provider's route), when known */
  official1h?: Map<string, number>;
}

export function buildProposals(input: ProposalInput): { proposals: Proposal[]; pool: PoolFinding | null } {
  const okPages = input.pages.filter((p) => p.ok);
  const allText = okPages.map((p) => p.text).join("\n");
  const nums = new Map(okPages.map((p) => [p.url, numbersIn(p.text)]));
  const allNums = numbersIn(allText);
  const byId = new Map(input.ai.models.map((m) => [m.id.toLowerCase(), m]));

  let pool: PoolFinding | null = null;
  if (input.basis === "pool" && input.ai.pool) {
    const p = input.ai.pool;
    const percent = p.percent ?? null;
    const names = [input.poolName, p.name, p.name.replace(/\([^)]*\)/g, "")].map((n) => (n ?? "").trim()).filter(Boolean);
    const verified = percent !== null && percent > 0 && percent <= 100 && (onPage(percent, allNums) || onPage(percent / 100, allNums)) && names.some((n) => nameOnPage(n, allText));
    pool = { name: p.name, percent, chargesCacheWrites: p.charges_cache_writes ?? null, imagePrice: p.image_price ?? null, models: p.models, verified };
  }

  const proposals: Proposal[] = input.routes.map((r) => {
    const base = { routeId: r.id, modelId: r.model.id, modelSlug: r.model.slug, upstreamModel: r.upstreamModel };
    const pinned = input.modelSources[r.id];
    if (pinned === "off") return { ...base, source: null, pageModel: null, status: "excluded", reasons: ["excluded from price sync"], units: [], updatesOfficial: false };
    const m = byId.get(r.upstreamModel.toLowerCase());
    const reasons: string[] = [];
    const source = pinned || m?.source || null;
    const pageNums = (pinned ? nums.get(pinned) : m?.source ? nums.get(m.source) : undefined) ?? allNums;
    const units: UnitChange[] = [];
    const updatesOfficial = input.basis === "official" && input.providerPreset === r.model.vendor;
    let notListed = false;

    if (input.basis === "official") {
      if (!m || !m.found) return { ...base, source, pageModel: null, status: "missing", reasons: ["not found on the page"], units: [], updatesOfficial };
      if (m.page_model && !nameOnPage(m.page_model, allText)) reasons.push(`model name "${m.page_model}" is not on the page`);
      // a promotional price is never used: we keep billing the regular list price
      if (m.promotional) return { ...base, source, pageModel: m.page_model, status: "same", reasons: ["the page shows a promotional price: kept the regular list price"], units: [], updatesOfficial };
      for (const u of SYNC_UNITS) {
        if (u.unit === "cacheWrite1h" && r.model.vendor !== "anthropic") continue; // only Anthropic has a 1h cache write
        const page = (m as Record<string, unknown>)[u.ai] as number | null | undefined;
        const cur = toNum(r[u.cost]);
        if (page === null || page === undefined) continue;
        const verified = onPage(page, pageNums);
        if (page === 0 && !verified) continue; // "$0" for a unit the page does not price (audio models ...): not a price
        if (!verified) reasons.push(`${u.label} $${page} is not written on the page`);
        const ch: UnitChange = { unit: u.unit, current: fmt(r[u.cost]), next: cur !== null && round(cur) === round(page) ? null : dec(page), verified, changePct: pct(cur, page) };
        if (updatesOfficial && u.official) {
          const curO = toNum(r.model[u.official]);
          ch.currentOfficial = fmt(r.model[u.official]);
          ch.nextOfficial = curO !== null && round(curO) === round(page) ? null : dec(page);
        }
        units.push(ch);
      }
    } else {
      const listed = pool ? pool.models.some((x) => x.toLowerCase() === r.upstreamModel.toLowerCase()) && nameOnPage(r.upstreamModel, allText) : false;
      if (!pool || pool.percent === null) return { ...base, source, pageModel: null, status: "missing", reasons: ["the pool's percentage was not found on the page"], units: [], updatesOfficial: false };
      if (!pool.verified) reasons.push(`pool "${pool.name}" ${pool.percent}% is not written on the page`);
      if (!listed) {
        notListed = true;
        reasons.push(`not listed for ${pool.name || "this pool"} on the page`);
      }
      const f = pool.percent / 100;
      // an image model the pool bills per image (flat): its token prices are not derived from the official ones
      const flatImage = pool.imagePrice !== null && r.model.capabilities.includes("images");
      for (const u of SYNC_UNITS) {
        if (flatImage && u.unit !== "image") continue;
        const cur = toNum(r[u.cost]);
        let next: number | null = null;
        let verified = pool.verified;
        if (u.unit === "image") {
          if (pool.imagePrice === null || !r.model.capabilities.includes("images")) continue;
          next = pool.imagePrice;
          verified = onPage(pool.imagePrice, allNums);
        } else if (u.unit === "cacheWrite" || u.unit === "cacheWrite1h") {
          if (pool.chargesCacheWrites === false) next = 0;
          else if (pool.chargesCacheWrites === true) {
            const off = u.unit === "cacheWrite" ? toNum(r.model.officialCacheWritePrice) : (input.official1h?.get(r.model.id) ?? null);
            if (off === null) continue;
            next = off * f;
          } else continue; // the page does not say: leave it
        } else {
          const off = toNum(r.model[u.official as string]);
          if (off === null) continue;
          next = off * f;
        }
        if (cur === null && next === null) continue;
        units.push({ unit: u.unit, current: fmt(r[u.cost]), next: cur !== null && next !== null && round(cur) === round(next) ? null : next === null ? null : dec(next), verified, changePct: pct(cur, next) });
      }
    }

    const changed = units.filter((u) => u.next !== null || (u.nextOfficial !== undefined && u.nextOfficial !== null));
    if (!changed.length) return { ...base, source, pageModel: m?.page_model ?? null, status: notListed ? "review" : "same", reasons, units, updatesOfficial };
    const big = changed.filter((u) => u.changePct === null || u.changePct > input.maxAutoChangePct);
    if (big.length) reasons.push(`change bigger than ${input.maxAutoChangePct}% (${big.map((u) => u.unit).join(", ")})`);
    const clean = !reasons.length && changed.every((u) => u.verified);
    return { ...base, source, pageModel: m?.page_model ?? null, status: clean ? "update" : "review", reasons, units, updatesOfficial };
  });
  return { proposals, pool };
}

// ------------------------------------------------------------------------------------------------ run

export interface RunOptions {
  trigger: "manual" | "auto";
  actorId?: string | null;
  ask?: AskAi;
  fetchText?: (url: string) => Promise<PageText>;
}

/** Read the pages, ask the AI, store the proposals. Returns the run id. Throws only when the provider does not exist. */
export async function runPriceSync(providerId: string, opts: RunOptions): Promise<string> {
  const provider = await db.provider.findUnique({ where: { id: providerId }, select: { id: true, name: true, preset: true } });
  if (!provider) throw new Error("Provider not found");
  const cfg = (await getPriceSyncConfig(providerId))!;
  const run = await db.priceSyncRun.create({ data: { providerId, trigger: opts.trigger, status: "running" } });
  await db.priceSync.upsert({ where: { providerId }, create: { providerId, sources: cfg.sources, basis: cfg.basis, poolName: cfg.poolName, lastRunAt: new Date() }, update: { lastRunAt: new Date() } });
  const requestIds: string[] = [];
  try {
    if (!cfg.sources.length) throw new Error("No pricing page is configured");
    const routes = (await db.modelRoute.findMany({
      where: { providerId, enabled: true },
      include: { model: true },
      orderBy: { upstreamModel: "asc" },
    })) as unknown as RouteRow[];
    if (!routes.length) throw new Error("The provider has no enabled model routes");
    const fetchText = opts.fetchText ?? ((url: string) => fetchPageText(url));
    const pages = await Promise.all(cfg.sources.map((s) => fetchText(s.url)));
    const sourcesInfo = pages.map((p) => ({ url: p.url, ok: p.ok, chars: p.chars, ...(p.error ? { error: p.error } : {}) }));
    if (!pages.some((p) => p.ok)) throw Object.assign(new Error(`No pricing page could be read: ${pages.map((p) => `${p.url}: ${p.error}`).join("; ")}`), { sourcesInfo });
    const active = routes.filter((r) => cfg.modelSources[r.id] !== "off");
    const pinned = (r: RouteRow) => (cfg.modelSources[r.id] && cfg.modelSources[r.id] !== "off" ? cfg.modelSources[r.id] : null);
    let ai: AiResult = { models: [], pool: null };
    if (active.length) {
      const { system, user } = buildPrompt(cfg, provider.name, active, pages, pinned);
      const ask = opts.ask ?? askPricingAi;
      let answer;
      try {
        answer = await ask(system, user);
      } catch (err) {
        const rid = (err as { requestId?: string | null }).requestId;
        if (rid) requestIds.push(rid);
        throw err;
      }
      if (answer.requestId) requestIds.push(answer.requestId);
      ai = parseAiJson(answer.text);
    }
    let official1h: Map<string, number> | undefined;
    if (cfg.basis === "pool") {
      // the vendor's own 1h cache-write price (the official provider's route of the same model)
      const off = await db.modelRoute.findMany({ where: { modelId: { in: routes.map((r) => r.model.id) }, providerId: { not: providerId }, cacheWrite1hCost: { not: null }, provider: { preset: { in: ["openai", "anthropic", "google", "xai", "deepseek"] } } }, include: { provider: { select: { preset: true } }, model: { select: { vendor: true } } } });
      official1h = new Map(off.filter((o) => o.provider.preset === o.model.vendor).map((o) => [o.modelId, Number(o.cacheWrite1hCost!.toString())]));
    }
    const { proposals, pool } = buildProposals({ basis: cfg.basis, poolName: cfg.poolName, providerPreset: provider.preset, maxAutoChangePct: cfg.maxAutoChangePct, routes, modelSources: cfg.modelSources, pages, ai, official1h });
    await db.priceSyncRun.update({ where: { id: run.id }, data: { status: "ok", proposals: proposals as never, pool: (pool ?? undefined) as never, sources: sourcesInfo as never, requestIds, finishedAt: new Date() } });
    return run.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("price sync failed", { providerId, err: msg });
    const sourcesInfo = (err as { sourcesInfo?: unknown }).sourcesInfo;
    await db.priceSyncRun.update({ where: { id: run.id }, data: { status: "failed", error: msg.slice(0, 1000), requestIds, finishedAt: new Date(), ...(sourcesInfo ? { sources: sourcesInfo as never } : {}) } });
    return run.id;
  }
}

/** Apply proposals of a run (only "update" / "review" rows; an automatic run passes the "update" ones). */
export async function applyPriceSyncRun(runId: string, routeIds: string[], opts: { actorId?: string | null; auto?: boolean } = {}): Promise<{ applied: number }> {
  const run = await db.priceSyncRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== "ok") throw new Error("Run not found or not finished");
  const wanted = new Set(routeIds);
  const proposals = (run.proposals as unknown as Proposal[]).filter((p) => wanted.has(p.routeId) && (p.status === "update" || (!opts.auto && p.status === "review")));
  const items: Array<{ routeId: string; modelSlug: string; changes: Record<string, { from: string | null; to: string }> }> = [];
  const models = new Set<string>();
  for (const p of proposals) {
    const routeData: Record<string, string> = {};
    const modelData: Record<string, string> = {};
    const changes: Record<string, { from: string | null; to: string }> = {};
    for (const u of p.units) {
      const def = SYNC_UNITS.find((x) => x.unit === u.unit)!;
      if (u.next !== null) {
        routeData[def.cost] = u.next;
        changes[def.cost] = { from: u.current, to: u.next };
      }
      if (p.updatesOfficial && def.official && u.nextOfficial) {
        modelData[def.official] = u.nextOfficial;
        changes[def.official] = { from: u.currentOfficial ?? null, to: u.nextOfficial };
      }
    }
    if (!Object.keys(changes).length) continue;
    if (Object.keys(routeData).length) await db.modelRoute.update({ where: { id: p.routeId }, data: routeData });
    if (Object.keys(modelData).length) await db.model.update({ where: { id: p.modelId }, data: modelData });
    models.add(p.modelId);
    items.push({ routeId: p.routeId, modelSlug: p.modelSlug, changes });
  }
  for (const id of models) await recomputeModelPrices(id);
  if (models.size) await invalidateGatewayConfig("models");
  const prev = (run.applied as { items?: unknown[] } | null)?.items ?? [];
  await db.priceSyncRun.update({ where: { id: runId }, data: { applied: { at: new Date().toISOString(), by: opts.actorId ?? (opts.auto ? "auto" : null), items: [...prev, ...items] } as never } });
  if (items.length) await audit(opts.actorId ?? null, "pricing.price_sync_apply", { type: "Provider", id: run.providerId }, { runId, auto: !!opts.auto, items });
  return { applied: items.length };
}

/** Maintenance: run every provider whose automatic sync is due (vendors first, so pools use fresh official prices). */
export async function runDuePriceSyncs(now = new Date()): Promise<{ ran: string[]; applied: number }> {
  const settings = await getSettings();
  if (!settings.priceSyncAuto) return { ran: [], applied: 0 };
  const intervalMs = settings.priceSyncIntervalHours * 3_600_000;
  const due = await db.priceSync.findMany({ where: { auto: true }, include: { provider: { select: { status: true } } } });
  const ready = due
    .filter((s) => s.provider.status === "ACTIVE" && (!s.lastRunAt || now.getTime() - s.lastRunAt.getTime() >= intervalMs))
    .sort((a, b) => (a.basis === b.basis ? 0 : a.basis === "official" ? -1 : 1));
  const ran: string[] = [];
  let applied = 0;
  for (const s of ready) {
    // claim (all instances): only the instance that moves lastRunAt runs it
    const claimed = await db.priceSync.updateMany({ where: { providerId: s.providerId, lastRunAt: s.lastRunAt }, data: { lastRunAt: now } });
    if (!claimed.count) continue;
    const runId = await runPriceSync(s.providerId, { trigger: "auto" });
    const run = await db.priceSyncRun.findUnique({ where: { id: runId }, select: { status: true, proposals: true } });
    ran.push(s.providerId);
    if (run?.status !== "ok") continue;
    const ids = (run.proposals as unknown as Proposal[]).filter((p) => p.status === "update").map((p) => p.routeId);
    if (ids.length) applied += (await applyPriceSyncRun(runId, ids, { auto: true })).applied;
  }
  return { ran, applied };
}
