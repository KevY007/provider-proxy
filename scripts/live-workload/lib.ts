/**
 * Shared harness for the live-workload scenarios (see run.ts).
 * - creates / reuses the customer workload@example.com and a fresh API key (never printed),
 * - tracks every HTTP call made through the gateway (x-request-id) so each scenario can verify the RequestLog rows,
 * - independently recomputes cost from the route's cost table and compares it with the logged cost,
 * - keeps running spend totals per upstream provider (sum of RequestLog.cost) and enforces the owner-approved budgets.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { db } from "../../src/lib/db";
import { generateApiKey, randomToken } from "../../src/lib/crypto";
import { hashPassword } from "../../src/lib/auth/password";
import { invalidateGatewayConfig } from "../../src/gateway/cache";
import { Decimal } from "../../src/lib/money";
import { credit, debit } from "../../src/server/billing/ledger";

export const BASE = (process.env.WL_BASE_URL ?? "http://localhost:3011").replace(/\/+$/, "");
export const EMAIL = "workload@example.com";
export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const OUT = path.join(ROOT, "live-output");
export const BUDGET = { anthropic: 120, openai: 10, other: 1 } as const;

export const D = (v: { toString(): string } | null | undefined) => new Decimal(v ? v.toString() : 0);
export const usd = (d: Decimal.Value) => {
  const x = new Decimal(d);
  return x.isZero() ? "$0" : `$${x.toSignificantDigits(5).toFixed()}`;
};
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const mkdir = (p: string) => fs.mkdirSync(p, { recursive: true });

// ------------------------------------------------------------------ context
export const ctx = {
  userId: "",
  keyId: "",
  key: "",
  providerSlug: new Map<string, string>(),
  runStart: new Date(),
};

export async function init(): Promise<void> {
  const group = await db.group.findUnique({ where: { slug: "standard" } });
  let u = await db.user.findUnique({ where: { email: EMAIL } });
  if (!u) {
    u = await db.user.create({
      data: { email: EMAIL, name: "Workload Tester", passwordHash: await hashPassword(randomToken(24)), role: "CUSTOMER", status: "ACTIVE", emailVerifiedAt: new Date(), groupId: group?.id, trialGrantedAt: new Date() },
    });
  } else {
    u = await db.user.update({ where: { id: u.id }, data: { status: "ACTIVE", emailVerifiedAt: u.emailVerifiedAt ?? new Date(), groupId: group?.id ?? u.groupId, priceMultiplier: null, creditLimit: "0", monthlySpendLimit: null } });
  }
  const diff = new Decimal(500).minus(D(u.balance));
  if (diff.gt(0)) await credit(u.id, diff, "ADJUSTMENT", "Live workload: starting balance $500");
  ctx.userId = u.id;
  await db.apiKey.updateMany({ where: { userId: u.id, name: { startsWith: "workload" }, status: "ACTIVE" }, data: { status: "REVOKED" } });
  const k = generateApiKey();
  const row = await db.apiKey.create({ data: { userId: u.id, name: "workload main", prefix: k.prefix, keyHash: k.hash } });
  ctx.keyId = row.id;
  ctx.key = k.key;
  ctx.providerSlug = new Map((await db.provider.findMany({ select: { id: true, slug: true } })).map((p) => [p.id, p.slug]));
  await invalidateGatewayConfig("all");
  await sleep(500);
}

/** Extra API key for the workload customer (returns the secret). */
export async function newKey(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const k = generateApiKey();
  await db.apiKey.create({ data: { userId: ctx.userId, name, prefix: k.prefix, keyHash: k.hash, ...extra } });
  return k.key;
}

/** Top the balance back up when a long run has used a lot of it. */
export async function topUp(min = 100): Promise<void> {
  const u = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { balance: true } });
  if (D(u.balance).lt(min)) await credit(ctx.userId, new Decimal(500).minus(D(u.balance)), "ADJUSTMENT", "Live workload: top-up to $500");
}

// ------------------------------------------------------------------ request tracking
export interface Tracked {
  scenario: string;
  rid: string | null;
  method: string;
  path: string;
  status: number;
  headersMs: number;
  /** wall clock when the request started (for correlation) */
  at: number;
}
export const tracked: Tracked[] = [];
let currentScenario = "-";
export const setCurrentScenario = (s: string) => (currentScenario = s);

/** fetch wrapper: records x-request-id of every call that goes through the gateway. */
export const tfetch: typeof fetch = async (input, init) => {
  const t0 = Date.now();
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const method = (init?.method ?? (input as Request).method ?? "GET").toUpperCase();
  const res = await fetch(input as RequestInfo, init);
  let p = url;
  try {
    const u = new URL(url);
    p = u.pathname + u.search;
  } catch {
    /* keep */
  }
  tracked.push({ scenario: currentScenario, rid: res.headers.get("x-request-id"), method, path: p, status: res.status, headersMs: Date.now() - t0, at: t0 });
  return res;
};

export function anthropic(extra: Record<string, unknown> = {}): Anthropic {
  return new Anthropic({ apiKey: ctx.key, baseURL: BASE, fetch: tfetch, maxRetries: 0, timeout: 25 * 60_000, ...extra });
}
export function openai(extra: Record<string, unknown> = {}): OpenAI {
  return new OpenAI({ apiKey: ctx.key, baseURL: `${BASE}/v1`, fetch: tfetch, maxRetries: 0, timeout: 25 * 60_000, ...extra });
}

/** raw call to the gateway with the customer key (Anthropic headers by default). */
export async function raw(p: string, o: { method?: string; headers?: Record<string, string>; body?: unknown; form?: FormData; anthropicStyle?: boolean; timeoutMs?: number } = {}) {
  const headers: Record<string, string> = o.anthropicStyle === false ? { authorization: `Bearer ${ctx.key}` } : { "x-api-key": ctx.key, "anthropic-version": "2023-06-01" };
  Object.assign(headers, o.headers);
  let body: BodyInit | undefined;
  if (o.form) body = o.form;
  else if (o.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.body);
  }
  const t0 = Date.now();
  const res = await tfetch(BASE + p, { method: o.method ?? (body ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? 600_000) });
  return { res, rid: res.headers.get("x-request-id"), ms: Date.now() - t0 };
}

// ------------------------------------------------------------------ spend
export async function spendByProvider(): Promise<Record<string, Decimal>> {
  const rows = await db.requestLog.groupBy({ by: ["providerId"], where: { userId: ctx.userId }, _sum: { cost: true, price: true } });
  const out: Record<string, Decimal> = {};
  for (const r of rows) {
    const slug = (r.providerId && ctx.providerSlug.get(r.providerId)) || "none";
    out[slug] = (out[slug] ?? new Decimal(0)).plus(D(r._sum.cost));
  }
  return out;
}
export async function spendLine(): Promise<string> {
  const s = await spendByProvider();
  return Object.entries(s)
    .map(([k, v]) => `${k} ${usd(v)}`)
    .join(" | ");
}
/** Throws when the owner-approved budget of a provider is used up. */
export async function guard(provider: "anthropic" | "openai", reserveUsd = 0): Promise<void> {
  const s = await spendByProvider();
  const used = s[provider] ?? new Decimal(0);
  const cap = BUDGET[provider];
  if (used.plus(reserveUsd).gt(cap)) throw new Error(`budget guard: ${provider} spend ${usd(used)} (+${reserveUsd} reserved) would exceed the cap $${cap}`);
  const other = new Decimal((s.fal ?? 0).toString()).plus((s.replicate ?? 0).toString());
  if (other.gt(BUDGET.other)) throw new Error(`budget guard: fal+replicate spend ${usd(other)} exceeds $${BUDGET.other}`);
}

// ------------------------------------------------------------------ independent price recomputation
type LogRow = Awaited<ReturnType<typeof db.requestLog.findUniqueOrThrow>>;
export async function expectedCost(log: LogRow): Promise<{ cost: Decimal; note: string } | null> {
  if (!log.modelSlug || !log.providerId || !log.upstreamModel) return null;
  const model = await db.model.findUnique({ where: { slug: log.modelSlug } });
  if (!model) return null;
  const route = await db.modelRoute.findFirst({ where: { modelId: model.id, providerId: log.providerId, upstreamModel: log.upstreamModel } });
  if (!route) return null;
  const M = new Decimal(1_000_000);
  const inp = log.inputTokens;
  const cached = Math.min(log.cachedTokens, inp);
  const cw = Math.min(log.cacheWriteTokens, inp - cached);
  const uncached = inp - cached - cw;
  const c = (v: unknown, fb: Decimal) => (v === null || v === undefined ? fb : D(v as never));
  const cin = D(route.inputCost);
  let tokens = new Decimal(uncached)
    .times(cin)
    .plus(new Decimal(cached).times(c(route.cachedInputCost, cin)))
    .plus(new Decimal(cw).times(c(route.cacheWriteCost, cin)))
    .plus(new Decimal(log.outputTokens).times(D(route.outputCost)))
    .div(M);
  let lc = "";
  if (model.longContextThreshold && model.longContextMultiplier && inp > model.longContextThreshold) {
    tokens = tokens.times(D(model.longContextMultiplier));
    lc = ` (long-context x${model.longContextMultiplier})`;
  }
  // Batch API results: the supplier's batch discount on the token part
  const batchId = (log as unknown as { batchId?: string | null }).batchId;
  if (batchId) {
    tokens = tokens.times(new Decimal(1).minus(D(route.batchCostDiscountPct ?? 50).div(100)));
    lc += " (batch)";
  }
  let flat = new Decimal(log.imageCount).times(D(route.imageCost)).plus(D(route.requestCost)).plus(new Decimal(log.videoSeconds).times(D(route.perSecondCost)));
  // server tools (web search, code execution hours ...): units x the route's tool cost
  const usage = ((log as unknown as { toolUsage?: Record<string, number> }).toolUsage ?? {}) as Record<string, number>;
  const toolCosts = (route.toolCosts ?? {}) as Record<string, unknown>;
  for (const [k, units] of Object.entries(usage)) if (toolCosts[k] !== undefined && units > 0) flat = flat.plus(D(toolCosts[k] as never).times(units));
  return { cost: tokens.plus(flat), note: `recomputed from route costs${lc}` };
}

// ------------------------------------------------------------------ scenario runner
export interface CheckRow {
  name: string;
  ok: boolean;
  note: string;
}
export interface ReqRow {
  rid: string;
  method: string;
  path: string;
  httpStatus: number;
  model: string | null;
  upstream: string | null;
  provider: string | null;
  stream: boolean;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  imageCount: number;
  price: string;
  cost: string;
  officialPrice: string;
  latencyMs: number;
  ttftMs: number | null;
  queueMs: number;
  costRecheck: string;
}
export interface ScenarioResult {
  id: string;
  title: string;
  status: "PASS" | "FAIL" | "SKIP";
  checks: CheckRow[];
  requests: ReqRow[];
  notes: string[];
  artifacts: string[];
  bugs: string[];
  wallMs: number;
  price: string;
  cost: string;
  official: string;
  startedAt: string;
}

export class Scn {
  checks: CheckRow[] = [];
  notes: string[] = [];
  artifacts: string[] = [];
  bugs: string[] = [];
  dir: string;
  skipped = "";
  constructor(
    public id: string,
    public title: string,
  ) {
    this.dir = path.join(OUT, id.toLowerCase());
    mkdir(this.dir);
  }
  note(s: string) {
    this.notes.push(s);
    console.log(`      . ${s}`);
  }
  bug(s: string) {
    this.bugs.push(s);
    console.log(`      !! BUG: ${s}`);
  }
  save(name: string, data: string | Buffer | object): string {
    const p = path.join(this.dir, name);
    mkdir(path.dirname(p));
    fs.writeFileSync(p, typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2));
    this.artifacts.push(path.relative(ROOT, p).replace(/\\/g, "/"));
    return p;
  }
  /** Record one check; never throws. */
  check(name: string, cond: unknown, note = ""): boolean {
    const ok = !!cond;
    this.checks.push({ name, ok, note: ok ? note : note || "failed" });
    console.log(`   ${ok ? "ok  " : "FAIL"} ${name}${note ? `  - ${note}` : ""}`);
    return ok;
  }
  /** Run an async step; exceptions become a failed check. */
  async step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    const t0 = Date.now();
    try {
      const r = await fn();
      this.check(name, true, `${Date.now() - t0} ms`);
      return r;
    } catch (e) {
      const msg = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
      this.check(name, false, msg.slice(0, 600));
      return undefined;
    }
  }
  skip(why: string) {
    this.skipped = why;
  }
}

export const results: ScenarioResult[] = [];

export async function waitLog(rid: string, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const row = await db.requestLog.findUnique({ where: { id: rid } });
    if (row) return row;
    await sleep(150);
  }
  return null;
}

export interface VerifyOpts {
  /** expect these requests to be billable (price >= cost > 0; equal under the match-official default). Default: any request that carries usage. */
  expectBilled?: boolean;
  /** tolerance for recomputed cost (relative) */
  tol?: number;
}

/** Verify RequestLog rows for every tracked request of this scenario. Returns the rows. */
async function verifyRequests(s: Scn, since: number): Promise<ReqRow[]> {
  const mine = tracked.filter((t) => t.scenario === s.id && t.at >= since && t.rid);
  const rows: ReqRow[] = [];
  let sumPrice = new Decimal(0);
  let missing = 0;
  let billed = 0;
  let badPrice = 0;
  let badCost = 0;
  let noOfficial = 0;
  let notSuccess = 0;
  const costNotes: string[] = [];
  for (const t of mine) {
    const log = await waitLog(t.rid!);
    if (!log) {
      missing++;
      continue;
    }
    const price = D(log.price);
    const cost = D(log.cost);
    const hasUsage = log.inputTokens + log.outputTokens + log.imageCount + log.characters > 0 || log.videoSeconds > 0 || log.audioSeconds > 0;
    sumPrice = sumPrice.plus(price);
    // (a stream the scenario itself abandoned is CANCELLED although its HTTP status was 200)
    if (log.status !== "SUCCESS" && log.status !== "CANCELLED" && t.status < 400) notSuccess++;
    let costRecheck = "";
    if (hasUsage && log.status === "SUCCESS") {
      billed++;
      if (!(cost.gt(0) && price.gte(cost))) {
        badPrice++;
        s.note(`request ${log.id}: expected price >= cost > 0, got price=${price} cost=${cost}`);
      }
      if (!D(log.officialPrice).gt(0)) noOfficial++;
      const exp = await expectedCost(log);
      if (exp) {
        const diff = exp.cost.minus(cost).abs();
        const rel = cost.isZero() ? (exp.cost.isZero() ? new Decimal(0) : new Decimal(1)) : diff.div(cost);
        costRecheck = rel.lte(0.001) ? "match" : `MISMATCH expected ${exp.cost.toSignificantDigits(6)} vs logged ${cost.toSignificantDigits(6)}`;
        if (rel.gt(0.001)) {
          badCost++;
          costNotes.push(`${log.id}: ${costRecheck} [${log.modelSlug} in=${log.inputTokens} cached=${log.cachedTokens} cw=${log.cacheWriteTokens} out=${log.outputTokens}] ${exp.note}`);
        }
      }
    }
    rows.push({
      rid: log.id,
      method: t.method,
      path: t.path,
      httpStatus: log.httpStatus,
      model: log.modelSlug,
      upstream: log.upstreamModel,
      provider: log.providerId ? (ctx.providerSlug.get(log.providerId) ?? null) : null,
      stream: log.stream,
      status: log.status,
      inputTokens: log.inputTokens,
      outputTokens: log.outputTokens,
      cachedTokens: log.cachedTokens,
      cacheWriteTokens: log.cacheWriteTokens,
      reasoningTokens: log.reasoningTokens,
      imageCount: log.imageCount,
      price: price.toFixed(),
      cost: cost.toFixed(),
      officialPrice: D(log.officialPrice).toFixed(),
      latencyMs: log.latencyMs,
      ttftMs: log.ttftMs,
      queueMs: log.queueMs,
      costRecheck,
    });
  }
  s.check("every request has a RequestLog row", missing === 0, `${mine.length} requests, ${missing} missing`);
  if (billed > 0) {
    s.check("billed rows: price >= cost > 0", badPrice === 0, `${billed} billed rows, ${badPrice} bad`);
    s.check("billed rows: officialPrice recorded", noOfficial === 0, `${noOfficial} without officialPrice`);
    s.check("logged cost == cost recomputed from the route cost table", badCost === 0, badCost ? costNotes.slice(0, 3).join(" ; ") : `${billed} rows`);
    if (badCost) for (const n of costNotes.slice(0, 5)) s.bug(`cost mismatch: ${n}`);
  }
  s.check("no 2xx request logged as non-SUCCESS", notSuccess === 0, `${notSuccess}`);
  void sumPrice;
  return rows;
}

/** Run one scenario, verify its requests, record the result. */
export async function runScenario(id: string, title: string, fn: (s: Scn) => Promise<void>): Promise<ScenarioResult> {
  const s = new Scn(id, title);
  console.log(`\n=== ${id}. ${title}`);
  setCurrentScenario(id);
  const since = Date.now() - 1;
  const balBefore = D((await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { balance: true } })).balance);
  const t0 = Date.now();
  const startedAt = new Date();
  try {
    await fn(s);
  } catch (e) {
    s.check("scenario completed without an unhandled error", false, e instanceof Error ? `${e.message}\n${e.stack?.split("\n").slice(1, 4).join("\n")}` : String(e));
  }
  const wallMs = Date.now() - t0;
  let reqs: ReqRow[] = [];
  if (!s.skipped) {
    reqs = await verifyRequests(s, since);
    await sleep(1800); // let the batched meter-writer flush balance updates
    const balAfter = D((await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { balance: true } })).balance);
    const sumP = reqs.reduce((a, r) => a.plus(r.price), new Decimal(0));
    const spent = balBefore.minus(balAfter);
    // refunds/credits excluded; other concurrent traffic does not exist (sequential scenarios)
    s.check("balance decreased by exactly the sum of the logged prices", spent.minus(sumP).abs().lte(0.000001), `balance moved ${spent.toSignificantDigits(8)} vs logged ${sumP.toSignificantDigits(8)}`);
  }
  const price = reqs.reduce((a, r) => a.plus(r.price), new Decimal(0));
  const cost = reqs.reduce((a, r) => a.plus(r.cost), new Decimal(0));
  const official = reqs.reduce((a, r) => a.plus(r.officialPrice), new Decimal(0));
  const failed = s.checks.filter((c) => !c.ok).length;
  const res: ScenarioResult = {
    id,
    title,
    status: s.skipped ? "SKIP" : failed ? "FAIL" : "PASS",
    checks: s.checks,
    requests: reqs,
    notes: s.skipped ? [...s.notes, `SKIPPED: ${s.skipped}`] : s.notes,
    artifacts: s.artifacts,
    bugs: s.bugs,
    wallMs,
    price: price.toFixed(),
    cost: cost.toFixed(),
    official: official.toFixed(),
    startedAt: startedAt.toISOString(),
  };
  results.push(res);
  mkdir(path.join(OUT, "results"));
  fs.writeFileSync(path.join(OUT, "results", `${id}${process.env.WL_RESULT_SUFFIX ?? ""}.json`), JSON.stringify(res, null, 2));
  console.log(`--- ${id}: ${res.status} (${failed} failed checks, ${reqs.length} requests, wall ${(wallMs / 1000).toFixed(1)}s, price ${usd(price)}, cost ${usd(cost)}, official ${usd(official)})`);
  console.log(`    running spend: ${await spendLine()}`);
  await topUp();
  return res;
}

// ------------------------------------------------------------------ helpers shared by scenarios
export const TECHPACK_PROMPT = `You are a senior apparel technical designer. Produce a COMPLETE apparel techpack for a unisex heavyweight pullover hoodie (style TP-2026-HD01, "Harbor Hoodie", Fall/Winter 2026) as ONE single self-contained SVG document.

Hard requirements:
- Output ONLY the SVG markup, starting with <svg and ending with </svg>. No markdown fences, no commentary before or after.
- viewBox="0 0 1800 1200", width="1800" height="1200", white background rect, font-family Arial/Helvetica only, no external resources, no <image>, no <foreignObject>, no scripts.
- Page layout (thin black frame, title block on top with style no., name, season, designer, date, revision, sizes XS-XL, base size M):
  1. FRONT flat sketch and BACK flat sketch (drawn with SVG paths: hood, kangaroo pocket, ribbed cuffs and hem, drawstrings, seams as dashed stitch lines), with numbered callouts (1..12) pointing at construction details.
  2. POINTS OF MEASURE table: at least 12 measurements (chest width, body length HPS, shoulder drop, sleeve length, cuff opening, hem opening, hood height, hood width, pocket width, etc.) for sizes XS, S, M, L, XL in centimetres with a tolerance column (+/-).
  3. BILL OF MATERIALS table: shell fabric (380gsm brushed-back cotton fleece), rib 2x2 (97/3 cotton/elastane), drawcord, metal eyelets, main label, care label, size label, hang tag, polybag, thread, with supplier code, placement, consumption per piece and unit.
  4. CONSTRUCTION NOTES: numbered list of at least 10 notes (stitch types and SPI, seam allowances, bartacks, topstitching, hood lining, pocket construction, label placement, finishing, packing).
  5. COLORWAY block: 4 colorways (Harbor Navy, Bone, Moss, Charcoal) as swatches with Pantone TCX codes and trim colours.
  6. Footer with approval signatures boxes and page note.
- Everything must fit inside the viewBox without overlapping text. The SVG MUST be well-formed XML (escape & as &amp;).`;

export function extractSvg(text: string): string | null {
  const m = text.match(/<svg[\s\S]*<\/svg>/i);
  return m ? m[0] : null;
}

/** well-formedness via python's expat parser (no extra dependency) */
export function xmlWellFormed(file: string): { ok: boolean; error?: string } {
  const code = "import sys,xml.etree.ElementTree as E\ntry:\n E.parse(sys.argv[1]); print('OK')\nexcept Exception as e:\n print('ERR '+str(e))";
  const r = spawnSync("python", ["-I", "-c", code, file], { encoding: "utf8" });
  const out = (r.stdout ?? "").trim();
  return out === "OK" ? { ok: true } : { ok: false, error: out || r.stderr };
}

export async function renderSvg(svgFile: string, pngFile: string, width = 1800): Promise<{ ok: boolean; error?: string; w?: number; h?: number }> {
  try {
    const { Resvg } = await import("@resvg/resvg-js");
    const svg = fs.readFileSync(svgFile, "utf8");
    const r = new Resvg(svg, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: true, defaultFontFamily: "Arial" }, background: "white" });
    const img = r.render();
    fs.writeFileSync(pngFile, img.asPng());
    return { ok: true, w: img.width, h: img.height };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function textOf(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** SSE parser used by raw-fetch scenarios */
export function parseSse(text: string): Array<{ event?: string; data: string }> {
  return text
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const lines = b.split(/\r?\n/);
      return { event: lines.find((l) => l.startsWith("event:"))?.slice(6).trim(), data: lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n") };
    });
}

/** Extract + validate + render an SVG from model text. Saves svg/png/raw. Returns the svg path or null. */
export async function processSvg(s: Scn, tag: string, text: string, expectWords: string[] = []): Promise<string | null> {
  const svg = extractSvg(text);
  s.save(`${tag}-raw.txt`, text);
  s.check(`${tag}: output contains an <svg> document`, !!svg, `${text.length} chars`);
  if (!svg) return null;
  const file = s.save(`${tag}.svg`, svg);
  const wf = xmlWellFormed(file);
  s.check(`${tag}: SVG is well-formed XML`, wf.ok, wf.error ?? `${(svg.length / 1024).toFixed(0)} KiB`);
  const png = path.join(s.dir, `${tag}.png`);
  const r = await renderSvg(file, png);
  if (r.ok) s.artifacts.push(path.relative(ROOT, png).replace(/\\/g, "/"));
  s.check(`${tag}: SVG renders to PNG (resvg)`, r.ok, r.ok ? `${r.w}x${r.h}, ${(fs.statSync(png).size / 1024).toFixed(0)} KiB` : r.error);
  if (expectWords.length) {
    const miss = expectWords.filter((k) => !new RegExp(k, "i").test(svg));
    s.check(`${tag}: contains expected sections/labels`, miss.length === 0, miss.length ? `missing: ${miss.join(", ")}` : expectWords.join(", "));
  }
  return file;
}

export { db, Decimal, debit };
