// Shared concurrency pool of providers on one upstream account (e.g. Codex Everywhere: 20 per account).
import { describe, expect, it } from "vitest";
import { upstreamPools } from "@/gateway/execute";

describe("upstreamPools", () => {
  it("adds one pool shared by every provider of the same upstream account", () => {
    const cand = (pid: string, settings: Record<string, unknown>) => ({ key: { id: `k-${pid}`, maxConcurrency: null }, route: { provider: { id: pid, maxConcurrency: null, settings } } }) as never;
    const shared = { sharedConcurrency: { group: "ce-account", max: 20 } };
    expect(upstreamPools(cand("p1", shared), { defaultKeyConcurrency: 50 })).toEqual([
      { kind: "pkey", id: "k-p1", max: 50 },
      { kind: "provider", id: "shared:ce-account", max: 20 },
    ]);
    expect(upstreamPools(cand("p2", shared), { defaultKeyConcurrency: 50 })[1]).toEqual({ kind: "provider", id: "shared:ce-account", max: 20 });
    expect(upstreamPools(cand("p3", {}), { defaultKeyConcurrency: 50 })).toHaveLength(1);
  });
});
