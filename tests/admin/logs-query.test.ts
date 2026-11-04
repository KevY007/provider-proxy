import { describe, expect, it } from "vitest";
import { buildLogWhere, decodeCursor, encodeCursor, filtersToQuery, parseLogFilters, summarizeAttempts } from "@/server/admin/logs-query";

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

describe("summarizeAttempts", () => {
  it("counts the failed attempts before the one that answered", () => {
    const s = summarizeAttempts([
      { status: 0, error: "stream failed before first event: terminated (ECONNRESET)", latencyMs: 36917 },
      { status: 522, error: "codex 522: Connection timed out", latencyMs: 20865 },
      { status: 200, latencyMs: 22278 },
    ]);
    expect(s).toEqual({ attempts: 3, failed: 2, failedMs: 57782, errors: ["stream failed before first event: terminated (ECONNRESET)", "codex 522: Connection timed out"] });
  });

  it("a single clean attempt has nothing to show", () => {
    expect(summarizeAttempts([{ status: 200, latencyMs: 900 }])).toEqual({ attempts: 1, failed: 0, failedMs: 0, errors: [] });
  });

  it("tolerates junk, missing fields and non-arrays", () => {
    expect(summarizeAttempts(null)).toEqual({ attempts: 0, failed: 0, failedMs: 0, errors: [] });
    expect(summarizeAttempts([null, "x", { status: 503 }])).toMatchObject({ attempts: 3, failed: 1, errors: ["HTTP 503"] });
  });

  it("keeps the error list short and deduplicated", () => {
    const many = Array.from({ length: 9 }, () => ({ status: 0, error: "terminated (ECONNRESET) " + "x".repeat(400) }));
    const s = summarizeAttempts(many);
    expect(s.failed).toBe(9);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0].length).toBeLessThanOrEqual(160);
  });
});

describe("retried filter", () => {
  const now = new Date("2026-05-01T12:00:00Z");
  it("parses retried=yes and ignores anything else", () => {
    expect(parseLogFilters({ retried: "yes" }, now).retried).toBe("yes");
    expect(parseLogFilters({ retried: "maybe" }, now).retried).toBe("");
    expect(parseLogFilters({}, now).retried).toBe("");
  });
  it("retried=yes needs a second upstream attempt; no filter adds nothing", () => {
    const yes = JSON.stringify(buildLogWhere(parseLogFilters({ retried: "yes" }, now)));
    expect(yes).toContain('"attempts"');
    expect(yes).toContain('"path":["1","status"]');
    expect(JSON.stringify(buildLogWhere(parseLogFilters({}, now)))).not.toContain("attempts");
  });
  it("travels with the CSV export link", () => {
    expect(filtersToQuery({ retried: "yes", status: "SUCCESS" })).toContain("retried=yes");
  });
});
