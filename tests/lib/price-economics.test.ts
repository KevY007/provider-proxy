import { describe, expect, it } from "vitest";
import { DEFAULT_WORKLOAD, economics, solveFactor, workloadPrice, workloadTotal } from "@/lib/price-economics";

describe("price economics", () => {
  it("prices the default 10M-token workload", () => {
    expect(workloadTotal(DEFAULT_WORKLOAD)).toBe(10);
    // 3.75 x 4 + 2.5 x 20 + 3.75 x 0.4 = 15 + 50 + 1.5
    expect(workloadPrice({ input: 4, output: 20, cached: 0.4 }, DEFAULT_WORKLOAD)).toBeCloseTo(66.5);
  });

  it("economics: profit, margin and customer saving", () => {
    const e = economics(40, 30, 100);
    expect(e.profit).toBe(10);
    expect(e.marginPct).toBeCloseTo(25);
    expect(e.savingsPct).toBeCloseTo(60);
  });

  it("solves the factor for each target kind", () => {
    // $40 revenue on $30 spend, basis (cost) 30 -> factor 40/30
    expect(solveFactor({ kind: "revenue_per_cost", revenue: 40, cost: 30 }, 30, 30, 100)).toBeCloseTo(4 / 3);
    // basis = model price 100 (list), cost 30, 40% margin -> revenue 50 -> 0.5
    expect(solveFactor({ kind: "margin", pct: 40 }, 100, 30, 100)).toBeCloseTo(0.5);
    expect(solveFactor({ kind: "markup", pct: 50 }, 30, 30, 100)).toBeCloseTo(1.5);
    expect(solveFactor({ kind: "savings", pct: 70 }, 100, 30, 100)).toBeCloseTo(0.3);
    expect(solveFactor({ kind: "savings", pct: 70 }, 100, 30, null)).toBeNull();
  });
});
