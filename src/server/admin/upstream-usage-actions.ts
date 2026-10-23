"use server";
import { z } from "zod";
import { adminAction, parseInput } from "./action";
import { checkUpstreamUsage, type UpstreamUsageReport } from "./upstream-usage";

/** "Check upstream usage" on the provider page: read-only, staff may run it. */
export async function checkUpstreamUsageAction(input: unknown) {
  return adminAction<UpstreamUsageReport>({ adminOnly: false }, async () => {
    const d = parseInput(z.object({ providerId: z.string().min(1) }), input);
    const report = await checkUpstreamUsage(d.providerId);
    return { data: report, message: report.supported ? "Upstream usage loaded" : "This provider does not publish per-key usage" };
  });
}

/** "Refresh" on the upstream balances card: reads every upstream balance now. */
export async function refreshUpstreamBalancesAction() {
  return adminAction<{ at: string | null }>({ adminOnly: false }, async () => {
    const { refreshUpstreamBalances } = await import("./upstream-balances");
    const snap = await refreshUpstreamBalances();
    return { data: { at: snap.at }, message: "Upstream balances refreshed" };
  });
}
