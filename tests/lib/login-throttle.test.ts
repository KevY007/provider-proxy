/** Brute-force protection on login: growing delays on wrong passwords, tighter attempt limits. Needs the database. */
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { __setLoginSleepForTests, failedLoginDelayMs, loginUser } from "@/lib/auth/service";

const dbOk = await db.$queryRaw`SELECT 1`.then(
  () => true,
  () => false,
);
const sfx = Math.random().toString(36).slice(2, 8);
const waits: number[] = [];
__setLoginSleepForTests(async (ms) => {
  waits.push(ms);
});

describe("failedLoginDelayMs", () => {
  it("doubles from 0.25 s and caps at 10 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 50].map(failedLoginDelayMs)).toEqual([0, 250, 500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
  });
});

describe.skipIf(!dbOk)("loginUser brute-force protection", () => {
  const email = `throttle-${sfx}@example.com`;
  afterAll(async () => {
    await db.user.deleteMany({ where: { email } });
  });

  it("every wrong password waits longer than the one before; the pair limit stops guessing after 5", async () => {
    await db.user.create({ data: { email, passwordHash: await hashPassword("right-password-1"), status: "ACTIVE", emailVerifiedAt: new Date() } });
    waits.length = 0;
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await loginUser({ email, password: `wrong-${i}`, ip: `10.9.${sfx.length}.1`, userAgent: null });
      outcomes.push(r.kind === "error" ? r.code : r.kind);
    }
    expect(outcomes).toEqual(["invalid", "invalid", "invalid", "invalid", "invalid", "rate_limited"]);
    // jitter is under 100 ms; the base delay doubles each time
    const base = waits.map((w) => Math.round(w / 250) * 250);
    expect(base).toEqual([250, 500, 1000, 2000, 4000]);
  });

  it("unknown accounts are slowed down the same way (no hint that the email does not exist)", async () => {
    waits.length = 0;
    const ip = `10.8.0.${Math.floor(Math.random() * 200)}`;
    for (let i = 0; i < 3; i++) await loginUser({ email: `nobody-${sfx}@example.com`, password: "x", ip, userAgent: null });
    expect(waits.map((w) => Math.round(w / 250) * 250)).toEqual([250, 500, 1000]);
  });
});
