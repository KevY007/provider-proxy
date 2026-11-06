import { describe, expect, it } from "vitest";
import { applyStripHeaders, normalizeStripList } from "@/lib/strip-headers";
import { buildUpstreamHeaders, type AdapterProvider } from "@/gateway/providers/adapters";

describe("normalizeStripList", () => {
  it("lowercases, trims, dedupes and drops blanks", () => {
    expect(normalizeStripList([" X-App ", "x-app", "", "OpenAI-Beta"])).toEqual(["x-app", "openai-beta"]);
  });
  it("splits text on commas / whitespace and ignores non-arrays", () => {
    expect(normalizeStripList("x-app, openai-beta\nanthropic-beta:claude-code-20250219")).toEqual(["x-app", "openai-beta", "anthropic-beta:claude-code-20250219"]);
    expect(normalizeStripList(5)).toEqual([]);
  });
  it("never accepts credentials or transport headers, or malformed names", () => {
    expect(normalizeStripList(["authorization", "x-api-key", "api-key", "x-goog-api-key", "content-type", "content-length", "host", "bad name", "a:b:c"])).toEqual([]);
  });
});

describe("applyStripHeaders", () => {
  const base = () => ({ "user-agent": "claude-cli/2", "x-app": "cli", "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14", "openai-beta": "assistants=v2", "x-api-key": "S" });
  it("removes whole headers (case-insensitive) and leaves the rest", () => {
    const h = base();
    applyStripHeaders(h, ["X-App", "openai-beta"]);
    expect(h).toEqual({ "user-agent": "claude-cli/2", "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14", "x-api-key": "S" });
  });
  it("removes one anthropic-beta flag and keeps the others", () => {
    const h = base();
    applyStripHeaders(h, ["anthropic-beta:claude-code-20250219"]);
    expect(h["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
  });
  it("drops anthropic-beta entirely when its last flag goes", () => {
    const h = { "anthropic-beta": "claude-code-20250219" } as Record<string, string>;
    applyStripHeaders(h, ["anthropic-beta:claude-code-20250219"]);
    expect("anthropic-beta" in h).toBe(false);
  });
  it("empty list changes nothing", () => {
    const h = base();
    applyStripHeaders(h, []);
    expect(h).toEqual(base());
  });
});

describe("buildUpstreamHeaders strip", () => {
  const mk = (settings: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}): AdapterProvider => ({ slug: "p", preset: "custom", baseUrl: "https://up.example/v1", authStyle: "X_API_KEY", tags: [], extraHeaders, settings });
  const inbound = new Headers({ "user-agent": "claude-cli/2", "x-app": "cli", "anthropic-beta": "claude-code-20250219", "idempotency-key": "k1" });
  const build = (p: AdapterProvider, clientStripHeaders?: string[]) => buildUpstreamHeaders({ provider: p, format: "anthropic_messages", secret: "S", stream: false, inbound, clientStripHeaders });

  it("nothing is stripped by default", () => {
    const h = build(mk());
    expect(h["x-app"]).toBe("cli");
    expect(h["anthropic-beta"]).toBe("claude-code-20250219");
    expect(h["idempotency-key"]).toBe("k1");
  });
  it("provider setting strips", () => {
    const h = build(mk({ stripHeaders: ["x-app", "idempotency-key"] }));
    expect(h["x-app"]).toBeUndefined();
    expect(h["idempotency-key"]).toBeUndefined();
    expect(h["anthropic-beta"]).toBe("claude-code-20250219");
  });
  it("the key's list strips too, and both lists add up", () => {
    const h = build(mk({ stripHeaders: ["x-app"] }), ["anthropic-beta"]);
    expect(h["x-app"]).toBeUndefined();
    expect(h["anthropic-beta"]).toBeUndefined();
  });
  it("auth survives, and admin extraHeaders are not stripped", () => {
    const h = build(mk({ stripHeaders: ["x-api-key", "x-team"] }, { "x-team": "a" }), ["authorization"]);
    expect(h["x-api-key"]).toBe("S");
    expect(h["x-team"]).toBe("a");
  });
  it("stripping the user-agent removes it", () => {
    expect(build(mk({ stripHeaders: ["user-agent"] }))["user-agent"]).toBeUndefined();
  });
});
