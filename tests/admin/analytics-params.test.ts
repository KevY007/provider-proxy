import { describe, expect, it } from "vitest";
import { csvEscape, toCsv } from "@/server/analytics/csv";
import { fillTimeBuckets, isBreakdownDim, marginPct, normalizeGranularity, parseAnalyticsParams, previousRange, trendPct } from "@/server/analytics/params";

const NOW = new Date("2026-03-10T12:00:00.000Z");

describe("parseAnalyticsParams", () => {
  it("defaults to 7d with day granularity", () => {
    const { range, gran, filter } = parseAnalyticsParams({}, { now: NOW });
    expect(range.preset).toBe("7d");
    expect(gran).toBe("day");
    expect(filter.to.getTime()).toBe(NOW.getTime());
    expect(filter.from.getTime()).toBe(NOW.getTime() - 7 * 86400_000);
    expect(filter.userId).toBeUndefined();
  });

  it("uses hourly buckets for short ranges", () => {
    expect(parseAnalyticsParams({ range: "24h" }, { now: NOW }).gran).toBe("hour");
  });

  it("honours a valid granularity but caps hourly on long ranges", () => {
    expect(parseAnalyticsParams({ range: "30d", gran: "week" }, { now: NOW }).gran).toBe("week");
    expect(parseAnalyticsParams({ range: "90d", gran: "hour" }, { now: NOW }).gran).toBe("day");
  });

  it("ignores junk granularity / status", () => {
    const r = parseAnalyticsParams({ gran: "minute", status: "nope" }, { now: NOW });
    expect(r.gran).toBe("day");
    expect(r.filter.status).toBeUndefined();
  });

  it("parses custom ranges and falls back on bad ones", () => {
    const ok = parseAnalyticsParams({ range: "custom", from: "2026-01-01", to: "2026-01-31" });
    expect(ok.range.preset).toBe("custom");
    expect(ok.filter.from.toISOString().slice(0, 10)).toBe("2026-01-01");
    const bad = parseAnalyticsParams({ range: "custom", from: "x", to: "y" }, { now: NOW });
    expect(bad.range.preset).toBe("7d");
  });

  it("forces the portal userId scope over the query string", () => {
    const r = parseAnalyticsParams({ userId: "someone-else" }, { userId: "me" });
    expect(r.filter.userId).toBe("me");
  });

  it("reads filters from URLSearchParams", () => {
    const r = parseAnalyticsParams(new URLSearchParams("model=gpt-x&provider=p1&status=SUCCESS&group=pro"), { now: NOW });
    expect(r.filter).toMatchObject({ modelSlug: "gpt-x", providerId: "p1", status: "SUCCESS", groupSlug: "pro" });
  });
});

describe("helpers", () => {
  it("marginPct", () => {
    expect(marginPct(100, 60)).toBe(40);
    expect(marginPct(0, 5)).toBe(0);
    expect(marginPct(10, 15)).toBe(-50);
  });
  it("trendPct", () => {
    expect(trendPct(150, 100)).toBe(50);
    expect(trendPct(0, 0)).toBe(0);
    expect(trendPct(5, 0)).toBeNull();
  });
  it("previousRange is the adjacent window of equal length", () => {
    const r = { from: new Date("2026-03-03T00:00:00Z"), to: new Date("2026-03-10T00:00:00Z") };
    const p = previousRange(r);
    expect(p.to.getTime()).toBe(r.from.getTime());
    expect(p.to.getTime() - p.from.getTime()).toBe(r.to.getTime() - r.from.getTime());
  });
  it("normalizeGranularity bounds bucket counts", () => {
    const long = { from: new Date("2024-01-01"), to: new Date("2026-03-01") };
    expect(normalizeGranularity(long, "day")).toBe("week");
  });
  it("isBreakdownDim", () => {
    expect(isBreakdownDim("model")).toBe(true);
    expect(isBreakdownDim("DROP TABLE")).toBe(false);
  });
  it("fillTimeBuckets zero-fills day gaps", () => {
    const pts = [{ t: "2026-03-01T00:00:00.000Z", v: 1 }, { t: "2026-03-03T00:00:00.000Z", v: 2 }];
    const out = fillTimeBuckets(pts, new Date("2026-03-01T05:00:00Z"), new Date("2026-03-03T10:00:00Z"), "day", (t) => ({ t, v: 0 }));
    expect(out.map((p) => p.v)).toEqual([1, 0, 2]);
  });
});

describe("csv", () => {
  it("escapes quotes, commas, newlines and formula injection", () => {
    expect(csvEscape('a,"b"')).toBe('"a,""b"""');
    expect(csvEscape("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvEscape(-5)).toBe("-5");
    expect(csvEscape(null)).toBe("");
  });
  it("toCsv builds header + rows", () => {
    const csv = toCsv([{ a: 1, b: "x" }], [{ key: "a", header: "A" }, { key: "b" }]);
    expect(csv).toBe("A,b\r\n1,x\r\n");
  });
});
