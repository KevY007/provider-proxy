import { describe, expect, it } from "vitest";
import { keyFormSchema } from "@/server/customer/key-schemas";
import { userAgentMode } from "@/lib/user-agents";

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

describe("userAgentMode (what the selector shows)", () => {
  it("empty / passthrough shows Passthrough", () => {
    expect(userAgentMode("", false)).toBe("passthrough");
    expect(userAgentMode("passthrough", false)).toBe("passthrough");
  });
  it("a preset id shows that preset, even if the Custom flag is still set", () => {
    expect(userAgentMode("claude-code", false)).toBe("claude-code");
    expect(userAgentMode("claude-code", true)).toBe("claude-code");
  });
  it("other text shows Custom", () => {
    expect(userAgentMode("My-Tool/1", false)).toBe("custom");
  });
  it("Custom chosen but nothing typed yet stays on Custom (so the text box shows)", () => {
    expect(userAgentMode("", true)).toBe("custom");
    expect(userAgentMode("   ", true)).toBe("custom");
  });
});

describe("key form: stripHeaders", () => {
  it("defaults to none", () => {
    expect(keyFormSchema.parse({ name: "k" }).stripHeaders).toEqual([]);
  });
  it("normalises the list and drops credentials", () => {
    expect(keyFormSchema.parse({ name: "k", stripHeaders: [" X-App ", "openai-beta", "authorization", "x-app"] }).stripHeaders).toEqual(["x-app", "openai-beta"]);
  });
});

describe("key form: streamHoldSec (stream start)", () => {
  it("is unset by default: the key follows the gateway's start hold", () => {
    expect(keyFormSchema.parse({ name: "k" }).streamHoldSec).toBeNull();
    expect(keyFormSchema.parse({ name: "k", streamHoldSec: null }).streamHoldSec).toBeNull();
  });
  it("accepts 0 (live streaming) and whole seconds, and refuses anything else", () => {
    expect(keyFormSchema.parse({ name: "k", streamHoldSec: 0 }).streamHoldSec).toBe(0);
    expect(keyFormSchema.parse({ name: "k", streamHoldSec: 30 }).streamHoldSec).toBe(30);
    expect(keyFormSchema.safeParse({ name: "k", streamHoldSec: -1 }).success).toBe(false);
    expect(keyFormSchema.safeParse({ name: "k", streamHoldSec: 1.5 }).success).toBe(false);
    expect(keyFormSchema.safeParse({ name: "k", streamHoldSec: 100_000 }).success).toBe(false);
  });
});
