import { describe, expect, it } from "vitest";
import {
  availabilityPct,
  buildDailyBars,
  combineHealth,
  currentLevel,
  levelFromPct,
  overallLevel,
  windowAvailability,
} from "@/server/customer/status-calc";

describe("status calc", () => {
  it("computes availability and levels", () => {
    expect(availabilityPct(0, 0)).toBeNull();
    expect(availabilityPct(99, 1)).toBeCloseTo(99);
    expect(levelFromPct(null)).toBe("nodata");
    expect(levelFromPct(100)).toBe("operational");
    expect(levelFromPct(95)).toBe("degraded");
    expect(levelFromPct(50)).toBe("down");
  });

  it("builds exactly N daily bars with gaps as nodata", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    const bars = buildDailyBars([{ date: "2026-03-10", success: 98, failed: 2 }, { date: "2026-03-08", success: 10, failed: 0 }], 90, now);
    expect(bars).toHaveLength(90);
    expect(bars[89].date).toBe("2026-03-10");
    expect(bars[89].level).toBe("degraded");
    expect(bars[88].level).toBe("nodata");
    expect(bars[87].level).toBe("operational");
    expect(windowAvailability(bars, 7)).toBeCloseTo((108 / 110) * 100);
  });

  it("combines traffic and health signals", () => {
    expect(combineHealth(["down", "operational"])).toBe("degraded");
    expect(combineHealth(["down", "down"])).toBe("down");
    expect(combineHealth([])).toBe("nodata");
    expect(currentLevel(0, 0, "operational")).toBe("operational");
    expect(currentLevel(100, 0, "down")).toBe("degraded");
    expect(currentLevel(10, 90, "operational")).toBe("down");
    expect(overallLevel(["operational", "nodata"])).toBe("operational");
    expect(overallLevel(["operational", "degraded"])).toBe("degraded");
    expect(overallLevel(["nodata"])).toBe("nodata");
  });
});
