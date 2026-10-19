import { describe, expect, it } from "vitest";
import { buildSnippets } from "@/components/customer/snippets";
import { ALL_DOC_PAGES, docHref, findDocPage, prevNext } from "@/components/marketing/docs/registry";
import { ERROR_CODES } from "@/server/customer/error-codes";

describe("marketing docs", () => {
  it("has unique slugs and working prev/next", () => {
    const slugs = ALL_DOC_PAGES.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(findDocPage("errors")?.title).toBe("Error codes");
    expect(docHref("")).toBe("/docs");
    expect(prevNext("").prev).toBeNull();
    expect(prevNext(slugs[slugs.length - 1]).next).toBeNull();
  });

  it("covers every PLAN error code", () => {
    const codes = ERROR_CODES.map((e) => e.code);
    for (const c of ["invalid_api_key", "insufficient_balance", "rate_limited", "no_available_provider", "internal_error"]) expect(codes).toContain(c);
  });

  it("uses the app URL in snippets", () => {
    const tabs = buildSnippets({ appUrl: "https://api.example.com/", apiKey: "sk-pp-abc" });
    const all = tabs.flatMap((t) => t.blocks.map((b) => b.code)).join("\n");
    expect(all).toContain("https://api.example.com/v1/chat/completions");
    expect(all).toContain("sk-pp-abc");
    expect(all).not.toContain("com//v1");
  });
});
