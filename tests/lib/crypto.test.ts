import { describe, expect, it } from "vitest";
import { decrypt, encrypt, generateApiKey, randomBase62, sha256 } from "@/lib/crypto";

describe("crypto", () => {
  it("round-trips AES-256-GCM and rejects tampering", () => {
    const enc = encrypt("sk-upstream-secret");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("sk-upstream-secret");
    expect(decrypt(enc)).toBe("sk-upstream-secret");
    expect(encrypt("x")).not.toBe(encrypt("x"));
    const parts = enc.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decrypt(parts.join(":"))).toThrow();
  });
  it("generates API keys", () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^sk-pp-[0-9A-Za-z]{40}$/);
    expect(prefix).toBe(key.slice(0, 12));
    expect(hash).toBe(sha256(key));
    expect(randomBase62(100)).toMatch(/^[0-9A-Za-z]{100}$/);
  });
});
