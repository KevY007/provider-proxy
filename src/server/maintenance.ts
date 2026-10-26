// Background work, cold by default.
//
// Three jobs:
//  - "upkeep":  provider health + uptime samples from real traffic, video/batch sweeps, metering dead-letter replay,
//               uptime-history pruning. No provider is contacted unless a video job or batch is actually open.
//  - "billing": auto-recharge, postpaid settlement, stale payment reconciliation (Stripe).
//  - "probes":  uptime pings of every upstream key (free model-list request). Only with the activeHealthChecks setting.
//  - "balances": reads the account balance of every upstream that publishes one (the relay /v1/usage) every
//               `upstreamBalanceIntervalMin` (default 60) and stores the snapshot for the admin pages.
//  - "priceSync": AI price sync of the providers whose automatic sync is on (each at its own interval, e.g. 10 h);
//               checked hourly. Nothing at all happens while no provider has it on.
//
// Who triggers them:
//  - DEFAULT (all monitoring settings off): only activity - a gateway call or an admin page - and at most every
//    5 minutes (billing: hourly). An idle server runs no timer and makes no request, so it can scale to zero.
//  - `backgroundJobs` on: an in-process timer also runs upkeep every `maintenanceIntervalMin` and billing hourly.
//  - `activeHealthChecks` on: an in-process timer pings every `healthCheckIntervalMin` (never on traffic).
//  - Cloud Scheduler (optional): /api/cron/health and /api/cron/billing run the same jobs.
//
// Each run is claimed atomically in the JobRun table, so several instances, timers and Cloud Scheduler never run a
// job twice within its interval.
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getSettings, type SettingValues } from "@/lib/settings";

export type JobName = "upkeep" | "billing" | "probes" | "priceSync" | "balances";
export type JobSource = "traffic" | "admin" | "timer" | "cron" | "boot";

const MIN = 60_000;
/** Upkeep / billing interval when only activity drives them (fixed: frequent enough, never spammy). */
export const ACTIVITY_UPKEEP_MS = 5 * MIN;
export const BILLING_MS = 60 * MIN;
/** A Cloud Scheduler call may run a job this soon after the previous run (its own schedule sets the pace). */
const CRON_GAP_MS = 60_000;
/** How often an instance even considers activity-driven jobs (an in-memory check, no query). */
const ACTIVITY_CHECK_MS = 60_000;
/** Timer tick: re-reads the (cached) settings and runs whatever is due. */
const TICK_MS = 30_000;

type Settings = Pick<SettingValues, "activeHealthChecks" | "healthCheckIntervalMin" | "backgroundJobs" | "maintenanceIntervalMin"> &
  Partial<Pick<SettingValues, "priceSyncAuto" | "priceSyncIntervalMin" | "upstreamBalanceIntervalMin">>;

const g = globalThis as unknown as {
  __ppMaint?: { lastActivityCheck: number; running: Set<JobName>; timer: ReturnType<typeof setInterval> | null; timerFor: string };
  __ppMaintTestActivity?: boolean;
};
const state = (g.__ppMaint ??= { lastActivityCheck: 0, running: new Set(), timer: null, timerFor: "" });

/** Interval of a job for a trigger, or null when that trigger must not run it. */
export function jobInterval(job: JobName, source: JobSource, s: Settings): number | null {
  if (job === "probes") {
    if (!s.activeHealthChecks) return null;
    if (source === "timer") return s.healthCheckIntervalMin * MIN;
    if (source === "cron") return CRON_GAP_MS;
    return null; // never pinged because of traffic
  }
  if (job === "priceSync" && s.priceSyncAuto === false) return null;
  if (job === "priceSync" && source !== "cron") return (s.priceSyncIntervalMin ?? 60) * MIN; // each provider is also gated by it
  if (job === "balances") {
    const min = s.upstreamBalanceIntervalMin ?? 60;
    if (!min) return null; // 0 = off (refresh button only)
    return source === "cron" ? CRON_GAP_MS : min * MIN;
  }
  if (source === "cron") return CRON_GAP_MS;
  if (job === "billing" || job === "priceSync") return BILLING_MS;
  if (source === "timer") return s.backgroundJobs ? s.maintenanceIntervalMin * MIN : null;
  return ACTIVITY_UPKEEP_MS;
}

/**
 * Start of the wall-clock slot `now` is in, for an interval (UTC-aligned: 60 min = every full hour, 15 min = :00 :15
 * :30 :45). Jobs are due once per slot, so every job with the same interval runs in the same tick instead of drifting
 * apart, and an instance has one burst of work per slot and is idle in between.
 */
export function slotStart(intervalMs: number, now = Date.now()): number {
  return intervalMs > 0 ? Math.floor(now / intervalMs) * intervalMs : now;
}

/** Claim a run: true when the job has not run in the current slot of `intervalMs` (atomic across instances). */
async function claim(job: JobName, intervalMs: number, source: JobSource): Promise<boolean> {
  const now = new Date();
  const threshold = new Date(slotStart(intervalMs, now.getTime()) - 1);
  const rows = await db.$queryRaw<Array<{ name: string }>>(Prisma.sql`
    INSERT INTO "JobRun" ("name", "lastRunAt", "source", "updatedAt") VALUES (${job}, ${now}, ${source}, ${now})
    ON CONFLICT ("name") DO UPDATE SET "lastRunAt" = EXCLUDED."lastRunAt", "source" = EXCLUDED."source", "updatedAt" = EXCLUDED."updatedAt"
    WHERE "JobRun"."lastRunAt" <= ${threshold}
    RETURNING "name"`);
  return rows.length > 0;
}

async function work(job: JobName): Promise<unknown> {
  switch (job) {
    case "upkeep": {
      const [{ refreshPassiveHealth, pruneHealthChecks }, { sweepVideoJobs }, { sweepBatches }, { replayDeadLetters }] = await Promise.all([
        import("@/gateway/health"),
        import("@/gateway/video"),
        import("@/gateway/batches"),
        import("@/gateway/meter-writer"),
      ]);
      const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> =>
        fn().catch((err) => {
          logger.warn(`upkeep step failed: ${name}`, { err });
          return { error: err instanceof Error ? err.message : String(err) };
        });
      return {
        health: await step("passive health", () => refreshPassiveHealth()),
        videos: await step("video sweep", () => sweepVideoJobs()),
        batches: await step("batch sweep", () => sweepBatches()),
        metering: await step("dead letters", () => replayDeadLetters()),
        pruned: await step("prune health history", () => pruneHealthChecks()),
        sealedKeys: await step("seal plain upstream keys", async () => (await import("@/server/admin/seal-secrets")).sealPendingProviderSecrets()),
      };
    }
    case "billing": {
      const { runBillingCron } = await import("@/server/billing/cron");
      return runBillingCron();
    }
    case "probes": {
      const { runAllHealthChecks } = await import("@/gateway/health");
      return runAllHealthChecks();
    }
    case "priceSync": {
      const { runDuePriceSyncs } = await import("@/server/pricing/price-sync/engine");
      return runDuePriceSyncs();
    }
    case "balances": {
      const { refreshUpstreamBalances } = await import("@/server/admin/upstream-balances");
      const snap = await refreshUpstreamBalances();
      return { accounts: snap.accounts.length, at: snap.at };
    }
  }
}

export interface JobOutcome {
  job: JobName;
  ran: boolean;
  result?: unknown;
  error?: string;
}

/** Run every job that is due for this trigger (or only `only`). Never throws. */
export async function runDueJobs(source: JobSource, opts: { only?: JobName[]; settings?: Settings } = {}): Promise<JobOutcome[]> {
  const s = opts.settings ?? (await getSettings());
  const out: JobOutcome[] = [];
  for (const job of opts.only ?? (["upkeep", "billing", "probes", "priceSync", "balances"] as JobName[])) {
    const interval = jobInterval(job, source, s);
    if (interval === null || state.running.has(job)) {
      out.push({ job, ran: false });
      continue;
    }
    state.running.add(job);
    try {
      if (!(await claim(job, interval, source))) {
        out.push({ job, ran: false });
        continue;
      }
      try {
        const result = await work(job);
        await db.jobRun.update({ where: { name: job }, data: { lastOkAt: new Date(), result: (result ?? null) as Prisma.InputJsonValue, error: null } }).catch(() => undefined);
        out.push({ job, ran: true, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("background job failed", { job, source, err });
        await db.jobRun.update({ where: { name: job }, data: { error: msg.slice(0, 500) } }).catch(() => undefined);
        out.push({ job, ran: true, error: msg });
      }
    } catch (err) {
      logger.warn("background job claim failed", { job, err });
      out.push({ job, ran: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      state.running.delete(job);
    }
  }
  return out;
}

/**
 * Activity hook (gateway calls, admin pages): cheap in-memory throttle, then runs the activity-driven jobs that are due
 * in the background. Also (re)arms or stops the timers when the settings changed.
 */
export function noteActivity(source: "traffic" | "admin" = "traffic", settings?: Settings): void {
  if (process.env.VITEST && !g.__ppMaintTestActivity) return;
  if (settings) armTimers(settings);
  else void getSettings().then(armTimers).catch(() => undefined);
  const now = Date.now();
  if (now - state.lastActivityCheck < ACTIVITY_CHECK_MS) return;
  state.lastActivityCheck = now;
  void runDueJobs(source, settings ? { settings } : {}).catch(() => undefined);
}

/** Start or stop the in-process timer to match the settings (no timer at all while every switch is off). */
export function armTimers(s: Settings): void {
  const want = s.backgroundJobs || s.activeHealthChecks;
  const key = want ? `${s.backgroundJobs}:${s.activeHealthChecks}` : "";
  if (key === state.timerFor) return;
  state.timerFor = key;
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (!want) {
    logger.info("background timers off (activity-driven only)");
    return;
  }
  logger.info("background timers on", { backgroundJobs: s.backgroundJobs, uptimePings: s.activeHealthChecks });
  state.timer = setInterval(() => void tick(), TICK_MS);
  state.timer.unref?.();
  void tick();
}

async function tick(): Promise<void> {
  const s = await getSettings().catch(() => null);
  if (!s) return;
  armTimers(s);
  if (!state.timer) return;
  await runDueJobs("timer", { settings: s });
}

/** Server start (instrumentation.ts): arm timers only when an admin enabled them. One settings read, nothing else. */
export async function bootMaintenance(): Promise<void> {
  const s = await getSettings();
  armTimers(s);
}

/** Last run of every job (admin status page). */
export async function getJobRuns() {
  const rows = await db.jobRun.findMany();
  return rows.map((r) => ({ name: r.name, lastRunAt: r.lastRunAt.toISOString(), lastOkAt: r.lastOkAt?.toISOString() ?? null, source: r.source, error: r.error }));
}

/** Test hooks. */
export const __claimJobForTests = (name: string, intervalMs: number) => claim(name as JobName, intervalMs, "timer");
export const __timerArmedForTests = (): boolean => state.timer !== null;

export function __resetMaintenanceForTests(opts: { activity?: boolean } = {}): void {
  state.lastActivityCheck = 0;
  state.running.clear();
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.timerFor = "";
  g.__ppMaintTestActivity = !!opts.activity;
}
