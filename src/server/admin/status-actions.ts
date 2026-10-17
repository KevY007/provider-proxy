"use server";

import { audit } from "@/lib/audit";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { runAllHealthChecks } from "@/gateway/health";
import { adminAction } from "./action";

/** Runs a health check on every active provider key now. ADMIN or SUPPORT. */
export async function runChecksNow() {
  return adminAction<{ checked: number; failed: number }>({}, async ({ admin, ip }) => {
    const res = await runAllHealthChecks();
    await audit(admin.id, "health.runAll", null, { checked: res.checked, failed: res.failed }, ip);
    await invalidateGatewayConfig("providers");
    return { data: res, message: res.checked === 0 ? "No active keys to check" : `${res.checked - res.failed}/${res.checked} checks passed` };
  });
}
