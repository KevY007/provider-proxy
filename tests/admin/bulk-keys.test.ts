import { describe, expect, it } from "vitest";
import { parseBulkKeys } from "@/server/admin/bulk-keys";

describe("parseBulkKeys", () => {
  it("parses plain secrets with auto labels continuing from startIndex", () => {
    const r = parseBulkKeys("sk-aaaaaaaa\n  sk-bbbbbbbb  \n\n", { startIndex: 2 });
    expect(r.entries.map((e) => e.label)).toEqual(["key-3", "key-4"]);
    expect(r.entries.map((e) => e.secret)).toEqual(["sk-aaaaaaaa", "sk-bbbbbbbb"]);
    expect(r.skipped).toEqual([]);
  });

  it("supports label|secret and keeps '|' inside later segments out of the label", () => {
    const r = parseBulkKeys("prod|sk-12345678\nsk-87654321");
    expect(r.entries[0]).toMatchObject({ label: "prod", secret: "sk-12345678", line: 1 });
    expect(r.entries[1].label).toBe("key-1");
  });

  it("skips duplicates, short secrets, comments and existing secrets", () => {
    const r = parseBulkKeys("# comment\nsk-aaaaaaaa\nsk-aaaaaaaa\nshort\nx|\nexisting-secret", {
      existingSecrets: ["existing-secret"],
    });
    expect(r.entries).toHaveLength(1);
    expect(r.skipped.map((s) => s.reason)).toEqual(["Duplicate secret", "Secret too short (min 8 chars)", "Empty secret", "Duplicate secret"]);
    expect(r.skipped.map((s) => s.line)).toEqual([3, 4, 5, 6]);
  });

  it("does not collide with existing labels", () => {
    const r = parseBulkKeys("sk-aaaaaaaa", { startIndex: 0, existingLabels: ["key-1", "key-2"] });
    expect(r.entries[0].label).toBe("key-3");
  });

  it("handles CRLF", () => {
    expect(parseBulkKeys("sk-aaaaaaaa\r\nsk-bbbbbbbb\r\n").entries).toHaveLength(2);
  });

  it("never echoes full secrets in skipped previews", () => {
    const r = parseBulkKeys("sk-secretsecretsecret\nsk-secretsecretsecret");
    expect(r.skipped[0].preview).not.toContain("secretsecret");
  });
});
