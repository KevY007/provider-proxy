import { describe, expect, it } from "vitest";
import type { ConfigSnapshot, GroupRec, KeyRec, ModelRec, ProviderRec, RouteRec } from "@/gateway/cache";
import { __resetCacheForTests, effectiveKeyState, isKeyUsable, setKeyRuntime } from "@/gateway/cache";
import { classifyStatus, recordKeyFailure, recordKeySuccess } from "@/gateway/keyhealth";
import { sellTable, costTable, officialTable } from "@/gateway/pricing";
import { buildCandidates, eligibleRoutes, orderKeys, orderRoutes } from "@/gateway/select";
import { Decimal } from "@/lib/money";

const provider = (id: string, formats: string[], over: Partial<ProviderRec> = {}): ProviderRec => ({
  id,
  name: id,
  slug: id,
  preset: "custom",
  baseUrl: "http://x/v1",
  authStyle: "BEARER",
  formats: new Set(formats),
  tags: [],
  extraHeaders: {},
  settings: {},
  status: "ACTIVE",
  timeoutMs: 1000,
  priority: 0,
  maxConcurrency: null,
  ...over,
});

const key = (id: string, providerId: string, over: Partial<KeyRec> = {}): KeyRec => ({
  id,
  providerId,
  label: id,
  secretEncrypted: "x",
  status: "ACTIVE",
  weight: 1,
  priority: 0,
  rpmLimit: null,
  tpmLimit: null,
  maxConcurrency: null,
  dailyBudget: null,
  cooldownUntil: null,
  consecutiveFailures: 0,
  extra: {},
  ...over,
});

const model: ModelRec = {
  id: "m1",
  slug: "m",
  aliases: [],
  displayName: "M",
  vendor: "v",
  description: null,
  capabilities: new Set(["chat"]),
  contextWindow: null,
  maxOutput: null,
  status: "ACTIVE",
  sortOrder: 0,
  maskUpstreamModel: true,
  sell: sellTable({ inputPrice: 1, outputPrice: 1 }),
  official: officialTable({}),
  retiresAt: null,
  longContext: { threshold: null, multiplier: null },
  createdAt: 0,
};

const route = (id: string, p: ProviderRec, over: Partial<RouteRec> = {}): RouteRec => ({
  id,
  modelId: "m1",
  providerId: p.id,
  provider: p,
  upstreamModel: `up-${id}`,
  label: null,
  priority: 0,
  weight: 1,
  groupSlugs: [],
  paramOverrides: {},
  maxOutputTokens: null,
  cost: costTable({ inputCost: 0, outputCost: 0 }),
  ...over,
});

const group = (over: Partial<GroupRec> = {}): GroupRec => ({
  id: "g1",
  slug: "standard",
  name: "Standard",
  priceMultiplier: new Decimal(1),
  providerTags: [],
  allowedModels: null,
  isDefault: true,
  isPublic: true,
  rpmLimit: null,
  effortRoutes: [],
  maxConcurrency: null,
  priceBasis: "model",
  ...over,
});

function snapshot(providers: ProviderRec[], keys: KeyRec[], routes: RouteRec[]): ConfigSnapshot {
  const keysByProvider = new Map<string, KeyRec[]>();
  for (const k of keys) keysByProvider.set(k.providerId, [...(keysByProvider.get(k.providerId) ?? []), k]);
  return {
    loadedAt: Date.now(),
    settings: {} as ConfigSnapshot["settings"],
    providers: new Map(providers.map((p) => [p.id, p])),
    keysByProvider,
    modelsById: new Map([[model.id, model]]),
    modelsBySlug: new Map([[model.slug, model]]),
    modelsByAlias: new Map([[model.slug, model]]),
    routesByModel: new Map([[model.id, routes]]),
    groupsById: new Map(),
    groupsBySlug: new Map(),
    defaultGroup: null,
  };
}

/** Deterministic RNG */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("route eligibility + ordering", () => {
  it("filters by provider status, group provider tags, route groupSlugs and format support", () => {
    const pOpenAI = provider("pa", ["openai_chat"], { tags: ["official"] });
    const pAnth = provider("pb", ["anthropic_messages"], { tags: ["reseller"] });
    const pGem = provider("pc", ["gemini"]);
    const pOff = provider("pd", ["openai_chat"], { status: "DISABLED" });
    const routes = [route("r1", pOpenAI), route("r2", pAnth), route("r3", pGem), route("r4", pOff), route("r5", pOpenAI, { groupSlugs: ["enterprise"] })];
    const snap = snapshot([pOpenAI, pAnth, pGem, pOff], [], routes);

    const ids = (g: GroupRec | null, fmt: Parameters<typeof eligibleRoutes>[3]) => eligibleRoutes(snap, model, g, fmt).map((r) => r.route.id).sort();
    expect(ids(group(), "openai_chat")).toEqual(["r1", "r2"]); // r2 via chat->messages translation, r5 hidden by groupSlugs
    expect(ids(group({ slug: "enterprise" }), "openai_chat")).toEqual(["r1", "r2", "r5"]);
    expect(ids(group({ providerTags: ["official"] }), "openai_chat")).toEqual(["r1"]);
    expect(ids(group(), "anthropic_messages")).toEqual(["r1", "r2"]); // r1 via messages->chat
    expect(ids(group(), "gemini")).toEqual(["r3"]);
    expect(ids(group(), "openai_embeddings")).toEqual([]);
    expect(ids(null, "openai_chat")).toEqual(["r1", "r2"]);
  });

  it("orders by route priority desc, then native-before-translated, then provider priority, ties weighted-random", () => {
    const native = provider("n", ["openai_chat"], { priority: 0 });
    const translated = provider("t", ["anthropic_messages"], { priority: 99 });
    const hiPrio = provider("h", ["anthropic_messages"]);
    const rN = route("native", native);
    const rT = route("translated", translated);
    const rH = route("hi", hiPrio, { priority: 5 });
    const plans = eligibleRoutes(snapshot([native, translated, hiPrio], [], [rN, rT, rH]), model, group(), "openai_chat");
    expect(orderRoutes(plans, seeded()).map((p) => p.route.id)).toEqual(["hi", "native", "translated"]);
  });

  it("splits traffic between equal routes proportionally to weight", () => {
    const pa = provider("a", ["openai_chat"]);
    const pb = provider("b", ["openai_chat"]);
    const plans = eligibleRoutes(snapshot([pa, pb], [], [route("a", pa, { weight: 9 }), route("b", pb, { weight: 1 })]), model, group(), "openai_chat");
    const rand = seeded(42);
    let firstA = 0;
    for (let i = 0; i < 2000; i++) if (orderRoutes(plans, rand)[0].route.id === "a") firstA++;
    expect(firstA / 2000).toBeGreaterThan(0.85);
    expect(firstA / 2000).toBeLessThan(0.95);
  });
});

describe("upstream key ordering + health", () => {
  it("orders by key priority desc and only includes usable keys", () => {
    __resetCacheForTests();
    const now = Date.now();
    const keys = [
      key("low", "p", { priority: 0 }),
      key("high", "p", { priority: 10 }),
      key("mid", "p", { priority: 5 }),
      key("off", "p", { priority: 99, status: "DISABLED" }),
      key("bad", "p", { priority: 98, status: "INVALID" }),
      key("cool", "p", { priority: 97, status: "COOLDOWN", cooldownUntil: now + 60_000 }),
      key("recovered", "p", { priority: 1, status: "COOLDOWN", cooldownUntil: now - 1 }),
    ];
    expect(orderKeys(keys, now, seeded()).map((k) => k.id)).toEqual(["high", "mid", "recovered", "low"]);
  });

  it("weights keys of equal priority", () => {
    __resetCacheForTests();
    const keys = [key("a", "p", { weight: 1 }), key("b", "p", { weight: 3 })];
    const rand = seeded(7);
    let firstB = 0;
    for (let i = 0; i < 2000; i++) if (orderKeys(keys, Date.now(), rand)[0].id === "b") firstB++;
    expect(firstB / 2000).toBeGreaterThan(0.7);
    expect(firstB / 2000).toBeLessThan(0.8);
  });

  it("walks route-by-route: key1 -> key2 of the best route, then the next route", () => {
    __resetCacheForTests();
    const p1 = provider("p1", ["openai_chat"]);
    const p2 = provider("p2", ["openai_chat"]);
    const r1 = route("r1", p1, { priority: 10 });
    const r2 = route("r2", p2, { priority: 0 });
    const snap = snapshot([p1, p2], [key("k1a", "p1", { priority: 1 }), key("k1b", "p1", { priority: 0 }), key("k2a", "p2")], [r1, r2]);
    const plans = orderRoutes(eligibleRoutes(snap, model, group(), "openai_chat"), seeded());
    expect(buildCandidates(snap, plans, { rand: seeded() }).map((c) => `${c.route.id}:${c.key.id}`)).toEqual(["r1:k1a", "r1:k1b", "r2:k2a"]);
  });

  it("pushes keys that already failed in this request behind untried ones", () => {
    __resetCacheForTests();
    const p1 = provider("p1", ["openai_chat"]);
    const p2 = provider("p2", ["openai_chat"]);
    const snap = snapshot([p1, p2], [key("k1", "p1"), key("k2", "p2")], [route("r1", p1, { priority: 5 }), route("r2", p2)]);
    const plans = orderRoutes(eligibleRoutes(snap, model, group(), "openai_chat"), seeded());
    const failures = new Map([["k1", 1]]);
    expect(buildCandidates(snap, plans, { failures }).map((c) => c.key.id)).toEqual(["k2", "k1"]);
  });

  it("pins to a single upstream key (Responses stickiness)", () => {
    __resetCacheForTests();
    const p1 = provider("p1", ["openai_chat"]);
    const snap = snapshot([p1], [key("k1", "p1"), key("k2", "p1")], [route("r1", p1)]);
    const plans = eligibleRoutes(snap, model, group(), "openai_chat");
    expect(buildCandidates(snap, plans, { pinKeyId: "k2" }).map((c) => c.key.id)).toEqual(["k2"]);
  });

  const settings = { keyCooldownSeconds: 60, failuresBeforeCooldown: 3 };

  it("429 puts the key on cooldown for retry-after (or the default), then it becomes usable again", () => {
    __resetCacheForTests();
    const k = key("k429", "p");
    const now = Date.now();
    recordKeyFailure(k, "rate_limit", { status: 429, message: "slow", retryAfterSec: 7 }, settings, now);
    expect(effectiveKeyState(k).status).toBe("COOLDOWN");
    expect(isKeyUsable(k, now + 1000)).toBe(false);
    expect(isKeyUsable(k, now + 8000)).toBe(true);

    const k2 = key("k429b", "p");
    recordKeyFailure(k2, "rate_limit", { status: 429, message: "slow" }, settings, now);
    expect(isKeyUsable(k2, now + 59_000)).toBe(false);
    expect(isKeyUsable(k2, now + 61_000)).toBe(true);
  });

  it("5xx/timeouts only cool the key down after failuresBeforeCooldown consecutive failures; success resets", () => {
    __resetCacheForTests();
    const k = key("k5xx", "p");
    const now = Date.now();
    recordKeyFailure(k, "server", { status: 500, message: "boom" }, settings, now);
    recordKeyFailure(k, "timeout", { status: 0, message: "t" }, settings, now);
    expect(isKeyUsable(k, now)).toBe(true);
    expect(effectiveKeyState(k).consecutiveFailures).toBe(2);
    recordKeySuccess(k);
    expect(effectiveKeyState(k).consecutiveFailures).toBe(0);
    recordKeyFailure(k, "server", { status: 502, message: "a" }, settings, now);
    recordKeyFailure(k, "server", { status: 502, message: "b" }, settings, now);
    recordKeyFailure(k, "network", { status: 0, message: "c" }, settings, now);
    expect(isKeyUsable(k, now)).toBe(false);
    expect(isKeyUsable(k, now + 61_000)).toBe(true);
  });

  it("tells the different 403s apart: bad key, no credit, or just not allowed for this model / endpoint", () => {
    // real upstream texts
    expect(classifyStatus(401)).toBe("auth");
    expect(classifyStatus(403, "API key not valid. Please pass a valid API key.")).toBe("auth");
    expect(classifyStatus(403, "Your API key has been revoked")).toBe("auth");
    expect(classifyStatus(403, "Insufficient account balance")).toBe("payment");
    expect(classifyStatus(403, "You exceeded your current quota, please check your plan and billing details.")).toBe("payment");
    expect(classifyStatus(403, "This group does not allow /v1/messages dispatch")).toBe("forbidden");
    expect(classifyStatus(403, "Project `proj_x` does not have access to model `gpt-6-astra`")).toBe("forbidden");
    expect(classifyStatus(403, "")).toBe("forbidden");
    expect(classifyStatus(402)).toBe("payment");
    expect(classifyStatus(429)).toBe("rate_limit");
  });

  it("a 'forbidden' 403 never invalidates or cools down the key (other customers keep using it)", () => {
    __resetCacheForTests();
    const k = key("k403", "p");
    const now = Date.now();
    for (let i = 0; i < 5; i++) recordKeyFailure(k, "forbidden", { status: 403, message: "This group does not allow /v1/messages dispatch" }, settings, now);
    expect(isKeyUsable(k, now)).toBe(true);
    expect(effectiveKeyState(k)).toMatchObject({ status: "ACTIVE", consecutiveFailures: 0 });
    // a real bad-key 403 still invalidates after two in a row
    recordKeyFailure(k, classifyStatus(403, "API key not valid"), { status: 403, message: "API key not valid" }, settings, now);
    recordKeyFailure(k, classifyStatus(403, "API key not valid"), { status: 403, message: "API key not valid" }, settings, now);
    expect(effectiveKeyState(k).status).toBe("INVALID");
  });

  it("ignores transient failures of requests that started before the key last answered (connection bursts)", () => {
    __resetCacheForTests();
    const k = key("kburst", "p");
    const started = Date.now() - 1000;
    recordKeySuccess(k);
    for (let i = 0; i < 6; i++) recordKeyFailure(k, "network", { status: 0, message: "ECONNREFUSED", startedAt: started }, settings);
    expect(isKeyUsable(k)).toBe(true);
    expect(effectiveKeyState(k).consecutiveFailures).toBe(0);
    // failures of requests that began AFTER the last success still count
    for (let i = 0; i < 3; i++) recordKeyFailure(k, "network", { status: 0, message: "dead", startedAt: Date.now() + 10 }, settings);
    expect(isKeyUsable(k)).toBe(false);
  });

  it("marks a key INVALID after 2 consecutive 401/403 and a success in between resets the streak", () => {
    __resetCacheForTests();
    const k = key("kauth", "p");
    recordKeyFailure(k, "auth", { status: 401, message: "no" }, settings);
    expect(effectiveKeyState(k).status).toBe("ACTIVE");
    recordKeySuccess(k);
    recordKeyFailure(k, "auth", { status: 403, message: "no" }, settings);
    expect(effectiveKeyState(k).status).toBe("ACTIVE");
    recordKeyFailure(k, "auth", { status: 401, message: "no" }, settings);
    expect(effectiveKeyState(k).status).toBe("INVALID");
    expect(isKeyUsable(k)).toBe(false);
  });

  it("402 (upstream out of credit) cools the key down for a long time", () => {
    __resetCacheForTests();
    const k = key("k402", "p");
    const now = Date.now();
    recordKeyFailure(k, "payment", { status: 402, message: "quota" }, settings, now);
    expect(isKeyUsable(k, now + 5 * 60_000)).toBe(false);
    expect(isKeyUsable(k, now + 11 * 60_000)).toBe(true);
  });

  it("runtime overlay overrides the loaded status", () => {
    __resetCacheForTests();
    const k = key("kov", "p");
    setKeyRuntime("kov", { status: "DISABLED" });
    expect(isKeyUsable(k)).toBe(false);
  });
});
