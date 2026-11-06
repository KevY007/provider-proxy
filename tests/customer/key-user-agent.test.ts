import { describe, expect, it } from "vitest";
import { keyFormSchema } from "@/server/customer/key-schemas";

const base = { name: "k" };

describe("key form: userAgent", () => {
  it("is optional and defaults to passthrough (null)", () => {
    expect(keyFormSchema.parse(base).userAgent).toBeNull();
  });
  it("blank, whitespace and 'passthrough' all mean passthrough", () => {
    for (const v of ["", "   ", "passthrough", " passthrough ", null]) expect(keyFormSchema.parse({ ...base, userAgent: v }).userAgent).toBeNull();
  });
  it("keeps a preset id or custom text, trimmed", () => {
    expect(keyFormSchema.parse({ ...base, userAgent: "claude-code" }).userAgent).toBe("claude-code");
    expect(keyFormSchema.parse({ ...base, userAgent: "  My-Tool/1.0 " }).userAgent).toBe("My-Tool/1.0");
  });
  it("strips control characters and rejects overlong text", () => {
    expect(keyFormSchema.parse({ ...base, userAgent: "a\tb\nc" }).userAgent).toBe("a b c");
    expect(keyFormSchema.safeParse({ ...base, userAgent: "x".repeat(301) }).success).toBe(false);
  });
});
