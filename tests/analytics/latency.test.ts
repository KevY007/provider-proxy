/**
 * Latency comes from real calls only: summary / breakdown / history over RequestLog, passive provider health from
 * traffic, and the health cron makes no upstream request unless "Active health probes" is enabled.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, dbOk } from "../gateway/harness";
import { db } from "@/lib/db";
import { getLatencyBreakdown, getLatencyHistory, getLatencySummary } from "@/server/analytics/latency";
import { refreshPassiveHealth } from "@/gateway/health";
import { setSetting } from "@/lib/settings";
import { getUptime, levelOf } from "@/server/admin/uptime-queries";

vi.mock("server-only", () => ({}));

const h = createHarness("lat");

describe.skipIf(!dbOk)("latency from real traffic", () => {
  let user = { id: "", key: "" };
  let other = { id: "", key: "" };
  let providerId = "";
  let keyId = "";
  let slug = "";
  const from = new Date(Date.now() - 60_000);

  beforeAll(async () => {
    await h.start();
    const u = await h.makeUser("u", { balance: "50" });
    const o = await h.makeUser("o", { balance: "50" });
    user = { id: u.id, key: (await h.makeKey("u", u.id)).key };
    other = { id: o.id, key: (await h.makeKey("o", o.id)).key };
    const p = await h.makeProvider("p", { formats: ["openai_chat"], keys: [{ s: "k1" }] });
    providerId = p.id;
    keyId = p.keys[0];
    slug = (await h.makeModel("m", { caps: ["chat"], providerId, upstream: "gpt-mock" })).slug;
    await db.provider.update({ where: { id: providerId }, data: { healthStatus: "UNKNOWN" } });
    for (const [k, stream] of [[user.key, false], [user.key, true], [user.key, false], [other.key, false]] as const) {
      const res = await h.call("/v1/chat/completions", k, { model: slug, stream, messages: [{ role: "user", content: "hi" }] });
      await res.text();
      expect(res.status).toBe(200);
      await h.logOf(res);
    }
  }, 60_000);
  afterAll(() => h.cleanup(), 60_000);

  it("summary + percentiles over successful calls; first-token only from streams", async () => {
    const s = await getLatencySummary({ from, to: new Date(), providerId });
    expect(s.calls).toBe(4);
    expect(s.p50Ms).toBeGreaterThan(0);
    expect(s.p95Ms).toBeGreaterThanOrEqual(s.p50Ms!);
    expect(s.ttftP50Ms).not.toBeNull();
    expect(s.lastAt).not.toBeNull();
  });

  it("customer scope: only their own calls", async () => {
    const mine = await getLatencySummary({ from, to: new Date(), userId: user.id });
    expect(mine.calls).toBe(3);
    const rows = await getLatencyBreakdown("model", { from, to: new Date(), userId: other.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: slug, calls: 1 });
  });

  it("breakdown per provider / key carries the last call; history buckets", async () => {
    const byKey = await getLatencyBreakdown("providerKey", { from, to: new Date(), providerId });
    expect(byKey.map((r) => r.key)).toEqual([keyId]);
    expect(byKey[0].lastMs).toBeGreaterThan(0);
    expect(byKey[0].label).toContain(" / ");
    const hist = await getLatencyHistory({ from: new Date(Date.now() - 3 * 3_600_000), to: new Date(), providerId }, "hour");
    expect(hist.reduce((a, p) => a + p.calls, 0)).toBe(4);
    expect(hist.some((p) => p.calls === 0 && p.p50Ms === null)).toBe(true); // empty buckets are "no calls", not 0 ms
  });

  it("passive health: status + latency from the calls, without asking the upstream", async () => {
    const before = ((await (await fetch(`${h.base}/__mock/stats`)).json()) as { total?: number; byPath: Record<string, number> }).byPath;
    await refreshPassiveHealth();
    const p = await db.provider.findUniqueOrThrow({ where: { id: providerId } });
    expect(p.healthStatus).toBe("OPERATIONAL");
    expect(p.lastLatencyMs).toBeGreaterThan(0);
    const after = ((await (await fetch(`${h.base}/__mock/stats`)).json()) as { byPath: Record<string, number> }).byPath;
    expect(after).toEqual(before);
  });

  it("health cron: no probes while Active health probes is off", async () => {
    const { env } = await import("@/lib/env");
    if (!env.CRON_SECRET) return; // CI and .env both set it
    const { GET } = await import("@/app/api/cron/health/route");
    await setSetting("activeHealthChecks", false);
    const checks = await db.healthCheck.count({ where: { providerId } });
    const res = await GET(new Request("http://x/api/cron/health", { headers: { authorization: `Bearer ${env.CRON_SECRET}` } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checked: number; skipped?: string };
    expect(body.checked).toBe(0);
    expect(body.skipped).toMatch(/off/);
    expect(await db.healthCheck.count({ where: { providerId } })).toBe(checks);
  });

  it("uptime history: calls and pings fill buckets; idle periods are 'no data', never 'up'", async () => {
    await refreshPassiveHealth();
    await db.healthCheck.create({ data: { providerId, providerKeyId: keyId, ok: false, latencyMs: 40, error: "timeout", source: "probe" } });
    await db.healthCheck.create({ data: { providerId, providerKeyId: keyId, ok: true, latencyMs: 120, source: "probe" } });
    const u = await getUptime("24h");
    const p = u.providers.find((x) => x.id === providerId)!;
    expect(p.buckets).toHaveLength(48);
    const filled = p.buckets.filter((b) => b.level !== "nodata");
    expect(filled.length).toBeGreaterThanOrEqual(1);
    const last = filled[filled.length - 1];
    expect(last.calls).toBe(4);
    expect(last.pings).toBe(2);
    expect(last.failedPings).toBe(1);
    expect(last.pingMs).toBe(120); // average of successful pings
    expect(last.pct).toBeCloseTo((5 / 6) * 100, 6);
    expect(last.level).toBe("down"); // < 90%
    expect(p.buckets[0].level).toBe("nodata");
    expect(p.lastPingMs).toBe(120);
    // traffic samples are recorded for history but not double counted as pings
    expect(await db.healthCheck.count({ where: { providerId, source: "traffic" } })).toBeGreaterThanOrEqual(1);
    expect([levelOf(null), levelOf(99.5), levelOf(95), levelOf(50)]).toEqual(["nodata", "up", "degraded", "down"]);
  });
});
