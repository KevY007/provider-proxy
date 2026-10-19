/**
 * Durable metering (QA finding #1): poison rows are isolated, dead-lettered to a JSONL file (and logged), their balance
 * debit still happens, and the file is replayed exactly once. Real database; skipped when it is unreachable.
 */
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createId } from "@paralleldrive/cuid2";
import { dbOk } from "./harness";
import { deadLetterPath, enqueueMeter, flushAll, flushMeter, isProgrammingError, replayDeadLetters, type MeterEntry, __resetMeterForTests } from "@/gateway/meter-writer";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { sha256 } from "@/lib/crypto";

const dir = mkdtempSync(path.join(tmpdir(), "pp-meter-"));
process.env.METER_DEADLETTER_DIR = dir;
const sfx = Math.random().toString(36).slice(2, 8);

let userId = "";
let keyId = "";
const logIds: string[] = [];

function entry(price: string, over: Partial<MeterEntry> = {}, logOver: Record<string, unknown> = {}): MeterEntry {
  const id = createId();
  logIds.push(id);
  const log = { id, userId, apiKeyId: keyId, endpoint: "/v1/chat/completions", inboundFormat: "openai_chat", status: "SUCCESS", httpStatus: 200, price, cost: "0", profit: price, officialPrice: price, createdAt: new Date(), ...logOver } as unknown as Prisma.RequestLogCreateManyInput;
  return { log, userId, apiKeyId: keyId, providerKeyId: null, price: new Decimal(price), cost: new Decimal(0), countForKey: false, keyHealthy: false, createdAt: new Date(), ...over };
}

const balance = async () => new Decimal((await db.user.findUniqueOrThrow({ where: { id: userId } })).balance.toString());
const deadLines = () => (existsSync(deadLetterPath()) ? readFileSync(deadLetterPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe.skipIf(!dbOk)("durable metering", () => {
  beforeAll(async () => {
    const u = await db.user.create({ data: { email: `meter-${sfx}@test.local`, passwordHash: "x", status: "ACTIVE", emailVerifiedAt: new Date(), balance: "10" } });
    userId = u.id;
    const k = await db.apiKey.create({ data: { userId, name: `meter-${sfx}`, prefix: "sk-pp-meter0", keyHash: sha256(`meter-${sfx}`) } });
    keyId = k.id;
  });

  beforeEach(async () => {
    __resetMeterForTests();
    rmSync(deadLetterPath(), { force: true });
    await db.user.update({ where: { id: userId }, data: { balance: "10" } });
  });

  afterAll(async () => {
    await db.requestLog.deleteMany({ where: { OR: [{ id: { in: logIds } }, { userId }] } }).catch(() => undefined);
    await db.apiKey.deleteMany({ where: { id: keyId } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("classifies Prisma validation errors as non-retryable programming errors", () => {
    expect(isProgrammingError(new Error("Invalid `prisma.requestLog.createManyAndReturn()` invocation: Unknown argument `bogus`"))).toBe(true);
    expect(isProgrammingError(new Error("Unknown field `x` for select statement"))).toBe(true);
    expect(isProgrammingError(new Error("Can't reach database server at localhost:5433"))).toBe(false);
    expect(isProgrammingError(new Error("connection terminated unexpectedly"))).toBe(false);
  });

  it("a poison row is isolated: the good rows are written, the poison one is dead-lettered and still debited", async () => {
    const good1 = entry("0.5");
    const poison = entry("1.25", {}, { bogusColumn: "x" });
    const good2 = entry("0.25");
    const t0 = Date.now();
    for (const e of [good1, poison, good2]) enqueueMeter(e);
    await flushMeter();
    expect(Date.now() - t0).toBeLessThan(4000); // no retry loop for a validation error

    expect(await db.requestLog.count({ where: { id: { in: [good1.log.id as string, good2.log.id as string] } } })).toBe(2);
    expect(await db.requestLog.count({ where: { id: poison.log.id as string } })).toBe(0);
    expect((await balance()).toString()).toBe("8"); // 10 - 0.5 - 1.25 - 0.25: the poison row's price was debited by the fallback
    const k = await db.apiKey.findUniqueOrThrow({ where: { id: keyId } });
    expect(k.spent.toString()).toBe("2");

    const lines = deadLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ debited: true, entry: { price: expect.stringMatching(/^1\.25/), userId } });
    expect(lines[0].entry.log.id).toBe(poison.log.id);
    expect(lines[0].reason).toMatch(/Unknown argument|bogusColumn/i);
  });

  it("replays the dead letter once the row is valid: inserted without a second debit; replaying again is a no-op", async () => {
    const poison = entry("1.25", {}, { bogusColumn: "x" });
    enqueueMeter(poison);
    await flushMeter();
    expect((await balance()).toString()).toBe("8.75");

    // "deploy the fix": the stored row loses its bogus column
    const rec = deadLines()[0];
    delete rec.entry.log.bogusColumn;
    writeFileSync(deadLetterPath(), JSON.stringify(rec) + "\n");

    const r1 = await replayDeadLetters();
    expect(r1).toMatchObject({ found: 1, replayed: 1, failed: 0 });
    expect(await db.requestLog.count({ where: { id: poison.log.id as string } })).toBe(1);
    expect((await balance()).toString()).toBe("8.75"); // not debited twice
    expect(existsSync(deadLetterPath())).toBe(false);
    expect(await replayDeadLetters()).toMatchObject({ found: 0, replayed: 0 });

    // the same record replayed again (e.g. two instances) does not double-apply either
    writeFileSync(deadLetterPath(), JSON.stringify(rec) + "\n");
    expect(await replayDeadLetters()).toMatchObject({ found: 1, replayed: 1 });
    expect((await balance()).toString()).toBe("8.75");
    expect(await db.requestLog.count({ where: { id: poison.log.id as string } })).toBe(1);
  });

  it("a row that still fails stays in the file for the next replay", async () => {
    const poison = entry("0.1", {}, { bogusColumn: "x" });
    enqueueMeter(poison);
    await flushMeter();
    const r = await replayDeadLetters(); // still invalid
    expect(r).toMatchObject({ found: 1, replayed: 0, failed: 1 });
    const lines = deadLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].replayAttempts).toBe(1);
    expect((await balance()).toString()).toBe("9.9");
  });

  it("shutdown spills what could not be written to the dead letter; replay applies it exactly once", async () => {
    const a = entry("0.4");
    const b = entry("0.6");
    enqueueMeter(a);
    enqueueMeter(b);
    await flushAll(0); // no time left: everything buffered is spilled
    const lines = deadLines();
    expect(lines.map((l) => l.entry.log.id).sort()).toEqual([a.log.id, b.log.id].sort());
    expect(lines.every((l) => l.debited === false)).toBe(true);
    expect((await balance()).toString()).toBe("10"); // nothing applied yet

    const r = await replayDeadLetters();
    expect(r).toMatchObject({ found: 2, replayed: 2, failed: 0 });
    expect((await balance()).toString()).toBe("9"); // 10 - 0.4 - 0.6
    expect(await db.requestLog.count({ where: { id: { in: [a.log.id as string, b.log.id as string] } } })).toBe(2);
    expect(existsSync(deadLetterPath())).toBe(false);
  });

  it("after N failed batch attempts with a reachable database every row is written on its own (nothing dead-lettered)", async () => {
    process.env.METER_BATCH_FAIL_LIMIT = "2";
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    let calls = 0;
    const spy = vi.spyOn(db, "$transaction").mockImplementation(((...args: unknown[]) => {
      calls++;
      if (calls <= 2) return Promise.reject(new Error("simulated transient failure of the whole batch"));
      return real(...args);
    }) as never);
    try {
      const rows = [entry("0.1"), entry("0.2"), entry("0.3")];
      for (const e of rows) enqueueMeter(e);
      await flushMeter();
      expect(calls).toBeGreaterThan(2);
      expect(await db.requestLog.count({ where: { id: { in: rows.map((r) => r.log.id as string) } } })).toBe(3);
      expect((await balance()).toString()).toBe("9.4");
      expect(deadLines()).toHaveLength(0);
    } finally {
      spy.mockRestore();
      delete process.env.METER_BATCH_FAIL_LIMIT;
    }
  });

  it("an already inserted row is skipped on replay (no double debit)", async () => {
    const e = entry("0.3");
    enqueueMeter(e);
    await flushMeter();
    expect((await balance()).toString()).toBe("9.7");
    // pretend the same entry was also spilled by another instance
    writeFileSync(
      deadLetterPath(),
      JSON.stringify({ v: 1, at: new Date().toISOString(), reason: "test", debited: false, replayAttempts: 0, entry: { log: JSON.parse(JSON.stringify(e.log)), userId, apiKeyId: keyId, providerKeyId: null, price: "0.3", cost: "0", countForKey: false, keyHealthy: false, createdAt: new Date().toISOString() } }) + "\n",
    );
    expect(await replayDeadLetters()).toMatchObject({ found: 1, replayed: 1 });
    expect((await balance()).toString()).toBe("9.7");
  });
});
