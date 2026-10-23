/** The API keys list keeps revoked keys out of the main view; they live in the "Revoked" bin until deleted. */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { db } from "@/lib/db";
import { countRevokedApiKeys, listApiKeys, parseKeyListParams } from "@/server/admin/keys-queries";

const dbOk = await db.$queryRaw`SELECT 1`.then(
  () => true,
  () => false,
);
const sfx = Math.random().toString(36).slice(2, 8);

describe("parseKeyListParams", () => {
  it("defaults to the active view; view=revoked opens the bin", () => {
    expect(parseKeyListParams({}).view).toBe("active");
    expect(parseKeyListParams({ view: "revoked" }).view).toBe("revoked");
    expect(parseKeyListParams({ view: "nonsense" }).view).toBe("active");
  });
});

describe.skipIf(!dbOk)("listApiKeys active vs revoked", () => {
  const users: string[] = [];
  afterAll(async () => {
    await db.apiKey.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  });

  it("the main list never shows revoked keys, the bin shows only them", async () => {
    const u = await db.user.create({ data: { email: `bin-${sfx}@example.com`, passwordHash: "!", status: "ACTIVE" } });
    users.push(u.id);
    for (const [n, status] of [["live", "ACTIVE"], ["off", "DISABLED"], ["gone", "REVOKED"]] as const) {
      await db.apiKey.create({ data: { userId: u.id, name: `${n}-${sfx}`, prefix: `sk-pp-${n}`, keyHash: `bin-${n}-${sfx}`, status } });
    }
    const base = { q: `bin-${sfx}@example.com`, prefix: "", status: "" as const, group: "", page: 0 };
    const active = await listApiKeys({ ...base, view: "active" });
    expect(active.rows.map((r) => r.status).sort()).toEqual(["ACTIVE", "DISABLED"]);
    // even an explicit status=REVOKED filter does not bring them back into the main list
    expect((await listApiKeys({ ...base, status: "REVOKED", view: "active" })).rows.every((r) => r.status !== "REVOKED")).toBe(true);
    const bin = await listApiKeys({ ...base, view: "revoked" });
    expect(bin.rows.map((r) => r.name)).toEqual([`gone-${sfx}`]);
    expect(await countRevokedApiKeys()).toBeGreaterThanOrEqual(1);
  });
});
