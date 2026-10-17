/**
 * In-process load/soak check of the gateway core. Opt-in (it hammers the dev database):
 *   GW_LOAD=1 [GW_LOAD_N=1000] pnpm vitest run tests/gateway/load.test.ts
 * Proves: no upstream key ever exceeds its slot limit under 1000 concurrent streams, excess requests queue and
 * complete, every request is metered exactly once, and the balance debit equals the sum of the logged prices.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockUpstream } from "../../scripts/mock-upstream";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { handle } from "@/gateway/handle";
import { flushMeter, pendingMeterCount } from "@/gateway/meter-writer";
import { slotInUse } from "@/gateway/slots";
import { encrypt, sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";

const N = Number(process.env.GW_LOAD_N ?? 1000);
const sfx = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const key = `sk-pp-gwl${sfx}`.padEnd(46, "0");

describe.skipIf(!process.env.GW_LOAD)("gateway load", () => {
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let base = "";
  const created = { user: "", provider: "", model: "", group: "", keys: [] as string[] };

  beforeAll(async () => {
    mock = await startMockUpstream(0, "127.0.0.1");
    base = `http://127.0.0.1:${mock.port}`;
    const g = await db.group.create({ data: { name: `gwl-${sfx}`, slug: `gwl-${sfx}`, priceMultiplier: "1" } });
    created.group = g.id;
    const u = await db.user.create({ data: { email: `gwl-${sfx}@test.local`, passwordHash: "x", status: "ACTIVE", emailVerifiedAt: new Date(), balance: "1000", groupId: g.id, maxConcurrency: 100_000 } });
    created.user = u.id;
    await db.apiKey.create({ data: { userId: u.id, name: "load", prefix: key.slice(0, 12), keyHash: sha256(key) } });
    const p = await db.provider.create({ data: { name: `gwl-${sfx}`, slug: `gwl-${sfx}`, preset: "custom", baseUrl: `${base}/v1`, formats: ["openai_chat"], tags: ["mock"], timeoutMs: 120_000 } });
    created.provider = p.id;
    for (let i = 1; i <= 3; i++) {
      const k = await db.providerKey.create({ data: { providerId: p.id, label: `k${i}`, secretEncrypted: encrypt(`gwl-key-${i}-${sfx}`), secretHint: "load", maxConcurrency: 100 } });
      created.keys.push(k.id);
    }
    const m = await db.model.create({ data: { slug: `gwl-${sfx}`, displayName: "load", vendor: "gwl", capabilities: ["chat"], inputPrice: "1", outputPrice: "2" } });
    created.model = m.id;
    await db.modelRoute.create({ data: { modelId: m.id, providerId: p.id, upstreamModel: "up", inputCost: "0.5", outputCost: "1" } });
    await invalidateGatewayConfig("all");
  }, 60_000);

  afterAll(async () => {
    await flushMeter();
    await db.requestLog.deleteMany({ where: { userId: created.user } }).catch(() => undefined);
    await db.apiKey.deleteMany({ where: { userId: created.user } }).catch(() => undefined);
    await db.modelRoute.deleteMany({ where: { modelId: created.model } }).catch(() => undefined);
    await db.model.deleteMany({ where: { id: created.model } }).catch(() => undefined);
    await db.provider.deleteMany({ where: { id: created.provider } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: created.user } }).catch(() => undefined);
    await db.group.deleteMany({ where: { id: created.group } }).catch(() => undefined);
    await invalidateGatewayConfig("all");
    await mock?.close();
  }, 60_000);

  it(`${N} concurrent streams over 3 keys x 100 slots`, async () => {
    const t0 = Date.now();
    const ids: string[] = [];
    const rss0 = process.memoryUsage().rss;
    const results = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const res = await handle(
          new Request("http://gateway.test/v1/chat/completions", {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-mock-delay-ms": "25" },
            body: JSON.stringify({ model: `gwl-${sfx}`, stream: true, messages: [{ role: "user", content: `req ${i} [[usage:in=100,out=50]]` }] }),
          }),
        );
        ids.push(res.headers.get("x-request-id")!);
        const text = await res.text();
        return { status: res.status, done: text.includes("[DONE]"), body: res.status === 200 ? "" : text.slice(0, 300) };
      }),
    );
    const elapsed = Date.now() - t0;
    const bad = results.filter((r) => r.status !== 200 || !r.done);
    if (bad.length) {
      console.log("FAILED", bad.length, JSON.stringify(bad.slice(0, 1)));
      await new Promise((r) => setTimeout(r, 500));
      await flushMeter();
      const errs = await db.requestLog.groupBy({ by: ["internalError"], where: { userId: created.user, status: { not: "SUCCESS" } }, _count: true });
      console.log("INTERNAL", JSON.stringify(errs.map((e) => [String(e.internalError).slice(0, 300), e._count])));
    }
    expect(bad.length).toBe(0);

    // slot limits were never exceeded, and queueing really happened (N > 300 slots)
    const stats = (await (await fetch(`${base}/__mock/stats`)).json()) as { maxInflight: number; byKey: Record<string, { total: number; maxInflight: number }> };
    for (const k of Object.values(stats.byKey)) expect(k.maxInflight).toBeLessThanOrEqual(100);
    expect(stats.maxInflight).toBeLessThanOrEqual(300);
    if (N > 300) expect(stats.maxInflight).toBeGreaterThan(250);

    // every request metered exactly once; balance debit == sum of logged prices
    for (let i = 0; i < 100 && pendingMeterCount() > 0; i++) await flushMeter();
    await new Promise((r) => setTimeout(r, 300));
    await flushMeter();
    const logs = await db.requestLog.findMany({ where: { userId: created.user }, select: { id: true, price: true, status: true, queueMs: true } });
    expect(logs.length).toBe(N);
    expect(new Set(logs.map((l) => l.id)).size).toBe(N);
    expect(logs.every((l) => l.status === "SUCCESS")).toBe(true);
    const sum = logs.reduce((a, l) => a.plus(l.price.toString()), new Decimal(0));
    const u = await db.user.findUniqueOrThrow({ where: { id: created.user } });
    expect(new Decimal(1000).minus(u.balance.toString()).equals(sum)).toBe(true);
    const total = Object.values(stats.byKey).reduce((a, k) => a + k.total, 0);
    expect(total).toBe(N);

    for (const id of created.keys) expect(await slotInUse("pkey", id)).toBe(0);
    expect(await slotInUse("user", created.user)).toBe(0);

    const queued = logs.filter((l) => l.queueMs > 0).length;
    const summary = { n: N, elapsedMs: elapsed, rps: Math.round((N / elapsed) * 1000), queuedRequests: queued, maxQueueMs: Math.max(...logs.map((l) => l.queueMs)), mockMaxInflight: stats.maxInflight, rssDeltaMB: Math.round((process.memoryUsage().rss - rss0) / 1048576) };
    process.stdout.write(`LOADRESULT ${JSON.stringify(summary)}\n`);
  }, 180_000);
});
