/** Upstream keys inserted as `plain:<secret>` work at once and are sealed into the encrypted form by upkeep. */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { sealPendingProviderSecrets } from "@/server/admin/seal-secrets";

const dbOk = await db.$queryRaw`SELECT 1`.then(
  () => true,
  () => false,
);
const sfx = Math.random().toString(36).slice(2, 8);

describe("plain secrets", () => {
  it("decrypt reads a pending plain secret and still reads encrypted ones", () => {
    expect(decrypt("plain:sk-abc")).toBe("sk-abc");
    expect(decrypt(encrypt("sk-xyz"))).toBe("sk-xyz");
  });
});

describe.skipIf(!dbOk)("sealPendingProviderSecrets", () => {
  let providerId = "";
  afterAll(async () => {
    if (providerId) await db.provider.delete({ where: { id: providerId } });
  });
  it("encrypts plain keys in place and leaves encrypted ones alone", async () => {
    const p = await db.provider.create({ data: { name: `seal-${sfx}`, slug: `seal-${sfx}`, preset: "custom", baseUrl: "http://x", formats: [] } });
    providerId = p.id;
    const plain = await db.providerKey.create({ data: { providerId: p.id, label: "plain", secretEncrypted: "plain:sk-test-12345678", secretHint: "?" } });
    const enc = encrypt("sk-other-87654321");
    const sealedAlready = await db.providerKey.create({ data: { providerId: p.id, label: "enc", secretEncrypted: enc, secretHint: "4321" } });
    expect(await sealPendingProviderSecrets()).toBeGreaterThanOrEqual(1);
    const after = await db.providerKey.findUniqueOrThrow({ where: { id: plain.id } });
    expect(after.secretEncrypted.startsWith("v1:")).toBe(true);
    expect(decrypt(after.secretEncrypted)).toBe("sk-test-12345678");
    expect(after.secretHint).toBe("5678");
    expect((await db.providerKey.findUniqueOrThrow({ where: { id: sealedAlready.id } })).secretEncrypted).toBe(enc);
  });
});
