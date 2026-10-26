/**
 * Cold by default: background jobs run only on activity (throttled) unless an admin turns timers on; uptime pings only
 * with uptime monitoring on, never because of traffic; a job runs once per interval across instances.
 */
import { afterAll, describe, expect, it } from "vitest";
import { dbOk } from "../gateway/harness";
import { db } from "@/lib/db";
import { ACTIVITY_UPKEEP_MS, BILLING_MS, __claimJobForTests, __resetMaintenanceForTests, __timerArmedForTests, armTimers, jobInterval, runDueJobs } from "@/server/maintenance";

const OFF = { activeHealthChecks: false, healthCheckIntervalMin: 5, backgroundJobs: false, maintenanceIntervalMin: 5 };
const ON = { activeHealthChecks: true, healthCheckIntervalMin: 7, backgroundJobs: true, maintenanceIntervalMin: 3 };

describe("job intervals per trigger", () => {
  it("defaults (everything off): activity drives upkeep (5 min) and billing (1 h); no timer work, never pings", () => {
    expect(jobInterval("upkeep", "traffic", OFF)).toBe(ACTIVITY_UPKEEP_MS);
    expect(jobInterval("billing", "admin", OFF)).toBe(BILLING_MS);
    expect(jobInterval("upkeep", "timer", OFF)).toBeNull();
    expect(jobInterval("probes", "traffic", OFF)).toBeNull();
    expect(jobInterval("probes", "timer", OFF)).toBeNull();
    expect(jobInterval("probes", "cron", OFF)).toBeNull(); // even Cloud Scheduler cannot ping while monitoring is off
  });

  it("switches on: timers use the admin intervals; pings still never come from traffic", () => {
    expect(jobInterval("upkeep", "timer", ON)).toBe(3 * 60_000);
    expect(jobInterval("billing", "timer", ON)).toBe(BILLING_MS);
    expect(jobInterval("probes", "timer", ON)).toBe(7 * 60_000);
    expect(jobInterval("probes", "traffic", ON)).toBeNull();
    expect(jobInterval("probes", "cron", ON)).toBe(60_000);
  });

  it("timers are armed only while a switch is on", () => {
    __resetMaintenanceForTests();
    armTimers(OFF);
    expect(__timerArmedForTests()).toBe(false);
    armTimers({ ...OFF, activeHealthChecks: true });
    expect(__timerArmedForTests()).toBe(true);
    armTimers(OFF);
    expect(__timerArmedForTests()).toBe(false);
    __resetMaintenanceForTests();
  });
});

describe.skipIf(!dbOk)("run claims (shared by every instance, timer and Cloud Scheduler)", () => {
  const name = `test-job-${Math.floor(Math.random() * 1e9)}`;
  afterAll(() => db.jobRun.deleteMany({ where: { name } }));

  it("a job runs once per interval", async () => {
    expect(await __claimJobForTests(name, 60_000)).toBe(true);
    expect(await __claimJobForTests(name, 60_000)).toBe(false);
    const both = await Promise.all([__claimJobForTests(name, 0), __claimJobForTests(name, 0)]);
    expect(both.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    await db.jobRun.update({ where: { name }, data: { lastRunAt: new Date(Date.now() - 2 * 60_000) } });
    const race = await Promise.all([__claimJobForTests(name, 60_000), __claimJobForTests(name, 60_000), __claimJobForTests(name, 60_000)]);
    expect(race.filter(Boolean)).toHaveLength(1);
  });

  it("probes are skipped (not even claimed) while uptime monitoring is off", async () => {
    const out = await runDueJobs("cron", { only: ["probes"], settings: OFF });
    expect(out).toEqual([{ job: "probes", ran: false }]);
  });

  it("a run records its outcome (billing without Stripe is a quick no-op)", async () => {
    await db.jobRun.deleteMany({ where: { name: "billing" } });
    const [out] = await runDueJobs("cron", { only: ["billing"], settings: OFF });
    expect(out.ran).toBe(true);
    expect(out.error).toBeUndefined();
    const row = await db.jobRun.findUniqueOrThrow({ where: { name: "billing" } });
    expect(row.lastOkAt).not.toBeNull();
    expect(row.source).toBe("cron");
    expect((await runDueJobs("cron", { only: ["billing"], settings: OFF }))[0].ran).toBe(false); // within the gap
  });
});

describe("wall-clock slots", () => {
  it("jobs with the same interval share one slot, so they run in the same tick", async () => {
    const { slotStart } = await import("@/server/maintenance");
    const h = 60 * 60_000;
    const t = Date.UTC(2026, 9, 26, 14, 37, 12);
    expect(slotStart(h, t)).toBe(Date.UTC(2026, 9, 26, 14, 0, 0));
    expect(slotStart(15 * 60_000, t)).toBe(Date.UTC(2026, 9, 26, 14, 30, 0));
    // a run at 14:59 and the next due at 15:00, not 15:59
    expect(slotStart(h, Date.UTC(2026, 9, 26, 15, 0, 1))).toBeGreaterThan(Date.UTC(2026, 9, 26, 14, 59));
    expect(slotStart(0, t)).toBe(t);
  });

  it("price sync is checked at its own interval in minutes", () => {
    expect(jobInterval("priceSync", "timer", { ...ON, priceSyncAuto: true, priceSyncIntervalMin: 15 })).toBe(15 * 60_000);
    expect(jobInterval("priceSync", "timer", { ...ON, priceSyncAuto: false, priceSyncIntervalMin: 15 })).toBeNull();
  });
});
