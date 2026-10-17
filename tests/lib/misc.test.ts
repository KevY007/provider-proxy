import { describe, expect, it } from "vitest";
import { parseRangeParams } from "@/lib/date-range";
import { getClientIp, safeNextPath } from "@/lib/http";
import { signupSchema } from "@/lib/auth/schemas";

describe("http", () => {
  it("takes the client IP from the right of x-forwarded-for", () => {
    const h = new Headers({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" });
    expect(getClientIp(h)).toBe("1.2.3.4");
    expect(getClientIp(new Headers())).toBe("unknown");
  });
  it("rejects open redirects", () => {
    expect(safeNextPath("/dashboard/keys")).toBe("/dashboard/keys");
    expect(safeNextPath("//evil.com")).toBe("/dashboard");
    expect(safeNextPath("https://evil.com")).toBe("/dashboard");
  });
});

describe("date-range", () => {
  it("parses presets and custom ranges", () => {
    expect(parseRangeParams({ range: "30d" }).preset).toBe("30d");
    expect(parseRangeParams({ range: "bogus" }).preset).toBe("7d");
    const c = parseRangeParams({ range: "custom", from: "2026-01-01", to: "2026-01-31" });
    expect(c.preset).toBe("custom");
    expect(c.to.toISOString()).toBe("2026-01-31T23:59:59.999Z");
  });
});

describe("auth schemas", () => {
  it("normalizes and validates signup", () => {
    const ok = signupSchema.safeParse({ email: " A@B.Com ", password: "longenough" });
    expect(ok.success && ok.data.email).toBe("a@b.com");
    expect(signupSchema.safeParse({ email: "nope", password: "short" }).success).toBe(false);
  });
});
