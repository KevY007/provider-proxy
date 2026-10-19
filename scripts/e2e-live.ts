/**
 * LIVE end-to-end verification against the REAL upstream providers (OpenAI, Anthropic, fal.ai, Replicate).
 *
 *   NEXT_DIST_DIR=.next-live pnpm next dev -p 3005     # terminal 1 (docker compose up -d: postgres + redis)
 *   pnpm setup:live                                    # once: providers, keys, models, prices
 *   pnpm e2e:live [--skip-video] [--video-timeout-min 10]   # terminal 2   (E2E_BASE_URL overrides http://localhost:3005)
 *
 * It creates (via the database / server functions, not the browser) a throwaway customer `live-e2e@example.com`
 * with $5 and fresh API keys, then drives the gateway over HTTP and asserts for every call: status, wire shape,
 * model-name masking, and metering - a RequestLog row with price >= cost > 0, profit == price - cost, the user's
 * balance decreased by EXACTLY the logged price and ApiKey.spent grew by the same amount.
 * The video check (one sora-2 job, 4 s, ~$0.40 upstream) only runs when everything before it passed AND the model is
 * enabled. NOTE: OpenAI shut the Sora API down on 2026-09-24 (GET /v1/models/sora-2 carries that shutdown_date and
 * /v1/videos answers 404), so `pnpm setup:live` disables sora-2 and the paid job is skipped; the free video checks still run.
 * The test customer is kept so the admin dashboard has real data. No secret is ever printed.
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { generateApiKey, encrypt, randomToken } from "../src/lib/crypto";
import { hashPassword } from "../src/lib/auth/password";
import { invalidateGatewayConfig } from "../src/gateway/cache";
import { Decimal } from "../src/lib/money";
import { credit, debit } from "../src/server/billing/ledger";

const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:3005").replace(/\/+$/, "");
const EMAIL = "live-e2e@example.com";
const OTHER_EMAIL = "live-e2e-other@example.com";
const START_BALANCE = "5";
/** Stop spending when the estimated upstream cost of this run (sum of RequestLog.cost) passes this. */
const COST_CAP = new Decimal(process.env.E2E_COST_CAP ?? "2.00");
const argv = process.argv.slice(2);
const SKIP_VIDEO = argv.includes("--skip-video");
const videoTimeoutMin = Number(argv[argv.indexOf("--video-timeout-min") + 1]) || 10;

const ZERO = new Decimal(0);
const D = (v: { toString(): string } | null | undefined) => new Decimal(v ? v.toString() : 0);
const usd = (d: Decimal) => (d.isZero() ? "-" : `$${d.toSignificantDigits(5).toFixed()}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ tiny test harness
class Failure extends Error {}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Failure(msg);
}
function eq<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) throw new Failure(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

interface Row {
  n: number;
  name: string;
  ok: boolean;
  skipped?: boolean;
  ms: number;
  price: Decimal;
  note: string;
}
const rows: Row[] = [];
let stepPrice = ZERO;
let stepNotes: string[] = [];
let aborted = "";
const runStart = new Date();

async function step(name: string, fn: () => Promise<void>): Promise<boolean> {
  const n = rows.length + 1;
  if (aborted) {
    rows.push({ n, name, ok: false, skipped: true, ms: 0, price: ZERO, note: aborted });
    return false;
  }
  stepPrice = ZERO;
  stepNotes = [];
  const t0 = Date.now();
  let ok = true;
  let note = "";
  try {
    await fn();
  } catch (e) {
    ok = false;
    note = e instanceof Error ? e.message : String(e);
  }
  rows.push({ n, name, ok, ms: Date.now() - t0, price: stepPrice, note: ok ? stepNotes.join("; ") : note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${String(n).padStart(2)}. ${name}  (${Date.now() - t0} ms${stepPrice.isZero() ? "" : `, ${usd(stepPrice)}`})${ok ? "" : `\n      -> ${note}`}`);
  const spent = await upstreamCost();
  if (spent.gt(COST_CAP)) aborted = `aborted: estimated upstream spend ${usd(spent)} passed the cap ${usd(COST_CAP)}`;
  return ok;
}

// ------------------------------------------------------------------ state
let userId = "";
let otherUserId = "";
let main = { id: "", key: "" };
let other = { id: "", key: "" };
let providerSlug = new Map<string, string>();

async function upstreamCost(): Promise<Decimal> {
  const a = await db.requestLog.aggregate({ where: { userId, createdAt: { gte: runStart } }, _sum: { cost: true } });
  return D(a._sum.cost);
}

async function snap() {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } });
  const k = await db.apiKey.findUniqueOrThrow({ where: { id: main.id }, select: { spent: true } });
  return { balance: D(u.balance), spent: D(k.spent) };
}
type Snap = Awaited<ReturnType<typeof snap>>;

async function waitLog(requestId: string) {
  for (let i = 0; i < 150; i++) {
    const row = await db.requestLog.findUnique({ where: { id: requestId } });
    if (row) return row;
    await sleep(150);
  }
  throw new Failure(`no RequestLog row for request ${requestId} after 22 s`);
}

interface BilledExpect {
  endpoint?: string;
  inboundFormat?: string;
  model?: string;
  upstream?: string;
  provider?: string;
  stream?: boolean;
  /** upstream is free (e.g. moderations): price and cost must both be 0 */
  free?: boolean;
  /** not a billable call (catalog, errors, lookups): price must be 0 */
  noCharge?: boolean;
  status?: string;
  httpStatus?: number;
  errorCode?: string;
  /** custom checks on the row */
  check?: (log: Awaited<ReturnType<typeof waitLog>>) => void;
  /** the request used a key other than the main one: skip the ApiKey.spent comparison */
  otherKey?: boolean;
}

/** Assert metering for one request: log row, price/cost/profit sanity, exact balance + key.spent deltas. */
async function billed(requestId: string | null, before: Snap, e: BilledExpect = {}) {
  assert(requestId, "response has no x-request-id");
  const log = await waitLog(requestId);
  const after = await snap();
  eq(log.status, e.status ?? "SUCCESS", `RequestLog.status (${log.errorCode ?? ""} ${log.errorMessage ?? ""})`);
  if (e.httpStatus !== undefined) eq(log.httpStatus, e.httpStatus, "RequestLog.httpStatus");
  if (e.errorCode !== undefined) eq(log.errorCode, e.errorCode, "RequestLog.errorCode");
  eq(log.userId, userId, "RequestLog.userId");
  if (!e.otherKey) eq(log.apiKeyId, main.id, "RequestLog.apiKeyId");
  if (e.endpoint) eq(log.endpoint, e.endpoint, "RequestLog.endpoint");
  if (e.inboundFormat) eq(log.inboundFormat, e.inboundFormat, "RequestLog.inboundFormat");
  if (e.model) eq(log.modelSlug, e.model, "RequestLog.modelSlug");
  if (e.upstream) eq(log.upstreamModel, e.upstream, "RequestLog.upstreamModel");
  if (e.provider) eq(log.providerId ? providerSlug.get(log.providerId) : null, e.provider, "RequestLog provider");
  if (e.stream !== undefined) eq(log.stream, e.stream, "RequestLog.stream");
  const price = D(log.price);
  const cost = D(log.cost);
  const profit = D(log.profit);
  if (e.noCharge || e.status) {
    assert(price.isZero() && cost.isZero(), `expected no charge, got price=${price} cost=${cost}`);
  } else if (e.free) {
    assert(price.isZero() && cost.isZero(), `free upstream expected, got price=${price} cost=${cost}`);
  } else {
    assert(cost.gt(0), `cost must be > 0 (got ${cost})`);
    // (match-official default: price == cost on official-vendor routes, so profit can be exactly 0)
    assert(price.gte(cost), `price must not be below cost (price=${price} cost=${cost})`);
    assert(profit.gte(0), `profit must be >= 0 (got ${profit})`);
    assert(profit.equals(price.minus(cost)), `profit ${profit} != price ${price} - cost ${cost}`);
  }
  assert(before.balance.minus(after.balance).equals(price), `balance moved by ${before.balance.minus(after.balance)} but the logged price is ${price}`);
  if (!e.otherKey) assert(after.spent.minus(before.spent).equals(price), `ApiKey.spent moved by ${after.spent.minus(before.spent)} but the logged price is ${price}`);
  e.check?.(log);
  stepPrice = stepPrice.plus(price);
  return { log, price, cost, profit };
}

// ------------------------------------------------------------------ http
interface Resp {
  res: Response;
  rid: string | null;
  ms: number;
}
async function http(path: string, o: { method?: string; key?: string | null; headers?: Record<string, string>; body?: unknown; form?: FormData; timeoutMs?: number } = {}): Promise<Resp> {
  const headers: Record<string, string> = { ...(o.key === null ? {} : { authorization: `Bearer ${o.key ?? main.key}` }), ...o.headers };
  let body: BodyInit | undefined;
  if (o.form) body = o.form;
  else if (o.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.body);
  }
  const t0 = Date.now();
  const res = await fetch(BASE + path, { method: o.method ?? (body ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? 180_000) });
  return { res, rid: res.headers.get("x-request-id"), ms: Date.now() - t0 };
}
const post = (path: string, body: unknown, o: Parameters<typeof http>[1] = {}) => http(path, { ...o, method: "POST", body });

function sse(text: string): Array<{ event?: string; data: string }> {
  return text
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const lines = b.split(/\r?\n/);
      return {
        event: lines.find((l) => l.startsWith("event:"))?.slice(6).trim(),
        data: lines
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n"),
      };
    });
}
const jsonEvents = (text: string) => sse(text).filter((e) => e.data && e.data !== "[DONE]").map((e) => ({ event: e.event, json: JSON.parse(e.data) as Record<string, any> })); // eslint-disable-line @typescript-eslint/no-explicit-any

const PNG = "89504e47";
const imageMagic = (b: Buffer) => {
  const hex = b.subarray(0, 4).toString("hex");
  if (hex === PNG) return "png";
  if (hex.startsWith("ffd8ff")) return "jpeg";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "webp";
  return null;
};

async function invalidate(scope: Parameters<typeof invalidateGatewayConfig>[0], id?: string) {
  await invalidateGatewayConfig(scope, id);
  await sleep(400); // pub/sub round trip to the dev server
}

// ------------------------------------------------------------------ fixtures
async function ensureUser(email: string, name: string, balance: string): Promise<string> {
  const group = await db.group.findUnique({ where: { slug: "standard" } });
  let u = await db.user.findUnique({ where: { email } });
  if (!u) {
    u = await db.user.create({
      data: { email, name, passwordHash: await hashPassword(randomToken(24)), role: "CUSTOMER", status: "ACTIVE", emailVerifiedAt: new Date(), groupId: group?.id, trialGrantedAt: new Date() },
    });
  } else {
    u = await db.user.update({ where: { id: u.id }, data: { status: "ACTIVE", emailVerifiedAt: u.emailVerifiedAt ?? new Date(), groupId: group?.id ?? u.groupId, priceMultiplier: null, creditLimit: "0", monthlySpendLimit: null } });
  }
  const diff = new Decimal(balance).minus(D(u.balance));
  if (diff.gt(0)) await credit(u.id, diff, "ADJUSTMENT", "Live e2e: starting balance");
  else if (diff.lt(0)) await debit(u.id, diff.abs(), "ADJUSTMENT", "Live e2e: reset balance");
  return u.id;
}

async function newKey(uid: string, name: string, extra: Record<string, unknown> = {}) {
  const k = generateApiKey();
  const row = await db.apiKey.create({ data: { userId: uid, name, prefix: k.prefix, keyHash: k.hash, ...extra } });
  return { id: row.id, key: k.key };
}

// ------------------------------------------------------------------ the checks
const TOOL_OPENAI = { type: "function", function: { name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } };
const TOOL_ANTHROPIC = { name: "get_weather", description: "Get the current weather for a city.", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
const TOOL_RESULT = JSON.stringify({ city: "Paris", temp_c: 18, sky: "cloudy" });

const REQUIRED_MODELS = ["gpt-5-nano", "gpt-4o-mini", "claude-haiku-5-5", "claude-haiku-4-5", "smart-fast", "gpt-image-1-mini", "flux-schnell", "flux-schnell-replicate", "tts-1", "whisper-1", "text-embedding-3-small", "omni-moderation-latest"];

async function run() {
  // ---- fixtures
  userId = await ensureUser(EMAIL, "Live E2E", START_BALANCE);
  otherUserId = await ensureUser(OTHER_EMAIL, "Live E2E (other)", "1");
  await db.apiKey.updateMany({ where: { userId: { in: [userId, otherUserId] }, name: { startsWith: "live-e2e" }, status: "ACTIVE" }, data: { status: "REVOKED" } });
  main = await newKey(userId, "live-e2e main");
  other = await newKey(otherUserId, "live-e2e other");
  providerSlug = new Map((await db.provider.findMany({ select: { id: true, slug: true } })).map((p) => [p.id, p.slug]));
  await invalidate("all");
  console.log(`Live e2e against ${BASE} - customer ${EMAIL}, starting balance $${START_BALANCE}, cost cap ${usd(COST_CAP)}\n`);

  // warm up (Next.js dev compiles the route on first hit) and make sure the server is the one we expect
  const warm = await http("/v1/models").catch((e) => {
    throw new Failure(`cannot reach ${BASE}: ${e instanceof Error ? e.message : e}. Start it with: NEXT_DIST_DIR=.next-live pnpm next dev -p 3005`);
  });
  await warm.res.arrayBuffer();

  // ============================================================ 1. catalogs
  await step("GET /v1/models (OpenAI shape)", async () => {
    const before = await snap();
    const { res, rid } = await http("/v1/models");
    eq(res.status, 200, "status");
    const j = await res.json();
    eq(j.object, "list", "object");
    const ids: string[] = j.data.map((m: { id: string }) => m.id);
    for (const slug of REQUIRED_MODELS) assert(ids.includes(slug), `missing model ${slug}`);
    assert(j.data.every((m: Record<string, unknown>) => m.object === "model" && typeof m.created === "number" && typeof m.owned_by === "string"), "model entries must be {id, object, created, owned_by}");
    assert(!ids.some((id) => /\d{8}/.test(id) && id.includes("claude")), "upstream-dated model ids must not leak");
    stepNotes.push(`${ids.length} models`);
    await billed(rid, before, { endpoint: "/v1/models", noCharge: true });
  });
  await step("GET /v1/models with anthropic-version (Anthropic shape)", async () => {
    const before = await snap();
    const { res, rid } = await http("/v1/models", { key: null, headers: { "x-api-key": main.key, "anthropic-version": "2023-06-01" } });
    eq(res.status, 200, "status");
    const j = await res.json();
    assert(Array.isArray(j.data) && j.data.length > 5, "data[]");
    assert(j.data.every((m: Record<string, unknown>) => m.type === "model" && typeof m.id === "string" && typeof m.display_name === "string" && typeof m.created_at === "string"), "entries must be {type:'model', id, display_name, created_at}");
    eq(j.has_more, false, "has_more");
    assert(typeof j.first_id === "string" && typeof j.last_id === "string", "first_id/last_id");
    await billed(rid, before, { endpoint: "/v1/models", noCharge: true });
  });
  await step("GET /v1beta/models (Gemini shape)", async () => {
    const before = await snap();
    const { res, rid } = await http("/v1beta/models", { key: null, headers: { "x-goog-api-key": main.key } });
    eq(res.status, 200, "status");
    const j = await res.json();
    assert(Array.isArray(j.models) && j.models.length > 5, "models[]");
    assert(j.models.every((m: Record<string, unknown>) => typeof m.name === "string" && (m.name as string).startsWith("models/") && Array.isArray(m.supportedGenerationMethods)), "entries must be {name:'models/..', supportedGenerationMethods}");
    assert(j.models.some((m: { name: string }) => m.name === "models/gpt-5-nano"), "models/gpt-5-nano missing");
    await billed(rid, before, { endpoint: "/v1beta/models", noCharge: true });
  });

  // ============================================================ 2. OpenAI chat
  const chatBody = (model: string, extra: Record<string, unknown> = {}) => ({ model, max_tokens: 24, messages: [{ role: "user", content: "Reply with the single word: pong" }], ...extra });

  await step("OpenAI chat, non-stream (gpt-4o-mini)", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/chat/completions", chatBody("gpt-4o-mini"));
    eq(res.status, 200, "status");
    const j = await res.json();
    eq(j.object, "chat.completion", "object");
    eq(j.model, "gpt-4o-mini", "model must be masked to the public slug (upstream answers gpt-4o-mini-2024-07-18)");
    assert(typeof j.choices[0].message.content === "string" && j.choices[0].message.content.length > 0, "empty completion");
    assert(j.usage.prompt_tokens > 0 && j.usage.completion_tokens > 0, "usage missing");
    stepNotes.push(`${j.usage.prompt_tokens}+${j.usage.completion_tokens} tok`);
    await billed(rid, before, { endpoint: "/v1/chat/completions", inboundFormat: "openai_chat", model: "gpt-4o-mini", upstream: "gpt-4o-mini", provider: "openai", stream: false, check: (l) => assert(l.inputTokens === j.usage.prompt_tokens && l.outputTokens === j.usage.completion_tokens, "logged tokens != reported usage") });
  });
  await step("OpenAI chat, stream (gpt-4o-mini) incl. usage chunk", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/chat/completions", chatBody("gpt-4o-mini", { stream: true, stream_options: { include_usage: true } }));
    eq(res.status, 200, "status");
    assert((res.headers.get("content-type") ?? "").includes("text/event-stream"), "content-type must be text/event-stream");
    const text = await res.text();
    const blocks = sse(text);
    eq(blocks[blocks.length - 1].data, "[DONE]", "stream must end with [DONE]");
    const chunks = jsonEvents(text).map((e) => e.json);
    assert(chunks.length >= 3, "too few chunks");
    assert(chunks.every((c) => c.object === "chat.completion.chunk" && c.model === "gpt-4o-mini"), "every chunk must be a chat.completion.chunk with the masked model");
    assert(chunks.some((c) => typeof c.choices?.[0]?.delta?.content === "string" && c.choices[0].delta.content.length > 0), "no content delta");
    const usageChunk = chunks.find((c) => c.usage);
    assert(usageChunk && usageChunk.usage.prompt_tokens > 0, "usage chunk missing although include_usage was requested");
    await billed(rid, before, { endpoint: "/v1/chat/completions", model: "gpt-4o-mini", provider: "openai", stream: true, check: (l) => assert(l.ttftMs !== null && l.outputTokens > 0, "ttft/outputTokens not recorded") });
  });
  await step("OpenAI chat on a reasoning model (gpt-5-nano)", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/chat/completions", { model: "gpt-5-nano", max_completion_tokens: 400, reasoning_effort: "minimal", messages: [{ role: "user", content: "Reply with the single word: pong" }] });
    eq(res.status, 200, "status");
    const j = await res.json();
    eq(j.model, "gpt-5-nano", "model masked");
    assert(j.choices[0].message.content?.length > 0, "empty completion");
    await billed(rid, before, { model: "gpt-5-nano", provider: "openai" });
  });

  // ============================================================ 3. Anthropic passthrough
  const anthHeaders = { "anthropic-version": "2023-06-01" };
  const msgBody = (model: string, extra: Record<string, unknown> = {}) => ({ model, max_tokens: 24, messages: [{ role: "user", content: "Reply with the single word: pong" }], ...extra });

  await step("Anthropic /v1/messages, non-stream passthrough (claude-haiku-5-5)", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/messages", msgBody("claude-haiku-5-5"), { key: null, headers: { ...anthHeaders, "x-api-key": main.key } });
    eq(res.status, 200, "status");
    const j = await res.json();
    eq(j.type, "message", "type");
    eq(j.role, "assistant", "role");
    eq(j.model, "claude-haiku-5-5", "model");
    assert(j.content[0].type === "text" && j.content[0].text.length > 0, "empty text block");
    assert(j.usage.input_tokens > 0 && j.usage.output_tokens > 0, "usage missing");
    await billed(rid, before, { endpoint: "/v1/messages", inboundFormat: "anthropic_messages", model: "claude-haiku-5-5", upstream: "claude-haiku-5-5", provider: "anthropic", stream: false });
  });
  await step("Anthropic /v1/messages, stream passthrough (claude-haiku-5-5)", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/messages", msgBody("claude-haiku-5-5", { stream: true }), { key: null, headers: { ...anthHeaders, "x-api-key": main.key } });
    eq(res.status, 200, "status");
    const events = jsonEvents(await res.text());
    const names = events.map((e) => e.event);
    for (const n of ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]) assert(names.includes(n), `missing SSE event ${n}`);
    eq(events.find((e) => e.event === "message_start")!.json.message.model, "claude-haiku-5-5", "message_start.model");
    assert(events.find((e) => e.event === "message_delta")!.json.usage.output_tokens > 0, "message_delta usage");
    await billed(rid, before, { endpoint: "/v1/messages", model: "claude-haiku-5-5", provider: "anthropic", stream: true });
  });
  await step("Anthropic passthrough masks the dated upstream id (claude-haiku-4-5)", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/messages", msgBody("claude-haiku-4-5"), { key: null, headers: { ...anthHeaders, "x-api-key": main.key } });
    eq(res.status, 200, "status");
    const j = await res.json();
    eq(j.model, "claude-haiku-4-5", "model must be the public slug, not claude-haiku-4-5-20251001");
    await billed(rid, before, { model: "claude-haiku-4-5", upstream: "claude-haiku-4-5-20251001", provider: "anthropic" });
  });

  // ============================================================ 4. translation
  await step("Translation chat -> messages, non-stream (OpenAI format to Claude)", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/chat/completions", chatBody("claude-haiku-5-5", { messages: [{ role: "system", content: "You are terse." }, { role: "user", content: "Reply with the single word: pong" }] }));
    eq(res.status, 200, "status");
    const j = await res.json();
    eq(j.object, "chat.completion", "response must be OpenAI-shaped");
    eq(j.model, "claude-haiku-5-5", "model");
    assert(j.choices[0].message.content?.length > 0, "empty completion");
    assert(["stop", "length"].includes(j.choices[0].finish_reason), `finish_reason ${j.choices[0].finish_reason}`);
    assert(j.usage.prompt_tokens > 0 && j.usage.completion_tokens > 0, "usage");
    await billed(rid, before, { endpoint: "/v1/chat/completions", inboundFormat: "openai_chat", model: "claude-haiku-5-5", provider: "anthropic", stream: false });
  });
  await step("Translation chat -> messages, stream", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/chat/completions", chatBody("claude-haiku-5-5", { stream: true, stream_options: { include_usage: true } }));
    eq(res.status, 200, "status");
    const text = await res.text();
    eq(sse(text).at(-1)!.data, "[DONE]", "[DONE]");
    const chunks = jsonEvents(text).map((e) => e.json);
    assert(chunks.every((c) => c.object === "chat.completion.chunk"), "chunks must be OpenAI-shaped");
    assert(chunks.some((c) => c.choices?.[0]?.delta?.content), "no content delta");
    assert(chunks.some((c) => c.choices?.[0]?.finish_reason), "no finish_reason");
    assert(chunks.some((c) => c.usage?.prompt_tokens > 0), "usage chunk missing");
    await billed(rid, before, { model: "claude-haiku-5-5", provider: "anthropic", stream: true });
  });
  await step("Translation chat -> messages: tool-call round (stream) + tool result", async () => {
    const q = { model: "claude-haiku-5-5", max_tokens: 200, tools: [TOOL_OPENAI], tool_choice: { type: "function", function: { name: "get_weather" } }, messages: [{ role: "user", content: "What is the weather in Paris?" }] };
    const before = await snap();
    const first = await post("/v1/chat/completions", { ...q, stream: true });
    eq(first.res.status, 200, "status");
    const chunks = jsonEvents(await first.res.text()).map((e) => e.json);
    const calls: Record<number, { id?: string; name?: string; args: string }> = {};
    for (const c of chunks) for (const tc of c.choices?.[0]?.delta?.tool_calls ?? []) {
      const slot = (calls[tc.index] ??= { args: "" });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      slot.args += tc.function?.arguments ?? "";
    }
    const call = calls[0];
    assert(call?.id && call.name === "get_weather", "streamed tool call missing");
    assert(JSON.parse(call.args).city, `tool arguments not valid JSON with a city: ${call.args}`);
    assert(chunks.some((c) => c.choices?.[0]?.finish_reason === "tool_calls"), "finish_reason must be tool_calls");
    await billed(first.rid, before, { model: "claude-haiku-5-5", provider: "anthropic", stream: true });

    const before2 = await snap();
    const second = await post("/v1/chat/completions", {
      model: "claude-haiku-5-5",
      max_tokens: 200,
      tools: [TOOL_OPENAI],
      messages: [
        { role: "user", content: "What is the weather in Paris?" },
        { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: "get_weather", arguments: call.args } }] },
        { role: "tool", tool_call_id: call.id, content: TOOL_RESULT },
      ],
    });
    eq(second.res.status, 200, "status (tool result)");
    const j = await second.res.json();
    assert(j.choices[0].message.content?.length > 0, "no final answer after the tool result");
    stepNotes.push(`answer: ${String(j.choices[0].message.content).slice(0, 40).replace(/\s+/g, " ")}`);
    await billed(second.rid, before2, { model: "claude-haiku-5-5", provider: "anthropic" });
  });
  await step("Translation messages -> chat, non-stream (Anthropic format to gpt-5-nano)", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/messages", { model: "gpt-5-nano", max_tokens: 600, system: "You are terse.", messages: [{ role: "user", content: "Reply with the single word: pong" }] }, { key: null, headers: { ...anthHeaders, "x-api-key": main.key } });
    eq(res.status, 200, "status");
    const j = await res.json();
    eq(j.type, "message", "response must be Anthropic-shaped");
    eq(j.model, "gpt-5-nano", "model");
    assert(j.content.some((b: { type: string; text?: string }) => b.type === "text" && b.text), "no text block");
    assert(j.usage.input_tokens > 0 && j.usage.output_tokens > 0, "usage");
    await billed(rid, before, { endpoint: "/v1/messages", inboundFormat: "anthropic_messages", model: "gpt-5-nano", provider: "openai", stream: false });
  });
  await step("Translation messages -> chat, stream", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/messages", { model: "gpt-5-nano", max_tokens: 600, stream: true, messages: [{ role: "user", content: "Reply with the single word: pong" }] }, { key: null, headers: { ...anthHeaders, "x-api-key": main.key } });
    eq(res.status, 200, "status");
    const events = jsonEvents(await res.text());
    const names = events.map((e) => e.event);
    for (const n of ["message_start", "content_block_start", "content_block_delta", "message_delta", "message_stop"]) assert(names.includes(n), `missing SSE event ${n}`);
    eq(events.find((e) => e.event === "message_start")!.json.message.model, "gpt-5-nano", "message_start.model");
    await billed(rid, before, { model: "gpt-5-nano", provider: "openai", stream: true });
  });
  await step("Translation messages -> chat: tool-use round + tool_result", async () => {
    const q = { model: "gpt-5-nano", max_tokens: 1000, tools: [TOOL_ANTHROPIC], tool_choice: { type: "tool", name: "get_weather" }, messages: [{ role: "user", content: "What is the weather in Paris?" }] };
    const hdr = { key: null as null, headers: { ...anthHeaders, "x-api-key": main.key } };
    const before = await snap();
    const first = await post("/v1/messages", q, hdr);
    eq(first.res.status, 200, "status");
    const j = await first.res.json();
    eq(j.stop_reason, "tool_use", "stop_reason");
    const use = j.content.find((b: { type: string }) => b.type === "tool_use");
    assert(use && use.name === "get_weather" && use.input?.city && use.id, `tool_use block missing: ${JSON.stringify(j.content)}`);
    await billed(first.rid, before, { model: "gpt-5-nano", provider: "openai" });

    const before2 = await snap();
    const second = await post(
      "/v1/messages",
      {
        model: "gpt-5-nano",
        max_tokens: 1000,
        tools: [TOOL_ANTHROPIC],
        messages: [
          { role: "user", content: "What is the weather in Paris?" },
          { role: "assistant", content: [{ type: "tool_use", id: use.id, name: use.name, input: use.input }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: TOOL_RESULT }] },
        ],
      },
      hdr,
    );
    eq(second.res.status, 200, "status (tool_result)");
    const k = await second.res.json();
    assert(k.content.some((b: { type: string; text?: string }) => b.type === "text" && b.text), "no final text after the tool result");
    eq(k.stop_reason, "end_turn", "stop_reason");
    await billed(second.rid, before2, { model: "gpt-5-nano", provider: "openai" });
  });

  // ============================================================ 5. Responses API
  let responseId = "";
  await step("Responses API, non-stream (gpt-5-nano) + GET by id", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/responses", { model: "gpt-5-nano", input: "Reply with the single word: pong", max_output_tokens: 400, reasoning: { effort: "minimal" } });
    eq(res.status, 200, "status");
    const j = await res.json();
    eq(j.object, "response", "object");
    eq(j.model, "gpt-5-nano", "model masked");
    assert(j.output.some((o: { type: string }) => o.type === "message"), "no message output");
    assert(j.usage.input_tokens > 0 && j.usage.output_tokens > 0, "usage");
    responseId = j.id;
    await billed(rid, before, { endpoint: "/v1/responses", inboundFormat: "openai_responses", model: "gpt-5-nano", provider: "openai", stream: false });
    const get = await http(`/v1/responses/${responseId}`);
    eq(get.res.status, 200, "GET /v1/responses/{id}");
    eq((await get.res.json()).id, responseId, "retrieved id");
    await waitLog(get.rid!);
  });
  await step("Responses API, stream (gpt-5-nano)", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/responses", { model: "gpt-5-nano", input: "Reply with the single word: pong", max_output_tokens: 400, reasoning: { effort: "minimal" }, stream: true });
    eq(res.status, 200, "status");
    const events = jsonEvents(await res.text());
    const names = events.map((e) => e.event ?? e.json.type);
    for (const n of ["response.created", "response.output_text.delta", "response.completed"]) assert(names.includes(n), `missing event ${n}`);
    const done = events.find((e) => (e.event ?? e.json.type) === "response.completed")!.json;
    eq(done.response.model, "gpt-5-nano", "response.completed model masked");
    assert(done.response.usage.input_tokens > 0, "usage in response.completed");
    await billed(rid, before, { endpoint: "/v1/responses", model: "gpt-5-nano", provider: "openai", stream: true });
  });

  // ============================================================ 6. embeddings / moderation / audio
  await step("Embeddings (text-embedding-3-small)", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/embeddings", { model: "text-embedding-3-small", input: "hello world" });
    eq(res.status, 200, "status");
    const j = await res.json();
    eq(j.data[0].embedding.length, 1536, "embedding dimensions");
    eq(j.model, "text-embedding-3-small", "model");
    assert(j.usage.prompt_tokens > 0, "usage");
    await billed(rid, before, { endpoint: "/v1/embeddings", inboundFormat: "openai_embeddings", model: "text-embedding-3-small", provider: "openai" });
  });
  await step("Moderations (omni-moderation-latest) - free upstream", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/moderations", { model: "omni-moderation-latest", input: "hello there" });
    eq(res.status, 200, "status");
    const j = await res.json();
    eq(j.results[0].flagged, false, "flagged");
    await billed(rid, before, { endpoint: "/v1/moderations", model: "omni-moderation-latest", provider: "openai", free: true });
  });
  let speech: Buffer = Buffer.alloc(0);
  await step("TTS (tts-1, 6 chars -> mp3 bytes)", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/audio/speech", { model: "tts-1", input: "Hello!", voice: "alloy", response_format: "mp3" });
    eq(res.status, 200, "status");
    assert((res.headers.get("content-type") ?? "").startsWith("audio/"), `content-type ${res.headers.get("content-type")}`);
    speech = Buffer.from(await res.arrayBuffer());
    assert(speech.length > 1000, `audio too small: ${speech.length} bytes`);
    stepNotes.push(`${speech.length} bytes`);
    await billed(rid, before, { endpoint: "/v1/audio/speech", inboundFormat: "openai_audio", model: "tts-1", provider: "openai", check: (l) => eq(l.characters, 6, "characters billed") });
  });
  await step("Transcription (whisper-1 on the TTS output)", async () => {
    assert(speech.length > 0, "needs the TTS bytes from the previous step");
    const before = await snap();
    const form = new FormData();
    form.set("model", "whisper-1");
    form.set("file", new Blob([new Uint8Array(speech)], { type: "audio/mpeg" }), "speech.mp3");
    const { res, rid } = await http("/v1/audio/transcriptions", { method: "POST", form });
    eq(res.status, 200, "status");
    const j = await res.json();
    assert(/hello/i.test(j.text), `transcript '${j.text}' does not contain 'hello'`);
    stepNotes.push(`"${String(j.text).trim()}"`);
    await billed(rid, before, { endpoint: "/v1/audio/transcriptions", model: "whisper-1", provider: "openai", check: (l) => assert(l.audioSeconds > 0, "audioSeconds not recorded") });
  });

  // ============================================================ 7. images
  const imgPrompt = "A photo of a golden retriever puppy sitting in a sunny meadow";
  await step("Images: gpt-image-1-mini (quality low, 1024x1024, b64_json)", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/images/generations", { model: "gpt-image-1-mini", prompt: imgPrompt, size: "1024x1024", quality: "low", n: 1 }, { timeoutMs: 240_000 });
    eq(res.status, 200, "status");
    const j = await res.json();
    eq(j.data.length, 1, "data.length");
    const bytes = Buffer.from(j.data[0].b64_json, "base64");
    assert(imageMagic(bytes), "b64_json is not a PNG/JPEG/WEBP");
    stepNotes.push(`${bytes.length} bytes`);
    await billed(rid, before, { endpoint: "/v1/images/generations", inboundFormat: "openai_images", model: "gpt-image-1-mini", provider: "openai", check: (l) => assert(l.imageCount === 1 && l.outputTokens > 0, "image count / image tokens not metered") });
  });
  const imageUrlCheck = async (url: string) => {
    assert(/^https?:\/\//.test(url), `not a URL: ${url.slice(0, 60)}`);
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    eq(r.status, 200, "result URL status");
    assert((r.headers.get("content-type") ?? "").startsWith("image/"), `result URL content-type ${r.headers.get("content-type")}`);
    const b = Buffer.from(await r.arrayBuffer());
    assert(b.length > 500 && imageMagic(b), "result URL does not serve an image");
  };
  for (const [model, label, provider, upstream] of [
    ["flux-schnell", "fal.ai", "fal", "fal-ai/flux/schnell"],
    ["flux-schnell-replicate", "Replicate", "replicate", "black-forest-labs/flux-schnell"],
  ] as const) {
    await step(`Images: ${model} (${label}) response_format=url`, async () => {
      const before = await snap();
      const { res, rid } = await post("/v1/images/generations", { model, prompt: imgPrompt, size: "1024x1024", n: 1, response_format: "url", seed: 42 }, { timeoutMs: 240_000 });
      eq(res.status, 200, "status");
      const j = await res.json();
      eq(j.data.length, 1, "data.length");
      assert(typeof j.created === "number", "created");
      await imageUrlCheck(j.data[0].url);
      await billed(rid, before, { endpoint: "/v1/images/generations", model, upstream, provider, check: (l) => eq(l.imageCount, 1, "imageCount") });
    });
    await step(`Images: ${model} (${label}) response_format=b64_json`, async () => {
      const before = await snap();
      const { res, rid } = await post("/v1/images/generations", { model, prompt: imgPrompt, size: "1024x1024", n: 1, response_format: "b64_json" }, { timeoutMs: 240_000 });
      eq(res.status, 200, "status");
      const j = await res.json();
      assert(j.data[0].url === undefined, "b64_json request must not return a url");
      assert(imageMagic(Buffer.from(j.data[0].b64_json, "base64")), "b64_json does not decode to an image");
      await billed(rid, before, { model, upstream, provider, check: (l) => eq(l.imageCount, 1, "imageCount") });
    });
  }

  // ============================================================ 8. failover: what customers see vs what runs
  await step("smart-fast: primary route serves it (Claude Haiku), model reported as smart-fast", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/chat/completions", chatBody("smart-fast"));
    eq(res.status, 200, "status");
    const j = await res.json();
    eq(j.model, "smart-fast", "customers only ever see the public slug");
    await billed(rid, before, { model: "smart-fast", upstream: "claude-haiku-5-5", provider: "anthropic" });
  });
  const anthKey = await db.providerKey.findFirstOrThrow({ where: { provider: { slug: "anthropic" }, label: "live-1" } });
  const originalSecret = anthKey.secretEncrypted;
  const restoreAnthropic = async () => {
    await sleep(1500); // let the gateway's coalesced key-health persistence land first
    await db.providerKey.update({ where: { id: anthKey.id }, data: { secretEncrypted: originalSecret, status: "ACTIVE", cooldownUntil: null, consecutiveFailures: 0, lastError: null } });
    await invalidate("providers", anthKey.id);
  };
  try {
    await step("smart-fast failover: Anthropic key INVALID -> served by OpenAI gpt-5-nano", async () => {
      await db.providerKey.update({ where: { id: anthKey.id }, data: { status: "INVALID" } });
      await invalidate("providers", anthKey.id);
      const before = await snap();
      const { res, rid } = await post("/v1/chat/completions", chatBody("smart-fast", { max_tokens: undefined, max_completion_tokens: 300, reasoning_effort: "minimal" }));
      eq(res.status, 200, "status");
      const j = await res.json();
      eq(j.model, "smart-fast", "model");
      assert(j.choices[0].message.content?.length > 0, "empty completion");
      await billed(rid, before, { model: "smart-fast", upstream: "gpt-5-nano", provider: "openai" });
    });
    await db.providerKey.update({ where: { id: anthKey.id }, data: { status: "ACTIVE", consecutiveFailures: 0 } });
    await invalidate("providers", anthKey.id);
    await step("smart-fast failover: REAL upstream 401 from Anthropic -> retried on OpenAI", async () => {
      await db.providerKey.update({ where: { id: anthKey.id }, data: { secretEncrypted: encrypt("sk-ant-api03-invalid-e2e-failover-test"), status: "ACTIVE", consecutiveFailures: 0, cooldownUntil: null } });
      await invalidate("providers", anthKey.id);
      const before = await snap();
      const { res, rid } = await post("/v1/chat/completions", chatBody("smart-fast", { max_tokens: undefined, max_completion_tokens: 300, reasoning_effort: "minimal" }));
      eq(res.status, 200, "status");
      const j = await res.json();
      eq(j.model, "smart-fast", "model");
      assert(JSON.stringify(j).indexOf("anthropic") === -1, "response leaks the upstream provider");
      await billed(rid, before, {
        model: "smart-fast",
        upstream: "gpt-5-nano",
        provider: "openai",
        check: (l) => {
          const a = l.attempts as Array<{ status: number }>;
          eq(a.length, 2, "attempts");
          eq(a[0].status, 401, "first attempt (Anthropic) status");
          eq(a[1].status, 200, "second attempt (OpenAI) status");
        },
      });
    });
  } finally {
    await restoreAnthropic();
  }
  await step("Anthropic key restored: smart-fast is served by Claude again", async () => {
    const before = await snap();
    const { res, rid } = await post("/v1/chat/completions", chatBody("smart-fast"));
    eq(res.status, 200, "status");
    await res.arrayBuffer();
    await billed(rid, before, { model: "smart-fast", provider: "anthropic" });
  });

  // ============================================================ 9. errors in native shapes
  const zeros = "sk-pp-" + "0".repeat(40);
  await step("Errors: bad API key -> 401 in OpenAI / Anthropic / Gemini shape", async () => {
    const o = await post("/v1/chat/completions", chatBody("gpt-4o-mini"), { key: zeros });
    eq(o.res.status, 401, "openai status");
    const oj = await o.res.json();
    assert(oj.error?.code === "invalid_api_key" && oj.error.type === "invalid_request_error" && oj.error.message, `OpenAI error shape: ${JSON.stringify(oj)}`);
    const a = await post("/v1/messages", msgBody("claude-haiku-5-5"), { key: null, headers: { ...anthHeaders, "x-api-key": zeros } });
    eq(a.res.status, 401, "anthropic status");
    const aj = await a.res.json();
    assert(aj.type === "error" && aj.error?.type === "authentication_error", `Anthropic error shape: ${JSON.stringify(aj)}`);
    const g = await http("/v1beta/models", { key: null, headers: { "x-goog-api-key": zeros } });
    eq(g.res.status, 401, "gemini status");
    const gj = await g.res.json();
    assert(gj.error?.code === 401 && gj.error.status === "UNAUTHENTICATED", `Gemini error shape: ${JSON.stringify(gj)}`);
    assert(o.rid && a.rid && g.rid, "x-request-id on errors");
  });
  await step("Errors: unknown model -> 404 model_not_found (OpenAI + Anthropic shape)", async () => {
    const before = await snap();
    const o = await post("/v1/chat/completions", chatBody("no-such-model"));
    eq(o.res.status, 404, "openai status");
    const oj = await o.res.json();
    eq(oj.error.code, "model_not_found", "code");
    await billed(o.rid, before, { status: "CLIENT_ERROR", httpStatus: 404, errorCode: "model_not_found" });
    const a = await post("/v1/messages", msgBody("no-such-model"), { key: null, headers: { ...anthHeaders, "x-api-key": main.key } });
    eq(a.res.status, 404, "anthropic status");
    const aj = await a.res.json();
    assert(aj.type === "error" && aj.error.type === "not_found_error", `Anthropic error shape: ${JSON.stringify(aj)}`);
    await a.res.arrayBuffer().catch(() => undefined);
  });
  await step("Errors: insufficient balance -> 402 (balance set to $0 temporarily)", async () => {
    const bal = (await snap()).balance;
    assert(bal.gt(0), "needs a positive balance to start");
    await debit(userId, bal, "ADJUSTMENT", "Live e2e: temporary zero balance");
    await sleep(400);
    try {
      const before = await snap();
      eq(before.balance.toString(), "0", "balance after debit");
      const o = await post("/v1/chat/completions", chatBody("gpt-4o-mini"));
      eq(o.res.status, 402, "openai status");
      const oj = await o.res.json();
      assert(oj.error.code === "insufficient_balance" && oj.error.type === "billing_error", `error body ${JSON.stringify(oj)}`);
      await billed(o.rid, before, { status: "CLIENT_ERROR", httpStatus: 402, errorCode: "insufficient_balance" });
      const a = await post("/v1/messages", msgBody("claude-haiku-5-5"), { key: null, headers: { ...anthHeaders, "x-api-key": main.key } });
      eq(a.res.status, 402, "anthropic status");
      const aj = await a.res.json();
      assert(aj.type === "error" && aj.error.type === "billing_error", `Anthropic error ${JSON.stringify(aj)}`);
    } finally {
      await credit(userId, bal, "ADJUSTMENT", "Live e2e: restore balance");
      await sleep(400);
    }
  });
  await step("Errors: customer concurrency limit -> 429 with retry-after", async () => {
    const conc = await newKey(userId, "live-e2e concurrency", { maxConcurrency: 1 });
    await invalidate("apiKeys");
    const long = { model: "gpt-4o-mini", max_tokens: 120, stream: true, messages: [{ role: "user", content: "Count slowly from 1 to 40, one number per line." }] };
    const first = await post("/v1/chat/completions", long, { key: conc.key });
    eq(first.res.status, 200, "first request status");
    const reader = first.res.body!.getReader();
    await reader.read(); // the first request now holds the only slot
    const second = await post("/v1/chat/completions", chatBody("gpt-4o-mini"), { key: conc.key });
    const sj = await second.res.json();
    eq(second.res.status, 429, `second request status (${JSON.stringify(sj)})`);
    assert(sj.error?.code === "rate_limited" && sj.error.type === "rate_limit_error", `429 body ${JSON.stringify(sj)}`);
    assert(Number(second.res.headers.get("retry-after")) >= 1, "retry-after header missing");
    // drain the first request so its slot and charge are released
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
    }
    const log = await waitLog(first.rid!);
    stepPrice = stepPrice.plus(D(log.price)); // the only billable request of this step
    const l2 = await waitLog(second.rid!);
    eq(l2.errorCode, "rate_limited", "429 log errorCode");
    await db.apiKey.update({ where: { id: conc.id }, data: { status: "REVOKED" } });
    await invalidate("apiKeys");
  });

  // ============================================================ 10. video (last, only when everything above passed)
  const failedSoFar = rows.filter((r) => !r.ok && !r.skipped).length;
  const sora = await db.model.findUnique({ where: { slug: "sora-2" }, select: { status: true } });
  const soraLive = sora?.status === "ACTIVE";
  if (!soraLive) {
    await step("Video: shut-down upstream model (sora-2 disabled) is not callable - 404 model_not_found, no charge", async () => {
      const before = await snap();
      const { res, rid } = await post("/v1/videos", { model: "sora-2", prompt: "x", seconds: "4" });
      eq(res.status, 404, "status");
      eq((await res.json()).error.code, "model_not_found", "code");
      await billed(rid, before, { status: "CLIENT_ERROR", httpStatus: 404, errorCode: "model_not_found" });
    });
  }
  await step("Video API surface (no upstream job): list is scoped to the caller, unknown ids are 404, validation works", async () => {
    const before = await snap();
    const list = await http("/v1/videos");
    eq(list.res.status, 200, "list status");
    const lj = await list.res.json();
    assert(lj.object === "list" && Array.isArray(lj.data) && typeof lj.has_more === "boolean", `list shape ${JSON.stringify(lj).slice(0, 200)}`);
    await billed(list.rid, before, { endpoint: "/v1/videos", inboundFormat: "openai_videos", noCharge: true });
    for (const [path, method] of [
      ["/v1/videos/video_unknown", "GET"],
      ["/v1/videos/video_unknown/content", "GET"],
      ["/v1/videos/video_unknown", "DELETE"],
    ] as const) {
      const r = await http(path, { method });
      eq(r.res.status, 404, `${method} ${path}`);
      eq((await r.res.json()).error.code, "not_found", "error code");
    }
    const bad = await post("/v1/videos", { model: "gpt-4o-mini", prompt: "x" });
    eq(bad.res.status, 400, "non-video model");
    eq((await bad.res.json()).error.code, "unsupported_endpoint", "error code");
  });
  if (SKIP_VIDEO) {
    rows.push({ n: rows.length + 1, name: "Video: sora-2", ok: true, skipped: true, ms: 0, price: ZERO, note: "skipped (--skip-video)" });
  } else if (!soraLive) {
    rows.push({ n: rows.length + 1, name: "Video: sora-2 job (create -> poll -> content -> ownership -> delete)", ok: true, skipped: true, ms: 0, price: ZERO, note: "SKIPPED: OpenAI shut the Sora API down on 2026-09-24 (model disabled by setup:live; /v1/videos is 404 upstream)" });
    console.log("SKIP  Video: sora-2 job - the upstream model is shut down (disabled)");
  } else if (failedSoFar > 0) {
    rows.push({ n: rows.length + 1, name: "Video: sora-2", ok: false, skipped: true, ms: 0, price: ZERO, note: `not run: ${failedSoFar} earlier check(s) failed (the single paid video is only generated when everything else passes)` });
    console.log(`SKIP  Video: sora-2 - ${failedSoFar} earlier check(s) failed`);
  } else {
    await videoChecks();
  }
}

async function videoChecks() {
  const st = { videoId: "", final: "", before: null as Snap | null, createRid: null as string | null };
  const sora = await db.model.findUniqueOrThrow({ where: { slug: "sora-2" }, select: { perSecondPrice: true } });
  const price = D(sora.perSecondPrice).times(4); // 4 s x the sell price per second (group multiplier 1)
  await step("Video: POST /v1/videos sora-2 (4 s, 720x1280) charges seconds x price at creation", async () => {
    st.before = await snap();
    const { res, rid } = await post("/v1/videos", { model: "sora-2", prompt: "A calm ocean wave rolling onto a beach at sunrise, soft light", seconds: "4", size: "720x1280" });
    eq(res.status, 200, "status");
    const j = await res.json();
    eq(j.object, "video", "object");
    eq(j.model, "sora-2", "model");
    assert(/^video_[0-9a-f]{48}$/.test(j.id), `id ${j.id}`);
    assert(["queued", "in_progress"].includes(j.status), `status ${j.status}`);
    st.videoId = j.id;
    st.createRid = rid;
    const b = await billed(rid, st.before, { endpoint: "/v1/videos", inboundFormat: "openai_videos", model: "sora-2", provider: "openai", upstream: "sora-2", check: (l) => eq(l.videoSeconds, 4, "videoSeconds") });
    assert(b.price.equals(price), `price ${b.price} != 4 s x per-second price`);
    stepNotes.push(`${usd(b.price)} charged, upstream ${usd(b.cost)}`);
  });
  const videoId = st.videoId;
  if (!videoId) return;

  await step(`Video: poll until completed (timeout ${videoTimeoutMin} min)`, async () => {
    const deadline = Date.now() + videoTimeoutMin * 60_000;
    let last = "";
    for (;;) {
      const { res } = await http(`/v1/videos/${videoId}`);
      eq(res.status, 200, "poll status");
      const j = await res.json();
      eq(j.id, videoId, "id");
      eq(j.model, "sora-2", "model");
      if (j.status !== last) stepNotes.push(`${j.status}${typeof j.progress === "number" ? ` ${j.progress}%` : ""}`);
      last = j.status;
      if (j.status === "completed" || j.status === "failed") {
        st.final = j.status;
        if (j.status === "failed") throw new Failure(`video job failed upstream: ${JSON.stringify(j.error)}`);
        return;
      }
      if (Date.now() > deadline) throw new Failure(`not completed after ${videoTimeoutMin} min (last status ${last})`);
      await sleep(5000);
    }
  });

  if (st.final === "failed") {
    await step("Video: failed job was refunded automatically", async () => {
      const refund = await db.ledgerEntry.findFirst({ where: { userId, type: "REFUND", metadata: { path: ["videoId"], equals: videoId } } });
      assert(refund, "no REFUND ledger entry for the failed video");
      assert(D(refund.amount).equals(price), `refund ${refund.amount} != ${price}`);
      stepNotes.push(`refunded ${usd(D(refund.amount))}`);
    });
    return;
  }

  await step("Video: GET content -> video/* bytes; thumbnail variant", async () => {
    const t0 = Date.now();
    const { res, rid } = await http(`/v1/videos/${videoId}/content`, { timeoutMs: 300_000 });
    eq(res.status, 200, "status");
    const ct = res.headers.get("content-type") ?? "";
    assert(ct.startsWith("video/"), `content-type ${ct}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert(bytes.length > 10_000, `video too small: ${bytes.length} bytes`);
    assert(bytes.subarray(4, 8).toString() === "ftyp", "not an MP4 container");
    stepNotes.push(`${(bytes.length / 1024).toFixed(0)} KiB ${ct} in ${Date.now() - t0} ms`);
    const log = await waitLog(rid!);
    assert(D(log.price).isZero() && log.status === "SUCCESS", "content download must be free and logged");
    const thumb = await http(`/v1/videos/${videoId}/content?variant=thumbnail`);
    eq(thumb.res.status, 200, "thumbnail status");
    assert((thumb.res.headers.get("content-type") ?? "").startsWith("image/"), `thumbnail content-type ${thumb.res.headers.get("content-type")}`);
    assert((await thumb.res.arrayBuffer()).byteLength > 100, "thumbnail empty");
  });
  await step("Video: the charge is exactly seconds x price, nothing more, nothing refunded", async () => {
    const after = await snap();
    assert(st.before !== null && st.createRid !== null, "no creation snapshot");
    const spent = st.before.balance.minus(after.balance);
    // other requests ran between create and now only for polls/content (price 0)
    assert(spent.equals(price), `balance dropped by ${spent}, expected ${price}`);
    const refunds = await db.ledgerEntry.count({ where: { userId, type: "REFUND", createdAt: { gte: runStart } } });
    eq(refunds, 0, "refund entries");
  });
  await step("Video: another customer's key gets 404 (get / content / delete) and cannot list it", async () => {
    for (const [path, method] of [
      [`/v1/videos/${videoId}`, "GET"],
      [`/v1/videos/${videoId}/content`, "GET"],
      [`/v1/videos/${videoId}`, "DELETE"],
    ] as const) {
      const r = await http(path, { method, key: other.key });
      eq(r.res.status, 404, `${method} ${path} with the other customer's key`);
      eq((await r.res.json()).error.code, "not_found", "error code");
    }
    const list = await (await http("/v1/videos", { key: other.key })).res.json();
    assert(!list.data.some((v: { id: string }) => v.id === videoId), "the other customer can list this video");
    const mine = await (await http("/v1/videos")).res.json();
    assert(mine.data.some((v: { id: string }) => v.id === videoId), "the owner cannot list the video");
  });
  await step("Video: DELETE removes the job", async () => {
    const del = await http(`/v1/videos/${videoId}`, { method: "DELETE" });
    eq(del.res.status, 200, "status");
    const j = await del.res.json();
    assert(j.deleted === true && j.id === videoId, `body ${JSON.stringify(j)}`);
    eq((await http(`/v1/videos/${videoId}`)).res.status, 404, "GET after delete");
  });
}

// ------------------------------------------------------------------ report
async function report() {
  console.log("\n" + "=".repeat(118));
  const w = { n: 3, name: 62, res: 6, ms: 8, price: 11 };
  console.log(`${"#".padStart(w.n)}  ${"check".padEnd(w.name)}  ${"result".padEnd(w.res)}  ${"ms".padStart(w.ms)}  ${"charged".padStart(w.price)}  notes`);
  for (const r of rows) {
    const result = r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL";
    console.log(`${String(r.n).padStart(w.n)}  ${r.name.slice(0, w.name).padEnd(w.name)}  ${result.padEnd(w.res)}  ${String(r.ms).padStart(w.ms)}  ${usd(r.price).padStart(w.price)}  ${r.note.slice(0, 90)}`);
  }
  const pass = rows.filter((r) => r.ok && !r.skipped).length;
  const fail = rows.filter((r) => !r.ok && !r.skipped).length;
  const skip = rows.filter((r) => r.skipped).length;
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);

  const agg = await db.requestLog.aggregate({ where: { userId, createdAt: { gte: runStart } }, _sum: { price: true, cost: true, profit: true }, _count: true });
  const refunds = await db.ledgerEntry.aggregate({ where: { userId, type: "REFUND", createdAt: { gte: runStart } }, _sum: { amount: true } });
  const revenue = D(agg._sum.price);
  const cost = D(agg._sum.cost);
  const profit = D(agg._sum.profit);
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } });
  console.log(`\nRequestLog rows this run : ${agg._count}`);
  console.log(`Total upstream cost      : ${usd(cost)}   (our cost price, i.e. the estimated real spend; budget cap ${usd(COST_CAP)})`);
  console.log(`Total revenue (charged)  : ${usd(revenue)}`);
  console.log(`Total profit             : ${usd(profit)}   (${revenue.isZero() ? "n/a" : profit.div(revenue).times(100).toFixed(1)}% of revenue, ${cost.isZero() ? "n/a" : profit.div(cost).times(100).toFixed(1)}% on cost)`);
  console.log(`Refunds (failed jobs)    : ${usd(D(refunds._sum.amount))}`);
  console.log(`Customer balance now     : $${user.balance.toString()}   (started at $${START_BALANCE})`);
  console.log(`Customer kept for the admin dashboard: ${EMAIL} (password is random and not stored anywhere readable)`);
  return fail;
}

run()
  .then(async () => {
    const failed = await report();
    await db.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(async (e) => {
    console.error("\nFATAL:", e instanceof Error ? e.message : e);
    try {
      await report();
    } catch {
      /* nothing to report yet */
    }
    await db.$disconnect();
    process.exit(2);
  });

