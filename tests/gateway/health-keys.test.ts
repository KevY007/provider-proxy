/**
 * Admin "Test key" (QA finding #2): 401/403 -> INVALID, 429 -> COOLDOWN with retry-after, success revives.
 * Real database + mock upstream (fault keys: "bad" -> 401, "fail429" -> 429 + retry-after, "fail500"); skipped when
 * the database is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbOk, createHarness } from "./harness";
import { checkProviderKey, judgeProbe } from "@/gateway/health";
import { db } from "@/lib/db";

describe("judgeProbe", () => {
  const r = (status: number, text = "", retryAfterSec?: number) => ({ status, text, retryAfterSec });
  it("maps statuses to verdicts", () => {
    expect(judgeProbe("openai", r(401), 60)).toEqual({ kind: "invalid" });
    expect(judgeProbe("openai", r(403, "forbidden"), 60)).toEqual({ kind: "invalid" });
    expect(judgeProbe("openai", r(429, "", 7), 60)).toMatchObject({ kind: "cooldown", seconds: 7 });
    expect(judgeProbe("openai", r(429), 60)).toMatchObject({ kind: "cooldown", seconds: 60 });
    expect(judgeProbe("openai", r(429, "", 99999), 60)).toMatchObject({ kind: "cooldown", seconds: 3600 });
    expect(judgeProbe("anthropic", r(402), 60)).toMatchObject({ kind: "cooldown", seconds: 600 });
    expect(judgeProbe("fal", r(403, "User is locked. Reason: Exhausted balance"), 60)).toMatchObject({ kind: "cooldown", seconds: 600 });
    expect(judgeProbe("fal", r(403, "forbidden"), 60)).toEqual({ kind: "invalid" });
    expect(judgeProbe("openai", r(500), 60)).toEqual({ kind: "none" });
    expect(judgeProbe("openai", r(0, "timeout"), 60)).toEqual({ kind: "none" });
  });
});

const h = createHarness("hk");

describe.skipIf(!dbOk)("checkProviderKey updates the key state", () => {
  let p: { id: string; keys: string[] };
  let noRoute: { id: string; keys: string[] };
  const key = (id: string) => db.providerKey.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await h.start();
    p = await h.makeProvider("p", { formats: ["openai_chat"], keys: [{ s: "good1" }, { s: "badkey" }, { s: "fail429x" }, { s: "fail500y" }, { s: "badoff" }] });
    noRoute = await h.makeProvider("nr", { formats: ["openai_chat"], keys: [{ s: "badnr" }] });
    await h.makeModel("m", { caps: ["chat"], providerId: p.id });
    await db.providerKey.update({ where: { id: p.keys[4] }, data: { status: "DISABLED" } });
  }, 60_000);

  afterAll(async () => {
    await h.cleanup();
  }, 30_000);

  it("401 -> INVALID (confirmed with a 1-token completion when the provider has a route)", async () => {
    const r = await checkProviderKey(p.keys[1]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/401/);
    const k = await key(p.keys[1]);
    expect(k.status).toBe("INVALID");
    expect(k.lastError).toMatch(/health: 401/);
  });

  it("401 -> INVALID also without any route", async () => {
    await checkProviderKey(noRoute.keys[0]);
    expect((await key(noRoute.keys[0])).status).toBe("INVALID");
  });

  it("429 -> COOLDOWN until the retry-after time", async () => {
    const t0 = Date.now();
    const r = await checkProviderKey(p.keys[2]);
    expect(r.ok).toBe(false);
    const k = await key(p.keys[2]);
    expect(k.status).toBe("COOLDOWN");
    const until = k.cooldownUntil!.getTime();
    expect(until).toBeGreaterThan(t0 + 1000); // the mock answers retry-after: 2
    expect(until).toBeLessThan(t0 + 10_000);
  });

  it("a 5xx / network problem records the error but does not change the key state", async () => {
    await checkProviderKey(p.keys[3]);
    const k = await key(p.keys[3]);
    expect(k.status).toBe("ACTIVE");
    expect(k.lastError).toMatch(/health: 500/);
  });

  it("a DISABLED key stays DISABLED", async () => {
    await checkProviderKey(p.keys[4]);
    expect((await key(p.keys[4])).status).toBe("DISABLED");
  });

  it("success revives an INVALID / cooled-down key", async () => {
    await db.providerKey.update({ where: { id: p.keys[0] }, data: { status: "INVALID", consecutiveFailures: 3 } });
    const r = await checkProviderKey(p.keys[0]);
    expect(r.ok).toBe(true);
    const k = await key(p.keys[0]);
    expect(k.status).toBe("ACTIVE");
    expect(k.consecutiveFailures).toBe(0);
  });
});
