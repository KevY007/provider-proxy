/**
 * Runs once per server start. Arms the background timers only when an admin turned them on (Settings > Monitoring);
 * by default nothing is scheduled and an idle server stays idle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build" || process.env.VITEST) return;
  const { bootMaintenance } = await import("@/server/maintenance");
  // not awaited: never delay start-up (or fail it) on a settings read
  void bootMaintenance().catch(() => undefined);
}
