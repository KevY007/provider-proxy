import { describe, expect, it } from "vitest";
import { buildLogWhere, decodeCursor, encodeCursor, filtersToQuery, parseLogFilters } from "@/server/admin/logs-query";

describe("cursor", () => {
  it("roundtrips, including ids containing underscores", () => {
    const c = { createdAt: new Date("2026-03-04T05:06:07.089Z"), id: "admintest_abc_1" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it("rejects malformed cursors", () => {
    for (const bad of ["", "garbage", "2026-03-04_x", "notadate_abc", "2026-13-99T99:99:99.000Z_x", "2026-03-04T05:06:07.089Z_"]) {
      expect(decodeCursor(bad)).toBeNull();
    }
    expect(decodeCursor(null)).toBeNull();
  });
});

describe("parseLogFilters", () => {
  const now = new Date("2026-05-01T12:00:00Z");
  it("defaults to the last 24h", () => {
    const f = parseLogFilters({}, now);
    expect(f.to.getTime() - f.from.getTime()).toBe(24 * 3600_000);
    expect(f.status).toBe("");
    expect(f.minLatency).toBeNull();
  });
  it("parses filters and ignores invalid enum values", () => {
    const f = parseLogFilters(new URLSearchParams("status=UPSTREAM_ERROR&stream=yes&minLatency=1500&model=gpt-x&range=7d"), now);
    expect(f).toMatchObject({ status: "UPSTREAM_ERROR", stream: "yes", minLatency: 1500, model: "gpt-x" });
    const g = parseLogFilters({ status: "BOGUS", stream: "maybe", minLatency: "-4" }, now);
    expect(g).toMatchObject({ status: "", stream: "", minLatency: null });
  });
});

describe("buildLogWhere", () => {
  const now = new Date("2026-05-01T12:00:00Z");
  it("treats @ as email search and adds keyset conditions", () => {
    const f = parseLogFilters({ user: "bob@x.io", key: "sk-pp-abc" }, now);
    const w = JSON.stringify(buildLogWhere(f, { createdAt: now, id: "z" }, "older"));
    expect(w).toContain("email");
    expect(w).toContain("prefix");
    expect(w).toContain('"lt"');
    expect(JSON.stringify(buildLogWhere(f, { createdAt: now, id: "z" }, "newer"))).toContain('"gt"');
  });
  it("filtersToQuery keeps only known keys", () => {
    expect(filtersToQuery({ model: "m", cursor: "x", evil: "1" })).toBe("model=m");
  });
});
