/**
 * End-to-end gateway tests: boots the mock upstream in-process and calls `handle()` against the real (dev)
 * database. All fixtures are created with a random suffix and removed afterwards, so the seed data and other
 * agents' rows are never touched. Skipped automatically when the database is unreachable.
 */
process.env.GW_TEST_PERSIST = "1"; // let upstream-key health changes reach the DB so we can assert on them

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockUpstream } from "../../scripts/mock-upstream";
import { handle } from "@/gateway/handle";
import { flushMeter } from "@/gateway/meter-writer";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { computeAmount, costTable, sellTable } from "@/gateway/pricing";
import { slotInUse, __resetSlotsForTests } from "@/gateway/slots";
import { emptyUsage } from "@/gateway/types";
import { encrypt, sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";

const dbOk = await db.$queryRaw`SELECT 1`.then(
  () => true,
  () => false,
);

const sfx = String(Math.floor(Math.random() * 1e8)).padStart(8, "0"); // digits only: mock keys containing "bad"/"slow"/"fail" trigger faults
const name = (s: string) => `gwt-${s}-${sfx}`;
const secret = (s: string) => `gwt-key-${s}-${sfx}`;
const apiKey = (tag: string) => `sk-pp-gwt${tag}${sfx}`.padEnd(46, "0");

const ids = {
  users: [] as string[],
  keys: [] as string[],
  providers: [] as string[],
  models: [] as string[],
  groups: [] as string[],
  logs: [] as string[],
};

let mock: Awaited<ReturnType<typeof startMockUpstream>>;
let base = "";
let groupId = "";

interface Fx {
  userId: string;
  key: string;
  keyId: string;
}
const fx: Record<string, Fx> = {};

async function makeUser(tag: string, o: { balance?: string; status?: "ACTIVE" | "SUSPENDED" | "PENDING_VERIFICATION"; priceMultiplier?: string; groupId?: string; monthlySpendLimit?: string; creditLimit?: string } = {}) {
  const u = await db.user.create({
    data: {
      email: `${name(tag)}@test.local`,
      passwordHash: "x",
      status: o.status ?? "ACTIVE",
      emailVerifiedAt: o.status === "PENDING_VERIFICATION" ? null : new Date(),
      balance: o.balance ?? "10",
      creditLimit: o.creditLimit ?? "0",
      groupId: o.groupId ?? groupId,
      priceMultiplier: o.priceMultiplier ?? null,
      monthlySpendLimit: o.monthlySpendLimit ?? null,
    },
  });
  ids.users.push(u.id);
  return u;
}

async function makeKey(tag: string, userId: string, o: Record<string, unknown> = {}): Promise<Fx> {
  const key = apiKey(tag);
  const k = await db.apiKey.create({ data: { userId, name: name(tag), prefix: key.slice(0, 12), keyHash: sha256(key), ...o } });
  ids.keys.push(k.id);
  const f = { userId, key, keyId: k.id };
  fx[tag] = f;
  return f;
}

async function makeProvider(tag: string, o: { formats: string[]; baseUrl?: string; authStyle?: "BEARER" | "X_API_KEY"; settings?: object; keys: Array<{ s: string; priority?: number; maxConcurrency?: number; weight?: number }> }) {
  const p = await db.provider.create({
    data: {
      name: name(tag),
      slug: name(tag),
      preset: "custom",
      baseUrl: o.baseUrl ?? `${base}/v1`,
      authStyle: o.authStyle ?? "BEARER",
      formats: o.formats,
      tags: ["mock"],
      settings: o.settings ?? {},
      timeoutMs: 30_000,
    },
  });
  ids.providers.push(p.id);
  const keys: string[] = [];
  for (const k of o.keys) {
    const pk = await db.providerKey.create({
      data: { providerId: p.id, label: `${tag}-${k.s}`, secretEncrypted: encrypt(secret(k.s)), secretHint: "test", priority: k.priority ?? 0, maxConcurrency: k.maxConcurrency, weight: k.weight ?? 1 },
    });
    keys.push(pk.id);
  }
  return { id: p.id, keys };
}

async function makeModel(tag: string, o: { caps: string[]; providerId: string; upstream?: string; in?: string; out?: string; cached?: string; image?: string; maxOutput?: number; status?: "ACTIVE" | "HIDDEN"; route?: Record<string, unknown>; cost?: Record<string, unknown> }) {
  const slug = name(tag);
  const m = await db.model.create({
    data: {
      slug,
      displayName: slug,
      vendor: "gwt",
      capabilities: o.caps,
      maxOutput: o.maxOutput ?? null,
      status: o.status ?? "ACTIVE",
      inputPrice: o.in ?? "3",
      outputPrice: o.out ?? "15",
      cachedInputPrice: o.cached ?? "0.3",
      imagePrice: o.image ?? null,
    },
  });
  ids.models.push(m.id);
  await db.modelRoute.create({
    data: { modelId: m.id, providerId: o.providerId, upstreamModel: o.upstream ?? `up-${tag}`, inputCost: "1.5", outputCost: "7.5", cachedInputCost: "0.15", imageCost: o.image ? "0.02" : null, ...o.cost, ...o.route },
  });
  return slug;
}

async function call(path: string, key: string | null, body?: unknown, o: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}), ...o.headers };
  const res = await handle(
    new Request(`http://gateway.test${path}`, {
      method: o.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: o.signal,
    }),
  );
  const id = res.headers.get("x-request-id");
  expect(id, "every response carries x-request-id").toBeTruthy();
  ids.logs.push(id!);
  return res;
}

/** The RequestLog of a response (streams finalize asynchronously after the body ends, so poll briefly). */
async function logOf(res: Response) {
  const id = res.headers.get("x-request-id")!;
  for (let i = 0; i < 100; i++) {
    await flushMeter();
    const row = await db.requestLog.findUnique({ where: { id } });
    if (row) return row;
    await sleep(20);
  }
  return db.requestLog.findUniqueOrThrow({ where: { id } });
}

const balanceOf = async (userId: string) => {
  await flushMeter();
  return new Decimal((await db.user.findUniqueOrThrow({ where: { id: userId } })).balance.toString());
};
const mockLast = async (path: string) => (await fetch(`${base}/__mock/last?path=${encodeURIComponent(path)}`)).json() as Promise<{ headers: Record<string, string>; body: Record<string, unknown>; query: Record<string, string> }>;
const mockStats = async () => (await fetch(`${base}/__mock/stats`)).json() as Promise<{ maxInflight: number; byKey: Record<string, { total: number; maxInflight: number }> }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parse an SSE body into {event, data} blocks. */
function sseBlocks(text: string) {
  return text
    .split(/\n\n/)
    .filter((b) => b.trim())
    .map((b) => {
      const event = /^event: (.*)$/m.exec(b)?.[1];
      const data = b
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      return { event, data };
    });
}

const sell = (o: { in?: string; out?: string; cached?: string; image?: string }) => sellTable({ inputPrice: o.in ?? "3", outputPrice: o.out ?? "15", cachedInputPrice: o.cached ?? "0.3", imagePrice: o.image });
const expectedPrice = (u: Partial<ReturnType<typeof emptyUsage>>, o: Parameters<typeof sell>[0] = {}, mult: Decimal.Value = 1) => computeAmount({ ...emptyUsage(), ...u }, sell(o), { multiplier: mult });
const expectedCost = (u: Partial<ReturnType<typeof emptyUsage>>) => computeAmount({ ...emptyUsage(), ...u }, costTable({ inputCost: "1.5", outputCost: "7.5", cachedInputCost: "0.15", imageCost: "0.02" }));

const M: Record<string, string> = {};
const P: Record<string, { id: string; keys: string[] }> = {};

describe.skipIf(!dbOk)("gateway end-to-end (mock upstream + database)", () => {
  beforeAll(async () => {
    __resetSlotsForTests();
    mock = await startMockUpstream(0, "127.0.0.1");
    base = `http://127.0.0.1:${mock.port}`;

    const g = await db.group.create({ data: { name: name("g"), slug: name("g"), priceMultiplier: "1" } });
    ids.groups.push(g.id);
    groupId = g.id;
    const g8 = await db.group.create({ data: { name: name("g8"), slug: name("g8"), priceMultiplier: "0.8" } });
    ids.groups.push(g8.id);

    // ---- providers
    const oaFormats = ["openai_chat", "openai_completions", "openai_responses", "openai_embeddings", "openai_images", "openai_audio", "openai_moderations"];
    P.oa = await makeProvider("oa", { formats: oaFormats, keys: [{ s: "oa1", maxConcurrency: 8 }] });
    P.anth = await makeProvider("anth", { formats: ["anthropic_messages"], baseUrl: base, authStyle: "X_API_KEY", settings: { anthropicBaseUrl: base }, keys: [{ s: "an1" }] });
    P.both = await makeProvider("both", { formats: ["openai_chat", "anthropic_messages", "gemini", "openai_embeddings"], settings: { anthropicBaseUrl: base, geminiBaseUrl: base }, keys: [{ s: "bo1" }] });
    P.fo = await makeProvider("fo", { formats: ["openai_chat"], keys: [{ s: "fail429a", priority: 10 }, { s: "goodb", priority: 0 }] });
    P.all429 = await makeProvider("all429", { formats: ["openai_chat"], keys: [{ s: "fail429x" }, { s: "fail429y" }] });
    P.f500 = await makeProvider("f500", { formats: ["openai_chat"], keys: [{ s: "fail500z" }] });
    P.bad = await makeProvider("bad", { formats: ["openai_chat"], keys: [{ s: "badkey" }] });
    P.flaky = await makeProvider("flaky", { formats: ["openai_chat"], settings: { noCooldown: true }, keys: [{ s: "flakystart1" }] });
    P.collect = await makeProvider("collect", { formats: ["openai_chat"], settings: { streamUpstream: true }, keys: [{ s: "col1" }] });
    P.collectFlaky = await makeProvider("colflaky", { formats: ["openai_chat"], settings: { streamUpstream: true, noCooldown: true }, keys: [{ s: "flakystart2" }] });
    P.deny = await makeProvider("deny", { formats: ["openai_chat"], keys: [{ s: "deny403a", priority: 10 }, { s: "denyok", priority: 0 }] });
    P.denyOnly = await makeProvider("denyonly", { formats: ["openai_chat"], keys: [{ s: "deny403b" }] });
    P.q = await makeProvider("q", { formats: ["openai_chat"], keys: [{ s: "q1", maxConcurrency: 1 }] });
    P.nousage = await makeProvider("nousage", { formats: ["openai_chat"], settings: { forceStreamUsage: false }, keys: [{ s: "nu1" }] });
    P.cap = await makeProvider("cap", { formats: ["openai_chat"], keys: [{ s: "cap1" }, { s: "cap2" }] });

    // ---- models
    M.chat = await makeModel("chat", {
      caps: ["chat", "completions", "responses", "tools", "vision"],
      providerId: P.oa.id,
      maxOutput: 4000,
      route: { paramOverrides: { seed: 7, temperature: null }, maxOutputTokens: 256 },
    });
    M.claude = await makeModel("claude", { caps: ["chat", "tools"], providerId: P.anth.id, maxOutput: 2048 });
    M.nat = await makeModel("nat", { caps: ["chat", "tools"], providerId: P.both.id, maxOutput: 1024 });
    M.oaOnly = await makeModel("oaonly", { caps: ["chat", "tools"], providerId: P.oa.id });
    M.fail = await makeModel("fail", { caps: ["chat"], providerId: P.fo.id });
    M.all429 = await makeModel("all429", { caps: ["chat"], providerId: P.all429.id });
    M.f500 = await makeModel("f500", { caps: ["chat"], providerId: P.f500.id });
    M.deny = await makeModel("deny", { caps: ["chat"], providerId: P.deny.id });
    M.flaky = await makeModel("flaky", { caps: ["chat"], providerId: P.flaky.id });
    M.collect = await makeModel("collect", { caps: ["chat"], providerId: P.collect.id });
    M.collectFlaky = await makeModel("colflaky", { caps: ["chat"], providerId: P.collectFlaky.id });
    M.denyOnly = await makeModel("denyonly", { caps: ["chat"], providerId: P.denyOnly.id });
    M.bad = await makeModel("bad", { caps: ["chat"], providerId: P.bad.id });
    M.queue = await makeModel("queue", { caps: ["chat"], providerId: P.q.id });
    M.nousage = await makeModel("nousage", { caps: ["chat"], providerId: P.nousage.id });
    M.embed = await makeModel("embed", { caps: ["embeddings"], providerId: P.oa.id, in: "0.1", out: "0", cached: undefined });
    M.image = await makeModel("image", { caps: ["images"], providerId: P.oa.id, image: "0.04", in: "0", out: "0" });
    M.hidden = await makeModel("hidden", { caps: ["chat"], providerId: P.oa.id, status: "HIDDEN" });
    M.resp = await makeModel("resp", { caps: ["responses", "chat"], providerId: P.oa.id });
    M.gemb = await makeModel("gemb", { caps: ["embeddings"], providerId: P.both.id, in: "0.1", out: "0", cached: undefined });
    M.speech = await makeModel("speech", { caps: ["audio_speech", "audio_transcription"], providerId: P.oa.id, in: "0", out: "0", route: {} });
    M.cap = await makeModel("cap", { caps: ["chat"], providerId: P.cap.id });

    // ---- customers
    const u1 = await makeUser("u1", { balance: "10" });
    await makeKey("main", u1.id);
    await makeKey("main2", u1.id);
    await makeKey("only", u1.id, { allowedModels: [M.chat] });
    await makeKey("rpm", u1.id, { rpmLimit: 2 });
    await makeKey("dis", u1.id, { status: "DISABLED" });
    await makeKey("rev", u1.id, { status: "REVOKED" });
    await makeKey("exp", u1.id, { expiresAt: new Date(Date.now() - 60_000) });
    await makeKey("ip", u1.id, { ipAllowlist: ["10.9.9.0/24"] });
    await makeKey("lim", u1.id, { spendLimit: "0.001", spent: "0.001" });

    const u0 = await makeUser("u0", { balance: "0" });
    await makeKey("zero", u0.id);
    const uc = await makeUser("uc", { balance: "10" });
    await makeKey("conc", uc.id, { maxConcurrency: 1 });
    const ud = await makeUser("ud", { balance: "10", priceMultiplier: "0.5", groupId: g8.id });
    await makeKey("disc", ud.id);
    const us = await makeUser("us", { status: "SUSPENDED" });
    await makeKey("susp", us.id);
    const up = await makeUser("up", { status: "PENDING_VERIFICATION" });
    await makeKey("pend", up.id);
    const um = await makeUser("um", { balance: "10", monthlySpendLimit: "0.0000001" });
    await makeKey("month", um.id);
    const ucr = await makeUser("ucr", { balance: "-1", creditLimit: "5" });
    await makeKey("credit", ucr.id);
    const uq = await makeUser("uq", { balance: "10" });
    await makeKey("qa", uq.id);
    await makeKey("qb", uq.id);
    const ur = await makeUser("ur", { balance: "10" });
    await makeKey("resp2", ur.id);

    await invalidateGatewayConfig("all");
  }, 60_000);

  afterAll(async () => {
    try {
      await flushMeter();
    } catch {
      /* ignore */
    }
    await db.requestLog.deleteMany({ where: { OR: [{ id: { in: ids.logs } }, { userId: { in: ids.users } }] } }).catch(() => undefined);
    await db.apiKey.deleteMany({ where: { id: { in: ids.keys } } }).catch(() => undefined);
    await db.modelRoute.deleteMany({ where: { modelId: { in: ids.models } } }).catch(() => undefined);
    await db.model.deleteMany({ where: { id: { in: ids.models } } }).catch(() => undefined);
    await db.provider.deleteMany({ where: { id: { in: ids.providers } } }).catch(() => undefined); // cascades provider keys
    await db.user.deleteMany({ where: { id: { in: ids.users } } }).catch(() => undefined);
    await db.group.deleteMany({ where: { id: { in: ids.groups } } }).catch(() => undefined);
    await invalidateGatewayConfig("all");
    await mock?.close();
  }, 30_000);

  // ------------------------------------------------------------------ OpenAI chat
  it("OpenAI chat (non-stream): masks the model, meters exactly once, and debits exactly the computed price", async () => {
    const before = await balanceOf(fx.main.userId);
    const res = await call("/v1/chat/completions", fx.main.key, { model: M.chat, messages: [{ role: "user", content: "hello [[usage:in=1000,out=500]]" }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe(M.chat); // upstream model name is masked
    expect(body.usage.prompt_tokens).toBe(1000);
    expect(body.choices[0].message.content).toContain("Mock reply to: hello");

    const log = await logOf(res);
    expect(log).toMatchObject({ status: "SUCCESS", httpStatus: 200, stream: false, inputTokens: 1000, outputTokens: 500, endpoint: "/v1/chat/completions", inboundFormat: "openai_chat", modelSlug: M.chat, upstreamModel: "up-chat", usageEstimated: false });
    expect(log.userId).toBe(fx.main.userId);
    expect(log.apiKeyId).toBe(fx.main.keyId);
    expect(log.providerId).toBe(P.oa.id);
    expect(log.providerKeyId).toBe(P.oa.keys[0]);

    const price = expectedPrice({ inputTokens: 1000, outputTokens: 500 });
    const cost = expectedCost({ inputTokens: 1000, outputTokens: 500 });
    expect(price.toString()).toBe("0.0105");
    expect(new Decimal(log.price.toString()).equals(price)).toBe(true);
    expect(new Decimal(log.cost.toString()).equals(cost)).toBe(true);
    expect(new Decimal(log.profit.toString()).equals(price.minus(cost))).toBe(true);

    const after = await balanceOf(fx.main.userId);
    expect(before.minus(after).equals(price)).toBe(true);
    const k = await db.apiKey.findUniqueOrThrow({ where: { id: fx.main.keyId } });
    expect(new Decimal(k.spent.toString()).gte(price)).toBe(true);
    expect(k.lastUsedAt).not.toBeNull();
    const pk = await db.providerKey.findUniqueOrThrow({ where: { id: P.oa.keys[0] } });
    expect(pk.totalRequests).toBeGreaterThanOrEqual(1);
    expect(new Decimal(pk.totalCost.toString()).gte(cost)).toBe(true);
    expect(await db.requestLog.count({ where: { id: log.id } })).toBe(1);
  });

  it("applies route paramOverrides + output clamp and sends the upstream model + the upstream key", async () => {
    const res = await call("/v1/chat/completions", fx.main.key, { model: M.chat, temperature: 0.9, max_tokens: 1000, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const last = await mockLast("/v1/chat/completions");
    expect(last.body.model).toBe("up-chat");
    expect(last.body.seed).toBe(7);
    expect(last.body.temperature).toBeUndefined(); // null override deletes the field
    expect(last.body.max_tokens).toBe(256); // route.maxOutputTokens clamp
    expect(last.headers.authorization).toBe(`Bearer ${secret("oa1")}`);
    expect(JSON.stringify(last.headers)).not.toContain(fx.main.key); // customer credential never reaches the upstream
    await res.text();
  });

  it("OpenAI chat (stream): injects include_usage upstream, hides the usage chunk from clients that did not ask, meters tokens + TTFT", async () => {
    const before = await balanceOf(fx.main.userId);
    const res = await call("/v1/chat/completions", fx.main.key, { model: M.chat, stream: true, messages: [{ role: "user", content: "stream me [[usage:in=2000,out=1000]]" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const blocks = sseBlocks(text);
    expect(blocks[blocks.length - 1].data).toBe("[DONE]");
    const chunks = blocks.slice(0, -1).map((b) => JSON.parse(b.data));
    expect(chunks.every((c) => c.model === M.chat)).toBe(true);
    expect(chunks.some((c) => c.usage)).toBe(false);
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toContain("Mock reply to: stream me");
    expect((await mockLast("/v1/chat/completions")).body.stream_options).toEqual({ include_usage: true });

    const log = await logOf(res);
    expect(log).toMatchObject({ status: "SUCCESS", stream: true, inputTokens: 2000, outputTokens: 1000, usageEstimated: false });
    expect(log.ttftMs).not.toBeNull();
    const price = expectedPrice({ inputTokens: 2000, outputTokens: 1000 });
    expect(new Decimal(log.price.toString()).equals(price)).toBe(true);
    expect((await balanceOf(fx.main.userId)).equals(before.minus(price))).toBe(true);
  });

  it("OpenAI chat (stream) forwards the usage chunk when the client asked for it", async () => {
    const res = await call("/v1/chat/completions", fx.main.key, { model: M.chat, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "x [[usage:in=10,out=5]]" }] });
    const blocks = sseBlocks(await res.text());
    const usageChunk = blocks.map((b) => (b.data === "[DONE]" ? null : JSON.parse(b.data))).find((c) => c?.usage);
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5 });
    expect(usageChunk.model).toBe(M.chat);
  });

  it("falls back to tokenizer estimation (usageEstimated) when the upstream reports no stream usage", async () => {
    const res = await call("/v1/chat/completions", fx.main.key, { model: M.nousage, stream: true, messages: [{ role: "user", content: "please count my tokens somehow" }] });
    expect((await mockLast("/v1/chat/completions")).body.stream_options).toBeUndefined();
    await res.text();
    const log = await logOf(res);
    expect(log.status).toBe("SUCCESS");
    expect(log.usageEstimated).toBe(true);
    expect(log.inputTokens).toBeGreaterThan(0);
    expect(log.outputTokens).toBeGreaterThan(0);
    expect(new Decimal(log.price.toString()).gt(0)).toBe(true);
  });

  it("legacy /v1/completions, embeddings and per-image pricing", async () => {
    const c = await call("/v1/completions", fx.main.key, { model: M.chat, prompt: "once upon [[usage:in=100,out=50]]" });
    expect(c.status).toBe(200);
    expect((await c.json()).object).toBe("text_completion");

    const e = await call("/v1/embeddings", fx.main.key, { model: M.embed, input: ["a", "b"] });
    expect(e.status).toBe(200);
    const eb = await e.json();
    expect(eb.data).toHaveLength(2);
    expect(eb.model).toBe(M.embed);
    const el = await logOf(e);
    expect(el.inputTokens).toBeGreaterThan(0);
    expect(new Decimal(el.price.toString()).equals(expectedPrice({ inputTokens: el.inputTokens }, { in: "0.1", out: "0", cached: undefined }))).toBe(true);

    const before = await balanceOf(fx.main.userId);
    const img = await call("/v1/images/generations", fx.main.key, { model: M.image, prompt: "a cat", n: 2 });
    expect(img.status).toBe(200);
    expect((await img.json()).data).toHaveLength(2);
    const il = await logOf(img);
    expect(il.imageCount).toBe(2);
    expect(il.price.toString()).toBe("0.08");
    expect(il.cost.toString()).toBe("0.04");
    expect((await balanceOf(fx.main.userId)).equals(before.minus("0.08"))).toBe(true);
  });

  it("multipart image edits and audio transcription pass through (model swapped, priced per image / minute)", async () => {
    const fd = new FormData();
    fd.append("model", M.image);
    fd.append("prompt", "edit");
    fd.append("image", new Blob([new Uint8Array(32)], { type: "image/png" }), "a.png");
    const res = await call("/v1/images/edits", fx.main.key, fd);
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBeGreaterThanOrEqual(1);
    const log = await logOf(res);
    expect(log.imageCount).toBeGreaterThanOrEqual(1);

    const tx = new FormData();
    tx.append("model", M.speech);
    tx.append("file", new Blob([new Uint8Array(32_000)], { type: "audio/wav" }), "a.wav");
    const t = await call("/v1/audio/transcriptions", fx.main.key, tx);
    expect(t.status).toBe(200);
    expect((await t.json()).text).toBeTruthy();
    expect((await logOf(t)).audioSeconds).toBeGreaterThan(0);

    const sp = await call("/v1/audio/speech", fx.main.key, { model: M.speech, input: "hello world", voice: "alloy" });
    expect(sp.status).toBe(200);
    expect(sp.headers.get("content-type")).toContain("audio");
    expect((await sp.arrayBuffer()).byteLength).toBeGreaterThan(50);
    expect((await logOf(sp)).characters).toBe(11);
  });

  // ------------------------------------------------------------------ Anthropic
  it("Anthropic messages passthrough: native upstream, correct auth/version headers, masked model, cache-token pricing", async () => {
    const before = await balanceOf(fx.main.userId);
    const res = await call(
      "/v1/messages",
      null,
      { model: M.nat, max_tokens: 100, messages: [{ role: "user", content: "hi claude [[usage:in=1000,out=500,cached=200,cw=100]]" }] },
      { headers: { "x-api-key": fx.main.key, "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("message");
    expect(body.model).toBe(M.nat);
    const last = await mockLast("/v1/messages");
    expect(last.headers["x-api-key"]).toBe(secret("bo1"));
    expect(last.headers["anthropic-version"]).toBe("2023-06-01");
    expect(last.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(last.body.model).toBe("up-nat");

    const log = await logOf(res);
    // Anthropic reports input excl. cache; the log stores TOTAL prompt tokens
    expect(log).toMatchObject({ status: "SUCCESS", inputTokens: 1000, cachedTokens: 200, cacheWriteTokens: 100, outputTokens: 500, inboundFormat: "anthropic_messages" });
    const price = computeAmount({ ...emptyUsage(), inputTokens: 1000, cachedTokens: 200, cacheWriteTokens: 100, outputTokens: 500 }, sellTable({ inputPrice: "3", outputPrice: "15", cachedInputPrice: "0.3" }));
    expect(new Decimal(log.price.toString()).equals(price)).toBe(true);
    expect((await balanceOf(fx.main.userId)).equals(before.minus(price))).toBe(true);
  });

  it("Anthropic messages stream passthrough keeps the real event sequence and masks the model", async () => {
    const res = await call("/v1/messages", null, { model: M.nat, max_tokens: 100, stream: true, messages: [{ role: "user", content: "yo [[usage:in=50,out=20]]" }] }, { headers: { "x-api-key": fx.main.key, "anthropic-version": "2023-06-01" } });
    const blocks = sseBlocks(await res.text());
    expect(blocks.map((b) => b.event)).toEqual(expect.arrayContaining(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]));
    expect(blocks[0].event).toBe("message_start");
    expect(JSON.parse(blocks[0].data).message.model).toBe(M.nat);
    const log = await logOf(res);
    expect(log).toMatchObject({ status: "SUCCESS", stream: true, inputTokens: 50, outputTokens: 20 });
  });

  it("OpenAI chat -> Anthropic upstream (translation): response, tools and usage mapping", async () => {
    const before = await balanceOf(fx.main.userId);
    const res = await call("/v1/chat/completions", fx.main.key, {
      model: M.claude,
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hello [[usage:in=1000,out=500,cached=200]]" }],
      temperature: 1.4,
      stop: ["END"],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe(M.claude);
    expect(body.choices[0].message.content).toContain("Mock reply to: hello");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toMatchObject({ prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } });

    const last = await mockLast("/v1/messages");
    expect(last.body).toMatchObject({ model: "up-claude", system: "Be brief.", max_tokens: 2048, temperature: 1, stop_sequences: ["END"] });
    expect(last.headers["x-api-key"]).toBe(secret("an1"));
    expect(last.headers["anthropic-version"]).toBe("2023-06-01");

    const log = await logOf(res);
    expect(log).toMatchObject({ inputTokens: 1000, cachedTokens: 200, outputTokens: 500, inboundFormat: "openai_chat" });
    const price = computeAmount({ ...emptyUsage(), inputTokens: 1000, cachedTokens: 200, outputTokens: 500 }, sell({}));
    expect(price.toString()).toBe("0.00996");
    expect(new Decimal(log.price.toString()).equals(price)).toBe(true);
    expect((await balanceOf(fx.main.userId)).equals(before.minus(price))).toBe(true);
  });

  it("OpenAI chat -> Anthropic upstream: tool calls come back as OpenAI tool_calls", async () => {
    const res = await call("/v1/chat/completions", fx.main.key, {
      model: M.claude,
      messages: [{ role: "user", content: "weather in Paris?" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
    });
    const body = await res.json();
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({ type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } });
    const last = await mockLast("/v1/messages");
    expect((last.body.tools as Array<{ name: string; input_schema: unknown }>)[0]).toMatchObject({ name: "get_weather", input_schema: { type: "object" } });
  });

  it("OpenAI chat -> Anthropic upstream (stream): Anthropic events become OpenAI chunks ending in [DONE]", async () => {
    const res = await call("/v1/chat/completions", fx.main.key, { model: M.claude, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "stream [[usage:in=300,out=40]]" }] });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const blocks = sseBlocks(await res.text());
    expect(blocks[blocks.length - 1].data).toBe("[DONE]");
    const chunks = blocks.slice(0, -1).map((b) => JSON.parse(b.data));
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks.every((c) => c.object === "chat.completion.chunk" && c.model === M.claude)).toBe(true);
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toContain("Mock reply to: stream");
    expect(chunks.find((c) => c.choices[0]?.finish_reason).choices[0].finish_reason).toBe("stop");
    expect(chunks[chunks.length - 1].usage).toMatchObject({ prompt_tokens: 300, completion_tokens: 40 });
    const log = await logOf(res);
    expect(log).toMatchObject({ status: "SUCCESS", stream: true, inputTokens: 300, outputTokens: 40 });
  });

  it("Anthropic inbound -> OpenAI-only upstream (translation): message response, system + tools mapped", async () => {
    const res = await call(
      "/v1/messages",
      null,
      { model: M.oaOnly, max_tokens: 321, system: "You are terse.", messages: [{ role: "user", content: [{ type: "text", text: "hello [[usage:in=700,out=70]]" }] }], temperature: 0.3 },
      { headers: { "x-api-key": fx.main.key, "anthropic-version": "2023-06-01" } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ type: "message", role: "assistant", model: M.oaOnly, stop_reason: "end_turn", usage: { input_tokens: 700, output_tokens: 70 } });
    expect(body.content[0]).toMatchObject({ type: "text" });
    expect(body.content[0].text).toContain("Mock reply to: hello");
    const last = await mockLast("/v1/chat/completions");
    expect(last.body).toMatchObject({ model: "up-oaonly", max_tokens: 321, temperature: 0.3 });
    expect((last.body.messages as Array<{ role: string; content: string }>)[0]).toEqual({ role: "system", content: "You are terse." });
    const log = await logOf(res);
    expect(log).toMatchObject({ inputTokens: 700, outputTokens: 70, inboundFormat: "anthropic_messages", status: "SUCCESS" });
  });

  it("Anthropic inbound -> OpenAI-only upstream (stream): produces the Anthropic event sequence", async () => {
    const res = await call(
      "/v1/messages",
      null,
      { model: M.oaOnly, max_tokens: 100, stream: true, messages: [{ role: "user", content: "go [[usage:in=60,out=15]]" }] },
      { headers: { "x-api-key": fx.main.key, "anthropic-version": "2023-06-01" } },
    );
    const blocks = sseBlocks(await res.text());
    const names = blocks.map((b) => b.event);
    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_start");
    expect(names).toContain("content_block_delta");
    expect(names[names.length - 2]).toBe("message_delta");
    expect(names[names.length - 1]).toBe("message_stop");
    const delta = JSON.parse(blocks[blocks.length - 2].data);
    expect(delta.delta.stop_reason).toBe("end_turn");
    expect(delta.usage).toMatchObject({ input_tokens: 60, output_tokens: 15 });
    expect(JSON.parse(blocks[0].data).message.model).toBe(M.oaOnly);
    const log = await logOf(res);
    expect(log).toMatchObject({ status: "SUCCESS", stream: true, inputTokens: 60, outputTokens: 15 });
  });

  it("Anthropic count_tokens: native upstream when available, local estimate otherwise (not billed)", async () => {
    const h = { "x-api-key": fx.main.key, "anthropic-version": "2023-06-01" };
    const nat = await call("/v1/messages/count_tokens", null, { model: M.nat, messages: [{ role: "user", content: "count me" }] }, { headers: h });
    expect(nat.status).toBe(200);
    expect((await nat.json()).input_tokens).toBeGreaterThan(0);
    expect((await logOf(nat)).price.toString()).toBe("0");
    const local = await call("/v1/messages/count_tokens", null, { model: M.oaOnly, messages: [{ role: "user", content: "count me please, locally" }] }, { headers: h });
    expect(local.status).toBe(200);
    expect((await local.json()).input_tokens).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------ Gemini
  it("Gemini generateContent / streamGenerateContent / embedContent through a gemini-capable provider (key via ?key=)", async () => {
    const g = await call(`/v1beta/models/${M.nat}:generateContent?key=${fx.main.key}`, null, { contents: [{ role: "user", parts: [{ text: "hi gemini [[usage:in=90,out=30]]" }] }] });
    expect(g.status).toBe(200);
    const gb = await g.json();
    expect(gb.candidates[0].content.parts[0].text).toContain("Mock reply to");
    expect(gb.modelVersion).toBe(M.nat);
    const last = await mockLast(`/v1beta/models/up-nat:generateContent`);
    expect(last.headers["x-goog-api-key"]).toBe(secret("bo1"));
    expect(last.query.key).toBeUndefined(); // customer's ?key= is never forwarded
    expect(await logOf(g)).toMatchObject({ inputTokens: 90, outputTokens: 30, inboundFormat: "gemini", endpoint: "/v1beta/models:generateContent" });

    const s = await call(`/v1beta/models/${M.nat}:streamGenerateContent?alt=sse`, null, { contents: [{ role: "user", parts: [{ text: "stream [[usage:in=20,out=8]]" }] }] }, { headers: { "x-goog-api-key": fx.main.key } });
    const blocks = sseBlocks((await s.text()).replace(/\r/g, ""));
    expect(blocks.length).toBeGreaterThan(1);
    expect(JSON.parse(blocks[blocks.length - 1].data).usageMetadata).toBeDefined();
    expect(await logOf(s)).toMatchObject({ stream: true, inputTokens: 20, outputTokens: 8, endpoint: "/v1beta/models:streamGenerateContent" });

    // without ?alt=sse Gemini streams a growing JSON array instead of SSE
    const arr = await call(`/v1beta/models/${M.nat}:streamGenerateContent`, fx.main.key, { contents: [{ role: "user", parts: [{ text: "array [[usage:in=12,out=4]]" }] }] });
    expect(arr.headers.get("content-type")).toContain("application/json");
    const parsed = JSON.parse(await arr.text()) as Array<{ usageMetadata?: unknown; modelVersion?: string }>;
    expect(parsed.length).toBeGreaterThan(1);
    expect(parsed[parsed.length - 1].usageMetadata).toBeDefined();
    expect(parsed[0].modelVersion).toBe(M.nat);
    expect(await logOf(arr)).toMatchObject({ stream: true, inputTokens: 12, outputTokens: 4, status: "SUCCESS" });

    const e = await call(`/v1beta/models/${M.gemb}:embedContent`, fx.main.key, { content: { parts: [{ text: "embed me" }] } });
    expect(e.status).toBe(200);
    expect((await e.json()).embedding.values.length).toBeGreaterThan(0);
    const el = await logOf(e);
    expect(el.inputTokens).toBeGreaterThan(0); // estimated: Gemini embeddings report no usage
    expect(el.usageEstimated).toBe(true);
  });

  it("Gemini on a model without a gemini route -> clean unsupported_endpoint in Gemini error shape", async () => {
    const res = await call(`/v1beta/models/${M.oaOnly}:generateContent`, fx.main.key, { contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: 400, status: "INVALID_ARGUMENT" });
    expect((await logOf(res)).errorCode).toBe("unsupported_endpoint");
  });

  // ------------------------------------------------------------------ Responses API
  it("Responses API: create (non-stream + stream), then GET / DELETE stick to the owning upstream key and are owner-only", async () => {
    const r = await call("/v1/responses", fx.main.key, { model: M.resp, input: "hello [[usage:in=40,out=10]]" });
    expect(r.status).toBe(200);
    const rb = await r.json();
    expect(rb.object).toBe("response");
    expect(rb.model).toBe(M.resp);
    const rl = await logOf(r);
    expect(rl).toMatchObject({ inputTokens: 40, outputTokens: 10, inboundFormat: "openai_responses" });

    const got = await call(`/v1/responses/${rb.id}`, fx.main.key);
    expect(got.status).toBe(200);
    expect((await got.json()).id).toBe(rb.id);
    const stranger = await call(`/v1/responses/${rb.id}`, fx.resp2.key);
    expect(stranger.status).toBe(404);
    const unknown = await call(`/v1/responses/resp_nope`, fx.main.key);
    expect(unknown.status).toBe(404);

    const s = await call("/v1/responses", fx.main.key, { model: M.resp, stream: true, input: "stream [[usage:in=30,out=6]]" });
    const text = await s.text();
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.completed");
    expect(text).not.toContain("up-resp");
    const sl = await logOf(s);
    expect(sl).toMatchObject({ stream: true, inputTokens: 30, outputTokens: 6, status: "SUCCESS" });
    const sid = /"id":"(resp_[^"]+)"/.exec(text)![1];
    expect((await call(`/v1/responses/${sid}`, fx.main.key)).status).toBe(200);

    const del = await call(`/v1/responses/${rb.id}`, fx.main.key, undefined, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).deleted).toBe(true);
  });

  // ------------------------------------------------------------------ catalog
  it("catalog: /v1/models lists visible models (OpenAI + Anthropic + Gemini shapes), honours key allow-lists, hides HIDDEN", async () => {
    const list = await (await call("/v1/models", fx.main.key)).json();
    const slugs = list.data.map((m: { id: string }) => m.id);
    expect(slugs).toContain(M.chat);
    expect(slugs).toContain(M.claude);
    expect(slugs).not.toContain(M.hidden);
    expect(list.data[0]).toMatchObject({ object: "model" });

    const only = await (await call("/v1/models", fx.only.key)).json();
    expect(only.data.map((m: { id: string }) => m.id)).toEqual([M.chat]);

    const anth = await (await call("/v1/models", fx.main.key, undefined, { headers: { "anthropic-version": "2023-06-01" } })).json();
    expect(anth.data[0]).toMatchObject({ type: "model" });
    expect(anth.has_more).toBe(false);

    const gem = await (await call("/v1beta/models", fx.main.key)).json();
    expect(gem.models.map((m: { name: string }) => m.name)).toContain(`models/${M.chat}`);

    expect((await call(`/v1/models/${M.chat}`, fx.main.key)).status).toBe(200);
    expect((await call(`/v1/models/${M.hidden}`, fx.main.key)).status).toBe(200); // explicitly requested HIDDEN models resolve
    const missing = await call(`/v1/models/does-not-exist`, fx.main.key);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("model_not_found");
  });

  it("accepts all four API-key styles", async () => {
    const k = fx.main.key;
    const ok = async (r: Promise<Response>) => (await r).status;
    expect(await ok(call("/v1/models", k))).toBe(200); // Authorization: Bearer
    expect(await ok(call("/v1/models", null, undefined, { headers: { "x-api-key": k } }))).toBe(200);
    expect(await ok(call("/v1/models", null, undefined, { headers: { "x-goog-api-key": k } }))).toBe(200);
    expect(await ok(call(`/v1/models?key=${k}`, null))).toBe(200);
    expect(await ok(call("/v1/v1/models", k))).toBe(200); // doubled prefix
  });

  // ------------------------------------------------------------------ failover + health
  it("a relay that opens the stream and fails before any output is retried invisibly (same key), and never cooled down", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await call("/v1/chat/completions", fx.main.key, { model: M.flaky, stream: true, messages: [{ role: "user", content: "flaky [[usage:in=40,out=8]]" }] });
      expect(res.status).toBe(200);
      const blocks = sseBlocks(await res.text());
      expect(blocks[blocks.length - 1].data).toBe("[DONE]");
      const chunks = blocks.slice(0, -1).map((b) => JSON.parse(b.data));
      // the client never sees the failed attempt: no error event, one role chunk, the whole reply
      expect(chunks.some((c) => c.error)).toBe(false);
      expect(chunks.filter((c) => c.choices?.[0]?.delta?.role).length).toBe(1);
      expect(chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")).toContain("Mock reply to: flaky");
      const log = await logOf(res);
      expect(log.status).toBe("SUCCESS");
      expect((log.attempts as unknown[]).length).toBe(2);
    }
    await sleep(1500);
    expect((await db.providerKey.findUniqueOrThrow({ where: { id: P.flaky.keys[0] } })).status).toBe("ACTIVE");
  });

  it("streamUpstream: a non-streaming request is sent upstream as a stream and answered as normal JSON (usage billed)", async () => {
    const res = await call("/v1/chat/completions", fx.main.key, { model: M.collect, messages: [{ role: "user", content: "assemble me [[usage:in=300,out=60]]" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe(M.collect);
    expect(body.choices[0].message.content).toContain("Mock reply to: assemble me");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toMatchObject({ prompt_tokens: 300, completion_tokens: 60 });
    const up = (await mockLast("/v1/chat/completions")).body;
    expect(up.stream).toBe(true);
    expect(up.stream_options).toEqual({ include_usage: true });
    const log = await logOf(res);
    expect(log).toMatchObject({ status: "SUCCESS", stream: false, inputTokens: 300, outputTokens: 60, usageEstimated: false });
  });

  it("streamUpstream + a relay failing before output: retried invisibly, the client just gets the JSON", async () => {
    const res = await call("/v1/chat/completions", fx.main.key, { model: M.collectFlaky, messages: [{ role: "user", content: "assemble flaky [[usage:in=30,out=6]]" }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toContain("Mock reply to: assemble flaky");
    const log = await logOf(res);
    expect(log.status).toBe("SUCCESS");
    expect((log.attempts as unknown[]).length).toBe(2);
  });

  it("a 'not allowed' 403 fails over to the next key without retrying the same key, and never invalidates the key", async () => {
    const res = await call("/v1/chat/completions", fx.main.key, { model: M.deny, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const log = await logOf(res);
    expect((log.attempts as Array<{ status: number }>).map((a) => a.status)).toEqual([403, 200]);
    expect(log.providerKeyId).toBe(P.deny.keys[1]);

    // only key: one attempt (a retry cannot help), the customer gets a gateway error, the key stays ACTIVE
    const only = await call("/v1/chat/completions", fx.main.key, { model: M.denyOnly, messages: [{ role: "user", content: "hi" }] });
    expect(only.status).toBe(503);
    expect((((await logOf(only)).attempts as unknown[]) ?? []).length).toBe(1);
    const again = await call("/v1/chat/completions", fx.main.key, { model: M.denyOnly, messages: [{ role: "user", content: "hi" }] });
    expect(again.status).toBe(503);
    await sleep(1500);
    for (const id of [P.deny.keys[0], P.denyOnly.keys[0]]) {
      const pk = await db.providerKey.findUniqueOrThrow({ where: { id } });
      expect(pk.status).toBe("ACTIVE");
    }
  });

  it("fails over from a 429 key to the next key (same request succeeds) and cools the 429 key down", async () => {
    const res = await call("/v1/chat/completions", fx.main.key, { model: M.fail, messages: [{ role: "user", content: "hi [[usage:in=100,out=10]]" }] });
    expect(res.status).toBe(200);
    const log = await logOf(res);
    const attempts = log.attempts as Array<{ providerKeyId: string; status: number }>;
    expect(attempts.map((a) => a.status)).toEqual([429, 200]);
    expect(attempts[0].providerKeyId).toBe(P.fo.keys[0]);
    expect(log.providerKeyId).toBe(P.fo.keys[1]);
    expect(log.status).toBe("SUCCESS");

    // next request skips the cooling-down key entirely
    const res2 = await call("/v1/chat/completions", fx.main.key, { model: M.fail, messages: [{ role: "user", content: "again" }] });
    expect(res2.status).toBe(200);
    const log2 = await logOf(res2);
    expect((log2.attempts as unknown[]).length).toBe(1);

    // the cooldown is persisted for the admin console (coalesced write, ~1s)
    let status = "";
    for (let i = 0; i < 30 && status !== "COOLDOWN"; i++) {
      await sleep(150);
      status = (await db.providerKey.findUniqueOrThrow({ where: { id: P.fo.keys[0] } })).status;
    }
    expect(status).toBe("COOLDOWN");
    const pk = await db.providerKey.findUniqueOrThrow({ where: { id: P.fo.keys[0] } });
    expect(pk.cooldownUntil).not.toBeNull();
    expect(pk.lastError).toContain("429");
  });

  it("when every key is rate limited the client gets a native 429 with retry-after + x-ratelimit headers (all shapes)", async () => {
    const o = await call("/v1/chat/completions", fx.main.key, { model: M.all429, messages: [{ role: "user", content: "x" }] });
    expect(o.status).toBe(429);
    expect(o.headers.get("retry-after")).toBe("2");
    expect(o.headers.get("x-ratelimit-remaining-requests")).toBe("0");
    const ob = await o.json();
    // the upstream's own error document: its type / code / message survive, only our identity is scrubbed (PLAN 9d.1a)
    expect(ob.error).toMatchObject({ type: "rate_limit_error", code: "rate_limit_exceeded", message: "Rate limit reached for requests." });
    expect(JSON.stringify(ob)).not.toMatch(/mock|127\.0\.0\.1|fail429/i);
    expect(o.headers.get("x-upstream-request-id")).toMatch(/^req_mock_/);
    expect(o.headers.get("openai-organization")).toBeNull();
    expect(o.headers.get("x-powered-by")).toBeNull();
    const ol = await logOf(o);
    expect(ol).toMatchObject({ status: "UPSTREAM_ERROR", httpStatus: 429, errorCode: "rate_limited" });
    expect((ol.attempts as unknown[]).length).toBe(2);
    expect(ol.internalError).toContain("429");
    expect(new Decimal(ol.price.toString()).isZero()).toBe(true);

    // both keys are now cooling down -> same answer from the other API shapes without touching the upstream
    const a = await call("/v1/messages", null, { model: M.all429, max_tokens: 5, messages: [{ role: "user", content: "x" }] }, { headers: { "x-api-key": fx.main.key, "anthropic-version": "2023-06-01" } });
    expect([429, 503]).toContain(a.status); // 503 while both keys cool down, 429 if the (2s) cooldown already elapsed
    const ab = await a.json();
    expect(ab.type).toBe("error");
    expect(["overloaded_error", "rate_limit_error"]).toContain(ab.error.type);
    expect(a.headers.get("retry-after")).toBeTruthy();
  });

  it("upstream 500s are retried; the client then gets the LAST upstream's real status + native error (PLAN 9d.1a), the gateway code only in the log", async () => {
    const res = await call("/v1/chat/completions", fx.main.key, { model: M.f500, messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatchObject({ type: "server_error", code: "internal_server_error", message: "The server had an error while processing your request." });
    expect(JSON.stringify(body)).not.toMatch(/fail500|mock|127\.0\.0\.1/i);
    const log = await logOf(res);
    expect(log).toMatchObject({ status: "UPSTREAM_ERROR", httpStatus: 500, errorCode: "upstream_error" });
    expect((log.attempts as Array<{ status: number }>).every((a) => a.status === 500)).toBe(true);
    expect(log.internalError).toContain("500");
  });

  it("a key the upstream keeps rejecting (401) is marked INVALID after 2 consecutive failures", async () => {
    const res = await call("/v1/chat/completions", fx.main.key, { model: M.bad, messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("no_available_provider");
    let status = "";
    for (let i = 0; i < 30 && status !== "INVALID"; i++) {
      await sleep(150);
      status = (await db.providerKey.findUniqueOrThrow({ where: { id: P.bad.keys[0] } })).status;
    }
    expect(status).toBe("INVALID");
  });

  it("a 4xx validation error from the upstream is returned as-is and never fails over", async () => {
    const res = await call("/v1/messages", null, { model: M.nat, max_tokens: 20, messages: [{ role: "user", content: "rejected upstream [[http400]]" }] }, { headers: { "x-api-key": fx.main.key, "anthropic-version": "2023-06-01" } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    const log = await logOf(res);
    expect(log.status).toBe("CLIENT_ERROR");
    expect((log.attempts as unknown[]).length).toBe(1);
  });

  it("an Anthropic request without max_tokens is not rejected: the funds guard fills it in", async () => {
    const res = await call("/v1/messages", null, { model: M.nat, messages: [{ role: "user", content: "no max_tokens" }] }, { headers: { "x-api-key": fx.main.key, "anthropic-version": "2023-06-01" } });
    expect(res.status).toBe(200);
    await res.text();
    const last = await mockLast("/v1/messages");
    expect(last.body.max_tokens).toBe(1024); // model.maxOutput
  });

  // ------------------------------------------------------------------ gateway errors
  it("402 insufficient_balance when the balance is 0 (OpenAI + Anthropic shapes), no upstream call, one log", async () => {
    const before = (await mockStats()).byKey[secret("oa1")]?.total ?? 0;
    const res = await call("/v1/chat/completions", fx.zero.key, { model: M.chat, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatchObject({ code: "insufficient_balance", type: "billing_error" });
    expect((await mockStats()).byKey[secret("oa1")]?.total ?? 0).toBe(before);
    const log = await logOf(res);
    expect(log).toMatchObject({ status: "CLIENT_ERROR", httpStatus: 402, errorCode: "insufficient_balance", userId: fx.zero.userId });
    expect(log.internalError).toContain("balance=");

    const a = await call("/v1/messages", null, { model: M.nat, max_tokens: 5, messages: [{ role: "user", content: "hi" }] }, { headers: { "x-api-key": fx.zero.key, "anthropic-version": "2023-06-01" } });
    expect(a.status).toBe(402);
    expect(await a.json()).toMatchObject({ type: "error", error: { type: "billing_error" } });
  });

  it("allows a negative balance within the credit limit (postpaid) and rejects when the estimate does not fit", async () => {
    const ok = await call("/v1/chat/completions", fx.credit.key, { model: M.chat, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(ok.status).toBe(200);
    await ok.text();
    const huge = await call("/v1/chat/completions", fx.credit.key, { model: M.chat, messages: [{ role: "user", content: "lorem ipsum ".repeat(700_000) }] });
    expect(huge.status).toBe(402); // ~2.3M estimated input tokens x $3/M = ~$7 > $4 headroom (-1 balance + 5 credit)
  });

  it("applies group x user price multipliers to the charge but not the cost", async () => {
    const before = await balanceOf(fx.disc.userId);
    const res = await call("/v1/chat/completions", fx.disc.key, { model: M.chat, messages: [{ role: "user", content: "hi [[usage:in=1000,out=500]]" }] });
    expect(res.status).toBe(200);
    const log = await logOf(res);
    const price = expectedPrice({ inputTokens: 1000, outputTokens: 500 }, {}, "0.4"); // 0.5 x 0.8
    expect(price.toString()).toBe("0.0042");
    expect(new Decimal(log.price.toString()).equals(price)).toBe(true);
    expect(new Decimal(log.cost.toString()).equals(expectedCost({ inputTokens: 1000, outputTokens: 500 }))).toBe(true);
    expect((await balanceOf(fx.disc.userId)).equals(before.minus(price))).toBe(true);
    expect(log.groupSlug).toBe(name("g8"));
  });

  it("429 when the key's concurrency is exceeded, and the slot frees when the first request finishes", async () => {
    const slow = await call("/v1/chat/completions", fx.conc.key, { model: M.chat, stream: true, messages: [{ role: "user", content: "hold [[usage:in=10,out=5]]" }] }, { headers: { "x-mock-delay-ms": "250" } });
    expect(slow.status).toBe(200);
    const reader = slow.body!.getReader();
    await reader.read(); // stream is open and holding its slots

    const rejected = await call("/v1/chat/completions", fx.conc.key, { model: M.chat, messages: [{ role: "user", content: "second" }] });
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("1");
    expect((await rejected.json()).error).toMatchObject({ code: "rate_limited", type: "rate_limit_error" });
    const rl = await logOf(rejected);
    expect(rl).toMatchObject({ status: "CLIENT_ERROR", httpStatus: 429, errorCode: "rate_limited" });

    while (!(await reader.read()).done) {
      /* drain */
    }
    await sleep(30);
    expect(await slotInUse("key", fx.conc.keyId)).toBe(0);
    const again = await call("/v1/chat/completions", fx.conc.key, { model: M.chat, messages: [{ role: "user", content: "third" }] });
    expect(again.status).toBe(200);
    await again.text();
  });

  it("queues when every upstream slot is busy, never exceeds the key's slot limit, and records queueMs", async () => {
    const run = (key: string, text: string) =>
      call("/v1/chat/completions", key, { model: M.queue, messages: [{ role: "user", content: `${text} [[usage:in=10,out=5]]` }] }, { headers: { "x-mock-delay-ms": "350" } });
    const t0 = Date.now();
    const [a, b] = await Promise.all([run(fx.qa.key, "first"), run(fx.qb.key, "second")]);
    const elapsed = Date.now() - t0;
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(650); // serialized through the single slot
    const logs = [await logOf(a), await logOf(b)];
    expect(Math.max(...logs.map((l) => l.queueMs))).toBeGreaterThanOrEqual(250);
    expect(Math.min(...logs.map((l) => l.queueMs))).toBeLessThan(150);
    const stats = await mockStats();
    expect(stats.byKey[secret("q1")].maxInflight).toBe(1);
    expect(await slotInUse("pkey", P.q.keys[0])).toBe(0);
  });

  it("spreads load across keys: a full first key spills to the second key (key1 full -> key2)", async () => {
    // cap1/cap2 have the default slot limit (50) - shrink cap1 to 1 slot and hold it
    await db.providerKey.update({ where: { id: P.cap.keys[0] }, data: { maxConcurrency: 1, priority: 5 } });
    await invalidateGatewayConfig("providers");
    const hold = await call("/v1/chat/completions", fx.main2.key, { model: M.cap, stream: true, messages: [{ role: "user", content: "hold" }] }, { headers: { "x-mock-delay-ms": "300" } });
    const reader = hold.body!.getReader();
    await reader.read();
    const second = await call("/v1/chat/completions", fx.main2.key, { model: M.cap, messages: [{ role: "user", content: "spill" }] });
    expect(second.status).toBe(200);
    const sl = await logOf(second);
    expect(sl.providerKeyId).toBe(P.cap.keys[1]);
    expect(sl.queueMs).toBeLessThan(100);
    while (!(await reader.read()).done) {
      /* drain */
    }
    const hl = await logOf(hold);
    expect(hl.providerKeyId).toBe(P.cap.keys[0]);
  });

  it("client cancel mid-stream: logs CANCELLED with partial usage, aborts the upstream and frees all slots", async () => {
    const res = await call("/v1/chat/completions", fx.main2.key, { model: M.chat, stream: true, messages: [{ role: "user", content: "cancel me please, this is a long enough prompt" }] }, { headers: { "x-mock-delay-ms": "300" } });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await sleep(100);
    const log = await logOf(res);
    expect(log.status).toBe("CANCELLED");
    expect(log.httpStatus).toBe(499);
    expect(log.inputTokens).toBeGreaterThan(0); // partial usage is metered from the tokenizer estimate
    expect(log.usageEstimated).toBe(true);
    expect(await slotInUse("user", fx.main2.userId)).toBe(0);
    expect(await slotInUse("pkey", P.oa.keys[0])).toBe(0);
  });

  it("auth failures: invalid / disabled / revoked / expired / IP / suspended / unverified / spend-limit, each logged once", async () => {
    const chat = (key: string, extra: Record<string, string> = {}) => call("/v1/chat/completions", key, { model: M.chat, messages: [{ role: "user", content: "x" }] }, { headers: extra });
    const code = async (r: Response) => (await r.json()).error.code as string;

    const none = await call("/v1/chat/completions", null, { model: M.chat, messages: [] });
    expect(none.status).toBe(401);
    expect(await code(none)).toBe("invalid_api_key");
    const wrong = await chat("sk-pp-doesnotexist");
    expect(wrong.status).toBe(401);
    expect(await code(wrong)).toBe("invalid_api_key");
    expect((await logOf(wrong)).userId).toBeNull(); // unauthenticated: logged without a user

    const dis = await chat(fx.dis.key);
    expect([dis.status, await code(dis)]).toEqual([401, "key_disabled"]);
    expect((await logOf(dis)).userId).toBe(fx.dis.userId);
    const rev = await chat(fx.rev.key);
    expect([rev.status, await code(rev)]).toEqual([401, "key_disabled"]);
    const exp = await chat(fx.exp.key);
    expect([exp.status, await code(exp)]).toEqual([401, "key_expired"]);
    const ipBad = await chat(fx.ip.key, { "x-forwarded-for": "1.2.3.4" });
    expect([ipBad.status, await code(ipBad)]).toEqual([403, "ip_not_allowed"]);
    const ipOk = await chat(fx.ip.key, { "x-forwarded-for": "10.9.9.77" });
    expect(ipOk.status).toBe(200);
    await ipOk.text();
    const susp = await chat(fx.susp.key);
    expect([susp.status, await code(susp)]).toEqual([403, "account_suspended"]);
    const pend = await chat(fx.pend.key);
    expect([pend.status, await code(pend)]).toEqual([403, "email_not_verified"]);
    const lim = await chat(fx.lim.key);
    expect([lim.status, await code(lim)]).toEqual([402, "spend_limit_reached"]);

    // monthly spend limit: the first request goes through, afterwards the limit is hit
    const m1 = await chat(fx.month.key);
    await m1.text();
    await flushMeter();
    await invalidateGatewayConfig("users", fx.month.userId);
    const m2 = await chat(fx.month.key);
    expect([m2.status, await code(m2)]).toEqual([402, "spend_limit_reached"]);
  });

  it("per-key RPM limit returns 429 with retry-after", async () => {
    const r = () => call("/v1/chat/completions", fx.rpm.key, { model: M.chat, messages: [{ role: "user", content: "x" }] });
    expect((await r()).status).toBe(200);
    expect((await r()).status).toBe(200);
    const third = await r();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await third.json()).error.code).toBe("rate_limited");
  });

  it("model resolution errors and error shapes per inbound format", async () => {
    const nf = await call("/v1/chat/completions", fx.main.key, { model: "no-such-model", messages: [] });
    expect(nf.status).toBe(404);
    expect((await nf.json()).error).toMatchObject({ code: "model_not_found", param: "model" });

    const notAllowed = await call("/v1/chat/completions", fx.only.key, { model: M.claude, messages: [{ role: "user", content: "x" }] });
    expect(notAllowed.status).toBe(403);
    expect((await notAllowed.json()).error.code).toBe("model_not_allowed");

    const wrongCap = await call("/v1/chat/completions", fx.main.key, { model: M.embed, messages: [{ role: "user", content: "x" }] });
    expect(wrongCap.status).toBe(400);
    expect((await wrongCap.json()).error.code).toBe("unsupported_endpoint");

    const noModel = await call("/v1/chat/completions", fx.main.key, { messages: [] });
    expect(noModel.status).toBe(400);
    const badJson = await handle(new Request("http://gateway.test/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${fx.main.key}`, "content-type": "application/json" }, body: "{not json" }));
    ids.logs.push(badJson.headers.get("x-request-id")!);
    expect(badJson.status).toBe(400);

    const anth = await call("/v1/messages", "sk-pp-nope", { model: M.nat, max_tokens: 1, messages: [] });
    expect(anth.status).toBe(401);
    expect(await anth.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
    const gem = await call(`/v1beta/models/${M.nat}:generateContent`, "sk-pp-nope", { contents: [] });
    expect(gem.status).toBe(401);
    expect(await gem.json()).toMatchObject({ error: { code: 401, status: "UNAUTHENTICATED" } });

    const unknown = await call("/v1/nope", fx.main.key, {});
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe("not_found");
    const wrongMethod = await call("/v1/chat/completions", fx.main.key, undefined, { method: "GET" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    const pre = await handle(new Request("http://gateway.test/v1/chat/completions", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-expose-headers")).toContain("x-request-id");
  });

  it("never leaks the upstream key, URL, provider name or real model name to customers", async () => {
    const responses = [
      await call("/v1/chat/completions", fx.main.key, { model: M.chat, messages: [{ role: "user", content: "leak? [[usage:in=5,out=5]]" }] }),
      await call("/v1/messages", null, { model: M.nat, max_tokens: 5, messages: [{ role: "user", content: "leak?" }] }, { headers: { "x-api-key": fx.main.key, "anthropic-version": "2023-06-01" } }),
      await call("/v1/chat/completions", fx.main.key, { model: M.f500, messages: [{ role: "user", content: "x" }] }),
    ];
    for (const r of responses) {
      const text = JSON.stringify([...r.headers.entries()]) + (await r.text());
      expect(text).not.toContain(secret("oa1"));
      expect(text).not.toContain("127.0.0.1");
      expect(text).not.toContain(name("oa"));
      expect(text).not.toMatch(/up-chat|up-nat|up-f500/);
    }
  });

  it("health checks: record HealthCheck rows, flag failing keys and roll the provider up to OPERATIONAL / DEGRADED / DOWN", async () => {
    const { checkProviderKey, checkProvider } = await import("@/gateway/health");
    const good = await checkProviderKey(P.oa.keys[0]);
    expect(good.ok).toBe(true);
    expect(good.latencyMs).not.toBeNull();
    let p = await db.provider.findUniqueOrThrow({ where: { id: P.oa.id } });
    expect(p.healthStatus).toBe("OPERATIONAL");
    expect(p.lastCheckAt).not.toBeNull();

    const bad = await checkProviderKey(P.bad.keys[0]);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("401");
    p = await db.provider.findUniqueOrThrow({ where: { id: P.bad.id } });
    expect(p.healthStatus).toBe("DOWN");

    // one good + one rate-limited key -> DEGRADED
    const results = await checkProvider(P.fo.id);
    expect(results.map((r) => r.ok).sort()).toEqual([false, true]);
    expect((await db.provider.findUniqueOrThrow({ where: { id: P.fo.id } })).healthStatus).toBe("DEGRADED");
    const rows = await db.healthCheck.findMany({ where: { providerId: P.fo.id } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => !r.ok)?.error).toContain("429");
    expect(await checkProviderKey("does-not-exist")).toMatchObject({ ok: false });
  });

  it("exactly one RequestLog per request (success, error, cancel), all with a request id", async () => {
    await flushMeter();
    const unique = new Set(ids.logs);
    expect(unique.size).toBe(ids.logs.length);
    const rows = await db.requestLog.findMany({ where: { id: { in: ids.logs } }, select: { id: true } });
    expect(rows.length).toBe(ids.logs.length);
  });

  it("settles all slots: nothing is left in use after the suite", async () => {
    for (const keyId of P.oa.keys.concat(P.q.keys, P.cap.keys, P.fo.keys)) expect(await slotInUse("pkey", keyId)).toBe(0);
    for (const u of ids.users) expect(await slotInUse("user", u)).toBe(0);
  });
});
