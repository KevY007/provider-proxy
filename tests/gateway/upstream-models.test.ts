/**
 * listUpstreamModels: live /models list of a provider's first healthy key + known prices + already-routed flag.
 * Real database + mock upstream; skipped when the database is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbOk, createHarness } from "./harness";
import { __resetUpstreamModelsCacheForTests, listUpstreamModels } from "@/gateway/upstream-models";
import { db } from "@/lib/db";

const h = createHarness("ulm");
const P: Record<string, { id: string; keys: string[] }> = {};

describe.skipIf(!dbOk)("listUpstreamModels", () => {
  beforeAll(async () => {
    await h.start();
    P.oa = await h.makeProvider("oa", { formats: ["openai_chat"], keys: [{ s: "k1", priority: 1 }, { s: "k2", priority: 5 }] });
    P.google = await h.makeProvider("google", { preset: "google", formats: ["gemini"], baseUrl: h.base, authStyle: "BEARER", keys: [{ s: "g1" }] });
    P.nokey = await h.makeProvider("nokey", { formats: ["openai_chat"], keys: [] });
    P.dead = await h.makeProvider("dead", { formats: ["openai_chat"], keys: [{ s: "dead1" }] });
    await db.providerKey.updateMany({ where: { providerId: P.dead.id }, data: { status: "INVALID" } });
    P.fal = await h.makeProvider("fal", { preset: "fal", formats: ["openai_images"], baseUrl: `${h.base}/fal`, keys: [{ s: "f1" }] });
    P.bad = await h.makeProvider("bad", { formats: ["openai_chat"], keys: [{ s: "badkey" }] });
  }, 60_000);

  afterAll(async () => {
    await h.cleanup();
  }, 30_000);

  it("lists the provider's models, with the announced shutdown date", async () => {
    const list = await listUpstreamModels(P.oa.id);
    expect(list.map((m) => m.id)).toEqual(expect.arrayContaining(["gpt-mock", "claude-mock", "embed-mock", "image-mock", "sunset-mock"]));
    expect(list.find((m) => m.id === "sunset-mock")?.shutdownDate).toBe("2026-12-31");
    expect(list.find((m) => m.id === "gpt-mock")?.shutdownDate).toBeNull();
    expect(list.find((m) => m.id === "gpt-mock")).toMatchObject({ ownedBy: "mock", known: null, alreadyRouted: false });
  });

  it("uses the best healthy key (highest priority) and caches the list for 5 minutes", async () => {
    __resetUpstreamModelsCacheForTests();
    await fetch(`${h.base}/__mock/reset`);
    await listUpstreamModels(P.oa.id);
    const stats1 = (await (await fetch(`${h.base}/__mock/stats`)).json()) as { byKey: Record<string, { total: number }>; byPath: Record<string, number> };
    await listUpstreamModels(P.oa.id);
    await listUpstreamModels(P.oa.id);
    const stats = (await (await fetch(`${h.base}/__mock/stats`)).json()) as { byKey: Record<string, { total: number }>; byPath: Record<string, number> };
    expect(stats.byPath["/v1/models"]).toBe(1); // the list is fetched once, with the priority-5 key (+ the provider's price list endpoints)
    expect(stats.byKey[h.secret("k2")]?.total).toBe(stats1.byKey[h.secret("k2")]?.total); // cached: no more upstream calls
    expect(stats.byKey[h.secret("k2")]?.total).toBeGreaterThanOrEqual(1);
    expect(stats.byKey[h.secret("k1")]?.total ?? 0).toBe(0);
  });

  it("flags models that already have a route and attaches known prices", async () => {
    await h.makeModel("routed", { caps: ["chat"], providerId: P.oa.id, upstream: "gpt-mock" });
    __resetUpstreamModelsCacheForTests();
    const list = await listUpstreamModels(P.oa.id);
    expect(list.find((m) => m.id === "gpt-mock")?.alreadyRouted).toBe(true);
    expect(list.find((m) => m.id === "claude-mock")?.alreadyRouted).toBe(false);
  });

  it("fal / Replicate have no cheap list: the catalog entries of that vendor are returned (with known prices)", async () => {
    const list = await listUpstreamModels(P.fal.id);
    const flux = list.find((m) => m.id === "fal-ai/flux/schnell");
    expect(flux?.known?.official).toEqual({ image: 0.003 });
    expect(list.every((m) => m.known?.vendor === "fal")).toBe(true);
    expect(list.length).toBeGreaterThan(4);
  });

  it("Google: lists /v1beta/models", async () => {
    const list = await listUpstreamModels(P.google.id);
    expect(list.map((m) => m.id)).toEqual(expect.arrayContaining(["gpt-mock", "claude-mock"]));
    expect(list.every((m) => !m.id.startsWith("models/"))).toBe(true);
  });

  it("explains instead of leaking when there is no usable key / the key is rejected", async () => {
    await expect(listUpstreamModels(P.nokey.id)).rejects.toThrow(/no usable key/i);
    await expect(listUpstreamModels(P.dead.id)).rejects.toThrow(/no usable key/i); // INVALID keys are not "healthy"
    await expect(listUpstreamModels(P.bad.id)).rejects.toThrow(/rejected the key \(HTTP 401\)/);
    await expect(listUpstreamModels("does-not-exist")).rejects.toThrow(/not found/i);
    for (const id of [P.nokey.id, P.dead.id, P.bad.id]) {
      try {
        await listUpstreamModels(id);
      } catch (e) {
        const msg = String((e as Error).message);
        expect(msg).not.toContain(h.base);
        expect(msg).not.toContain(h.secret("badkey"));
      }
    }
  });

  it("never returns secrets", async () => {
    const text = JSON.stringify(await listUpstreamModels(P.oa.id));
    expect(text).not.toContain(h.secret("k1"));
    expect(text).not.toContain(h.secret("k2"));
    expect(text).not.toContain(h.base);
  });
});
