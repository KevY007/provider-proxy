import { describe, expect, it } from "vitest";
import { bucketStarts, clampGranularity, fillSeries, floorBucket } from "@/server/customer/buckets";
import { isValidIpOrCidr, keyFormSchema, parseIpList } from "@/server/customer/key-schemas";
import { csvCell, toCsv } from "@/server/customer/csv";
import { describeErrorCode, ERROR_CODES } from "@/server/customer/error-codes";

describe("time buckets", () => {
  it("floors to UTC hour/day", () => {
    expect(floorBucket(new Date("2026-03-04T10:45:12Z"), "hour").toISOString()).toBe("2026-03-04T10:00:00.000Z");
    expect(floorBucket(new Date("2026-03-04T10:45:12Z"), "day").toISOString()).toBe("2026-03-04T00:00:00.000Z");
  });
  it("lists contiguous bucket starts and fills gaps with zeros", () => {
    const from = new Date("2026-03-01T05:00:00Z");
    const to = new Date("2026-03-03T01:00:00Z");
    expect(bucketStarts(from, to, "day")).toHaveLength(3);
    const rows = fillSeries([{ bucket: new Date("2026-03-02T00:00:00Z"), n: 5 }], from, to, "day", (bucket) => ({ bucket, n: 0 }));
    expect(rows.map((r) => r.n)).toEqual([0, 5, 0]);
  });
  it("only allows hourly granularity for ranges <= 14 days", () => {
    const to = new Date("2026-03-30T00:00:00Z");
    expect(clampGranularity("hour", new Date(to.getTime() - 5 * 86400_000), to)).toBe("hour");
    expect(clampGranularity("hour", new Date(to.getTime() - 30 * 86400_000), to)).toBe("day");
    expect(clampGranularity(undefined, new Date(to.getTime() - 86400_000), to)).toBe("hour");
  });
});

describe("api key form validation", () => {
  it("validates IPs and CIDRs", () => {
    for (const ok of ["203.0.113.7", "10.0.0.0/8", "2001:db8::/32", "::1"]) expect(isValidIpOrCidr(ok)).toBe(true);
    for (const bad of ["999.1.1.1", "10.0.0.0/33", "not-an-ip", "1.2.3", "2001:db8::/200"]) expect(isValidIpOrCidr(bad)).toBe(false);
    expect(parseIpList("1.1.1.1, 2.2.2.2\n1.1.1.1")).toEqual(["1.1.1.1", "2.2.2.2"]);
  });
  it("accepts a minimal key and rejects bad limits", () => {
    expect(keyFormSchema.safeParse({ name: "prod" }).success).toBe(true);
    expect(keyFormSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(keyFormSchema.safeParse({ name: "x", rpmLimit: 0 }).success).toBe(false);
    expect(keyFormSchema.safeParse({ name: "x", spendLimit: -1 }).success).toBe(false);
    expect(keyFormSchema.safeParse({ name: "x", expiresAt: "2001-01-01T00:00:00Z" }).success).toBe(false);
    expect(keyFormSchema.safeParse({ name: "x", ipAllowlist: ["nope"] }).success).toBe(false);
  });
});

describe("csv + error codes", () => {
  it("escapes cells and neutralises formula injection", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell(-5)).toBe("-5");
    expect(toCsv(["a", "b"], [[1, "x"]])).toBe("a,b\r\n1,x\r\n");
  });
  it("documents every gateway error code from the plan", () => {
    const codes = ["invalid_api_key", "key_disabled", "key_expired", "ip_not_allowed", "account_suspended", "email_not_verified", "model_not_found", "model_not_allowed", "unsupported_endpoint", "insufficient_balance", "spend_limit_reached", "rate_limited", "no_available_provider", "upstream_timeout", "upstream_error", "invalid_request", "internal_error"];
    for (const c of codes) expect(describeErrorCode(c), c).not.toBeNull();
    expect(ERROR_CODES.find((e) => e.code === "insufficient_balance")?.http).toBe(402);
    expect(describeErrorCode("nope")).toBeNull();
  });
});
